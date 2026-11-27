/**
 * A message from one Tower to another, end to end (Spec 1967, plan phase 8, layer A): the
 * sending Tower S (its sender, outbox, cloud client and peer list, over its own database)
 * calls the stand-in cloud C over loopback, which forwards down the receiving Tower R's
 * tunnel (the real tunnel client and the phase 6 receiver, over R's database). One injected
 * clock is C's, S's and R's, so the limits' windows, the back-off and the lifetime are the
 * test's to move; the network, the tunnel and the answers are real.
 *
 * R's delivery port marks a message delivered as soon as its turn comes: the delivery path
 * itself (the gate, the locks, the frame) is plan phase 6's and tested there.
 *
 * - a backlog of 50 held drains in order, none refused, against C's per-pair limit and,
 *   with C's raised, against R's own;
 * - a fresh send refused for rate, by C or by R, ends refused; C's ceiling on every call
 *   is a 429 like any other;
 * - twenty sends at once go in acceptance order, never two in flight;
 * - an answer lost after R accepted, then the retry's `duplicate: true`;
 * - a restart resumes the queue in order;
 * - not registered: deregistered refuses with no call; a key C rejects refuses the same way.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { AgentAddress } from '@cluesmith/codev-types';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as mailbox from '../db/mailbox.js';
import { TunnelClient } from '../lib/tunnel-client.js';
import { CloudClient } from '../peer/cloud-client.js';
import { Outbox } from '../peer/outbox.js';
import { PeerList, type OwnRegistration } from '../peer/peer-list.js';
import { createReceiver, type RecipientLookup } from '../peer/receiver.js';
import { Sender, type PeerSendRequest, type PeerSendResult } from '../peer/sender.js';
import * as store from '../peer/store.js';
import { setSwitch } from '../peer/switch.js';
import type { GrantWorld } from '../peer/grants.js';
import { ManualClock } from './helpers/peer-cloud-fixtures.js';
import { StandInRelay, type StandInLimits, type StandInTower } from './helpers/stand-in-relay.js';
import { waitFor } from './helpers/tower-test-utils.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** On a minute boundary, so C's and R's per-minute windows start with the test. */
const T0 = Date.UTC(2026, 10, 21, 3, 34, 0, 0);
const CODEV = '/work/codev';

/** The two Towers and the cloud between them. */
class Pipeline {
  readonly clock = new ManualClock(T0);
  readonly relay: StandInRelay;
  readonly dirs: string[] = [];
  readonly logs: string[] = [];
  s!: StandInTower;
  r!: StandInTower;

  // S
  dbS!: Database.Database;
  registration!: OwnRegistration;
  apiKey!: string;
  client!: CloudClient;
  list!: PeerList;
  outbox!: Outbox;
  sender!: Sender;

  // R
  dbR!: Database.Database;
  rLimits = { acceptedPerPeerPerMinute: 30, undeliveredPerPeer: 50 };
  /** While false, R's agent is busy: a message is held there, as no turn came in time. */
  rDelivers = true;
  tunnel!: TunnelClient;
  private local!: http.Server;
  readonly localRequests: string[] = [];

  constructor(limits: Partial<StandInLimits> = {}) {
    this.relay = new StandInRelay({ now: () => this.clock.now, limits });
  }

  async start(): Promise<void> {
    await this.relay.start();
    const owner = this.relay.addAccount({ ownerId: 'usr_ana', ownerEmail: 'ana@example.com' });
    this.s = this.relay.addTower({ account: owner, slug: 'mbp' });
    this.r = this.relay.addTower({ account: owner, slug: 'devvm' });
    this.startS();
    await this.startR();
  }

  private tempDb(name: string): Database.Database {
    const dir = mkdtempSync(join(tmpdir(), `peer-pipeline-${name}-`));
    this.dirs.push(dir);
    const db = new Database(join(dir, 'global.db'));
    db.exec(GLOBAL_SCHEMA);
    setSwitch(db, 'on', T0 - MINUTE);
    return db;
  }

