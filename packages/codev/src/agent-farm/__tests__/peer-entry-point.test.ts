/**
 * The receiving Tower's peer entry point (Spec 1967, plan phase 5, layer A).
 *
 * An in-process tunnel client connected to the stand-in relay over loopback, with a local
 * listener on its proxy port that records every request it is sent. The stand-in plays
 * Codev Cloud: it originates forwarded requests (genuine, and crafted to fail one check
 * each), sends anything down the tunnel as the `/t/` proxy might, drops tunnels and
 * deploys. Every time-dependent rule runs on one injected clock shared by both sides.
 *
 * What is checked:
 * - the handshake: `peer` from the switch, read afresh on every reconnect; `slug` and
 *   `relay` read from `auth_ok`; the TLS rule;
 * - the last failure (`afx tower status`): kept through a circuit-breaker reset and the
 *   half-open retry, which are not failed attempts;
 * - steps 1 to 8 of contract section 5, each failing alone, with nothing handed on, the
 *   contract's answer, and exactly one entry event that says no more than it may;
 * - the statement-id memory, scoped to the session;
 * - interception: nothing at or under `/__tower/peer` reaches the local listener;
 * - the secret never reaches a log, through a session, forwarded requests and a reconnect,
 *   both in the tunnel client and through `tower-tunnel.ts`'s wiring and logger.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { PEER_FRESHNESS_MS, PEER_STATEMENT_ID_MEMORY_MS, type PeerSwitchState } from '@cluesmith/codev-types';
import {
  TunnelClient,
  AUTH_RETRY_INTERVAL_MS,
  isUnderPeerEntryPath,
  takeRelay,
  type PeerEntryEvent,
  type TunnelPeerOptions,
  type VerifiedPeerRequest,
} from '../lib/tunnel-client.js';
import { encodeReceiverAnswer, isSecureCloudTransport, readRelayOffer, type EncodedAnswer, type RelayOffer } from '../peer/contract.js';
import { StandInRelay, messagePayload, type ForwardOptions, type ForwardResult, type StandInTower } from './helpers/stand-in-relay.js';
import { waitFor } from './helpers/tower-test-utils.js';

// tower-tunnel.ts's own reads, for the wiring tests at the end. Nothing above uses them.
const { mockReadCloudConfig, mockGetCloudConfigPath, mockReadSwitch } = vi.hoisted(() => ({
  mockReadCloudConfig: vi.fn(),
  mockGetCloudConfigPath: vi.fn(),
  mockReadSwitch: vi.fn(),
}));
vi.mock('../lib/cloud-config.js', () => ({
  readCloudConfig: () => mockReadCloudConfig(),
  writeCloudConfig: vi.fn(),
  updateCloudConfig: vi.fn().mockReturnValue(true),
  deleteCloudConfig: vi.fn(),
  getCloudConfigPath: () => mockGetCloudConfigPath(),
  getOrCreateMachineId: vi.fn().mockReturnValue('machine-id'),
  maskApiKey: (key: string) => `***${key.slice(-4)}`,
  DEFAULT_CLOUD_URL: 'https://cloud.codevos.ai',
}));
vi.mock('../db/index.js', () => ({ getGlobalDb: () => ({ stand: 'in for the global database' }) }));
vi.mock('../peer/switch.js', () => ({ readSwitch: (db: unknown) => mockReadSwitch(db) }));

const { initTunnel, shutdownTunnel, getTunnelPeerSession, handleTunnelEndpoint } = await import('../servers/tower-tunnel.js');

// A reconnect waits out the client's own back-off (2 to 3 seconds), and some tests make two.
vi.setConfig({ testTimeout: 20_000 });

const STATEMENT = 'x-codev-peer-statement';
const MAC = 'x-codev-peer-mac';
const OUTCOME = 'x-codev-peer-outcome';

/** C's clock and R's, one clock. */
const T0 = 1_764_100_000_000;
const MINUTE = 60_000;

// ===========================================================================
// The fixture: the stand-in, a receiving Tower's tunnel client, and its local listener
// ===========================================================================

let clock: number;
let relay: StandInRelay;
/** The receiving Tower, R. */
let r: StandInTower;
/** Another Tower on R's account, the stated sender. */
let s: StandInTower;
let local: http.Server;
let localPort: number;
/** Every request Tower's local listener was sent. */
let localRequests: string[];
let switchState: PeerSwitchState;
let events: PeerEntryEvent[];
let handed: VerifiedPeerRequest[];
let handler: (request: VerifiedPeerRequest) => Promise<EncodedAnswer>;
let client: TunnelClient | null;

/** The Tower's handler as phase 5 ships it: every verified request refused as `remote-off`. */
const refuseRemoteOff = async () => encodeReceiverAnswer({ outcome: 'refused', reason: 'remote-off' });

function peerOptions(overrides: Partial<TunnelPeerOptions> = {}): TunnelPeerOptions {
  return {
    remoteMessaging: () => switchState,
    onVerifiedRequest: (request) => {
      handed.push(request);
      return handler(request);
    },
    onEntryEvent: (event) => events.push(event),
    now: () => clock,
    ...overrides,
  };
}

function newClient(options: { serverUrl?: string; peer?: TunnelPeerOptions | null } = {}): TunnelClient {
  const created = new TunnelClient({
    serverUrl: options.serverUrl ?? relay.url,
    apiKey: r.apiKey,
    towerId: r.towerId,
    localPort,
    ...(options.peer === null ? {} : { peer: options.peer ?? peerOptions() }),
  });
  client = created;
  return created;
}

/** Connect and wait until both sides hold the session (the `sessions`-th one for R). */
async function connected(tunnel: TunnelClient, sessions = 1): Promise<void> {
  tunnel.connect();
  const up = await waitFor(
    async () => tunnel.getState() === 'connected' && relay.session(r.towerId) !== null && relay.sessionsOpened(r.towerId) >= sessions,
    10_000,
    10,
  );
  expect(up, 'the tunnel never came up').toBe(true);
}

/** Drop R's tunnel and wait for the client's own reconnect, a new session. */
async function reconnected(tunnel: TunnelClient): Promise<void> {
  const before = relay.sessionsOpened(r.towerId);
  relay.dropTunnels(r.towerId);
  const up = await waitFor(
    async () => relay.sessionsOpened(r.towerId) > before && relay.session(r.towerId) !== null && tunnel.getState() === 'connected',
    15_000,
    20,
  );
  expect(up, 'the tunnel never came back').toBe(true);
}

