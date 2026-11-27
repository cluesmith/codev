/**
 * Spec 1967, plan phase 7: the sending Tower's peer list (`peer/peer-list.ts`), layer A.
 *
 * A real cloud client against the stand-in relay, a temporary database and a hand-made
 * registration, every timer on an injected clock. This Tower (`ana-s-mbp`) never opens a
 * tunnel here: a send does not need one. What is proven:
 *
 * - whether the cloud has a relay: the TLS rule first, then the latest of the last
 *   `auth_ok`, the last listing, and a bodyless `404` from a cloud that never stated one;
 * - the cached listing (C13): a cached name resolves with the cloud unreachable, a name not
 *   in it fails saying when the list was last refreshed, a former name fails naming the
 *   current one, and a name new to the cache is found after one refresh;
 * - this Tower's own name follows the listing's `self.slug` (G4);
 * - walkthrough step 1 end to end: `afx peer list` through the real route and the SDK,
 *   with the switch off; and `afx peer limits` shows the cloud's limits from the listing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { TowerClient } from '@cluesmith/codev-sdk/tower-client';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as store from '../peer/store.js';
import { CloudClient, LISTING_ON_DEMAND_INTERVAL_MS } from '../peer/cloud-client.js';
import { PeerList, type OwnRegistration } from '../peer/peer-list.js';
import { createPeerRouteHandler } from '../servers/peer-routes.js';
import { peerGrant, peerLimits, peerList, peerOn, type PeerDeps } from '../commands/peer.js';
import { resolvePeerSettings } from '../../lib/config.js';
import { StandInRelay, type StandInAccount, type StandInLimits, type StandInTower } from './helpers/stand-in-relay.js';
import { ManualClock, connectBareSession, type BareSession } from './helpers/peer-cloud-fixtures.js';

const T0 = 1_764_100_000_000;
const ISO = (ms: number) => new Date(ms).toISOString();

let clock: ManualClock;
let relay: StandInRelay;
let ana: StandInAccount;
let mbp: StandInTower;
let devvm: StandInTower;
let dir: string;
let db: Database.Database;
let registration: OwnRegistration | null;
let adopted: Array<[string, string]>;
let logged: string[];
let client: CloudClient;
let list: PeerList;
const sessions: BareSession[] = [];

async function startRelay(limits: Partial<StandInLimits> = {}): Promise<void> {
  relay = new StandInRelay({ now: () => clock.now, limits });
  await relay.start();
  ana = relay.addAccount({ ownerId: 'usr_ana', ownerEmail: 'ana@example.com' });
  mbp = relay.addTower({ account: ana, slug: 'ana-s-mbp', name: "Ana's MBP", towerId: '01JMBP000000000000000000AA' });
  devvm = relay.addTower({ account: ana, slug: 'devvm', towerId: '01JDEVVM0000000000000000AA' });
}

/** This Tower's cloud client and peer list, as `peer/cloud-wiring.ts` builds them. */
function wire(): void {
  const apiKey = mbp.apiKey;
  client = new CloudClient({
    registration: () => (registration === null ? null : { serverUrl: registration.serverUrl, apiKey }),
    relayStated: () => list.relayStated(),
    now: () => clock.now,
    timers: clock.timers,
    log: (level, message) => logged.push(`${level} ${message}`),
  });
  list = new PeerList({
    db: () => db,
    now: () => clock.now,
    client,
    registration: () => registration,
    adoptOwnName: (towerId, slug) => {
      adopted.push([towerId, slug]);
      if (registration !== null && registration.towerId === towerId) registration = { ...registration, towerName: slug };
    },
    log: (level, message) => logged.push(`${level} ${message}`),
  });
}

const listingCalls = () => relay.calls.filter((c) => c.route === 'listing').length;

beforeEach(async () => {
  clock = new ManualClock(T0);
  logged = [];
  adopted = [];
  await startRelay();
  dir = mkdtempSync(join(tmpdir(), 'peer-list-'));
  db = new Database(join(dir, 'global.db'));
  db.exec(GLOBAL_SCHEMA);
  registration = { serverUrl: relay.url, towerId: mbp.towerId, towerName: 'ana-s-mbp', deregistered: false };
  wire();
});

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  await relay.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// Whether the cloud has a relay
// ===========================================================================

