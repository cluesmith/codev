/**
 * Spec 1967, plan phase 7: the sending Tower's cloud client (`peer/cloud-client.ts`), layer A.
 *
 * The client against the stand-in relay's normal and fault modes, and against loopback
 * servers that misbehave as something in front of the cloud might, every timer on an
 * injected clock. What is proven:
 *
 * - the TLS rule: no call to a plain-HTTP cloud that is not on loopback, by any of the three;
 * - the relay call: the contract's headers, the key, the payload bytes, and the answer read
 *   as section 6 reads it; S's 20-second call timeout, body included; no redirect followed;
 *   the answer cap;
 * - the listing: read, within its call budget (10 s on demand, 30 s while holding mail),
 *   shared while in flight; an old cloud is no relay, a cloud that stated one is unreachable;
 * - the switch-state report: retried at 5 s, 30 s and 2 min (or `retryAfterSec`), then not
 *   until the next connect; a newer change replaces a pending one; one call at a time.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  CloudClient,
  LISTING_HOLDING_INTERVAL_MS,
  LISTING_ON_DEMAND_INTERVAL_MS,
  MAX_LISTING_BYTES,
  isSecureCloud,
  type CloudClientOptions,
  type RelayRequest,
} from '../peer/cloud-client.js';
import { StandInRelay, messagePayload, type StandInLimits, type StandInTower } from './helpers/stand-in-relay.js';
import { ManualClock, connectBareSession, faultServer, type BareSession, type FaultServer } from './helpers/peer-cloud-fixtures.js';

/** 40 seconds into a minute of C's clock, so a `retryAfterSec` from a fresh window is 20. */
const T0 = 1_764_100_000_000;

let clock: ManualClock;
let relay: StandInRelay;
let mbp: StandInTower;
let devvm: StandInTower;
let logged: string[];
const sessions: BareSession[] = [];
const servers: FaultServer[] = [];

async function startRelay(limits: Partial<StandInLimits> = {}): Promise<void> {
  relay = new StandInRelay({ now: () => clock.now, limits });
  await relay.start();
  const ana = relay.addAccount({ ownerId: 'usr_ana', ownerEmail: 'ana@example.com' });
  mbp = relay.addTower({ account: ana, slug: 'ana-s-mbp', name: "Ana's MBP", towerId: '01JMBP000000000000000000AA' });
  devvm = relay.addTower({ account: ana, slug: 'devvm', towerId: '01JDEVVM0000000000000000AA' });
}

/** A client holding the key `tower` has now, as a registration does: a later rotation leaves it stale. */
function clientFor(tower: StandInTower, options: Partial<CloudClientOptions> = {}): CloudClient {
  const apiKey = tower.apiKey;
  return new CloudClient({
    registration: () => ({ serverUrl: relay.url, apiKey }),
    relayStated: () => true,
    now: () => clock.now,
    timers: clock.timers,
    log: (level, message) => logged.push(`${level} ${message}`),
    ...options,
  });
}

function message(toTowerId: string): RelayRequest {
  return {
    kind: 'message',
    toTowerId,
    requestId: randomUUID(),
    payload: messagePayload({
      sentAt: clock.now,
      to: { workspace: 'codev', kind: 'architect', name: 'local' },
      from: { workspace: 'codev', kind: 'architect', name: 'main' },
      body: 'CI is green on the tunnel branch',
    }),
  };
}

const callsTo = (route: 'relay' | 'listing' | 'state') => relay.calls.filter((c) => c.route === route);

async function serve(handler: Parameters<typeof faultServer>[0]): Promise<FaultServer> {
  const server = await faultServer(handler);
  servers.push(server);
  return server;
}

beforeEach(async () => {
  clock = new ManualClock(T0);
  logged = [];
  await startRelay();
});

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  for (const server of servers.splice(0)) await server.close();
  await relay.stop();
});

// ===========================================================================
// The TLS rule
// ===========================================================================