beforeEach(async () => {
  clock = T0;
  relay = new StandInRelay({ now: () => clock });
  await relay.start();
  const owner = relay.addAccount({ ownerId: 'usr_entry', ownerEmail: 'owner@example.com' });
  r = relay.addTower({ account: owner, slug: 'devvm' });
  s = relay.addTower({ account: owner, slug: 'mbp' });
  localRequests = [];
  local = http.createServer((req, res) => {
    localRequests.push(`${req.method} ${req.url}`);
    req.resume();
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  });
  await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', () => resolve()));
  localPort = (local.address() as { port: number }).port;
  switchState = 'off';
  events = [];
  handed = [];
  handler = refuseRemoteOff;
  client = null;
});

afterEach(async () => {
  client?.disconnect();
  await relay.stop();
  local.closeAllConnections();
  await new Promise<void>((resolve) => local.close(() => resolve()));
  vi.restoreAllMocks();
});

// ===========================================================================
// Helpers for presenting requests
// ===========================================================================

/** A forward from the stand-in and the one entry event it produced. */
async function present(options: ForwardOptions = {}): Promise<{ result: ForwardResult; event: PeerEntryEvent }> {
  const before = events.length;
  const result = await relay.forward(r.towerId, options);
  // The event is emitted before the answer is written, so it is already here.
  expect(events.length, 'exactly one entry event per request').toBe(before + 1);
  const event = events[before];
  expectNothingSecretIn(JSON.stringify(event), result);
  return { result, event };
}

/** An answer of R's, exactly: status 200, the media type, the outcome header and the body. */
function expectAnswer(result: { status: number; headers: Record<string, string | string[]>; json?: unknown }, body: Record<string, unknown>): void {
  expect(result.status).toBe(200);
  expect(result.headers['content-type']).toBe('application/json');
  expect(result.headers[OUTCOME]).toBe(body.outcome);
  expect(result.json).toEqual({ v: 1, ...body });
}

const NOT_VERIFIED = { outcome: 'not-verified' };
const NO_FACTS = { fromTowerId: null, requestId: null, kind: null };

/** What an entry event must never contain: the secret, the statement, the MAC or the body. */
function expectNothingSecretIn(text: string, forward: ForwardResult): void {
  const secret = relay.session(r.towerId)?.secret;
  if (secret) for (const form of secretForms(secret)) expect(text).not.toContain(form);
  expect(text).not.toContain(forward.sentHeaders[STATEMENT] ?? '\u0000');
  expect(text).not.toContain(forward.sentHeaders[MAC] ?? '\u0000');
  if (forward.payload.length > 0) expect(text).not.toContain(forward.payload.toString('utf8'));
}

function secretForms(secret: Uint8Array): string[] {
  const bytes = Buffer.from(secret);
  return [bytes.toString('base64url'), bytes.toString('base64'), bytes.toString('hex')];
}

// ===========================================================================
// Section 1: the handshake and the TLS rule
// ===========================================================================

describe('the handshake', () => {
  it('states the protocol and the switch in auth, read afresh on every reconnect', async () => {
    const tunnel = newClient();
    await connected(tunnel);
    switchState = 'on';
    await reconnected(tunnel);
    switchState = 'off';
    await reconnected(tunnel);

    expect(relay.handshakes.filter((h) => h.towerId === r.towerId).map((h) => h.peer)).toEqual([
      { protocols: [1], remoteMessaging: 'off' },
      { protocols: [1], remoteMessaging: 'on' },
      { protocols: [1], remoteMessaging: 'off' },
    ]);
  });

  it("takes its own name from auth_ok's slug and reports the relay available, without the secret", async () => {
    relay.renameTower(r.towerId, 'devvm-2');
    const tunnel = newClient();
    const identities: unknown[] = [];
    tunnel.onAuthOk((identity) => identities.push(identity));
    await connected(tunnel);

    const session = tunnel.getPeerSession();
    expect(session).toEqual({
      sessionId: expect.any(String),
      towerId: r.towerId,
      slug: 'devvm-2',
      relay: 'available',
      relayProtocols: [1],
    });
    expect(identities).toEqual([{ towerId: r.towerId, slug: 'devvm-2', name: 'devvm', relay: 'available' }]);
    for (const form of secretForms(relay.session(r.towerId)!.secret!)) {
      expect(JSON.stringify([session, identities])).not.toContain(form);
    }

    tunnel.disconnect();
    expect(tunnel.getPeerSession()).toBeNull();
  });

  it('a new session after a reconnect has a new id', async () => {
    const tunnel = newClient();
    await connected(tunnel);
    const first = tunnel.getPeerSession()!.sessionId;
    await reconnected(tunnel);
    expect(tunnel.getPeerSession()!.sessionId).not.toBe(first);
  });

  it.each([
    ['absent', 'absent'],
    ['null', 'null'],
  ] as const)('an auth_ok with relay %s leaves no secret, and every forward fails at step 2', async (mode, status) => {
    relay.setMode(mode);
    const tunnel = newClient();
    await connected(tunnel);
    expect(tunnel.getPeerSession()?.relay).toBe(status);
    expect(relay.session(r.towerId)!.secret).toBeNull();

    // The stand-in has no secret to MAC with, so it uses one of its own.
    const { result, event } = await present();
    expectAnswer(result, NOT_VERIFIED);
    expect(event).toMatchObject({ outcome: 'not-verified', step: 2, ...NO_FACTS });
    expect(handed).toEqual([]);
  });

  it("drops the old session's secret and statement ids when its tunnel goes, on a reconnect and on a disconnect", async () => {
    type Held = { secret: Uint8Array | null; statementIds: Map<string, number> };
    const held = (tunnel: TunnelClient) => (tunnel as unknown as { session: Held | null }).session;
    const tunnel = newClient();
    await connected(tunnel);
    await present();
    const first = held(tunnel)!;
    expect(first.secret).toHaveLength(32);
    expect(first.statementIds.size).toBe(1);

    await reconnected(tunnel);
    expect(first.secret).toBeNull();
    expect(first.statementIds.size).toBe(0);
    await present();
    const second = held(tunnel)!;
    expect(second).not.toBe(first);
    expect(second.secret).toHaveLength(32);

    tunnel.disconnect();
    expect(held(tunnel)).toBeNull();
    expect(second.secret).toBeNull();
    expect(second.statementIds.size).toBe(0);
  });

  it('a client given no peer options states nothing, takes no relay, and verifies nothing', async () => {
    const tunnel = newClient({ peer: null });
    await connected(tunnel);
    expect(relay.handshakes.filter((h) => h.towerId === r.towerId).map((h) => h.peer)).toEqual(['absent']);
    expect(tunnel.getPeerSession()?.relay).toBe('not-stated');

    const result = await relay.forward(r.towerId);
    expectAnswer(result, NOT_VERIFIED);
    expect(handed).toEqual([]);
    expect(localRequests).toEqual([]);
  });

  it('a switch that cannot be read fails the connect attempt instead of stating a guess', async () => {
    const reasons: string[] = [];
    const tunnel = newClient({
      peer: peerOptions({
        remoteMessaging: () => {
          throw new Error('database is locked');
        },
      }),
    });
    tunnel.onStateChange((_state, _prev, reason) => reasons.push(reason ?? ''));
    tunnel.connect();
    expect(await waitFor(async () => reasons.some((reason) => reason.includes('remote-messaging switch unreadable')), 10_000, 10)).toBe(true);
    expect(relay.handshakes).toEqual([]);
    expect(tunnel.getState()).toBe('disconnected');
    expect(tunnel.getLastFailure()).toBe('connection error: remote-messaging switch unreadable: database is locked');
    tunnel.disconnect();
    expect(tunnel.getLastFailure()).toBeNull();
  });
});