describe('whether the cloud has a relay', () => {
  it("is unknown until the cloud says, and then what the last auth_ok said", () => {
    expect(list.relay()).toEqual({ state: 'unknown', why: null });
    list.noteAuthOk('available', registration!);
    expect(list.relay()).toEqual({ state: 'available', why: null });
    list.noteAuthOk('absent', registration!);
    expect(list.relay()).toEqual({ state: 'none', why: 'old-cloud' });
    list.noteAuthOk('null', registration!);
    expect(list.relay()).toEqual({ state: 'none', why: 'stated-none' });
    list.noteAuthOk('unsupported', registration!);
    expect(list.relay()).toEqual({ state: 'none', why: 'unsupported' });
    list.noteAuthOk('malformed', registration!);
    expect(list.relay()).toEqual({ state: 'none', why: 'malformed' });
    // A session that did not state the protocol took no relay, and says nothing of one.
    list.noteAuthOk('not-stated', registration!);
    expect(list.relay()).toEqual({ state: 'unknown', why: null });
  });

  it('is the latest statement, whether from the handshake or the listing', async () => {
    list.noteAuthOk('available', registration!);
    relay.setMode('null');
    expect((await list.refresh()).fresh).toBe(true);
    expect(list.relay()).toEqual({ state: 'none', why: 'stated-none' });
    list.noteAuthOk('available', registration!);
    expect(list.relay()).toEqual({ state: 'available', why: null });
  });

  it('applies the TLS rule first: a plain-HTTP cloud off loopback has none, and is never called', async () => {
    list.noteAuthOk('available', registration!);
    registration = { ...registration!, serverUrl: 'http://cloud.example' };
    expect(list.relay()).toEqual({ state: 'none', why: 'insecure' });
    expect(await list.refresh()).toMatchObject({ fresh: false, problem: 'no-relay' });
    expect(listingCalls()).toBe(0);
  });

  it('takes a bodyless 404 from a cloud that never stated a relay as an old cloud with none', async () => {
    relay.setMode('absent');
    expect(await list.refresh()).toMatchObject({ fresh: false, problem: 'no-relay', listing: { refreshedAt: null } });
    expect(list.relay()).toEqual({ state: 'none', why: 'old-cloud' });
    expect(list.relayStated()).toBe(false);
    // The cloud gains a relay: its next handshake says so.
    list.noteAuthOk('available', registration!);
    expect(list.relay()).toEqual({ state: 'available', why: null });
  });

  it('takes a bodyless 404 from a cloud that has stated a relay as the cloud unreachable', async () => {
    expect((await list.refresh()).fresh).toBe(true);
    expect(list.relayStated()).toBe(true);
    relay.injectFault({ kind: 'bodyless', status: 404, route: 'listing' });
    clock.advance(LISTING_ON_DEMAND_INTERVAL_MS);
    expect(await list.refresh()).toMatchObject({ fresh: false, problem: 'cloud-unreachable' });
    expect(list.relay()).toEqual({ state: 'available', why: null });
  });

  it('remembers a listed relay across a restart, from the cache on disk', async () => {
    await list.refresh();
    wire();
    expect(list.relayStated()).toBe(true);
    expect(list.relay()).toEqual({ state: 'available', why: null });
  });

  it('counts as stated a relay object in the last auth_ok or a non-null relay in the last listing, and nothing else', async () => {
    expect(list.relayStated()).toBe(false);
    list.noteAuthOk('insecure', registration!);
    expect(list.relayStated()).toBe(true);
    list.noteAuthOk('null', registration!);
    expect(list.relayStated()).toBe(false);
    relay.setMode('null');
    await list.refresh();
    expect(list.relayStated()).toBe(false);
  });
});

// ===========================================================================
// The cached listing and names (C13, G4)
// ===========================================================================