describe('the TLS rule', () => {
  it('calls over https:, and over plain HTTP only to a loopback host', () => {
    expect(isSecureCloud('https://cloud.codevos.ai')).toBe(true);
    expect(isSecureCloud('https://cloud.codevos.ai/')).toBe(true);
    for (const loopback of ['http://127.0.0.1:4100', 'http://127.9.9.9', 'http://localhost:8080', 'http://[::1]:1']) {
      expect(isSecureCloud(loopback)).toBe(true);
    }
    for (const plain of ['http://cloud.example', 'http://10.0.0.1', 'http://[::ffff:127.0.0.1]', 'http://localhost.example']) {
      expect(isSecureCloud(plain)).toBe(false);
    }
  });

  it('makes none of the three calls to a plain-HTTP cloud that is not on loopback', async () => {
    const fetch = vi.fn();
    const client = clientFor(mbp, { registration: () => ({ serverUrl: 'http://cloud.example', apiKey: 'ctk_x' }), fetch });
    expect(await client.relay(message(devvm.towerId))).toEqual({ called: false, reason: 'insecure' });
    expect(await client.listTowers('on-demand')).toEqual({ called: false, reason: 'insecure' });
    client.reportSwitch('on');
    await client.switchReportSettled();
    expect(client.hasPendingSwitchReport()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(clock.waiting()).toEqual([]);
  });

  it('calls an https: cloud with the key, no redirect followed, at the route under the server URL', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const client = clientFor(mbp, { registration: () => ({ serverUrl: 'https://cloud.example/', apiKey: 'ctk_key' }), fetch });
    client.reportSwitch('off');
    await client.switchReportSettled();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cloud.example/api/peer/state');
    expect(init).toMatchObject({ method: 'PUT', redirect: 'manual', headers: { authorization: 'Bearer ctk_key', 'content-type': 'application/json' } });
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe('{"remoteMessaging":"off"}');
  });

  it('makes no call without a registration', async () => {
    const fetch = vi.fn();
    const client = clientFor(mbp, { registration: () => null, fetch });
    expect(await client.relay(message(devvm.towerId))).toEqual({ called: false, reason: 'not-connected' });
    expect(await client.listTowers('on-demand')).toEqual({ called: false, reason: 'not-connected' });
    client.reportSwitch('on');
    await client.switchReportSettled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails loudly on a server URL that is not a URL', async () => {
    const client = clientFor(mbp, { registration: () => ({ serverUrl: 'not a url', apiKey: 'k' }) });
    await expect(client.listTowers('on-demand')).rejects.toThrow("cloud-config.json's server_url is not a URL");
    await expect(client.relay(message(devvm.towerId))).rejects.toThrow("cloud-config.json's server_url is not a URL");
    client.reportSwitch('on');
    await client.switchReportSettled();
    expect(client.hasPendingSwitchReport()).toBe(false);
    expect(logged).toEqual(["ERROR Peer: the switch-state report was not made: cloud-config.json's server_url is not a URL"]);
  });
});

// ===========================================================================
// The relay call
// ===========================================================================