  private startS(): void {
    this.dbS = this.tempDb('s');
    this.registration = { serverUrl: this.relay.url, towerId: this.s.towerId, towerName: 'mbp', deregistered: false };
    this.apiKey = this.s.apiKey;
    const log = (level: string, message: string) => this.logs.push(`S ${level} ${message}`);
    this.client = new CloudClient({
      registration: () => ({ serverUrl: this.registration.serverUrl, apiKey: this.apiKey }),
      relayStated: () => this.list.relayStated(),
      now: () => this.clock.now,
      timers: this.clock.timers,
      log,
    });
    this.list = new PeerList({
      db: () => this.dbS,
      now: () => this.clock.now,
      client: this.client,
      registration: () => this.registration,
      adoptOwnName: () => {},
      log,
    });
    this.restartOutbox();
  }

  /** A new outbox and sender over S's database: what a Tower restart leaves. */
  restartOutbox(): void {
    this.outbox?.stop();
    const log = (level: string, message: string) => this.logs.push(`S ${level} ${message}`);
    this.outbox = new Outbox({
      db: () => this.dbS,
      now: () => this.clock.now,
      timers: this.clock.timers,
      client: this.client,
      list: this.list,
      registration: () => this.registration,
      log,
    });
    this.sender = new Sender({
      db: () => this.dbS,
      now: () => this.clock.now,
      registration: () => this.registration,
      list: this.list,
      outbox: this.outbox,
      limits: () => ({ waitingPerPeer: 50 }),
      log,
    });
  }

  private async startR(): Promise<void> {
    this.dbR = this.tempDb('r');
    store.putGrant(this.dbR, { peerTowerId: this.s.towerId, scope: 'front-door', workspacePath: CODEV, architect: null, mode: 'deliver' }, T0);
    const world: GrantWorld = { registered: [{ workspacePath: CODEV, explicitName: null }], running: [CODEV], architectsOf: () => ['main'] };
    const receiver = createReceiver({
      db: () => this.dbR,
      now: () => this.clock.now,
      world: () => world,
      limits: () => this.rLimits,
      resolveRecipient: (address): RecipientLookup =>
        address.workspace === 'codev' && address.kind === 'architect' && (address.name ?? 'main') === 'main'
          ? { found: true, recipient: { workspacePath: CODEV, kind: 'architect', name: 'main' } }
          : { found: false, reason: 'no-such-agent' },
      deliverWithin: async (workspacePath, toAgent) => {
        if (!this.rDelivers) return { started: false };
        for (const row of mailbox.findHeldForAgent(this.dbR, workspacePath, toAgent, this.clock.now)) {
          mailbox.markDelivered(this.dbR, row.id, this.clock.now);
        }
        return { started: true };
      },
      onHeldChanged: () => {},
      log: (level, message) => this.logs.push(`R ${level} ${message}`),
    });
    this.local = http.createServer((req, res) => {
      this.localRequests.push(String(req.url));
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => this.local.listen(0, '127.0.0.1', resolve));
    this.tunnel = new TunnelClient({
      serverUrl: this.relay.url,
      apiKey: this.r.apiKey,
      towerId: this.r.towerId,
      localPort: (this.local.address() as AddressInfo).port,
      peer: { remoteMessaging: () => 'on', onVerifiedRequest: receiver, onEntryEvent: () => {}, now: () => this.clock.now },
    });
    this.tunnel.connect();
    const up = await waitFor(async () => this.tunnel.getState() === 'connected' && this.relay.session(this.r.towerId) !== null, 10_000, 10);
    if (!up) throw new Error('the tunnel never came up');
  }

  async stop(): Promise<void> {
    this.outbox?.stop();
    this.tunnel?.disconnect();
    await this.relay.stop();
    if (this.local) {
      this.local.closeAllConnections();
      await new Promise<void>((resolve) => this.local.close(() => resolve()));
    }
    this.dbS?.close();
    this.dbR?.close();
    for (const dir of this.dirs) rmSync(dir, { recursive: true, force: true });
  }

  /** A send from S's main architect to R's front door. */
  send(body = 'CI is green on the tunnel branch'): Promise<PeerSendResult> {
    const request: PeerSendRequest = {
      to: { tower: 'devvm', workspace: 'codev', kind: 'architect' } as AgentAddress,
      body,
      options: { raw: false, interrupt: false, noEnter: false, delay: false },
      from: { workspacePath: CODEV, agent: 'main', address: { workspace: 'codev', kind: 'architect', name: 'main' }, isBuilder: false },
    };
    return this.sender.send(request);
  }

  /** Move the clock on, then let every relay call it sets off (and those after) finish. */
  async advance(ms: number): Promise<void> {
    this.clock.advance(ms);
    await this.outbox.settled();
  }

  /** Every message relay call S made, oldest first, by message id. */
  relayCalls(): string[] {
    return this.relay.calls.filter((c) => c.route === 'relay').map((c) => c.requestId as string);
  }

  /** Message ids in the order R forwarded and answered them, each once. */
  forwardedOrder(): string[] {
    const seen: string[] = [];
    for (const c of this.relay.calls) {
      if (c.route !== 'relay' || c.answer !== 'receiver' || c.requestId === undefined) continue;
      if (!seen.includes(c.requestId)) seen.push(c.requestId);
    }
    return seen;
  }

  outboxRows(): store.PeerOutboxRow[] {
    return (this.dbS.prepare('SELECT message_id FROM peer_outbox ORDER BY seq').all() as Array<{ message_id: string }>).map(
      (r) => store.getOutbox(this.dbS, r.message_id) as store.PeerOutboxRow,
    );
  }

  /** The mailbox rows R stored, oldest first. */
  rMail(): Array<{ id: string; status: string; message: string }> {
    return this.dbR.prepare('SELECT id, status, body AS message FROM mailbox ORDER BY rowid').all() as never;
  }
}

let p: Pipeline | null = null;

async function pipeline(limits: Partial<StandInLimits> = {}): Promise<Pipeline> {
  p = new Pipeline(limits);
  await p.start();
  return p;
}

afterEach(async () => {
  await p?.stop();
  p = null;
});

/** Queue `n` messages while R is offline: the first is held after its call, the rest behind it. */
async function backlog(t: Pipeline, n: number): Promise<string[]> {
  t.relay.setOffline(t.r.towerId, true);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const result = await t.send(`message ${i}`);
    expect(result).toMatchObject({ outcome: 'held', where: 'this-tower', reason: 'tower-offline', ahead: i });
    ids.push((result as { messageId: string }).messageId);
  }
  expect(t.relayCalls()).toHaveLength(1);
  t.relay.setOffline(t.r.towerId, false);
  return ids;
}

