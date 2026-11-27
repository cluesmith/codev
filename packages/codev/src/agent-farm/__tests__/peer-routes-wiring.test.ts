/**
 * Spec 1967, phase 4: the peer routes as production wires them.
 *
 * `peer-commands.test.ts` drives the handler with hand-built dependencies. This file proves
 * the wiring around it: `/api/peer/…` is reached through Tower's real `handleRequest`
 * dispatch, and the production dependencies read what they should, the global database for
 * the switch and grants, the registry (`known_workspaces`, `architect`) for workspaces and
 * architects, the cloud config for this Tower's own name, and the user's config for the
 * limits. The tunnel marker is honoured through the real dispatch. The cloud behind the
 * peer list is `peer/cloud-wiring.ts`'s, as production builds it; the cloud config's server
 * URL is plain HTTP on a host that is not this machine, so the TLS rule keeps every call to
 * it from being made (phase 7).
 *
 * Standard tower-routes harness: the database seam returns an in-memory database seeded with
 * the real schema, and the rest of tower-routes' import graph is stubbed. Served on a
 * loopback port by a throwaway server; nothing touches the live Tower or the user's files.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as store from '../peer/store.js';
import { handleRequest, type RouteContext } from '../servers/tower-routes.js';

const holder = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock('../db/index.js', () => ({ getGlobalDb: () => holder.db, getDb: () => holder.db, closeDb: vi.fn() }));

// This Tower's own identity, and the user's config, as production reads them.
vi.mock('../lib/cloud-config.js', () => ({
  readCloudConfig: () => ({ tower_id: '01JSELF0000000000000000AAA', tower_name: 'ana-s-mbp', api_key: 'ctk_x', server_url: 'http://cloud.example' }),
}));
vi.mock('../../lib/config.js', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/config.js')>()),
  loadConfig: () => ({ peer: { recordRetentionDays: 7, limits: { acceptedPerPeerPerMinute: 20 } } }),
}));

// Stub the rest of the tower-routes import graph (standard route-test preamble).
vi.mock('../servers/tower-cron.js', () => ({
  getAllTasks: vi.fn(() => []),
  executeTask: vi.fn(async () => ({ result: 'success', output: 'ok' })),
  getTaskId: vi.fn((ws: string, name: string) => `${ws}:${name}`),
  loadWorkspaceTasks: vi.fn(() => []),
}));
vi.mock('../servers/tower-instances.js', () => ({
  getInstances: vi.fn(async () => []),
  getKnownWorkspacePaths: vi.fn(() => []),
  getDirectorySuggestions: vi.fn(async () => []),
  launchInstance: vi.fn(async () => ({ success: true })),
  killTerminalWithShellper: vi.fn(async () => true),
  stopInstance: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../servers/tower-terminals.js', () => ({
  getWorkspaceTerminals: vi.fn(() => new Map()),
  getTerminalManager: vi.fn(() => ({ getSession: vi.fn(), listSessions: vi.fn(() => []) })),
  getWorkspaceTerminalsEntry: vi.fn(),
  getNextShellId: vi.fn(),
  saveTerminalSession: vi.fn(),
  isSessionPersistent: vi.fn(),
  deleteTerminalSession: vi.fn(),
  removeTerminalFromRegistry: vi.fn(),
  deleteWorkspaceTerminalSessions: vi.fn(),
  saveFileTab: vi.fn(),
  removeFileTab: vi.fn(),
  getTerminalsForWorkspace: vi.fn(() => []),
  isStartupReconcileSettled: () => true,
  whenStartupReconcileSettled: () => Promise.resolve(),
}));
vi.mock('../servers/tower-messages.js', () => ({
  resolveTarget: vi.fn(),
  broadcastMessage: vi.fn(),
  runningWorkspacePaths: vi.fn(() => []),
  isResolveError: vi.fn((r: unknown) => typeof r === 'object' && r !== null && 'code' in r),
}));
vi.mock('../utils/message-format.js', () => ({
  formatArchitectMessage: vi.fn((_to: string, msg: string) => msg),
  formatArchitectToBuilderMessage: vi.fn((_to: string, msg: string) => msg),
  formatBuilderMessage: vi.fn((id: string, to: string, msg: string) => `[${id} → ${to}] ${msg}`),
}));
vi.mock('../utils/server-utils.js', async (importActual) => ({
  ...(await importActual<typeof import('../utils/server-utils.js')>()),
  isRequestAllowed: vi.fn(() => true),
}));
vi.mock('../servers/tower-tunnel.js', () => ({
  initTunnel: vi.fn(),
  shutdownTunnel: vi.fn(),
  handleTunnelEndpoint: vi.fn(),
}));
vi.mock('../servers/tower-websocket.js', () => ({ setupUpgradeHandler: vi.fn() }));
vi.mock('../servers/overview.js', () => ({
  OverviewCache: class {
    getOverview = vi.fn(async () => ({ builders: [], pendingPRs: [], backlog: [] }));
    invalidate = vi.fn();
  },
}));
vi.mock('../../terminal/session-manager.js', () => ({ SessionManager: class {} }));
vi.mock('../../terminal/index.js', () => ({ DEFAULT_COLS: 120, defaultSessionOptions: {} }));
vi.mock('../lib/tower-client.js', () => ({
  DEFAULT_TOWER_PORT: 4100,
  encodeWorkspacePath: (p: string) => Buffer.from(p).toString('base64url'),
  decodeWorkspacePath: (p: string) => Buffer.from(p, 'base64url').toString(),
}));

const DEVVM = '01JDEVVM0000000000000000AA';
/** The mocked registration's scope: the cached listing is this Tower's only while it matches. */
const FETCHED_FOR = 'http://cloud.example 01JSELF0000000000000000AAA';