describe('the cached listing (C13)', () => {
  it("keeps the listing, its time and the cloud's limits, and every name a Tower has had", async () => {
    expect(await list.refresh()).toMatchObject({ fresh: true, problem: null, listing: { refreshedAt: T0 } });
    relay.renameTower(devvm.towerId, 'vm2');
    clock.advance(LISTING_ON_DEMAND_INTERVAL_MS);
    const refreshed = await list.refresh();
    expect(refreshed.listing).toMatchObject({
      refreshedAt: T0 + LISTING_ON_DEMAND_INTERVAL_MS,
      relayProtocols: [1],
      limits: { messagesPerTowerPerMinute: 60, messagesPerPairPerMinute: 30, queriesPerPairPerMinute: 10 },
      towers: [{ towerId: devvm.towerId, slug: 'vm2' }],
    });
    expect(store.listTowerNames(db, devvm.towerId).map((n) => n.slug)).toEqual(['devvm', 'vm2']);
  });

  it('resolves a cached name with the cloud unreachable, and refuses one not in it saying when the list was refreshed', async () => {
    await list.refresh();
    relay.injectFault({ kind: 'bodyless', status: 503, route: 'listing' });
    clock.advance(LISTING_ON_DEMAND_INTERVAL_MS);
    const callsBefore = listingCalls();
    expect(await list.resolve('devvm')).toMatchObject({ ok: true, fresh: false, tower: { towerId: devvm.towerId, slug: 'devvm' } });
    expect(listingCalls()).toBe(callsBefore);
    expect(await list.resolve('studio')).toEqual({
      ok: false,
      reason: 'unknown-tower',
      currentName: null,
      message: `No Tower named 'studio' is in this Tower's peer list (its peer list was last refreshed ${ISO(T0)}; Codev Cloud is unreachable).`,
    });
  });

  it('says so when this Tower has never listed its peers and the cloud is unreachable', async () => {
    await relay.stop();
    expect(await list.resolve('devvm')).toMatchObject({
      ok: false,
      message: "No Tower named 'devvm' is in this Tower's peer list (this Tower has not listed its peers yet; Codev Cloud is unreachable).",
    });
    await relay.start();
  });

  it('refuses a former name, naming the current one, with the cloud unreachable', async () => {
    await list.refresh();
    relay.renameTower(devvm.towerId, 'vm2');
    clock.advance(LISTING_ON_DEMAND_INTERVAL_MS);
    await list.refresh();
    relay.injectFault({ kind: 'bodyless', status: 503, route: 'listing' });
    clock.advance(LISTING_ON_DEMAND_INTERVAL_MS);
    expect(await list.resolve('devvm')).toEqual({
      ok: false,
      reason: 'unknown-tower',
      currentName: 'vm2',
      message: "'devvm' is a former name of the Tower now called 'vm2'. Name it 'vm2'.",
    });
    expect(await list.resolve('vm2')).toMatchObject({ ok: true, fresh: false, tower: { towerId: devvm.towerId } });
  });

  it('finds a Tower new to the cache after one refresh, within the call budget', async () => {
    await list.refresh();
    relay.addTower({ account: ana, slug: 'studio', towerId: '01JSTUDIO00000000000000AA' });
    // Within 10 seconds of the last call the list is not asked again, so the name is not found yet.
    expect(await list.resolve('studio')).toMatchObject({
      ok: false,
      message: `No Tower named 'studio' is in this Tower's peer list (its peer list was last refreshed ${ISO(T0)}).`,
    });
    clock.advance(LISTING_ON_DEMAND_INTERVAL_MS);
    expect(await list.resolve('studio')).toMatchObject({ ok: true, fresh: true, tower: { slug: 'studio' } });
    expect(listingCalls()).toBe(2);
  });

  it('refuses the name of a Tower no longer on the account', async () => {
    await list.refresh();
    relay.moveTower(devvm.towerId, relay.addAccount({ ownerId: 'usr_bob', ownerEmail: 'bob@example.com' }));
    clock.advance(LISTING_ON_DEMAND_INTERVAL_MS);
    await list.refresh();
    expect(await list.resolve('devvm')).toMatchObject({
      ok: false,
      currentName: null,
      message: `'devvm' was the name of a Tower that is no longer in this Tower's peer list (its peer list was last refreshed ${ISO(T0 + LISTING_ON_DEMAND_INTERVAL_MS)}).`,
    });
  });

  it('takes no listing whose self is another Tower, and keeps the cached one', async () => {
    await list.refresh();
    const other = await fetch(`${relay.url}/api/peer/towers`, { headers: { authorization: `Bearer ${devvm.apiKey}` } });
    const devvmsListing = await other.json();
    // A cloud that answers this Tower's call with another Tower's list.
    const confused = new PeerList({
      db: () => db,
      now: () => clock.now,
      client: { listTowers: async () => ({ called: true, answer: { ok: true, listing: devvmsListing } }) },
      registration: () => registration,
      adoptOwnName: (towerId, slug) => adopted.push([towerId, slug]),
      log: (level, message) => logged.push(`${level} ${message}`),
    });
    expect(await confused.refresh()).toMatchObject({ fresh: false, problem: 'bad-listing', listing: { refreshedAt: T0, towers: [{ slug: 'devvm' }] } });
    expect(logged).toContain("WARN Peer: Codev Cloud's peer list is for another Tower (its self is not this Tower's id); the cached list stands");
    expect(adopted).toEqual([]);
  });

  it('takes no listing for the registration a call was made under once another Tower has registered here', async () => {
    await list.refresh();
    clock.advance(LISTING_ON_DEMAND_INTERVAL_MS);
    const pending = list.refresh();
    registration = { ...registration!, towerId: '01JSOMEONEELSE00000000000A', towerName: 'someone' };
    // The previous registration's list is not this one's either: it is dropped, and nothing replaces it.
    expect(await pending).toMatchObject({ fresh: false, problem: 'registration-changed', listing: { refreshedAt: null, towers: [] } });
    expect(adopted).toEqual([]);
    expect(logged).toContain("INFO Peer: this Tower's Codev Cloud registration changed while its peer list was fetched; that answer is not used");
  });

  it("keeps the cached list when the cloud's does not fit, and says why in the log", async () => {
    await list.refresh();
    relay.writeRecordUnchecked(devvm.towerId, { slug: 'Dev VM' });
    clock.advance(LISTING_ON_DEMAND_INTERVAL_MS);
    expect(await list.refresh()).toMatchObject({ fresh: false, problem: 'bad-listing', listing: { refreshedAt: T0, towers: [{ slug: 'devvm' }] } });
    expect(logged).toContain("WARN Peer: Codev Cloud's peer list was not in the expected form (towers[0].slug is not a Tower name); the cached list stands");
  });

  it('makes no call without a registration, or with one the cloud removed', async () => {
    const saved = registration;
    registration = null;
    expect(await list.refresh()).toMatchObject({ fresh: false, problem: 'not-connected' });
    registration = { ...saved!, deregistered: true };
    expect(await list.refresh()).toMatchObject({ fresh: false, problem: 'not-registered' });
    expect(listingCalls()).toBe(0);
  });

  it('resolves only a Tower name an address parser took', async () => {
    await expect(list.resolve('DevVM')).rejects.toThrow('resolve takes a Tower name the address parser accepted');
    await expect(list.resolve('sam@studio')).rejects.toThrow();
  });
});