describe('the relay call (section 4)', () => {
  it("sends the contract's headers, the key and the payload's exact bytes, and reads C's answer by its status", async () => {
    const client = clientFor(mbp);
    const request = message(devvm.towerId);
    const offline = await client.relay(request);
    expect(offline).toEqual({
      called: true,
      answer: { decidedBy: 'cloud', status: 503, outcome: 'unavailable', reason: 'tower-offline', answer: { v: 1, outcome: 'unavailable', reason: 'tower-offline' } },
    });
    expect(callsTo('relay')).toMatchObject([
      { towerId: mbp.towerId, version: '1', kind: 'message', to: devvm.towerId, requestId: request.requestId, payloadBytes: request.payload.length },
    ]);
  });

  it("reads R's answer, passed through by C, as R's", async () => {
    sessions.push(await connectBareSession(relay, devvm.apiKey));
    const answer = await clientFor(mbp).relay(message(devvm.towerId));
    expect(answer).toEqual({
      called: true,
      answer: { decidedBy: 'receiver', status: 200, outcome: 'delivered', reason: null, answer: { v: 1, outcome: 'delivered' } },
    });
    expect(sessions[0].received).toEqual(['/__tower/peer']);
  });

  it("gives up at S's 20-second call timeout, counting the answer's body, and that is no answer: held as the cloud unreachable", async () => {
    // Headers at once, then a body that never ends.
    const stall = await serve((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json', 'x-codev-peer-outcome': 'delivered' });
      res.write('{"v":1,');
    });
    const client = clientFor(mbp, { registration: () => ({ serverUrl: stall.url, apiKey: 'k' }) });
    let settled = false;
    const pending = client.relay(message(devvm.towerId)).then((r) => {
      settled = true;
      return r;
    });
    await vi.waitFor(() => expect(stall.requests).toHaveLength(1));
    expect(clock.waiting()).toEqual([20_000]);
    clock.advance(19_999);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    clock.advance(1);
    expect(await pending).toEqual({
      called: true,
      answer: { decidedBy: 'none', status: null, outcome: 'unavailable', reason: 'cloud-unreachable', answer: null },
    });
    expect(clock.waiting()).toEqual([]);
  });

  it('follows no redirect: the key goes nowhere else, and a 3xx is an answer without the body', async () => {
    const elsewhere = await serve((_req, res) => res.end());
    const redirecting = await serve((req, res) => {
      req.resume();
      res.writeHead(307, { location: `${elsewhere.url}/api/peer/relay` });
      res.end();
    });
    const answer = await clientFor(mbp, { registration: () => ({ serverUrl: redirecting.url, apiKey: 'ctk_secret' }) }).relay(message(devvm.towerId));
    expect(answer).toMatchObject({ called: true, answer: { decidedBy: 'none', status: 307, reason: 'cloud-unreachable' } });
    expect(elsewhere.requests).toEqual([]);
  });

  it('reads no more of an answer than the cap and one byte, and an answer over the cap is a tower-error', async () => {
    const big = Buffer.alloc(1_000_000, 0x20);
    const flood = await serve((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json', 'x-codev-peer-outcome': 'delivered' });
      res.end(Buffer.concat([Buffer.from('{"v":1,"outcome":"delivered"'), big, Buffer.from('}')]));
    });
    const answer = await clientFor(mbp, { registration: () => ({ serverUrl: flood.url, apiKey: 'k' }) }).relay(message(devvm.towerId));
    expect(answer).toMatchObject({ called: true, answer: { decidedBy: 'none', status: 200, outcome: 'unavailable', reason: 'tower-error' } });
  });
});

// ===========================================================================
// The listing
// ===========================================================================