let server: http.Server;
let port: number;
let dir: string;
let workspace: string;

function makeCtx(): RouteContext {
  return {
    log: vi.fn(),
    port: 4100,
    version: '9.9.9',
    startedAt: '2026-01-01T00:00:00.000Z',
    templatePath: null,
    reactDashboardPath: '/tmp/dash',
    hasReactDashboard: false,
    getShellperManager: () => null,
    broadcastNotification: vi.fn(),
    addSseClient: vi.fn(),
    removeSseClient: vi.fn(),
  } as RouteContext;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'peer-wiring-')));
  workspace = join(dir, 'codev');
  holder.db = new Database(':memory:');
  holder.db.exec(GLOBAL_SCHEMA);
  holder.db.prepare('INSERT INTO known_workspaces (workspace_path, name) VALUES (?, ?)').run(workspace, 'codev');
  const architect = holder.db.prepare(
    "INSERT INTO architect (workspace_path, id, pid, port, cmd, started_at) VALUES (?, ?, 0, 0, 'claude', ?)",
  );
  architect.run(workspace, 'local', '2026-11-01 10:00:00');
  architect.run(workspace, 'review', '2026-11-01 11:00:00');
  store.writeListing(
    holder.db,
    {
      relay: { protocols: [1] },
      limits: { messagesPerTowerPerMinute: 60, messagesPerPairPerMinute: 30, queriesPerPairPerMinute: 10 },
      towers: [{ towerId: DEVVM, slug: 'devvm', online: true, protocols: [1], remoteMessaging: 'on' }],
      fetchedFor: FETCHED_FOR,
    },
    Date.now(),
  );
  const ctx = makeCtx();
  server = http.createServer((req, res) => void handleRequest(req, res, ctx));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  holder.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the peer routes through handleRequest', () => {
  it('turn the switch on in the global database, naming this Tower from its cloud config', async () => {
    const answer = await call('PUT', '/api/peer/switch', { state: 'on', humanApproved: true });
    expect(answer).toMatchObject({ status: 200, body: { state: 'on', changed: true, towerName: 'ana-s-mbp', grantCount: 0 } });
    expect(store.readRemoteMessaging(holder.db).state).toBe('on');
  });

  it('check a grant against the registry and store it under the workspace key', async () => {
    const answer = await call('POST', '/api/peer/grants', {
      tower: 'devvm',
      addresses: ['codev:architect:review', 'codev:architect'],
      humanApproved: true,
    });
    expect(answer.status).toBe(200);
    expect(store.listGrants(holder.db)).toMatchObject([
      { peerTowerId: DEVVM, workspacePath: workspace, scope: 'architect', architect: 'review', mode: 'deliver' },
      { peerTowerId: DEVVM, workspacePath: workspace, scope: 'front-door', architect: null, mode: 'deliver' },
    ]);
    // No `main` registered: the front door is the first registered architect.
    const listed = await call('GET', '/api/peer/grants');
    expect(listed.body.grants).toMatchObject([
      { recipient: 'codev:architect:review', reaches: null, matchesNothing: null },
      { recipient: 'codev:architect', reaches: 'local', matchesNothing: null },
    ]);
    const missing = await call('POST', '/api/peer/grants', { tower: 'devvm', addresses: ['codev:architect:main'], humanApproved: true });
    expect(missing).toMatchObject({ status: 404, body: { error: 'NOT_FOUND' } });
  });

  it('refuse a tunnel-borne grant through the real dispatch', async () => {
    const answer = await call(
      'POST',
      '/api/peer/grants',
      { tower: 'devvm', all: true, humanApproved: true },
      { 'x-codev-tunnel-proxy': '1' },
    );
    expect(answer).toMatchObject({ status: 403, body: { error: 'NOT_OVER_TUNNEL' } });
    expect(store.listGrants(holder.db)).toEqual([]);
  });

  it("read this Tower's limits from the user's config, with the retention raised to 30 days", async () => {
    expect(await call('GET', '/api/peer/limits')).toEqual({
      status: 200,
      body: {
        tower: { acceptedPerPeerPerMinute: 20, undeliveredPerPeer: 50, waitingPerPeer: 50 },
        recordRetentionDays: 30,
        cloud: { limits: { messagesPerTowerPerMinute: 60, messagesPerPairPerMinute: 30, queriesPerPairPerMinute: 10 }, listedAt: expect.any(Number) },
      },
    });
  });

  it("list the peers from the cached listing, with no call to a cloud the TLS rule refuses, and what each may message here", async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      await call('POST', '/api/peer/grants', { tower: 'devvm', addresses: ['codev:architect:review'], humanApproved: true });
      const answer = await call('GET', '/api/peer/towers');
      expect(answer).toEqual({
        status: 200,
        body: {
          remoteMessaging: 'off',
          towerName: 'ana-s-mbp',
          tunnel: 'down',
          relay: { state: 'none', why: 'insecure' },
          listing: { fresh: false, refreshedAt: expect.any(Number), problem: 'no-relay', retryAfterSec: null },
          towers: [
            {
              towerId: DEVVM,
              name: 'devvm',
              online: true,
              protocols: [1],
              remoteMessaging: 'on',
              mayMessage: [expect.objectContaining({ recipient: 'codev:architect:review', mode: 'deliver' })],
            },
          ],
        },
      });
      // The switch report goes nowhere either: the tunnel is down.
      expect(await call('PUT', '/api/peer/switch', { state: 'on', humanApproved: true })).toMatchObject({
        status: 200,
        body: { changed: true, cloudReport: 'tunnel-down' },
      });
      // The test's own calls to this Tower are the only fetches made.
      expect(fetch.mock.calls.every(([url]) => String(url).startsWith(`http://127.0.0.1:${port}/`))).toBe(true);
    } finally {
      fetch.mockRestore();
    }
  });

  it("show and resolve nothing from a peer list fetched under another registration, and keep a human's grants", async () => {
    await call('POST', '/api/peer/grants', { tower: 'devvm', all: true, humanApproved: true });
    store.writeListing(
      holder.db,
      {
        relay: { protocols: [1] },
        limits: { messagesPerTowerPerMinute: 60, messagesPerPairPerMinute: 30, queriesPerPairPerMinute: 10 },
        towers: [{ towerId: DEVVM, slug: 'devvm', online: true, protocols: [1], remoteMessaging: 'on' }],
        fetchedFor: 'https://cloud.codevos.ai 01JPREVIOUSTOWER000000000A',
      },
      Date.now(),
    );
    const listed = await call('GET', '/api/peer/towers');
    expect(listed).toMatchObject({ status: 200, body: { towers: [], listing: { refreshedAt: null } } });
    expect((await call('GET', '/api/peer/limits')).body.cloud).toBeNull();
    const grant = await call('POST', '/api/peer/grants', { tower: 'devvm', addresses: ['codev:architect:review'], humanApproved: true });
    expect(grant).toMatchObject({ status: 404, body: { error: 'UNKNOWN_TOWER' } });
    expect(store.listGrants(holder.db)).toHaveLength(1);
  });

  it('answer an unknown peer path with a coded 404, so a client can tell it from an older Tower', async () => {
    expect(await call('GET', '/api/peer/nothing')).toMatchObject({ status: 404, body: { error: 'NOT_FOUND' } });
  });
});