describe('after this Tower registers again', () => {
  it('takes in no auth_ok from a connection made under a registration since replaced', () => {
    const previous = registration!;
    registration = { ...previous, towerId: '01JBOBSTOWER0000000000000A' };
    expect(list.noteAuthOk('available', previous)).toBe(false);
    expect(list.relay()).toEqual({ state: 'unknown', why: null });
    expect(list.relayStated()).toBe(false);
    expect(list.noteAuthOk('null', registration)).toBe(true);
    expect(list.relay()).toEqual({ state: 'none', why: 'stated-none' });
    // The same Tower on the same cloud, its URL written another way, is the same registration.
    expect(list.noteAuthOk('available', { ...registration, serverUrl: `${registration.serverUrl}/` })).toBe(true);
    expect(list.relay()).toEqual({ state: 'available', why: null });
  });

  it("shows none of the previous account's Towers or relay, with the new cloud unreachable", async () => {
    list.noteAuthOk('available', registration!);
    await list.refresh();
    expect(list.cached().towers.map((t) => t.slug)).toEqual(['devvm']);
    expect(list.relay()).toEqual({ state: 'available', why: null });

    // Account B, on a cloud this test never starts: a port that refuses.
    registration = { serverUrl: 'http://127.0.0.1:9', towerId: '01JBOBSTOWER0000000000000A', towerName: 'bobs-mbp', deregistered: false };
    expect(list.cached()).toEqual({ refreshedAt: null, relayProtocols: null, limits: null, towers: [] });
    expect(store.listTowerNames(db)).toEqual([]);
    expect(list.relay()).toEqual({ state: 'unknown', why: null });
    expect(list.relayStated()).toBe(false);
    expect(await list.resolve('devvm')).toMatchObject({
      ok: false,
      reason: 'unknown-tower',
      message: "No Tower named 'devvm' is in this Tower's peer list (this Tower has not listed its peers yet; Codev Cloud is unreachable).",
    });
    expect(logged).toContain("INFO Peer: this Tower's Codev Cloud registration changed; the peer list cached for the previous one is dropped");
  });

  it('keeps the list for the same Tower on the same cloud, whatever its key (as --reauth gives) and however its URL ends', async () => {
    await list.refresh();
    registration = { ...registration!, serverUrl: `${relay.url}/` };
    expect(list.cached().towers.map((t) => t.slug)).toEqual(['devvm']);
    expect(logged.filter((line) => line.includes('registration changed'))).toEqual([]);
  });

  it("keeps nothing from the previous cloud's answer when only the cloud changes while the call is out", async () => {
    const second = new StandInRelay({ now: () => clock.now });
    await second.start();
    try {
      const account = second.addAccount({ ownerId: 'usr_ana', ownerEmail: 'ana@example.com' });
      second.addTower({ account, slug: 'ana-s-mbp', towerId: mbp.towerId, apiKey: mbp.apiKey });
      second.addTower({ account, slug: 'studio', towerId: '01JSTUDIO00000000000000AA' });
      // The same Tower id, so only the scope tells the two answers apart.
      const pending = list.refresh();
      registration = { ...registration!, serverUrl: second.url };
      expect(await pending).toMatchObject({ fresh: false, problem: 'registration-changed', listing: { refreshedAt: null, towers: [] } });
      expect(store.listTowerNames(db)).toEqual([]);
      // The next refresh is the second cloud's own, and within its own budget.
      expect(await list.refresh()).toMatchObject({ fresh: true, listing: { towers: [{ slug: 'studio' }] } });
    } finally {
      await second.stop();
    }
  });

  it("notes nothing from a failure under the previous registration either", async () => {
    relay.setMode('absent');
    const pending = list.refresh();
    registration = { ...registration!, towerId: '01JSOMEONEELSE00000000000A' };
    expect(await pending).toMatchObject({ problem: 'registration-changed' });
    // The old cloud's bodyless 404 would have said "no relay"; it says nothing of this registration.
    expect(list.relay()).toEqual({ state: 'unknown', why: null });
  });

  it('drops the list when only the cloud changes, and counts the listing budget afresh for it', async () => {
    await list.refresh();
    const second = new StandInRelay({ now: () => clock.now });
    await second.start();
    try {
      const account = second.addAccount({ ownerId: 'usr_ana', ownerEmail: 'ana@example.com' });
      second.addTower({ account, slug: 'ana-s-mbp', towerId: mbp.towerId, apiKey: mbp.apiKey });
      second.addTower({ account, slug: 'studio', towerId: '01JSTUDIO00000000000000AA' });
      registration = { ...registration!, serverUrl: second.url };
      // Within 10 seconds of the first cloud's call: the second's budget is its own.
      expect(await list.refresh()).toMatchObject({ fresh: true, listing: { towers: [{ slug: 'studio' }] } });
      expect(store.listTowerNames(db).map((n) => n.slug)).toEqual(['studio']);
    } finally {
      await second.stop();
    }
  });
});