// ===========================================================================
// A backlog, against each limit
// ===========================================================================

describe('a backlog of held mail', () => {
  it("drains in order against C's per-pair limit, none refused; this Tower's own cap holds it at 50", async () => {
    const t = await pipeline();
    const ids = await backlog(t, 50);
    expect(await t.send('one too many')).toMatchObject({ outcome: 'refused', by: 'this-tower', reason: 'rate-limited' });

    // The first retry, 5 seconds on. C counts a pair's call whatever follows it (step 6), so
    // the call that found R offline took one of this minute's 30: 29 go, then a 429.
    await t.advance(5 * SECOND);
    let rows = t.outboxRows();
    expect(rows.filter((r) => r.state === 'accepted')).toHaveLength(29);
    expect(rows.filter((r) => r.state === 'held')[0]).toMatchObject({ lastReason: 'rate-limited', nextAttemptAt: T0 + MINUTE });
    expect(t.relay.calls.filter((c) => c.status === 429)).toHaveLength(1);

    // The next minute, after C's retryAfterSec: the rest.
    await t.advance(T0 + MINUTE - t.clock.now);
    rows = t.outboxRows();
    expect(rows.map((r) => r.state)).toEqual(Array.from({ length: 50 }, () => 'accepted'));
    expect(t.forwardedOrder()).toEqual(ids);
    expect(t.rMail().map((m) => m.message)).toEqual(ids.map((_, i) => `message ${i}`));
    expect(t.relay.inFlight(t.s.towerId, t.r.towerId).max).toBe(1);
  }, 30_000);

  it("drains in order against R's own limit with C's raised, none refused", async () => {
    const t = await pipeline({ messagesPerPairPerMinute: 1000, messagesPerTowerPerMinute: 1000 });
    const ids = await backlog(t, 50);
    await t.advance(5 * SECOND);
    let rows = t.outboxRows();
    expect(rows.filter((r) => r.state === 'accepted')).toHaveLength(30);
    // C passes R's answer through as it came; its own log names no reason for it.
    const refusal = t.relay.calls.find(
      (c) => c.answer === 'receiver' && c.forward?.answer?.body.toString('utf8').includes('"rate-limited"') === true,
    );
    expect(refusal).toMatchObject({ status: 200, outcome: 'refused' });
    expect(JSON.parse(refusal!.forward!.answer!.body.toString('utf8'))).toMatchObject({ reason: 'rate-limited', retryAfterSec: 55 });
    expect(rows.find((r) => r.state === 'held')).toMatchObject({ lastReason: 'rate-limited', nextAttemptAt: T0 + MINUTE });
    await t.advance(T0 + MINUTE - t.clock.now);
    rows = t.outboxRows();
    expect(rows.every((r) => r.state === 'accepted')).toBe(true);
    expect(t.forwardedOrder()).toEqual(ids);
    expect(t.rMail()).toHaveLength(50);
  }, 30_000);

  it("C's ceiling on every call from a Tower is a 429 like any other: held mail waits it out", async () => {
    // The listing and the first (offline) call count as well: two of six.
    const t = await pipeline({ peerRoutesPerTowerPerMinute: 6 });
    const ids = await backlog(t, 6);
    await t.advance(5 * SECOND);
    expect(t.outboxRows().map((r) => r.state)).toEqual(['accepted', 'accepted', 'accepted', 'accepted', 'held', 'held']);
    expect(t.outboxRows()[4]).toMatchObject({ lastReason: 'rate-limited' });
    await t.advance(T0 + MINUTE - t.clock.now);
    expect(t.outboxRows().every((r) => r.state === 'accepted')).toBe(true);
    expect(t.forwardedOrder()).toEqual(ids);
  }, 30_000);
});