// ===========================================================================
// The last failure, which `afx tower status` shows while the tunnel is down
// ===========================================================================

describe('the last failure', () => {
  it('keeps the last failure through a circuit-breaker reset, which is not a failed attempt', async () => {
    const cloud = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/tunnel' });
    await once(cloud, 'listening');
    cloud.on('connection', (socket) => socket.once('message', () => socket.send(JSON.stringify({ type: 'auth_error', reason: 'invalid_api_key' }))));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tunnel = newClient({ serverUrl: `http://127.0.0.1:${(cloud.address() as { port: number }).port}` });
    try {
      tunnel.connect();
      expect(await waitFor(async () => tunnel.getState() === 'auth_failed', 10_000, 5)).toBe(true);
      expect(tunnel.getLastFailure()).toBe('auth rejected: invalid_api_key');
      tunnel.resetCircuitBreaker();
      expect(tunnel.getState()).toBe('disconnected');
      expect(tunnel.getLastFailure()).toBe('auth rejected: invalid_api_key');
    } finally {
      tunnel.disconnect();
      for (const socket of cloud.clients) socket.terminate();
      await new Promise<void>((resolve) => cloud.close(() => resolve()));
    }
    expect(tunnel.getLastFailure()).toBeNull();
  });

  it('keeps the auth rejection through the half-open retry, which is not a failed attempt', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const tunnel = newClient();
      // Driven through the private handlers, as tunnel-client.test.ts drives the breaker, so
      // the 15-minute interval runs on the fake clock and no connection is made.
      const priv = tunnel as unknown as { handleAuthError: (reason: string) => void; doConnect: () => void };
      const doConnect = vi.spyOn(priv, 'doConnect').mockImplementation(() => {});
      priv.handleAuthError('invalid_api_key');
      expect(tunnel.getState()).toBe('auth_failed');
      expect(tunnel.getLastFailure()).toBe('auth rejected: invalid_api_key');

      vi.advanceTimersByTime(AUTH_RETRY_INTERVAL_MS);
      expect(doConnect).toHaveBeenCalledTimes(1);
      expect(tunnel.getState()).toBe('disconnected');
      expect(tunnel.getLastFailure()).toBe('auth rejected: invalid_api_key');
      tunnel.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the TLS rule', () => {
  const secret = randomBytes(32);
  const offered: RelayOffer = { relay: 'offered', protocols: [1], secret };

  it.each([
    ['wss://cloud.codevos.ai/tunnel', true],
    ['https://cloud.codevos.ai/', true],
    ['ws://cloud.codevos.ai/tunnel', false],
    ['http://cloud.codevos.ai/', false],
    ['ws://127.0.0.1:4000/tunnel', true],
    ['ws://127.8.9.10/tunnel', true],
    ['ws://127.1/tunnel', true],
    ['ws://localhost:4000/tunnel', true],
    ['ws://LOCALHOST/tunnel', true],
    ['ws://[::1]:4000/tunnel', true],
    ['ws://[::ffff:127.0.0.1]/tunnel', false],
    ['ws://localhost.example.com/tunnel', false],
    ['ws://128.0.0.1/tunnel', false],
    ['ws://10.0.0.2/tunnel', false],
  ])('%s is a secure transport: %s', (url, secure) => {
    expect(isSecureCloudTransport(new URL(url))).toBe(secure);
  });

  it('keeps the secret only for a relay it can use, on a transport the rule allows, having stated the protocol', () => {
    expect(takeRelay(offered, new URL('wss://cloud.codevos.ai/tunnel'), true)).toEqual({ relay: 'available', protocols: [1], secret });
    expect(takeRelay(offered, new URL('ws://127.0.0.1:9/tunnel'), true)).toEqual({ relay: 'available', protocols: [1], secret });
    expect(takeRelay(offered, new URL('ws://cloud.codevos.ai/tunnel'), true)).toEqual({ relay: 'insecure', protocols: [1], secret: null });
    expect(takeRelay(offered, new URL('wss://cloud.codevos.ai/tunnel'), false)).toEqual({ relay: 'not-stated', protocols: [], secret: null });
    for (const relay of ['absent', 'null', 'malformed'] as const) {
      expect(takeRelay({ relay }, new URL('wss://cloud.codevos.ai/tunnel'), true)).toEqual({ relay, protocols: [], secret: null });
    }
    expect(takeRelay({ relay: 'unsupported', protocols: [2] }, new URL('wss://cloud.codevos.ai/tunnel'), true)).toEqual({
      relay: 'unsupported',
      protocols: [2],
      secret: null,
    });
  });

  it('reads auth_ok.relay strictly', () => {
    const good = secret.toString('base64url');
    expect(readRelayOffer({ type: 'auth_ok' })).toEqual({ relay: 'absent' });
    expect(readRelayOffer({ relay: null })).toEqual({ relay: 'null' });
    expect(readRelayOffer({ relay: { protocols: [1], sessionSecret: good } })).toEqual({ relay: 'offered', protocols: [1], secret: new Uint8Array(secret) });
    expect(readRelayOffer({ relay: { protocols: [1, 2], sessionSecret: good } })).toMatchObject({ relay: 'offered', protocols: [1, 2] });
    expect(readRelayOffer({ relay: { protocols: [2], sessionSecret: good } })).toEqual({ relay: 'unsupported', protocols: [2] });
    expect(readRelayOffer({ relay: { protocols: [], sessionSecret: good } })).toEqual({ relay: 'unsupported', protocols: [] });
    for (const relay of [
      'yes',
      [],
      {},
      { protocols: [1] },
      { protocols: '1', sessionSecret: good },
      { protocols: [1.5], sessionSecret: good },
      { protocols: [0], sessionSecret: good },
      { protocols: ['1'], sessionSecret: good },
      { protocols: [1], sessionSecret: `${good}=` },
      { protocols: [1], sessionSecret: secret.toString('base64') },
      { protocols: [1], sessionSecret: randomBytes(31).toString('base64url') },
      { protocols: [1], sessionSecret: 42 },
    ]) {
      expect(readRelayOffer({ relay }), JSON.stringify(relay)).toEqual({ relay: 'malformed' });
    }
  });

  it('over ws: to a host that is not loopback, refuses the secret, reports no relay, and verifies nothing', async () => {
    // The stand-in listens on loopback; this name resolves to it, so the client really
    // connects over ws: to a host that is not loopback by name or address.
    const name = 'cloud.peer-entry-test.invalid';
    const realLookup = dns.lookup;
    vi.spyOn(dns, 'lookup').mockImplementation(((hostname: string, options: unknown, callback?: unknown) => {
      const done = (typeof options === 'function' ? options : callback) as (...args: unknown[]) => void;
      const opts = (typeof options === 'object' && options !== null ? options : {}) as { all?: boolean };
      if (hostname !== name) return (realLookup as (...args: unknown[]) => void)(hostname, options, callback);
      if (opts.all) process.nextTick(done, null, [{ address: '127.0.0.1', family: 4 }]);
      else process.nextTick(done, null, '127.0.0.1', 4);
    }) as typeof dns.lookup);

    const tunnel = newClient({ serverUrl: `http://${name}:${relay.port}` });
    await connected(tunnel);
    expect(tunnel.getPeerSession()?.relay).toBe('insecure');
    // The stand-in issued a secret, and MACs this genuine statement with it.
    expect(relay.session(r.towerId)!.secret).toHaveLength(32);

    const { result, event } = await present();
    expectAnswer(result, NOT_VERIFIED);
    expect(event).toMatchObject({ outcome: 'not-verified', step: 2, ...NO_FACTS });
    expect(handed).toEqual([]);
  });
});

// ===========================================================================
// Section 5: steps 1 to 8, each failing alone
// ===========================================================================

describe('steps 1 to 8, each failing alone, hand nothing on', () => {
  beforeEach(async () => {
    await connected(newClient());
  });

  afterEach(() => {
    expect(localRequests, 'nothing reaches the local listener').toEqual([]);
  });

  it('a genuine request passes all eight and is handed on, with exactly its statement and payload', async () => {
    const { result, event } = await present({ requestId: '6f1c2a9e-3b4d-4c5e-8f60-718293a4b5c6' });
    expectAnswer(result, { outcome: 'refused', reason: 'remote-off' });
    expect(event).toEqual({
      outcome: 'handed-on',
      step: null,
      at: T0,
      sessionId: client!.getPeerSession()!.sessionId,
      fromTowerId: s.towerId,
      requestId: '6f1c2a9e-3b4d-4c5e-8f60-718293a4b5c6',
      kind: 'message',
    });
    expect(handed).toHaveLength(1);
    expect(handed[0].sessionId).toBe(event.sessionId);
    expect(handed[0].receivedAt).toBe(T0);
    expect(Buffer.from(handed[0].payload).equals(result.payload)).toBe(true);
    expect(handed[0].statement).toEqual(JSON.parse(result.statementBytes.toString('utf8')));
    expect(handed[0]).not.toHaveProperty('secret');
  });

  it("passes the handler's answer back unchanged", async () => {
    handler = async () => encodeReceiverAnswer({ outcome: 'held', reason: 'busy' });
    const { result } = await present();
    expectAnswer(result, { outcome: 'held', reason: 'busy' });
  });

  describe('step 1', () => {
    it.each([
      ['a method other than POST', { method: 'PUT' }],
      ['a query on the path', { path: '/__tower/peer?kind=message' }],
      ['a further segment', { path: '/__tower/peer/x' }],
      ['no statement header', { headers: { [STATEMENT]: undefined } }],
      ['no MAC header', { headers: { [MAC]: undefined } }],
      ['a statement header over 4 096 bytes', { headers: { [STATEMENT]: 'A'.repeat(4_097) } }],
    ] as const)('%s', async (_name, options) => {
      const { result, event } = await present(options as ForwardOptions);
      expectAnswer(result, NOT_VERIFIED);
      expect(event).toEqual({ outcome: 'not-verified', step: 1, at: T0, sessionId: expect.any(String), ...NO_FACTS });
      expect(handed).toEqual([]);
    });

    it('a body over 102 400 bytes, with a statement issued for exactly that body', async () => {
      const body = messagePayload({ sentAt: T0, to: { workspace: 'codev', kind: 'architect' }, body: 'x'.repeat(102_400) });
      expect(body.length).toBeGreaterThan(102_400);
      const { result, event } = await present({ payload: body });
      expectAnswer(result, NOT_VERIFIED);
      expect(event).toMatchObject({ outcome: 'not-verified', step: 1, ...NO_FACTS });
      expect(handed).toEqual([]);
    });

    it('a stream reset before its body ends: one event, no answer', async () => {
      const serverSession = (client as unknown as { h2Session: http2.ServerHttp2Session }).h2Session;
      const seen = new Promise<void>((resolve) => serverSession.once('stream', () => resolve()));
      const stream = relay.session(r.towerId)!.h2.request(
        { ':method': 'POST', ':path': '/__tower/peer', 'content-type': 'application/json', [STATEMENT]: 'AAAA', [MAC]: 'AAAA' },
        { endStream: false },
      );
      stream.on('error', () => {});
      stream.write(Buffer.alloc(1_000));
      await seen;
      // `destroy` resets the stream without ending its body (`close` would end it first).
      stream.destroy(new Error('the relay gave up'));

      expect(await waitFor(async () => events.length === 1, 5_000, 5)).toBe(true);
      expect(events[0]).toMatchObject({ outcome: 'not-verified', step: 1, ...NO_FACTS });
      expect(handed).toEqual([]);
    });
  });

  describe('step 2', () => {
    it('a MAC under another secret', async () => {
      const { result, event } = await present({ secret: randomBytes(32) });
      expectAnswer(result, NOT_VERIFIED);
      expect(event).toMatchObject({ outcome: 'not-verified', step: 2, ...NO_FACTS });
      expect(handed).toEqual([]);
    });

    it('a MAC that is not base64url, and one of the wrong length', async () => {
      for (const mac of ['!!!!', randomBytes(31).toString('base64url')]) {
        const { result, event } = await present({ mac });
        expectAnswer(result, NOT_VERIFIED);
        expect(event).toMatchObject({ outcome: 'not-verified', step: 2, ...NO_FACTS });
      }
      expect(handed).toEqual([]);
    });

    it('a /t/-style request: arbitrary headers, the local key and the tunnel marker, a real statement, no valid MAC', async () => {
      const genuine = await present();
      const result = await relay.tunnelRequest(r.towerId, {
        method: 'POST',
        path: '/__tower/peer',
        headers: {
          'content-type': 'application/json',
          'x-codev-tunnel-proxy': '1',
          'codev-tower-key': 'whatever the proxy carried',
          cookie: 'session=abc',
          [STATEMENT]: genuine.result.sentHeaders[STATEMENT],
          [MAC]: randomBytes(32).toString('base64url'),
        },
        body: genuine.result.payload,
      });
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body.toString('utf8'))).toEqual({ v: 1, outcome: 'not-verified' });
      expect(events.at(-1)).toMatchObject({ outcome: 'not-verified', step: 2, ...NO_FACTS });
      expect(handed).toHaveLength(1);
    });
  });

  it('step 3: a version this Tower does not speak, refused with the versions it does, a sender but no request id', async () => {
    const { result, event } = await present({ statement: { v: 2 } });
    expectAnswer(result, { outcome: 'refused', reason: 'unsupported-version', supported: [1] });
    expect(event).toMatchObject({ outcome: 'unsupported-version', step: 3, fromTowerId: s.towerId, requestId: null, kind: null });
    expect(handed).toEqual([]);
  });

  it('step 4: a field outside its rule, a sender but no request id', async () => {
    const { result, event } = await present({ statement: { fromTowerSlug: 'Not A Slug' } });
    expectAnswer(result, NOT_VERIFIED);
    expect(event).toMatchObject({ outcome: 'not-verified', step: 4, fromTowerId: s.towerId, requestId: null, kind: null });
    expect(handed).toEqual([]);
  });

  it('step 5: addressed to another Tower, with the sender and the request id', async () => {
    const { result, event } = await present({ statement: { toTowerId: s.towerId }, requestId: '0e8c7b3e-1a2b-4c5d-9e6f-a1b2c3d4e5f6' });
    expectAnswer(result, NOT_VERIFIED);
    expect(event).toMatchObject({
      outcome: 'not-verified',
      step: 5,
      fromTowerId: s.towerId,
      requestId: '0e8c7b3e-1a2b-4c5d-9e6f-a1b2c3d4e5f6',
      kind: 'message',
    });
    expect(handed).toEqual([]);
  });

  it('step 6: a body other than the one the statement was issued for', async () => {
    const { result, event } = await present({ statement: { payloadSha256: '0'.repeat(64) } });
    expectAnswer(result, NOT_VERIFIED);
    expect(event).toMatchObject({ outcome: 'not-verified', step: 6, fromTowerId: s.towerId, kind: 'message' });
    expect(event.requestId).toEqual(expect.any(String));
    expect(handed).toEqual([]);
  });

  it('step 7: issued more than 5 minutes either side of this clock, refused as clock-skew; 5 minutes exactly passes', async () => {
    for (const issuedAt of [T0 - PEER_FRESHNESS_MS - 1, T0 + PEER_FRESHNESS_MS + 1]) {
      const { result, event } = await present({ issuedAt });
      expectAnswer(result, { outcome: 'refused', reason: 'clock-skew' });
      expect(event).toMatchObject({ outcome: 'clock-skew', step: 7, fromTowerId: s.towerId, kind: 'message' });
    }
    expect(handed).toEqual([]);
    for (const issuedAt of [T0 - PEER_FRESHNESS_MS, T0 + PEER_FRESHNESS_MS]) {
      expect((await present({ issuedAt })).event.outcome).toBe('handed-on');
    }
  });

  describe('step 8: the statement-id memory', () => {
    it('a statement is used up by its first presentation, even one the handler refused', async () => {
      const first = await present();
      expectAnswer(first.result, { outcome: 'refused', reason: 'remote-off' });
      expect(handed).toHaveLength(1);

      const again = await relay.replay(first.result, r.towerId);
      expectAnswer(again, NOT_VERIFIED);
      const event = events.at(-1)!;
      expect(event).toMatchObject({ outcome: 'not-verified', step: 8, fromTowerId: s.towerId, kind: 'message' });
      expect(event.requestId).toBe(first.event.requestId);
      expect(handed).toHaveLength(1);
    });

    it('is refused when presented again 9 minutes later (a statement still fresh by its issuedAt)', async () => {
      // Issued 4.5 minutes ahead of R's clock: fresh at T0, and still fresh 9 minutes on.
      const first = await present({ issuedAt: T0 + 4.5 * MINUTE });
      expect(first.event.outcome).toBe('handed-on');

      clock = T0 + 9 * MINUTE;
      await relay.replay(first.result, r.towerId);
      expect(events.at(-1)).toMatchObject({ outcome: 'not-verified', step: 8 });
      expect(handed).toHaveLength(1);
    });

    it('forgets an id after 10 minutes, by when freshness refuses the statement anyway', async () => {
      const first = await present({ issuedAt: T0 + PEER_FRESHNESS_MS });
      expect(first.event.outcome).toBe('handed-on');

      clock = T0 + PEER_STATEMENT_ID_MEMORY_MS;
      await relay.replay(first.result, r.towerId);
      expect(events.at(-1)).toMatchObject({ outcome: 'not-verified', step: 8 });

      clock = T0 + PEER_STATEMENT_ID_MEMORY_MS + 1;
      await relay.replay(first.result, r.towerId);
      expect(events.at(-1)).toMatchObject({ outcome: 'clock-skew', step: 7 });
      expect(handed).toHaveLength(1);
    });

    it('a statement from an earlier session fails after a reconnect, at step 2; a new one verifies', async () => {
      const first = await present();
      expect(first.event.outcome).toBe('handed-on');

      await reconnected(client!);
      const replayed = await relay.replay(first.result, r.towerId);
      expectAnswer(replayed, NOT_VERIFIED);
      expect(events.at(-1)).toMatchObject({ outcome: 'not-verified', step: 2, ...NO_FACTS });

      const fresh = await present();
      expect(fresh.event.outcome).toBe('handed-on');
      expect(fresh.event.sessionId).not.toBe(first.event.sessionId);
      expect(handed).toHaveLength(2);
    });

    it('two different statements for one message are each accepted (the request id is not step 8)', async () => {
      const requestId = '7d3f2a10-5b6c-4d7e-8f90-a1b2c3d4e5f6';
      expect((await present({ requestId })).event.outcome).toBe('handed-on');
      expect((await present({ requestId })).event.outcome).toBe('handed-on');
      expect(handed).toHaveLength(2);
    });
  });
});