describe('the listing (section 3)', () => {
  it("reads the account's other Towers, this Tower as the cloud has it, the relay and the cloud's limits", async () => {
    sessions.push(await connectBareSession(relay, devvm.apiKey, 'off'));
    const call = await clientFor(mbp).listTowers('on-demand');
    expect(call).toEqual({
      called: true,
      answer: {
        ok: true,
        listing: {
          v: 1,
          relay: { protocols: [1] },
          self: { towerId: mbp.towerId, slug: 'ana-s-mbp' },
          limits: { messagesPerTowerPerMinute: 60, messagesPerPairPerMinute: 30, queriesPerPairPerMinute: 10 },
          towers: [{ towerId: devvm.towerId, slug: 'devvm', online: true, protocols: [1], remoteMessaging: 'off' }],
        },
      },
    });
  });

  it('is called on demand at most every 10 seconds, and while holding mail at most every 30, counted from the last call', async () => {
    const client = clientFor(mbp);
    expect((await client.listTowers('on-demand')).called).toBe(true);
    clock.advance(LISTING_ON_DEMAND_INTERVAL_MS - 1);
    expect(await client.listTowers('on-demand')).toEqual({ called: false, reason: 'budget', lastCalledAt: T0 });
    clock.advance(1);
    expect((await client.listTowers('on-demand')).called).toBe(true);
    clock.advance(LISTING_HOLDING_INTERVAL_MS - 1);
    expect(await client.listTowers('holding')).toMatchObject({ called: false, reason: 'budget' });
    expect((await client.listTowers('on-demand')).called).toBe(true);
    clock.advance(LISTING_HOLDING_INTERVAL_MS);
    expect((await client.listTowers('holding')).called).toBe(true);
    expect(callsTo('listing')).toHaveLength(4);
  });

  it('shares a call in flight with every caller, and lets a clock that went back call again', async () => {
    const client = clientFor(mbp);
    const [a, b] = await Promise.all([client.listTowers('on-demand'), client.listTowers('holding')]);
    expect(a).toEqual(b);
    expect(callsTo('listing')).toHaveLength(1);
    clock.now -= 60_000;
    expect((await client.listTowers('on-demand')).called).toBe(true);
  });

  it('reports an old cloud (no relay, a bodyless 404) as having no relay, and one that stated a relay as unreachable', async () => {
    relay.setMode('absent');
    expect(await clientFor(mbp, { relayStated: () => false }).listTowers('on-demand')).toEqual({
      called: true,
      answer: { ok: false, status: 404, reason: 'no-relay', retryAfterSec: null, retryable: false },
    });
    relay.setMode('relay');
    relay.injectFault({ kind: 'bodyless', status: 404, route: 'listing' });
    expect(await clientFor(mbp, { relayStated: () => true }).listTowers('on-demand')).toEqual({
      called: true,
      answer: { ok: false, status: 404, reason: 'cloud-unreachable', retryAfterSec: null, retryable: true },
    });
  });

  it("reads C's 401 for a replaced key and its 429 with retryAfterSec", async () => {
    await relay.stop();
    await startRelay({ listingPerTowerPerMinute: 1 });
    const client = clientFor(mbp);
    expect((await client.listTowers('on-demand')).called).toBe(true);
    clock.advance(LISTING_ON_DEMAND_INTERVAL_MS);
    expect(await client.listTowers('on-demand')).toEqual({
      called: true,
      answer: { ok: false, status: 429, reason: 'rate-limited', retryAfterSec: 10, retryable: true },
    });
    relay.rotateKey(mbp.towerId);
    clock.advance(LISTING_ON_DEMAND_INTERVAL_MS);
    expect(await client.listTowers('on-demand')).toMatchObject({ called: true, answer: { ok: false, status: 401, reason: 'unauthenticated', retryable: false } });
  });

  it('does not take a listing that does not fit, saying what did not, and reads no more than its bound', async () => {
    relay.writeRecordUnchecked(devvm.towerId, { slug: 'Dev VM' });
    expect(await clientFor(mbp).listTowers('on-demand')).toMatchObject({
      called: true,
      answer: { ok: false, status: 200, reason: 'bad-listing', problem: 'towers[0].slug is not a Tower name' },
    });
    const huge = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(Buffer.alloc(MAX_LISTING_BYTES + 10, 0x20));
    });
    expect(await clientFor(mbp, { registration: () => ({ serverUrl: huge.url, apiKey: 'k' }) }).listTowers('on-demand')).toMatchObject({
      called: true,
      answer: { ok: false, reason: 'bad-listing', problem: `the body is longer than ${MAX_LISTING_BYTES} bytes` },
    });
  });
});

// ===========================================================================
// The switch-state report
// ===========================================================================