// ===========================================================================
// A fresh send refused for rate
// ===========================================================================

describe('a fresh send refused for rate', () => {
  it('by C: it ends refused, and the next minute sends again', async () => {
    const t = await pipeline({ messagesPerPairPerMinute: 3 });
    for (let i = 0; i < 3; i++) expect(await t.send()).toMatchObject({ outcome: 'delivered' });
    const refused = await t.send();
    expect(refused).toMatchObject({ outcome: 'refused', by: 'cloud', reason: 'rate-limited', retryAfterSec: 60 });
    expect(store.getOutbox(t.dbS, (refused as { messageId: string }).messageId)).toMatchObject({ state: 'refused', lastReason: 'rate-limited' });
    await t.advance(MINUTE);
    expect(await t.send()).toMatchObject({ outcome: 'delivered' });
    expect(t.rMail()).toHaveLength(4);
  });

  it('by R: it ends refused, with R\'s retryAfterSec', async () => {
    const t = await pipeline({ messagesPerPairPerMinute: 1000 });
    t.rLimits = { ...t.rLimits, acceptedPerPeerPerMinute: 3 };
    for (let i = 0; i < 3; i++) await t.send();
    await t.advance(20 * SECOND);
    expect(await t.send()).toMatchObject({ outcome: 'refused', by: 'peer', reason: 'rate-limited', retryAfterSec: 40 });
    expect(t.outboxRows().map((r) => r.state)).toEqual(['accepted', 'accepted', 'accepted', 'refused']);
  });

  it("by C's ceiling: refused too", async () => {
    const t = await pipeline({ peerRoutesPerTowerPerMinute: 3 });
    // The listing, then two sends; the third call is over the ceiling.
    expect(await t.send()).toMatchObject({ outcome: 'delivered' });
    expect(await t.send()).toMatchObject({ outcome: 'delivered' });
    expect(await t.send()).toMatchObject({ outcome: 'refused', by: 'cloud', reason: 'rate-limited' });
  });
});

// ===========================================================================
// Order, and one in flight
// ===========================================================================

describe('one relay call in flight per peer', () => {
  it('twenty sends at once go in acceptance order, never two in flight', async () => {
    const t = await pipeline();
    // C holds each answer a little, so calls S let overlap would be seen together.
    t.relay.injectFault({ kind: 'answer-delay', ms: 15 });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => t.send(`at once ${i}`)));
    expect(results.every((r) => r.outcome === 'delivered')).toBe(true);
    const order = t.outboxRows().map((r) => r.messageId);
    expect(t.relayCalls()).toEqual(order);
    expect(t.relay.inFlight(t.s.towerId, t.r.towerId).max).toBe(1);
    expect(results.map((r) => (r as { messageId: string }).messageId).sort()).toEqual([...order].sort());
  }, 30_000);
});

// ===========================================================================
// A lost answer
// ===========================================================================