// ===========================================================================
// Handing on
// ===========================================================================

describe('handing on', () => {
  beforeEach(async () => {
    await connected(newClient());
  });

  it('a handler that fails resets the stream unanswered; the request still had its one event', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    handler = async () => {
      throw new Error('the receiver broke');
    };
    await expect(relay.forward(r.towerId)).rejects.toThrow(/no answer/);
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('handed-on');
  });

  it('an audit hook that fails changes no answer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    client!.disconnect();
    const tunnel = newClient({
      peer: peerOptions({
        onEntryEvent: () => {
          throw new Error('the record is full');
        },
      }),
    });
    await connected(tunnel, 2);
    expectAnswer(await relay.forward(r.towerId), { outcome: 'refused', reason: 'remote-off' });
    expectAnswer(await relay.forward(r.towerId, { secret: randomBytes(32) }), NOT_VERIFIED);
  });
});

// ===========================================================================
// Interception: nothing at or under the entry path reaches the local listener
// ===========================================================================

describe('interception', () => {
  it.each([
    ['/__tower/peer', true],
    ['/__tower/peer?x=1', true],
    ['/__tower/peer/', true],
    ['/__tower/peer/anything', true],
    ['/__tower/peers', true],
    ['/__TOWER/PEER', true],
    ['/__tower/%70eer', true],
    ['/__tower%2Fpeer', true],
    ['//__tower//peer', true],
    ['/__tower\\peer', true],
    ['/x/../__tower/peer', true],
    ['/%2e%2e/__tower/peer', true],
    ['/__tower/peer%', true],
    ['__tower/peer', true],
    ['/__tower/metadata', false],
    ['/__tower/pee', false],
    ['/api/state', false],
    ['/t/devvm/__tower/peer', false],
  ])('%s is at or under the entry path: %s', (path, under) => {
    expect(isUnderPeerEntryPath(path)).toBe(under);
  });

  it('every spelling of the path is answered by the entry point, and only other paths reach the listener', async () => {
    await connected(newClient());
    for (const path of ['/__tower/peer/x', '/__TOWER/PEER', '/__tower/%70eer', '//__tower//peer', '/x/../__tower/peer', '/__tower/peer?y=2']) {
      for (const method of ['POST', 'GET']) {
        const result = await relay.tunnelRequest(r.towerId, { method, path, headers: { 'x-codev-tunnel-proxy': '1' }, body: method === 'POST' ? '{}' : undefined });
        expect(result.status, `${method} ${path}`).toBe(200);
        expect(JSON.parse(result.body.toString('utf8'))).toEqual({ v: 1, outcome: 'not-verified' });
      }
    }
    expect(localRequests).toEqual([]);
    expect(events.every((event) => event.outcome === 'not-verified' && event.step === 1)).toBe(true);
    expect(events).toHaveLength(12);

    // The listener is there, and an ordinary path reaches it.
    const ordinary = await relay.tunnelRequest(r.towerId, { path: '/api/state' });
    expect(ordinary.status).toBe(404);
    expect(localRequests).toEqual(['GET /api/state']);
    expect(handed).toEqual([]);
  });
});