describe('the switch-state report (section 2, K5)', () => {
  it('tells the cloud, which then lists the switch for this Tower', async () => {
    const client = clientFor(mbp);
    client.reportSwitch('on');
    await client.switchReportSettled();
    expect(mbp.remoteMessaging).toBe('on');
    expect(callsTo('state')).toMatchObject([{ status: 204, towerId: mbp.towerId }]);
    expect(client.hasPendingSwitchReport()).toBe(false);
    expect(logged).toEqual(['INFO Peer: Codev Cloud told remote messaging is on']);
  });

  it('retries a failed report three times, at 5 s, 30 s and 2 min, then not until the next connect', async () => {
    relay.injectFault({ kind: 'bodyless', status: 503, route: 'state' });
    const client = clientFor(mbp);
    client.reportSwitch('on');
    for (const delay of [5_000, 30_000, 120_000]) {
      await client.switchReportSettled();
      expect(clock.waiting()).toEqual([delay]);
      clock.advance(delay - 1);
      expect(callsTo('state')).toHaveLength([5_000, 30_000, 120_000].indexOf(delay) + 1);
      clock.advance(1);
    }
    await client.switchReportSettled();
    expect(callsTo('state')).toHaveLength(4);
    expect(clock.waiting()).toEqual([]);
    expect(client.hasPendingSwitchReport()).toBe(false);
    clock.advance(24 * 60 * 60_000);
    expect(callsTo('state')).toHaveLength(4);
    expect(logged.at(-1)).toBe(
      'WARN Peer: Codev Cloud could not be told remote messaging is on (cloud-unreachable, HTTP 503); gave up after three retries. The next connection states it.',
    );
  });

  it('waits for retryAfterSec instead when the cloud asks for longer', async () => {
    await relay.stop();
    await startRelay({ statePerTowerPerMinute: 0 });
    const client = clientFor(mbp);
    client.reportSwitch('on');
    await client.switchReportSettled();
    // 20 seconds left in C's minute, longer than the first interval.
    expect(clock.waiting()).toEqual([20_000]);
    clock.advance(20_000);
    await client.switchReportSettled();
    // A whole new minute, longer than the second interval.
    expect(clock.waiting()).toEqual([60_000]);
  });

  it('replaces a pending retry with a newer change, which is sent at once', async () => {
    relay.injectFault({ kind: 'bodyless', status: 503, route: 'state' }, 1);
    const client = clientFor(mbp);
    client.reportSwitch('on');
    await client.switchReportSettled();
    expect(clock.waiting()).toEqual([5_000]);
    client.reportSwitch('off');
    await client.switchReportSettled();
    expect(clock.waiting()).toEqual([]);
    expect(mbp.remoteMessaging).toBe('off');
    clock.advance(10 * 60_000);
    expect(callsTo('state').map((c) => c.status)).toEqual([503, 204]);
  });

  it('makes one call at a time, so the cloud hears the changes in order, and sends only the newest after one in flight', async () => {
    const sent: string[] = [];
    const answer: Array<(response: Response) => void> = [];
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      sent.push(new TextDecoder().decode(init.body as Uint8Array));
      return new Promise<Response>((resolve) => answer.push(resolve));
    });
    const client = clientFor(mbp, { fetch });
    client.reportSwitch('on');
    client.reportSwitch('off');
    client.reportSwitch('on');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent).toEqual(['{"remoteMessaging":"on"}']);
    answer[0](new Response(null, { status: 204 }));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toBe('{"remoteMessaging":"on"}');
    answer[1](new Response(null, { status: 204 }));
    await client.switchReportSettled();
    expect(client.hasPendingSwitchReport()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry C's 401, or a cloud with no relay", async () => {
    const client = clientFor(mbp);
    relay.rotateKey(mbp.towerId);
    client.reportSwitch('on');
    await client.switchReportSettled();
    expect(clock.waiting()).toEqual([]);
    expect(logged.at(-1)).toContain('(unauthenticated, HTTP 401); not retried.');

    relay.setMode('absent');
    const old = clientFor(mbp, { relayStated: () => false, registration: () => ({ serverUrl: relay.url, apiKey: relay.tower(mbp.towerId).apiKey }) });
    old.reportSwitch('off');
    await old.switchReportSettled();
    expect(clock.waiting()).toEqual([]);
    expect(logged.at(-1)).toContain('(no-relay, HTTP 404); not retried.');
  });

  it('drops a pending retry when a new connection states the switch', async () => {
    relay.injectFault({ kind: 'bodyless', status: 502, route: 'state' });
    const client = clientFor(mbp);
    client.reportSwitch('on');
    await client.switchReportSettled();
    expect(clock.waiting()).toEqual([5_000]);
    client.cancelSwitchReport();
    expect(clock.waiting()).toEqual([]);
    expect(client.hasPendingSwitchReport()).toBe(false);
    clock.advance(10 * 60_000);
    expect(callsTo('state')).toHaveLength(1);
  });
});
