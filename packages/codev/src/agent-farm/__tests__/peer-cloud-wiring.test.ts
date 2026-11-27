/**
 * Spec 1967, plan phase 7: the cloud client and peer list as the running Tower wires them
 * (`peer/cloud-wiring.ts`), layer A.
 *
 * The registration is a mocked `cloud-config.json`, the database an in-memory one with the
 * real schema, and the network a stubbed `fetch`; each test loads the module afresh, so its
 * one-per-process state starts empty. What is proven:
 *
 * - a switch change is reported only while the tunnel is up and its session has a relay;
 * - each `auth_ok` notes the relay it stated and drops a pending report, and a change made
 *   after the `auth` was sent is reported then;
 * - a listing's `self.slug` becomes this Tower's name in its cloud config (G4), only for the
 *   registration the listing was for.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { CloudConfig } from '../lib/cloud-config.js';
import type { TunnelPeerSession } from '../lib/tunnel-client.js';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import { writeRemoteMessaging } from '../peer/store.js';

const SELF = '01JMBP000000000000000000AA';
const DEVVM = '01JDEVVM0000000000000000AA';
/** The registration the test's tunnel session connected under: the one in its cloud config. */
const CONNECTED_AS = { serverUrl: 'http://127.0.0.1:9', towerId: SELF };

const holder = vi.hoisted(() => ({
  db: null as unknown as import('better-sqlite3').Database,
  config: null as CloudConfig | null,
}));
vi.mock('../db/index.js', () => ({ getGlobalDb: () => holder.db, getDb: () => holder.db, closeDb: vi.fn() }));
vi.mock('../lib/cloud-config.js', () => ({
  readCloudConfig: () => (holder.config === null ? null : { ...holder.config }),
  updateCloudConfig: (apiKey: string, patch: Partial<CloudConfig>) => {
    if (holder.config === null || holder.config.api_key !== apiKey) return false;
    holder.config = { ...holder.config, ...patch };
    return true;
  },
}));

type Wiring = typeof import('../peer/cloud-wiring.js');
type Client = typeof import('../peer/cloud-client.js').CloudClient;

let wiring: Wiring;
let reportSwitch: ReturnType<typeof vi.spyOn>;
let cancelSwitchReport: ReturnType<typeof vi.spyOn>;
let logged: string[];

function session(relay: TunnelPeerSession['relay']): TunnelPeerSession {
  return { sessionId: 's1', towerId: SELF, slug: 'ana-s-mbp', relay, relayProtocols: relay === 'available' ? [1] : [] };
}

function setSwitch(state: 'on' | 'off'): void {
  writeRemoteMessaging(holder.db, state, Date.now());
}

