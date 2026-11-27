/**
 * Issue #1871: Tower must persist and follow the cloud's canonical slug, and
 * react to being deregistered.
 *
 * Real tower-tunnel, cloud-config, token-exchange and TunnelClient against a
 * fake cloud (MockTunnelServer: redeem endpoint + tunnel handshake on a local
 * port). The suite pins its own agent-farm dir, so it never reads or writes the
 * real ~/.agent-farm/cloud-config.json and never talks to a live Tower.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import http from 'node:http';
import { Readable } from 'node:stream';
import { mkdirSync, rmSync } from 'node:fs';

const { TEST_DIR, PREV_AGENT_FARM_DIR_ENV } = vi.hoisted(() => {
  const { resolve } = require('node:path');
  const { tmpdir } = require('node:os');
  const { randomBytes } = require('node:crypto');
  const testDir = resolve(tmpdir(), `bugfix-1871-${randomBytes(4).toString('hex')}`);
  const prevEnv = process.env.CODEV_AGENT_FARM_DIR;
  process.env.CODEV_AGENT_FARM_DIR = resolve(testDir, '.agent-farm');
  return { TEST_DIR: testDir, PREV_AGENT_FARM_DIR_ENV: prevEnv };
});

afterAll(() => {
  // Windows will not unlink an open database file (EBUSY).
  closeGlobalDb();
  if (PREV_AGENT_FARM_DIR_ENV === undefined) delete process.env.CODEV_AGENT_FARM_DIR;
  else process.env.CODEV_AGENT_FARM_DIR = PREV_AGENT_FARM_DIR_ENV;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

import { initTunnel, shutdownTunnel, handleTunnelEndpoint, type TunnelDeps } from '../servers/tower-tunnel.js';
import { readCloudConfig, writeCloudConfig, deleteCloudConfig, type CloudConfig } from '../lib/cloud-config.js';
import { createPendingRegistration } from '../lib/nonce-store.js';
import { redeemToken } from '../lib/token-exchange.js';
import { getPublicAuthority } from '../servers/ide-forward.js';
import { AUTH_RETRY_INTERVAL_MS, calculateBackoff } from '../lib/tunnel-client.js';
import { MockTunnelServer } from './helpers/mock-tunnel-server.js';
import { closeGlobalDb } from '../db/index.js';

const API_KEY = 'ctk_Bugfix1871Key0001';

function makeReq(url: string, method = 'GET'): http.IncomingMessage {
  const readable = new Readable({ read() { this.push(null); } });
  return Object.assign(readable, {
    method,
    url,
    headers: { host: 'localhost:4100' },
    socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as http.IncomingMessage;
}

async function call(sub: string, url = `/api/tunnel/${sub}`, method = 'GET'): Promise<{ status: number; body: string }> {
  let status = 0;
  let body = '';
  const res = {
    writeHead: (code: number) => { status = code; },
    end: (data?: string) => { if (data) body += data; },
  } as unknown as http.ServerResponse;
  await handleTunnelEndpoint(makeReq(url, method), res, sub);
  return { status, body };
}

async function tunnelStatus(): Promise<Record<string, unknown>> {
  return JSON.parse((await call('status')).body);
}

async function until(fn: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > timeoutMs) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('Issue #1871: Tower follows the cloud identity', () => {
  let cloud: MockTunnelServer;
  let cloudUrl: string;
  let logs: string[];
  let deps: TunnelDeps;

  function registration(overrides: Partial<CloudConfig> = {}): CloudConfig {
    return { tower_id: 'tw-1', tower_name: 'mac', api_key: API_KEY, server_url: cloudUrl, ...overrides };
  }

  beforeEach(async () => {
    mkdirSync(process.env.CODEV_AGENT_FARM_DIR!, { recursive: true });
    cloud = new MockTunnelServer({ towerId: 'tw-1', slug: 'mac-2', name: 'mac' });
    cloudUrl = `http://127.0.0.1:${await cloud.start()}`;
    logs = [];
    deps = {
      port: 1,
      log: (level, message) => { logs.push(`${level} ${message}`); },
      workspaceTerminals: new Map() as unknown as TunnelDeps['workspaceTerminals'],
      terminalManager: null,
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    shutdownTunnel();
    // Every auth_ok reads the remote-messaging switch from the real global db (Spec 1967),
    // which opens it under TEST_DIR; close it so each test, and the final rmSync, starts clean.
    closeGlobalDb();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await cloud.stop();
    deleteCloudConfig();
  });

  describe('registration persists the slug the cloud returned', () => {
    it('stores the bumped slug, names it on the success page, and builds every public URL from it', async () => {
      cloud.configure({ redeemResponse: { towerId: 'tw-1', slug: 'mac-2', name: 'mac', apiKey: API_KEY } });
      await initTunnel(deps, { getInstances: async () => [] });

      const nonce = createPendingRegistration('mac', cloudUrl);
      const page = await call('connect/callback', `/api/tunnel/connect/callback?token=tok&nonce=${nonce}`);

      expect(page.status).toBe(200);
      expect(readCloudConfig()).toMatchObject({ tower_name: 'mac-2', display_name: 'mac', api_key: API_KEY });
      expect(page.body).toContain('<strong>mac-2</strong>" is now connected');
      expect(page.body).toContain('<strong>mac</strong> was taken');
      expect(logs.some((l) => l.includes('Registration complete: tower="mac-2" (requested "mac")'))).toBe(true);

      expect(getPublicAuthority()?.prefix).toBe('/t/mac-2/ide');
      const status = await tunnelStatus();
      expect(status.towerName).toBe('mac-2');
      expect(status.displayName).toBe('mac');
      expect(status.accessUrl).toBe(`${cloudUrl}/t/mac-2/`);
    });

    it('a redeem response without slug/name keeps the requested name, as before', async () => {
      cloud.configure({ redeemResponse: { towerId: 'tw-1', apiKey: API_KEY }, slug: undefined, name: undefined });
      await initTunnel(deps, { getInstances: async () => [] });

      const nonce = createPendingRegistration('mac', cloudUrl);
      const page = await call('connect/callback', `/api/tunnel/connect/callback?token=tok&nonce=${nonce}`);

      expect(page.status).toBe(200);
      expect(readCloudConfig()).toMatchObject({ tower_name: 'mac', display_name: 'mac' });
      expect(page.body).not.toContain('was taken');
      expect(getPublicAuthority()?.prefix).toBe('/t/mac/ide');
    });

    it('redeemToken sends claimSlug only when asked', async () => {
      cloud.configure({ redeemResponse: { towerId: 'tw-1', slug: 'mac', name: 'mac', apiKey: API_KEY } });

      await redeemToken(cloudUrl, 'tok-1', 'mac', 'machine-1');
      await redeemToken(cloudUrl, 'tok-2', 'mac', 'machine-1', { claimSlug: true });

      expect(cloud.redeemBodies[0]).not.toHaveProperty('claimSlug');
      expect(cloud.redeemBodies[1]).toMatchObject({ token: 'tok-2', name: 'mac', claimSlug: true });
    });
  });

  describe('auth_ok carries the current identity', () => {
    it('rewrites cloud-config.json when the cloud renamed the tower', async () => {
      writeCloudConfig(registration({ display_name: 'mac' }));
      cloud.configure({ slug: 'studio', name: 'Studio' });

      await initTunnel(deps, { getInstances: async () => [] });
      await until(() => readCloudConfig()?.tower_name === 'studio');

      expect(readCloudConfig()).toMatchObject({ tower_name: 'studio', display_name: 'Studio', api_key: API_KEY });
      expect(getPublicAuthority()?.prefix).toBe('/t/studio/ide');
      expect(logs.some((l) => l.includes('slug "mac" → "studio"'))).toBe(true);
    });

    it('an auth_ok without slug (older cloud) leaves the stored identity alone', async () => {
      writeCloudConfig(registration());
      cloud.configure({ slug: undefined, name: undefined });

      await initTunnel(deps, { getInstances: async () => [] });
      await until(async () => (await tunnelStatus()).state === 'connected');

      expect(readCloudConfig()).toEqual(registration());
    });
  });

  describe('deregistration', () => {
    /** Connect, then delete the tower cloud-side: the session closes and the key dies. */
    async function connectThenDelete(): Promise<void> {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await initTunnel(deps, { getInstances: async () => [] });
      await until(async () => (await tunnelStatus()).state === 'connected');

      cloud.configure({ acceptKey: 'ctk_none' });
      cloud.disconnectAll();
      await vi.advanceTimersByTimeAsync(calculateBackoff(1, () => 0) + 100);
    }

    // Each starts from the identity the cloud confirms, so auth_ok writes nothing
    // and the config watcher stays out of the way until the test writes.
    it('invalid_api_key after a successful connect marks the config deregistered and stops retrying', async () => {
      writeCloudConfig(registration({ tower_name: 'mac-2', display_name: 'mac' }));
      await connectThenDelete();
      await until(() => Boolean(readCloudConfig()?.deregistered_at));

      // Credentials are kept for inspection, only stamped.
      expect(readCloudConfig()).toMatchObject({ tower_id: 'tw-1', api_key: API_KEY, tower_name: 'mac-2' });
      expect(logs.some((l) => l.startsWith('ERROR') && l.includes("deregistered from Codev Cloud") && l.includes("'afx tower connect'"))).toBe(true);

      const status = await tunnelStatus();
      expect(status).toMatchObject({ registered: false, state: 'deregistered', towerName: 'mac-2', accessUrl: null });
      expect(status.deregisteredAt).toBe(readCloudConfig()!.deregistered_at);

      // No half-open retry: the #1372 breaker would try again after this long.
      const attempts = cloud.authKeys.length;
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(AUTH_RETRY_INTERVAL_MS + 60_000);
      expect(cloud.authKeys.length).toBe(attempts);

      // A Tower restart does not connect a deregistered registration, nor does smart reconnect.
      shutdownTunnel();
      await initTunnel(deps, { getInstances: async () => [] });
      const reconnect = await call('connect', '/api/tunnel/connect', 'POST');
      expect(reconnect.status).toBe(400);
      expect(reconnect.body).toContain('deregistered');
      await vi.advanceTimersByTimeAsync(1000);
      expect(cloud.authKeys.length).toBe(attempts);
    }, 20_000);

    it('a registration replaced while connected reconnects with the new key and is never stamped', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      writeCloudConfig(registration({ tower_name: 'mac-2', display_name: 'mac' }));
      await initTunnel(deps, { getInstances: async () => [] });
      await until(async () => (await tunnelStatus()).state === 'connected');

      // A re-registration elsewhere replaced the key on disk while connected; the
      // cloud now accepts only the new key and drops the old session.
      const replaced = registration({ api_key: 'ctk_ReplacedKey0002', tower_name: 'mac-2', display_name: 'mac' });
      cloud.configure({ acceptKey: replaced.api_key });
      writeCloudConfig(replaced);

      // The config watcher swaps the client instead of keeping the stale one.
      await until(async () => cloud.authKeys.at(-1) === replaced.api_key && (await tunnelStatus()).state === 'connected');
      // Drop every session: whatever reconnects must use the new key — a stale
      // client still holding the old one would show up here.
      cloud.disconnectAll();
      await until(() => cloud.authKeys.length >= 3, 8000);
      await until(async () => (await tunnelStatus()).state === 'connected');

      expect(cloud.authKeys[0]).toBe(API_KEY);
      expect(cloud.authKeys.slice(1).every((k) => k === replaced.api_key)).toBe(true);
      expect(readCloudConfig()).toEqual(replaced);
    }, 20_000);
  });
});