// ===========================================================================
// The secret never reaches a log
// ===========================================================================

/** Every console line written while `run` runs, as text. */
async function consoleLines(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg))).join(' '));
    });
  }
  await run();
  return lines;
}

function expectNoSecretInLines(lines: string[], secrets: Uint8Array[]): void {
  expect(secrets.length).toBeGreaterThanOrEqual(2);
  for (const line of lines) {
    for (const secret of secrets) {
      for (const form of secretForms(secret)) expect(line).not.toContain(form);
    }
  }
}

describe('the secret never reaches a log', () => {
  it('through a session, forwarded requests of every fate, and a reconnect, in the tunnel client', async () => {
    const secrets: Uint8Array[] = [];
    const remember = () => {
      const secret = relay.session(r.towerId)?.secret;
      if (secret) secrets.push(Buffer.from(secret));
    };
    const reasons: string[] = [];
    const lines = await consoleLines(async () => {
      const tunnel = newClient();
      tunnel.onStateChange((state, prev, reason) => reasons.push(`${prev} -> ${state} ${reason ?? ''}`));
      tunnel.onAuthOk((identity) => reasons.push(JSON.stringify(identity)));
      await connected(tunnel);
      remember();
      await present();
      await present({ secret: randomBytes(32) });
      await present({ issuedAt: T0 - PEER_FRESHNESS_MS - 1 });
      handler = async () => {
        throw new Error('the receiver broke');
      };
      await relay.forward(r.towerId).catch(() => {});
      handler = refuseRemoteOff;
      await reconnected(tunnel);
      remember();
      await present();
      tunnel.disconnect();
    });
    // The handler's failure is logged by its class, never its message.
    expect(lines).toContain('Tunnel: peer entry point failed (Error); the request was reset unanswered');
    expect(lines.some((line) => line.includes('the receiver broke'))).toBe(false);
    expectNoSecretInLines([...lines, ...reasons, ...events.map((event) => JSON.stringify(event))], secrets);
  });

  it('a handler error that quotes the statement and the payload is logged by its class alone', async () => {
    await connected(newClient());
    const body = 'a body only the receiving handler ever saw';
    handler = async (request) => {
      throw new TypeError(
        `could not deliver ${request.statement.requestId} from ${request.statement.fromOwnerEmail}: ${Buffer.from(request.payload).toString('utf8')}`,
      );
    };
    const requestId = '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a';
    const lines = await consoleLines(async () => {
      await expect(
        relay.forward(r.towerId, { requestId, payload: messagePayload({ sentAt: T0, to: { workspace: 'codev', kind: 'architect' }, body }) }),
      ).rejects.toThrow(/no answer/);
    });
    expect(handed).toHaveLength(1);
    expect(lines.filter((line) => line.includes('peer entry point'))).toEqual([
      'Tunnel: peer entry point failed (TypeError); the request was reset unanswered',
    ]);
    for (const line of lines) {
      for (const quoted of [requestId, 'owner@example.com', body]) expect(line).not.toContain(quoted);
    }
  });

  it('an auth response that is not an object of a known type is reported without its text, whatever it carries', async () => {
    // A cloud of its own, so each response to `auth` is exactly what the test says.
    const cloud = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/tunnel' });
    await once(cloud, 'listening');
    let reply = '';
    cloud.on('connection', (socket) => socket.once('message', () => socket.send(reply)));
    const port = (cloud.address() as { port: number }).port;
    const secret = randomBytes(32);
    const forms = secretForms(secret);
    try {
      for (const [response, expected] of [
        [`not json at all ${forms[0]}`, /^connection error: invalid auth response \(\d+ bytes, not shown: it may carry a session secret\)$/],
        [`{"type":"auth_ok","towerId":"${r.towerId}","relay":{"protocols":[1],"SessionSecret":"${forms[0]}"`, /invalid auth response \(\d+ bytes, not shown/],
        [`["${forms[1]}", "${forms[2]}"]`, /invalid auth response \(\d+ bytes, not shown/],
        [`{"type":"${forms[0]}"}`, /^connection error: unexpected auth response type: \(not shown\)$/],
      ] as const) {
        reply = response;
        const reasons: string[] = [];
        const lines = await consoleLines(async () => {
          const tunnel = newClient({ serverUrl: `http://127.0.0.1:${port}` });
          tunnel.onStateChange((_state, _prev, reason) => reasons.push(reason ?? ''));
          tunnel.connect();
          expect(await waitFor(async () => reasons.some((reason) => expected.test(reason)), 10_000, 5), `${response}: ${JSON.stringify(reasons)}`).toBe(true);
          tunnel.disconnect();
        });
        for (const text of [...reasons, ...lines]) {
          for (const form of forms) expect(text).not.toContain(form);
        }
      }
    } finally {
      for (const socket of cloud.clients) socket.terminate();
      await new Promise<void>((resolve) => cloud.close(() => resolve()));
    }
  });

  it('an auth_ok that repeats its session secret in a field Tower keeps is not used, and nothing of it is kept or logged', async () => {
    const cloud = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/tunnel' });
    await once(cloud, 'listening');
    let reply = '';
    cloud.on('connection', (socket) => socket.once('message', () => socket.send(reply)));
    const port = (cloud.address() as { port: number }).port;
    const secret = randomBytes(32);
    const [b64url, b64, hex] = secretForms(secret);
    // A hex-spelled secret is decoded as hex only: read as base64 its text is other bytes,
    // whose spellings are no repeat of anything the cloud sent.
    const hexReadAsBase64 = Buffer.from(hex, 'base64').toString('hex');
    const authOk = (fields: Record<string, unknown>) =>
      JSON.stringify({ type: 'auth_ok', towerId: r.towerId, slug: 'devvm', name: 'devvm', relay: { protocols: [1], sessionSecret: b64url }, ...fields });
    try {
      const unsupported = { protocols: [2], sessionSecret: b64url };
      for (const [fields, usedWithRelay] of [
        // The controls: the same responses without the repeat are used.
        [{}, 'available'],
        [{ relay: unsupported }, 'unsupported'],
        [{ relay: { protocols: [1], sessionSecret: b64 } }, 'malformed'],
        [{ name: `devvm ${b64url}` }, null],
        [{ name: hex.toUpperCase() }, null],
        [{ slug: hex }, null],
        [{ slug: b64.replace(/=+$/, '') }, null],
        [{ towerId: `${r.towerId}${b64}` }, null],
        [{ relay: { protocols: [1], sessionSecret: hex }, name: hexReadAsBase64 }, 'malformed'],
        // A secret the client would not take is still never kept, in any spelling:
        // an offer for a version it does not speak,
        [{ relay: unsupported, name: hex }, null],
        [{ relay: unsupported, slug: b64 }, null],
        // and offers it cannot read (padded base64, standard alphabet; hex).
        [{ relay: { protocols: [1], sessionSecret: `${b64url}=` }, name: `${b64url}=` }, null],
        [{ relay: { protocols: [1], sessionSecret: b64 }, name: hex }, null],
        [{ relay: { protocols: [1], sessionSecret: b64 }, slug: b64url }, null],
        [{ relay: { protocols: [1], sessionSecret: hex }, towerId: `${r.towerId}${b64url}` }, null],
      ] as const) {
        reply = authOk(fields);
        const reasons: string[] = [];
        const identities: unknown[] = [];
        const lines = await consoleLines(async () => {
          const tunnel = newClient({ serverUrl: `http://127.0.0.1:${port}` });
          tunnel.onStateChange((_state, _prev, reason) => reasons.push(reason ?? ''));
          tunnel.onAuthOk((identity) => identities.push(identity));
          tunnel.connect();
          const settled = await waitFor(
            async () => identities.length > 0 || reasons.some((reason) => reason.includes('auth_ok not used')),
            10_000,
            5,
          );
          expect(settled, JSON.stringify(fields)).toBe(true);
          tunnel.disconnect();
        });
        if (usedWithRelay !== null) {
          const name = 'name' in fields ? fields.name : 'devvm';
          expect(identities, JSON.stringify(fields)).toEqual([{ towerId: r.towerId, slug: 'devvm', name, relay: usedWithRelay }]);
        } else {
          expect(identities, JSON.stringify(fields)).toEqual([]);
          expect(reasons).toContain('connection error: auth_ok not used: a field repeats its session secret (not shown)');
        }
        for (const text of [...reasons, ...lines, JSON.stringify(identities)]) {
          for (const form of [b64url, b64, hex]) expect(text.toLowerCase()).not.toContain(form.toLowerCase());
        }
      }
    } finally {
      for (const socket of cloud.clients) socket.terminate();
      await new Promise<void>((resolve) => cloud.close(() => resolve()));
    }
  });

  it('a switch tower-tunnel cannot read: one ERROR naming the cause per failing run, the reason in the status while it lasts, then recovery', async () => {
    class SqliteError extends Error {
      code = 'SQLITE_CORRUPT';
    }
    clock = Date.now();
    const configDir = mkdtempSync(join(tmpdir(), 'codev-peer-entry-'));
    mockGetCloudConfigPath.mockReturnValue(join(configDir, 'cloud-config.json'));
    mockReadCloudConfig.mockReturnValue({ tower_id: r.towerId, tower_name: r.slug, api_key: r.apiKey, server_url: relay.url });
    mockReadSwitch.mockImplementation(() => {
      throw new SqliteError('database disk image is malformed');
    });
    const logged: Array<{ level: string; message: string }> = [];
    const tunnelStatus = async (): Promise<Record<string, unknown>> => {
      let body = '';
      const res = { writeHead: () => {}, end: (data?: string) => { body += data ?? ''; } } as unknown as http.ServerResponse;
      const req = { method: 'GET', url: '/api/tunnel/status', headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as http.IncomingMessage;
      await handleTunnelEndpoint(req, res, 'status');
      return JSON.parse(body) as Record<string, unknown>;
    };
    const cause = 'global.db could not be read (SqliteError SQLITE_CORRUPT)';
    const attempts = () => logged.filter((line) => line.message.includes('→ disconnected') && line.message.includes(cause)).length;
    try {
      await initTunnel(
        { port: localPort, log: (level, message) => logged.push({ level, message }), workspaceTerminals: new Map() as never, terminalManager: null },
        { getInstances: async () => [] },
      );
      // Two failing attempts: the first and the back-off's retry.
      expect(await waitFor(async () => attempts() >= 2, 15_000, 20)).toBe(true);
      expect(logged.filter((line) => line.level === 'ERROR')).toEqual([
        { level: 'ERROR', message: `Cloud connection not made: the remote-messaging switch is unreadable: ${cause}. Retrying on back-off.` },
      ]);
      expect(relay.handshakes).toEqual([]);
      expect(await tunnelStatus()).toMatchObject({
        registered: true,
        state: expect.stringMatching(/^(disconnected|connecting)$/),
        lastFailure: `connection error: remote-messaging switch unreadable: ${cause}`,
      });

      // The read works again: the back-off connects, and the failure is gone from the status.
      mockReadSwitch.mockReturnValue({ state: 'off', changedAt: null });
      expect(await waitFor(async () => getTunnelPeerSession() !== null, 15_000, 20)).toBe(true);
      expect(await tunnelStatus()).toMatchObject({ state: 'connected', lastFailure: null });
      expect(relay.handshakes.map((h) => h.peer)).toEqual([{ protocols: [1], remoteMessaging: 'off' }]);
      for (const line of logged) expect(line.message).not.toContain('malformed');
    } finally {
      shutdownTunnel();
      rmSync(configDir, { recursive: true, force: true });
    }
  }, 40_000);

  it("through tower-tunnel's wiring: its logger, the stub handler, the switch re-announced on reconnect, the exposed session", async () => {
    // tower-tunnel's client reads the real clock, so the stand-in issues statements on it too.
    clock = Date.now();
    const configDir = mkdtempSync(join(tmpdir(), 'codev-peer-entry-'));
    mockGetCloudConfigPath.mockReturnValue(join(configDir, 'cloud-config.json'));
    mockReadCloudConfig.mockReturnValue({ tower_id: r.towerId, tower_name: r.slug, api_key: r.apiKey, server_url: relay.url });
    mockReadSwitch.mockReturnValue({ state: 'off', changedAt: null });
    const logged: string[] = [];
    const secrets: Uint8Array[] = [];
    const remember = () => {
      const secret = relay.session(r.towerId)?.secret;
      if (secret) secrets.push(Buffer.from(secret));
    };
    try {
      const lines = await consoleLines(async () => {
        await initTunnel(
          {
            port: localPort,
            log: (level, message) => logged.push(`${level} ${message}`),
            workspaceTerminals: new Map() as never,
            terminalManager: null,
          },
          { getInstances: async () => [] },
        );
        expect(await waitFor(async () => getTunnelPeerSession() !== null && relay.session(r.towerId) !== null, 10_000, 10)).toBe(true);
        remember();
        expect(getTunnelPeerSession()).toMatchObject({ towerId: r.towerId, slug: r.slug, relay: 'available', relayProtocols: [1] });

        // A verified request is refused as remote-off by the Tower's stub handler.
        expectAnswer(await relay.forward(r.towerId), { outcome: 'refused', reason: 'remote-off' });
        expectAnswer(await relay.forward(r.towerId, { secret: randomBytes(32) }), NOT_VERIFIED);

        // The switch is read for every auth: a reconnect states it as it now stands.
        mockReadSwitch.mockReturnValue({ state: 'on', changedAt: T0 });
        const before = relay.sessionsOpened(r.towerId);
        relay.dropTunnels(r.towerId);
        expect(
          await waitFor(async () => relay.sessionsOpened(r.towerId) > before && getTunnelPeerSession() !== null, 15_000, 20),
        ).toBe(true);
        remember();
        expectAnswer(await relay.forward(r.towerId), { outcome: 'refused', reason: 'remote-off' });
        shutdownTunnel();
      });
      expect(relay.handshakes.filter((h) => h.towerId === r.towerId).map((h) => h.peer)).toEqual([
        { protocols: [1], remoteMessaging: 'off' },
        { protocols: [1], remoteMessaging: 'on' },
      ]);
      expect(logged.some((line) => line.includes('Codev Cloud relay available'))).toBe(true);
      expect(getTunnelPeerSession()).toBeNull();
      expectNoSecretInLines([...lines, ...logged], secrets);
    } finally {
      shutdownTunnel();
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