describe("this Tower's own name (G4)", () => {
  it("follows the listing's self.slug after a rename in the cloud, and the old name no longer resolves here", async () => {
    await list.refresh();
    expect(adopted).toEqual([]);
    expect(await list.resolve('ana-s-mbp')).toEqual({ ok: false, reason: 'self' });

    relay.renameTower(mbp.towerId, 'ana-laptop');
    clock.advance(LISTING_ON_DEMAND_INTERVAL_MS);
    expect((await list.refresh()).fresh).toBe(true);
    expect(adopted).toEqual([[mbp.towerId, 'ana-laptop']]);
    expect(registration?.towerName).toBe('ana-laptop');
    expect(await list.resolve('ana-laptop')).toEqual({ ok: false, reason: 'self' });
    clock.advance(LISTING_ON_DEMAND_INTERVAL_MS);
    expect(await list.resolve('ana-s-mbp')).toMatchObject({ ok: false, reason: 'unknown-tower', message: expect.stringContaining("No Tower named 'ana-s-mbp'") });
  });
});

// ===========================================================================
// Walkthrough step 1, end to end
// ===========================================================================

describe("walkthrough step 1: 'afx peer list' on mbp, with the switch off", () => {
  let server: http.Server;
  let printed: string[];
  let deps: PeerDeps;

  beforeEach(async () => {
    const handler = createPeerRouteHandler({
      db: () => db,
      now: () => clock.now,
      world: () => ({ registered: [{ workspacePath: '/work/codev', explicitName: null }], running: ['/work/codev'], architectsOf: () => ['main'] }),
      ownTower: () => ({ name: registration?.towerName ?? null, towerId: registration?.towerId ?? null }),
      settings: () => resolvePeerSettings({}),
      cloud: () => ({
        scopeToRegistration: () => list.scopeToRegistration(),
        refreshListing: () => list.refresh('on-demand'),
        relay: () => list.relay(),
        reportSwitch: (state) => {
          client.reportSwitch(state);
          return 'reporting';
        },
        tunnelUp: () => true,
        wakeOutbox: () => {},
        outbox: () => ({ inFlightFor: () => null, pausedBecause: () => null }),
        show: async () => {
          throw new Error('these routes ask no peer');
        },
      }),
      log: (level, message) => logged.push(`${level} ${message}`),
    });
    server = http.createServer((req, res) => void handler(req, res, new URL(req.url ?? '/', 'http://127.0.0.1')));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    printed = [];
    deps = {
      client: new TowerClient({ host: '127.0.0.1', port: (server.address() as AddressInfo).port }),
      out: {
        success: (m) => printed.push(`[ok] ${m}`),
        info: (m) => printed.push(`[info] ${m}`),
        warn: (m) => printed.push(`[warn] ${m}`),
        line: (t) => printed.push(t),
      },
    };
    // devvm's tunnel is up, so the cloud lists it online.
    sessions.push(await connectBareSession(relay, devvm.apiKey, 'off'));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('prints the switch, then one line for devvm, as the walkthrough shows', async () => {
    await peerList({}, deps);
    expect(printed).toEqual([
      'Remote messaging: off — a human turns it on with: afx peer on',
      'devvm  you  online  may message this Tower: nothing',
    ]);
    expect(store.readRemoteMessaging(db).state).toBe('off');
  });

  it('then step 2: afx peer on reports the switch to the cloud, which lists it for mbp', async () => {
    await peerOn({ humanApproved: true }, deps);
    await client.switchReportSettled();
    expect(mbp.remoteMessaging).toBe('on');
  });

  it("lets a grant name a Tower this Tower has never listed, and shows it in the list's line", async () => {
    await peerGrant({ tower: 'devvm', addresses: ['codev:architect:main'], humanApproved: true }, deps);
    expect(listingCalls()).toBe(1);
    printed.length = 0;
    clock.advance(LISTING_ON_DEMAND_INTERVAL_MS);
    await peerList({}, deps);
    expect(printed[1]).toBe('devvm  you  online  may message this Tower: codev:architect:main (deliver)');
  });

  it("shows the cloud's limits once the list has been fetched, and says they are not known before", async () => {
    await relay.stop();
    await startRelay({ messagesPerPairPerMinute: 25 });
    registration = { serverUrl: relay.url, towerId: mbp.towerId, towerName: 'ana-s-mbp', deregistered: false };
    wire();
    await peerLimits({}, deps);
    expect(printed.at(-1)).toBe("Codev Cloud's limits: not known yet. This Tower learns them from its peer list: afx peer list");
    printed.length = 0;
    await peerList({}, deps);
    printed.length = 0;
    await peerLimits({}, deps);
    expect(printed.slice(-4)).toEqual([
      `Codev Cloud's limits (approximate, the cloud's to change; from its peer list at ${ISO(T0)}):`,
      '  Messages from this Tower          60 a minute',
      '  Messages to one Tower             25 a minute',
      '  Discovery queries to one Tower    10 a minute',
    ]);
  });
});