describe('an answer lost after R accepted', () => {
  it('the message is held here; the retry is told duplicate: true and resolves it as delivered, stored once at R', async () => {
    const t = await pipeline();
    t.relay.injectFault({ kind: 'answer-late' }, 1);
    const first = await t.send();
    expect(first).toMatchObject({ outcome: 'held', where: 'this-tower', reason: 'no-answer' });
    const id = (first as { messageId: string }).messageId;
    expect(t.rMail()).toMatchObject([{ status: 'delivered' }]);

    await t.advance(5 * SECOND);
    expect(store.getOutbox(t.dbS, id)).toMatchObject({ state: 'accepted', lastOutcome: 'delivered', attempts: 2 });
    const retried = t.relay.calls.filter((c) => c.route === 'relay');
    expect(retried.map((c) => [c.requestId, c.status])).toEqual([
      [id, 504],
      [id, 200],
    ]);
    expect(JSON.parse(retried[1].forward!.answer!.body.toString('utf8'))).toMatchObject({ outcome: 'delivered', duplicate: true });
    expect(t.rMail()).toHaveLength(1);
  });

  it('a message held at R and then lost is the same: the duplicate reports it still held', async () => {
    const t = await pipeline();
    t.rDelivers = false;
    t.relay.injectFault({ kind: 'answer-late' }, 1);
    const first = await t.send();
    await t.advance(5 * SECOND);
    expect(store.getOutbox(t.dbS, (first as { messageId: string }).messageId)).toMatchObject({ state: 'accepted', lastOutcome: 'held' });
    expect(t.rMail()).toMatchObject([{ status: 'held' }]);
  });
});

// ===========================================================================
// A restart
// ===========================================================================

describe('a restart', () => {
  it("resumes S's queue from its rows, in order, one at a time", async () => {
    const t = await pipeline();
    const ids = await backlog(t, 4);
    // S's Tower stops before the first retry, and starts again over the same database.
    t.restartOutbox();
    t.outbox.start();
    await t.advance(5 * SECOND);
    expect(t.outboxRows().map((r) => r.state)).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
    expect(t.forwardedOrder()).toEqual(ids);
    expect(t.relay.inFlight(t.s.towerId, t.r.towerId).max).toBe(1);
  });
});

// ===========================================================================
// Not registered
// ===========================================================================

describe('not registered (C12)', () => {
  it('a registration marked deregistered: refused here, and no call is made', async () => {
    const t = await pipeline();
    t.registration = { ...t.registration, deregistered: true };
    expect(await t.send()).toMatchObject({ outcome: 'refused', by: 'this-tower', reason: 'not-registered' });
    expect(t.relay.calls.filter((c) => c.route === 'relay' || c.route === 'listing')).toEqual([]);
  });

  it("a key C rejects with 401: refused the same way, as C's answer", async () => {
    const t = await pipeline();
    expect(await t.send()).toMatchObject({ outcome: 'delivered' });
    t.relay.rotateKey(t.s.towerId);
    const result = await t.send();
    expect(result).toMatchObject({ outcome: 'refused', by: 'cloud', reason: 'not-registered' });
    expect((result as { message: string }).message).toMatch(/afx tower connect --reauth/);
    expect(store.getOutbox(t.dbS, (result as { messageId: string }).messageId)).toMatchObject({ state: 'refused', lastReason: 'unauthenticated' });
  });
});

// ===========================================================================
// What stays on each side
// ===========================================================================

describe('what each side records', () => {
  it("S records each relay call, R records what it accepted; neither holds the body in its record, and nothing reaches R's local listener", async () => {
    const t = await pipeline();
    t.relay.injectFault({ kind: 'answer-late' }, 1);
    await t.send('the body stays in the mailbox only');
    await t.advance(5 * SECOND);
    const sent = store.listRecords(t.dbS).reverse();
    expect(sent.map((r) => [r.direction, r.outcome, r.reason])).toEqual([
      ['outbound', 'unavailable', 'no-answer'],
      ['outbound', 'delivered', null],
    ]);
    expect(sent[0]).toMatchObject({ peerSlug: 'devvm', toAddress: 'afx://devvm/codev:architect', fromAddress: 'codev:architect:main' });
    const received = store.listRecords(t.dbR);
    expect(received.length).toBeGreaterThan(0);
    expect(JSON.stringify([sent, received])).not.toContain('the body stays');
    expect(t.localRequests).toEqual([]);
  });
});