function listingResponse(selfSlug: string): Response {
  return new Response(
    JSON.stringify({
      v: 1,
      relay: { protocols: [1] },
      self: { towerId: SELF, slug: selfSlug },
      limits: { messagesPerTowerPerMinute: 60, messagesPerPairPerMinute: 30, queriesPerPairPerMinute: 10 },
      towers: [{ towerId: DEVVM, slug: 'devvm', online: true, protocols: [1], remoteMessaging: 'on' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

beforeEach(async () => {
  holder.db = new Database(':memory:');
  holder.db.exec(GLOBAL_SCHEMA);
  holder.config = { tower_id: SELF, tower_name: 'ana-s-mbp', api_key: 'ctk_mbp', server_url: 'http://127.0.0.1:9' };
  logged = [];
  vi.resetModules();
  wiring = await import('../peer/cloud-wiring.js');
  const { CloudClient } = (await import('../peer/cloud-client.js')) as { CloudClient: Client };
  reportSwitch = vi.spyOn(CloudClient.prototype, 'reportSwitch').mockImplementation(() => {});
  cancelSwitchReport = vi.spyOn(CloudClient.prototype, 'cancelSwitchReport');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => listingResponse('ana-s-mbp'));
});

afterEach(() => {
  vi.restoreAllMocks();
  holder.db.close();
});

describe('reporting a switch change', () => {
  it('reports only while the tunnel is up and its session has a relay', () => {
    expect(wiring.reportSwitchChange('on')).toBe('tunnel-down');
    wiring.setTunnelSessionSource(() => session('null'), (level, message) => logged.push(`${level} ${message}`));
    expect(wiring.reportSwitchChange('on')).toBe('no-relay');
    wiring.setTunnelSessionSource(() => session('absent'), () => {});
    expect(wiring.reportSwitchChange('on')).toBe('no-relay');
    expect(reportSwitch).not.toHaveBeenCalled();
    wiring.setTunnelSessionSource(() => session('available'), () => {});
    expect(wiring.reportSwitchChange('on')).toBe('reporting');
    expect(reportSwitch).toHaveBeenCalledWith('on');
  });

  it('has nothing to tell without a registration, or with one the cloud removed', () => {
    wiring.setTunnelSessionSource(() => session('available'), () => {});
    holder.config = null;
    expect(wiring.reportSwitchChange('off')).toBe('not-connected');
    holder.config = { tower_id: SELF, tower_name: 'ana-s-mbp', api_key: 'k', server_url: 'http://127.0.0.1:9', deregistered_at: '2026-11-20T00:00:00Z' };
    expect(wiring.reportSwitchChange('off')).toBe('not-connected');
    expect(reportSwitch).not.toHaveBeenCalled();
  });

  it('says whether the tunnel is up from the live session', () => {
    expect(wiring.peerCloudRouteDeps().tunnelUp()).toBe(false);
    wiring.setTunnelSessionSource(() => session('available'), () => {});
    expect(wiring.peerCloudRouteDeps().tunnelUp()).toBe(true);
  });
});

describe('each auth_ok', () => {
  it('notes the relay it stated, and drops a pending report', () => {
    expect(wiring.peerCloudRouteDeps().relay()).toEqual({ state: 'unknown', why: null });
    wiring.onTunnelAuthOk('available', 'off', CONNECTED_AS);
    expect(cancelSwitchReport).toHaveBeenCalledTimes(1);
    expect(wiring.peerCloudRouteDeps().relay()).toEqual({ state: 'available', why: null });
    wiring.onTunnelAuthOk('absent', 'off', CONNECTED_AS);
    expect(wiring.peerCloudRouteDeps().relay()).toEqual({ state: 'none', why: 'old-cloud' });
    expect(cancelSwitchReport).toHaveBeenCalledTimes(2);
    expect(reportSwitch).not.toHaveBeenCalled();
  });

  it('does nothing for an auth_ok from a connection made under a registration since replaced', () => {
    wiring.setTunnelSessionSource(() => null, (level, message) => logged.push(`${level} ${message}`));
    setSwitch('on');
    holder.config = { tower_id: '01JOTHER00000000000000000A', tower_name: 'other', api_key: 'ctk_other', server_url: 'https://cloud.example' };
    wiring.onTunnelAuthOk('available', 'off', CONNECTED_AS);
    expect(wiring.peerCloudRouteDeps().relay()).toEqual({ state: 'unknown', why: null });
    expect(cancelSwitchReport).not.toHaveBeenCalled();
    expect(reportSwitch).not.toHaveBeenCalled();
    expect(logged).toEqual(['INFO Peer: a connection made under a registration since replaced answered; its relay state is not taken in']);
  });

  it('reports a change made after the auth was sent, and only to a cloud with a relay', () => {
    setSwitch('on');
    wiring.onTunnelAuthOk('available', 'on', CONNECTED_AS);
    expect(reportSwitch).not.toHaveBeenCalled();
    wiring.onTunnelAuthOk('null', 'off', CONNECTED_AS);
    wiring.onTunnelAuthOk('available', null, CONNECTED_AS);
    expect(reportSwitch).not.toHaveBeenCalled();
    wiring.onTunnelAuthOk('available', 'off', CONNECTED_AS);
    expect(reportSwitch).toHaveBeenCalledExactlyOnceWith('on');
  });
});

describe("this Tower's own name from its peer list (G4)", () => {
  it("writes the listing's self.slug into the cloud config, and logs the change", async () => {
    wiring.setTunnelSessionSource(() => null, (level, message) => logged.push(`${level} ${message}`));
    vi.mocked(globalThis.fetch).mockImplementation(async () => listingResponse('ana-laptop'));
    expect(await wiring.peerCloudRouteDeps().refreshListing()).toMatchObject({ fresh: true, problem: null });
    expect(holder.config?.tower_name).toBe('ana-laptop');
    expect(logged).toEqual(['INFO Codev Cloud identity changed: slug "ana-s-mbp" → "ana-laptop" (from its peer list)']);
  });

  it('leaves alone a registration for another Tower written while the call was out', async () => {
    wiring.setTunnelSessionSource(() => null, (level, message) => logged.push(`${level} ${message}`));
    vi.mocked(globalThis.fetch).mockImplementation(async () => {
      holder.config = { tower_id: '01JOTHER00000000000000000A', tower_name: 'other', api_key: 'ctk_other', server_url: 'http://127.0.0.1:9' };
      return listingResponse('ana-laptop');
    });
    expect(await wiring.peerCloudRouteDeps().refreshListing()).toMatchObject({ fresh: false, problem: 'registration-changed' });
    expect(holder.config?.tower_name).toBe('other');
    expect(logged).toEqual(["INFO Peer: this Tower's Codev Cloud registration changed while its peer list was fetched; that answer is not used"]);
  });
});
