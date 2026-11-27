/**
 * The sending Tower's outbox (Spec 1967, plan phase 8, layer A): the per-peer queue over
 * `peer_outbox`, on an in-memory global database, an injected clock and a scripted relay.
 * Every answer is read by the contract's own reader (`classifyRelayAnswer`) from the bytes
 * and status the cloud would send, so what is scripted is the wire, not the outbox's input.
 *
 * - the back-off's shape, and a listing that shows the peer back bringing the retry forward;
 * - how each answer resolves the row (section 6's table), a lost answer then a duplicate;
 * - rate-limited mail (C4): held mail waits, a fresh send ends refused;
 * - one relay call in flight per peer, in acceptance order; a send behind held mail;
 * - the 30-day lifetime;
 * - the runs of not-verified and cloud-error, and the clock mark (G10, G12, G15);
 * - a queue rebuilt from its durable rows (a restart);
 * - an answer under a registration since replaced; held mail while it may not leave;
 * - the record of every relay call.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { PEER_MESSAGE_LIFETIME_MS, type PeerCloudRelay, type PeerRequestKind } from '@cluesmith/codev-types';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import { classifyRelayAnswer, type ClassifiedAnswer } from '../peer/contract.js';
import type { RelayCall, RelayRequest } from '../peer/cloud-client.js';
import type { OwnRegistration, PeerListRefresh } from '../peer/peer-list.js';
import { Outbox, backoffDelayMs, decide, readPeerMarks, PEER_RUN_MARK_LENGTH, type FirstAnswer } from '../peer/outbox.js';
import * as store from '../peer/store.js';
import { setSwitch } from '../peer/switch.js';
import { ManualClock } from './helpers/peer-cloud-fixtures.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
const T0 = Date.UTC(2026, 10, 21, 3, 34, 47, 452);
const SELF = '01JMBP000000000000000000AA';
const DEVVM = '01JDEVVM0000000000000000AA';
const STUDIO = '01JSTUDIO000000000000000AA';
const WS = '/work/codev';

// ===========================================================================
// Answers, as the wire carries them
// ===========================================================================

const utf8 = (text: string) => new TextEncoder().encode(text);

function read(call: Parameters<typeof classifyRelayAnswer>[0], relayStated = true, kind: PeerRequestKind = 'message'): ClassifiedAnswer {
  return classifyRelayAnswer(call, { kind, relayStated });
}

/** R's answer (status 200). */
function fromR(body: Record<string, unknown>, outcomeHeader = body.outcome as string): ClassifiedAnswer {
  return read({ answered: true, status: 200, contentType: 'application/json', outcomeHeader, body: utf8(JSON.stringify({ v: 1, ...body })) });
}

/** C's answer, in the contract's shape. */
function fromC(status: number, body: Record<string, unknown>): ClassifiedAnswer {
  return read({
    answered: true,
    status,
    contentType: 'application/json',
    outcomeHeader: body.outcome as string,
    body: utf8(JSON.stringify({ v: 1, ...body })),
  });
}

/** Something in front of C, with no body. */
function bodyless(status: number, relayStated = true): ClassifiedAnswer {
  return read({ answered: true, status, contentType: 'text/html', outcomeHeader: undefined, body: utf8('<html>nope</html>') }, relayStated);
}

const A = {
  delivered: () => fromR({ outcome: 'delivered' }),
  held: (reason = 'busy') => fromR({ outcome: 'held', reason }),
  refused: (reason: string, extra: Record<string, unknown> = {}) => fromR({ outcome: 'refused', reason, ...extra }),
  notVerified: () => fromR({ outcome: 'not-verified' }),
  offline: () => fromC(503, { outcome: 'unavailable', reason: 'tower-offline' }),
  noAnswer: () => fromC(504, { outcome: 'unavailable', reason: 'no-answer' }),
  cloudError: () => fromC(500, { outcome: 'unavailable', reason: 'cloud-error' }),
  cloudRateLimited: (retryAfterSec?: number) =>
    fromC(429, { outcome: 'refused', reason: 'rate-limited', ...(retryAfterSec === undefined ? {} : { retryAfterSec }) }),
  nothing: () => read({ answered: false }),
};

// ===========================================================================
// The fixture
// ===========================================================================

interface Call {
  request: RelayRequest;
  at: number;
  answered: boolean;
  /** Answer it; until then the call is in flight. */
  answer(answer: ClassifiedAnswer | RelayCall): void;
}

class Fixture {
  readonly db = new Database(':memory:');
  readonly clock = new ManualClock(T0);
  registration: OwnRegistration | null = { serverUrl: 'https://cloud.example', towerId: SELF, towerName: 'mbp', deregistered: false };
  relayState: PeerCloudRelay = { state: 'available', why: null };
  /** What the listing at the holding budget gives the outbox. */
  listing: PeerListRefresh = { fresh: false, problem: 'recent', retryAfterSec: null, listing: { refreshedAt: null, relayProtocols: [1], limits: null, towers: [] } };
  readonly listingPurposes: string[] = [];
  readonly calls: Call[] = [];
  /** Scripted answers per peer, used in order; with none left, a call waits for the test. */
  readonly script = new Map<string, Array<ClassifiedAnswer | RelayCall>>();
  inFlight = 0;
  maxInFlight = 0;
  noRelayNoted = 0;
  /** Run while a call is out, as the registration might change under it. */
  duringCall: (() => void) | null = null;
  readonly logs: string[] = [];
  outbox: Outbox;

  constructor() {
    this.db.exec(GLOBAL_SCHEMA);
    setSwitch(this.db, 'on', T0 - DAY);
    this.outbox = this.newOutbox();
  }

  newOutbox(): Outbox {
    return new Outbox({
      db: () => this.db,
      now: () => this.clock.now,
      timers: this.clock.timers,
      client: { relay: (request) => this.relay(request) },
      list: {
        relay: () => this.relayState,
        noteNoRelay: () => {
          this.noRelayNoted++;
        },
        refresh: async (purpose) => {
          this.listingPurposes.push(purpose ?? 'on-demand');
          return this.listing;
        },
      },
      registration: () => this.registration,
      log: (level, message) => this.logs.push(`${level} ${message}`),
    });
  }

  private relay(request: RelayRequest): Promise<RelayCall> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    return new Promise<RelayCall>((resolve) => {
      const call: Call = {
        request,
        at: this.clock.now,
        answered: false,
        answer: (answer) => {
          if (call.answered) throw new Error('a call was answered twice');
          call.answered = true;
          this.duringCall?.();
          this.inFlight--;
          resolve('called' in answer ? answer : { called: true, answer });
        },
      };
      this.calls.push(call);
      const next = this.script.get(request.toTowerId)?.shift();
      if (next !== undefined) queueMicrotask(() => call.answer(next));
    });
  }

  answers(peer: string, ...answers: Array<ClassifiedAnswer | RelayCall>): void {
    this.script.set(peer, [...(this.script.get(peer) ?? []), ...answers]);
  }

  /** The call for `peer` waiting for the test to answer it, if any. */
  pending(peer = DEVVM): Call | undefined {
    return this.calls.find((c) => c.request.toTowerId === peer && !c.answered);
  }

  /** Answer the call waiting for `peer`; there must be one. */
  respond(answer: ClassifiedAnswer, peer = DEVVM): void {
    const call = this.pending(peer);
    if (call === undefined) throw new Error(`no call to ${peer} is waiting`);
    call.answer(answer);
  }

  /** Persist a message for `peer`, as the sender does, without queueing it. */
  insert(peer = DEVVM, sentAt = this.clock.now): store.PeerOutboxRow {
    return store.insertOutbox(
      this.db,
      {
        messageId: randomUUID(),
        peerTowerId: peer,
        toAddress: `afx://${peer === DEVVM ? 'devvm' : 'studio'}/codev:architect:local`,
        fromAddress: 'codev:architect:main',
        payload: utf8(`{"sentAt":${sentAt},"n":"${randomUUID()}"}`),
        sentAt,
        fromWorkspacePath: WS,
        fromAgent: 'architect:main',
      },
      this.clock.now,
    );
  }

  /** A fresh send: persisted and queued, its sender waiting for the first answer. */
  send(peer = DEVVM): { row: store.PeerOutboxRow; first: Promise<FirstAnswer> } {
    const row = this.insert(peer);
    return { row, first: this.outbox.enqueue(row) };
  }

  row(messageId: string): store.PeerOutboxRow {
    const row = store.getOutbox(this.db, messageId);
    if (row === null) throw new Error(`no row ${messageId}`);
    return row;
  }

  /** Move the clock on and let every call it starts finish. */
  async advance(ms: number): Promise<void> {
    this.clock.advance(ms);
    await this.settle();
  }

  /**
   * Let every answered call, and the look at the queue after it, finish. Scripted answers
   * come as microtasks and every timer is the manual clock's, so a few turns of the event
   * loop drain all of it; a call the test has yet to answer is left in flight.
   */
  async settle(): Promise<void> {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  /** When each call for `peer` was made, relative to T0. */
  callTimes(peer = DEVVM): number[] {
    return this.calls.filter((c) => c.request.toTowerId === peer).map((c) => c.at - T0);
  }
}

let f: Fixture;

beforeEach(() => {
  f = new Fixture();
});

afterEach(() => {
  f.outbox.stop();
  f.db.close();
});

// ===========================================================================
// The back-off
// ===========================================================================

describe('the back-off', () => {
  it('starts at 5 seconds, doubles and is capped at 2 minutes; the base scales the whole curve', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffDelayMs(n) / SECOND)).toEqual([5, 10, 20, 40, 80, 120, 120, 120]);
    expect([1, 2, 6, 7].map((n) => backoffDelayMs(n, 10))).toEqual([10, 20, 240, 240]);
    expect(() => backoffDelayMs(0)).toThrow(/at least one attempt/);
  });

  it('retries a held message on that curve, whatever happens to be listed', async () => {
    f.answers(DEVVM, ...Array.from({ length: 8 }, () => A.offline()));
    f.insert();
    f.outbox.start();
    await f.settle();
    for (const wait of [5, 10, 20, 40, 80, 120, 120]) await f.advance(wait * SECOND);
    const times = f.callTimes();
    expect(times.map((t, i) => (i === 0 ? t : t - times[i - 1])).map((ms) => ms / SECOND)).toEqual([0, 5, 10, 20, 40, 80, 120, 120]);
  });

  it('a listing fetched after a tower-offline answer that shows the peer online brings the retry forward', async () => {
    f.answers(DEVVM, ...Array.from({ length: 6 }, () => A.offline()), A.delivered());
    const row = f.insert();
    f.outbox.start();
    await f.settle();
    for (const wait of [5, 10, 20, 40, 80]) await f.advance(wait * SECOND);
    expect(f.callTimes()).toHaveLength(6);
    const lastAnswer = f.row(row.messageId).updatedAt;
    // The next retry is two minutes away. 30 seconds on, the listing shows the peer back.
    f.listing = {
      fresh: true,
      problem: null,
      retryAfterSec: null,
      listing: { refreshedAt: lastAnswer + 10 * SECOND, relayProtocols: [1], limits: null, towers: [tower(DEVVM, 'devvm', true)] },
    };
    await f.advance(30 * SECOND);
    expect(f.listingPurposes).toContain('holding');
    expect(f.callTimes()).toHaveLength(7);
    expect(f.callTimes()[6] - f.callTimes()[5]).toBe(30 * SECOND);
    expect(f.row(row.messageId).state).toBe('accepted');
  });

  it('a listing does not bring the retry forward when it is older than the answer, shows the peer offline, or the peer was not gone', async () => {
    // Older than the last answer.
    f.answers(DEVVM, ...Array.from({ length: 7 }, () => A.offline()));
    const row = f.insert();
    f.outbox.start();
    await f.settle();
    for (const wait of [5, 10, 20, 40, 80]) await f.advance(wait * SECOND);
    const lastAnswer = f.row(row.messageId).updatedAt;
    f.listing = { fresh: false, problem: 'recent', retryAfterSec: null, listing: { refreshedAt: lastAnswer - 1, relayProtocols: [1], limits: null, towers: [tower(DEVVM, 'devvm', true)] } };
    await f.advance(30 * SECOND);
    expect(f.callTimes()).toHaveLength(6);
    // Newer, but the peer listed offline.
    f.listing = { fresh: true, problem: null, retryAfterSec: null, listing: { refreshedAt: lastAnswer + 1, relayProtocols: [1], limits: null, towers: [tower(DEVVM, 'devvm', false)] } };
    await f.advance(30 * SECOND);
    expect(f.callTimes()).toHaveLength(6);
    await f.advance(60 * SECOND);
    expect(f.callTimes()).toHaveLength(7);

    // `no-answer`: C had a session for the peer, so "online" adds nothing.
    const g = new Fixture();
    g.answers(DEVVM, ...Array.from({ length: 7 }, () => A.noAnswer()));
    const other = g.insert();
    g.outbox.start();
    await g.settle();
    for (const wait of [5, 10, 20, 40, 80]) await g.advance(wait * SECOND);
    g.listing = {
      fresh: true,
      problem: null,
      retryAfterSec: null,
      listing: { refreshedAt: g.row(other.messageId).updatedAt + 1, relayProtocols: [1], limits: null, towers: [tower(DEVVM, 'devvm', true)] },
    };
    await g.advance(30 * SECOND);
    expect(g.callTimes()).toHaveLength(6);
    expect(g.listingPurposes).toEqual([]);
    g.outbox.stop();
  });
});

function tower(towerId: string, slug: string, online: boolean) {
  return { towerId, slug, online, protocols: [1], remoteMessaging: 'on' as const };
}

// ===========================================================================
// How S resolves its row
// ===========================================================================

describe('how each answer resolves the row (section 6)', () => {
  const ended: Array<[string, () => ClassifiedAnswer, store.PeerOutboxState, string | null]> = [
    ['delivered', A.delivered, 'accepted', null],
    ['held at the recipient, busy', () => A.held('busy'), 'accepted', 'busy'],
    ['held at the recipient for release', () => A.held('held-for-release'), 'accepted', 'held-for-release'],
    ['a duplicate, delivered', () => fromR({ outcome: 'delivered', duplicate: true }), 'accepted', null],
    ['a duplicate, held', () => fromR({ outcome: 'held', reason: 'no-live-pty', duplicate: true }), 'accepted', 'no-live-pty'],
    ['a duplicate, dismissed', () => fromR({ outcome: 'refused', reason: 'dismissed', duplicate: true }), 'refused', 'dismissed'],
    ["R's refusal", () => A.refused('no-grant', { detail: 'mbp has no grant here' }), 'refused', 'no-grant'],
    ["R's clock-skew", () => A.refused('clock-skew'), 'refused', 'clock-skew'],
    ["R's unsupported version", () => A.refused('unsupported-version', { supported: [2] }), 'refused', 'unsupported-version'],
    ["C's 400", () => fromC(400, { outcome: 'refused', reason: 'malformed' }), 'refused', 'malformed'],
    ["C's 401", () => fromC(401, { outcome: 'refused', reason: 'unauthenticated' }), 'refused', 'unauthenticated'],
    ["C's 404", () => fromC(404, { outcome: 'refused', reason: 'unknown-tower' }), 'refused', 'unknown-tower'],
    ["C's 409", () => fromC(409, { outcome: 'refused', reason: 'peer-unsupported' }), 'refused', 'peer-unsupported'],
    ["C's 413", () => fromC(413, { outcome: 'refused', reason: 'too-large' }), 'refused', 'too-large'],
    ['a 404 without the body, from a cloud that never stated a relay', () => bodyless(404, false), 'refused', 'no-relay'],
  ];

  for (const [name, answer, state, reason] of ended) {
    it(`${name}: ${state}, and never sent again`, async () => {
      f.answers(DEVVM, answer());
      const row = f.insert();
      f.outbox.start();
      await f.settle();
      const after = f.row(row.messageId);
      expect(after).toMatchObject({ state, lastReason: reason, attempts: 1, nextAttemptAt: null });
      expect(after.resolvedAt).toBe(T0);
      await f.advance(10 * MINUTE);
      expect(f.calls).toHaveLength(1);
    });
  }

  it('a 404 without the body from an old cloud tells the peer list it has no relay', async () => {
    f.answers(DEVVM, bodyless(404, false));
    f.insert();
    f.outbox.start();
    await f.settle();
    expect(f.noRelayNoted).toBe(1);
  });

  const held: Array<[string, () => ClassifiedAnswer, string]> = [
    ['not-verified', A.notVerified, 'not-verified'],
    ["C's 500 cloud-error", A.cloudError, 'cloud-error'],
    ["C's 502 tower-error", () => fromC(502, { outcome: 'unavailable', reason: 'tower-error' }), 'tower-error'],
    ["C's 503 tower-offline", A.offline, 'tower-offline'],
    ["C's 504 no-answer", A.noAnswer, 'no-answer'],
    ['no answer at all', A.nothing, 'cloud-unreachable'],
    ['a 401 without the body, once a relay was stated', () => bodyless(401), 'cloud-unreachable'],
    ['a 403 without the body', () => bodyless(403), 'cloud-unreachable'],
    ['a 404 without the body', () => bodyless(404), 'cloud-unreachable'],
    ['a 429 without the body', () => bodyless(429), 'cloud-unreachable'],
    ['a 502 without the body', () => bodyless(502), 'cloud-unreachable'],
    ['a 200 whose body claims another outcome than its header', () => fromR({ outcome: 'delivered' }, 'held'), 'tower-error'],
    ['a non-200 whose body claims delivered', () => fromC(503, { outcome: 'delivered' }), 'cloud-unreachable'],
  ];

  for (const [name, answer, reason] of held) {
    it(`${name}: still held here, retried with the same id and bytes`, async () => {
      f.answers(DEVVM, answer(), A.delivered());
      const row = f.insert();
      f.outbox.start();
      await f.settle();
      expect(f.row(row.messageId)).toMatchObject({ state: 'held', attempts: 1, nextAttemptAt: T0 + 5 * SECOND });
      expect(f.row(row.messageId).lastReason ?? f.row(row.messageId).lastOutcome).toBe(reason);
      await f.advance(5 * SECOND);
      expect(f.calls).toHaveLength(2);
      expect(f.calls[1].request.requestId).toBe(row.messageId);
      expect(Buffer.from(f.calls[1].request.payload).equals(Buffer.from(f.calls[0].request.payload))).toBe(true);
      expect(f.row(row.messageId).state).toBe('accepted');
    });
  }

  it('a lost answer followed by duplicate: true resolves the row as the state reported', async () => {
    f.answers(DEVVM, A.noAnswer(), fromR({ outcome: 'held', reason: 'no-live-pty', duplicate: true }));
    const { row, first } = f.send();
    await f.settle();
    expect(await first).toMatchObject({ kind: 'held', reason: 'no-answer' });
    await f.advance(5 * SECOND);
    expect(f.row(row.messageId)).toMatchObject({ state: 'accepted', lastOutcome: 'held', lastReason: 'no-live-pty', attempts: 2 });
  });

  it('a fresh send is told its first answer: accepted, refused, or held here', async () => {
    f.answers(DEVVM, A.delivered(), A.refused('no-such-agent'), A.offline());
    const a = f.send();
    await f.settle();
    const b = f.send();
    await f.settle();
    const c = f.send();
    await f.settle();
    expect(await a.first).toMatchObject({ kind: 'resolved', state: 'accepted', answer: { outcome: 'delivered' } });
    expect(await b.first).toMatchObject({ kind: 'resolved', state: 'refused', answer: { reason: 'no-such-agent' } });
    expect(await c.first).toMatchObject({ kind: 'held', reason: 'tower-offline', ahead: 0, answer: { reason: 'tower-offline' } });
  });

  it('the table is total for a message, and has no place for a discovery answer', () => {
    expect(decide(A.delivered(), false)).toEqual({ act: 'accept', heldReason: null });
    expect(decide(A.held('busy'), true)).toEqual({ act: 'accept', heldReason: 'busy' });
    const answered = read(
      { answered: true, status: 200, contentType: 'application/json', outcomeHeader: 'answered', body: utf8('{"v":1,"outcome":"answered","truncated":false,"addresses":[]}') },
      true,
      'query',
    );
    expect(() => decide(answered, false)).toThrow(/discovery answer/);
  });
});

// ===========================================================================
// Rate-limited mail (C4)
// ===========================================================================

describe('rate-limited mail (C4)', () => {
  it("held mail stays held: the queue waits the cloud's retryAfterSec, then retries the same row first", async () => {
    f.answers(DEVVM, A.offline());
    const first = f.insert();
    const second = f.insert();
    f.outbox.start();
    await f.settle();
    f.answers(DEVVM, A.cloudRateLimited(20), A.delivered(), A.delivered());
    await f.advance(5 * SECOND);
    expect(f.row(first.messageId)).toMatchObject({ state: 'held', lastReason: 'rate-limited', nextAttemptAt: T0 + 25 * SECOND });
    await f.advance(20 * SECOND - 1);
    expect(f.calls).toHaveLength(2);
    await f.advance(1);
    expect(f.calls.map((c) => c.request.requestId)).toEqual([first.messageId, first.messageId, first.messageId, second.messageId]);
    expect([f.row(first.messageId).state, f.row(second.messageId).state]).toEqual(['accepted', 'accepted']);
  });

  it("held mail refused for rate by R without retryAfterSec waits the next back-off interval", async () => {
    f.answers(DEVVM, A.offline(), A.offline(), A.refused('rate-limited'), A.delivered());
    const row = f.insert();
    f.outbox.start();
    await f.settle();
    await f.advance(5 * SECOND);
    await f.advance(10 * SECOND);
    // The third answer is the third held answer: the next interval is 20 seconds.
    expect(f.row(row.messageId)).toMatchObject({ state: 'held', lastReason: 'rate-limited', attempts: 3 });
    await f.advance(20 * SECOND);
    expect(f.row(row.messageId).state).toBe('accepted');
    expect(f.callTimes().map((t) => t / SECOND)).toEqual([0, 5, 15, 35]);
  });

  it('a fresh send refused for rate ends refused, from either source; the next send is still made', async () => {
    f.answers(DEVVM, A.cloudRateLimited(20), A.refused('rate-limited', { retryAfterSec: 7 }), A.delivered());
    const a = f.send();
    const b = f.send();
    const c = f.send();
    await f.settle();
    expect(await a.first).toMatchObject({ kind: 'resolved', state: 'refused', answer: { decidedBy: 'cloud', reason: 'rate-limited' } });
    expect(await b.first).toMatchObject({ kind: 'resolved', state: 'refused', answer: { decidedBy: 'receiver', reason: 'rate-limited' } });
    expect(await c.first).toMatchObject({ kind: 'resolved', state: 'accepted' });
    expect([a, b, c].map((s) => f.row(s.row.messageId).state)).toEqual(['refused', 'refused', 'accepted']);
  });

  it('a retryAfterSec of 0 is waited as one second', async () => {
    f.answers(DEVVM, A.offline(), A.cloudRateLimited(0), A.delivered());
    const row = f.insert();
    f.outbox.start();
    await f.settle();
    await f.advance(5 * SECOND);
    expect(f.row(row.messageId).nextAttemptAt).toBe(T0 + 6 * SECOND);
  });
});

// ===========================================================================
// One in flight, in order
// ===========================================================================

describe('one relay call in flight per peer, in acceptance order', () => {
  it('twenty sends queued at once are sent in acceptance order, never two in flight', async () => {
    const sends = Array.from({ length: 20 }, () => f.send());
    // Answer each call only once the test sees it, so two could overlap if the queue let them.
    for (let i = 0; i < 20; i++) {
      await f.settle();
      expect(f.inFlight).toBe(1);
      f.calls[i].answer(A.delivered());
    }
    await f.settle();
    expect(f.maxInFlight).toBe(1);
    expect(f.calls.map((c) => c.request.requestId)).toEqual(sends.map((s) => s.row.messageId));
    for (const s of sends) expect(await s.first).toMatchObject({ kind: 'resolved', state: 'accepted' });
  });

  it('two peers each have their own one call in flight', async () => {
    f.send(DEVVM);
    f.send(STUDIO);
    f.send(DEVVM);
    await f.settle();
    expect(f.calls.map((c) => c.request.toTowerId)).toEqual([DEVVM, STUDIO]);
    expect(f.maxInFlight).toBe(2);
    f.calls[0].answer(A.delivered());
    await f.settle();
    expect(f.calls.map((c) => c.request.toTowerId)).toEqual([DEVVM, STUDIO, DEVVM]);
  });

  it('a send behind held mail is told at once that it is held here, and goes after it', async () => {
    f.answers(DEVVM, A.offline());
    const head = f.send();
    await f.settle();
    expect(await head.first).toMatchObject({ kind: 'held', reason: 'tower-offline' });
    const behind = f.send();
    const third = f.send();
    expect(await behind.first).toEqual({ kind: 'held', reason: 'tower-offline', answer: null, ahead: 1 });
    expect(await third.first).toEqual({ kind: 'held', reason: 'tower-offline', answer: null, ahead: 2 });
    expect(f.calls).toHaveLength(1);
    f.answers(DEVVM, A.delivered(), A.delivered(), A.delivered());
    await f.advance(5 * SECOND);
    expect(f.calls.map((c) => c.request.requestId)).toEqual([head, head, behind, third].map((s) => s.row.messageId));
  });

  it('when an attempt leaves a row held, the sends waiting behind it are told so', async () => {
    const a = f.send();
    const b = f.send();
    const c = f.send();
    await f.settle();
    f.calls[0].answer(A.notVerified());
    await f.settle();
    expect(await a.first).toMatchObject({ kind: 'held', reason: 'not-verified', ahead: 0 });
    expect(await b.first).toEqual({ kind: 'held', reason: 'not-verified', answer: null, ahead: 1 });
    expect(await c.first).toEqual({ kind: 'held', reason: 'not-verified', answer: null, ahead: 2 });
    expect(f.calls).toHaveLength(1);
  });
});

// ===========================================================================
// The lifetime
// ===========================================================================

describe('the 30-day lifetime', () => {
  it('a row is marked expired at 30 days from sentAt and is not sent again', async () => {
    // Accepted 29 days ago, held all that time: its last day is retried at the cap.
    const sentAt = T0 - 29 * DAY;
    const end = sentAt + PEER_MESSAGE_LIFETIME_MS;
    f.answers(DEVVM, ...Array.from({ length: 24 * 30 + 10 }, () => A.offline()));
    const row = f.insert(DEVVM, sentAt);
    f.outbox.start();
    await f.settle();
    // Two minutes at a time, to just before the lifetime runs out.
    while (f.clock.now + 2 * MINUTE < end) {
      f.clock.advance(2 * MINUTE);
      await f.outbox.settled();
    }
    await f.settle();
    expect(f.row(row.messageId).state).toBe('held');
    expect(f.calls.length).toBeGreaterThan(24 * 25);
    const calls = f.calls.length;
    await f.advance(end - f.clock.now);
    expect(f.row(row.messageId)).toMatchObject({ state: 'expired', resolvedAt: end, lastReason: 'tower-offline' });
    await f.advance(DAY);
    expect(f.calls.length).toBe(calls);
  });

  it('a row behind the head expires on time while the head waits', async () => {
    f.answers(DEVVM, A.offline(), A.offline());
    const head = f.insert(DEVVM, T0);
    const old = f.insert(DEVVM, T0 - PEER_MESSAGE_LIFETIME_MS + 3 * SECOND);
    f.outbox.start();
    await f.settle();
    await f.advance(3 * SECOND);
    expect(f.row(old.messageId).state).toBe('expired');
    expect(f.row(head.messageId).state).toBe('held');
  });

  it('on start, a row already past its lifetime is expired without a call', async () => {
    const row = f.insert(DEVVM, T0 - PEER_MESSAGE_LIFETIME_MS);
    f.outbox.start();
    await f.settle();
    expect(f.row(row.messageId).state).toBe('expired');
    expect(f.calls).toHaveLength(0);
  });
});

// ===========================================================================
// Runs (G10, G12, G15)
// ===========================================================================

describe('the not-verified, cloud-error and clock marks', () => {
  /** Answer the head's call with each answer in turn, waiting out each back-off between. */
  async function answerHead(...answers: ClassifiedAnswer[]): Promise<void> {
    for (const answer of answers) {
      await f.settle();
      f.respond(answer);
      await f.settle();
      const head = store.listHeldOutbox(f.db, DEVVM)[0];
      if (head !== undefined && head.nextAttemptAt !== null) await f.advance(Math.max(0, head.nextAttemptAt - f.clock.now));
    }
  }

  it(`${PEER_RUN_MARK_LENGTH} not-verified in a row mark the peer not verifying, until any other answer`, async () => {
    f.insert();
    f.insert();
    f.outbox.start();
    await answerHead(A.notVerified(), A.notVerified(), A.notVerified(), A.notVerified());
    expect(readPeerMarks(f.db)).toEqual([]);
    await answerHead(A.notVerified());
    expect(readPeerMarks(f.db)).toMatchObject([{ peerTowerId: DEVVM, mark: 'not-verifying', run: 5 }]);
    await answerHead(A.notVerified());
    expect(readPeerMarks(f.db)).toMatchObject([{ mark: 'not-verifying', run: 6 }]);
    await answerHead(A.delivered());
    expect(readPeerMarks(f.db)).toEqual([]);
  });

  it(`${PEER_RUN_MARK_LENGTH} cloud-error in a row mark the peer cloud error, until any other answer`, async () => {
    f.insert();
    f.outbox.start();
    await answerHead(A.cloudError(), A.cloudError(), A.cloudError(), A.cloudError(), A.cloudError());
    expect(readPeerMarks(f.db)).toMatchObject([{ peerTowerId: DEVVM, mark: 'cloud-error', run: 5 }]);
    await answerHead(A.offline());
    expect(readPeerMarks(f.db)).toEqual([]);
  });

  it('a clock-skew answer marks the peer clock out of range at once, until a later message gets another answer', async () => {
    f.insert();
    f.insert();
    f.outbox.start();
    await answerHead(A.refused('clock-skew'));
    expect(readPeerMarks(f.db)).toMatchObject([{ peerTowerId: DEVVM, mark: 'clock-out-of-range', run: 1 }]);
    await answerHead(A.delivered());
    expect(readPeerMarks(f.db)).toEqual([]);
  });

  it('runs are "in a row": a different answer starts again; no answer, or one without the body, neither extends nor ends one', async () => {
    f.insert();
    f.outbox.start();
    await answerHead(A.notVerified(), A.notVerified(), A.notVerified(), A.cloudError(), A.notVerified(), A.notVerified());
    expect(readPeerMarks(f.db)).toEqual([]);
    expect(store.listPeerAnswerRuns(f.db)).toMatchObject([{ answer: 'not-verified', run: 2 }]);
    await answerHead(A.nothing(), bodyless(502), A.notVerified(), A.notVerified(), A.nothing(), A.notVerified());
    expect(readPeerMarks(f.db)).toMatchObject([{ mark: 'not-verifying', run: 5 }]);
  });

  it("marks are each peer's own, and survive a restart", async () => {
    f.insert(DEVVM);
    f.insert(STUDIO);
    f.outbox.start();
    await answerHead(A.refused('clock-skew'));
    f.respond(A.delivered(), STUDIO);
    await f.settle();
    f.outbox.stop();
    f.outbox = f.newOutbox();
    expect(readPeerMarks(f.db)).toMatchObject([{ peerTowerId: DEVVM, mark: 'clock-out-of-range' }]);
    expect(readPeerMarks(f.db, STUDIO)).toEqual([]);
  });
});

// ===========================================================================
// A restart
// ===========================================================================

describe('a queue rebuilt from its durable rows', () => {
  it('resumes in order, one at a time, each at its own due time', async () => {
    f.answers(DEVVM, A.offline());
    const rows = [f.insert(), f.insert(), f.insert()];
    f.outbox.start();
    await f.settle();
    expect(f.row(rows[0].messageId).nextAttemptAt).toBe(T0 + 5 * SECOND);
    // The Tower stops with three held; a new process, over the same database, starts.
    f.outbox.stop();
    await f.advance(MINUTE);
    expect(f.calls).toHaveLength(1);
    f.outbox = f.newOutbox();
    f.answers(DEVVM, A.delivered(), A.delivered(), A.delivered());
    f.outbox.start();
    await f.settle();
    expect(f.calls.slice(1).map((c) => c.request.requestId)).toEqual(rows.map((r) => r.messageId));
    expect(f.maxInFlight).toBe(1);
    expect(rows.map((r) => f.row(r.messageId).state)).toEqual(['accepted', 'accepted', 'accepted']);
  });

  it('a head whose retry is not yet due waits out what is left of it', async () => {
    f.answers(DEVVM, A.offline(), A.offline());
    const row = f.insert();
    f.outbox.start();
    await f.settle();
    await f.advance(5 * SECOND);
    expect(f.row(row.messageId).nextAttemptAt).toBe(T0 + 15 * SECOND);
    f.outbox.stop();
    f.outbox = f.newOutbox();
    f.answers(DEVVM, A.delivered());
    await f.advance(4 * SECOND);
    f.outbox.start();
    await f.advance(5 * SECOND);
    expect(f.calls).toHaveLength(2);
    await f.advance(1 * SECOND);
    expect(f.callTimes().map((t) => t / SECOND)).toEqual([0, 5, 15]);
  });
});

// ===========================================================================
// The registration, and when held mail may leave
// ===========================================================================

describe('the registration an answer belongs to', () => {
  it('an answer that arrives after the registration changed is not used: the row stays held and is retried', async () => {
    const { row, first } = f.send();
    f.duringCall = () => {
      f.registration = { serverUrl: 'https://other-cloud.example', towerId: SELF, towerName: 'mbp', deregistered: false };
      f.duringCall = null;
    };
    await f.settle();
    f.calls[0].answer(A.delivered());
    await f.settle();
    expect(await first).toEqual({ kind: 'held', reason: 'registration-changed', answer: null, ahead: 0 });
    expect(f.row(row.messageId)).toMatchObject({ state: 'held', lastOutcome: 'unavailable', lastReason: 'registration-changed' });
    expect(store.listPeerAnswerRuns(f.db)).toEqual([]);
    f.answers(DEVVM, A.delivered());
    await f.advance(5 * SECOND);
    expect(f.row(row.messageId).state).toBe('accepted');
  });

  it('a new key alone is the same registration: its answer is used', async () => {
    const { row } = f.send();
    f.duringCall = () => {
      f.registration = { ...(f.registration as OwnRegistration) };
    };
    await f.settle();
    f.calls[0].answer(A.delivered());
    await f.settle();
    expect(f.row(row.messageId).state).toBe('accepted');
  });
});

describe('held mail leaves only while this Tower would accept the send now', () => {
  const blocked: Array<[string, () => void, string]> = [
    ['the switch is off', () => setSwitch(f.db, 'off', f.clock.now), 'remote-off'],
    ['there is no registration', () => (f.registration = null), 'not-connected'],
    ['the registration is marked deregistered', () => (f.registration = { ...(f.registration as OwnRegistration), deregistered: true }), 'not-registered'],
    ['the cloud has no relay', () => (f.relayState = { state: 'none', why: 'stated-none' }), 'no-relay'],
  ];

  for (const [name, block, reason] of blocked) {
    it(`${name}: nothing is sent and no attempt counted; it goes once that changes`, async () => {
      f.answers(DEVVM, A.offline());
      const row = f.insert();
      f.outbox.start();
      await f.settle();
      const saved = { registration: f.registration, relay: f.relayState };
      block();
      await f.advance(10 * MINUTE);
      expect(f.calls).toHaveLength(1);
      expect(f.row(row.messageId)).toMatchObject({ state: 'held', attempts: 1 });
      expect(f.logs.some((l) => l.includes(`(${reason})`))).toBe(true);
      setSwitch(f.db, 'on', f.clock.now);
      f.registration = saved.registration;
      f.relayState = saved.relay;
      f.answers(DEVVM, A.delivered());
      f.outbox.wake();
      await f.settle();
      expect(f.row(row.messageId).state).toBe('accepted');
    });
  }

  it('a call the client could not make (a cloud that fails the TLS rule) is no attempt', async () => {
    f.answers(DEVVM, { called: false, reason: 'insecure' });
    const { row, first } = f.send();
    await f.settle();
    expect(await first).toEqual({ kind: 'held', reason: 'no-relay', answer: null, ahead: 0 });
    expect(f.row(row.messageId)).toMatchObject({ state: 'held', attempts: 0 });
    expect(store.listRecords(f.db)).toEqual([]);
  });

  it('a fresh send after held mail was blocked goes at once, not after the wait', async () => {
    setSwitch(f.db, 'off', f.clock.now);
    const held = f.insert();
    f.outbox.start();
    await f.settle();
    setSwitch(f.db, 'on', f.clock.now);
    store.resolveOutbox(f.db, held.messageId, { state: 'dismissed', outcome: null, reason: null, attempted: false }, f.clock.now);
    f.answers(DEVVM, A.delivered());
    const { first } = f.send();
    await f.settle();
    expect(await first).toMatchObject({ kind: 'resolved', state: 'accepted' });
  });

  it('a registration that cannot be read fails the send loudly, and the mail stays held', async () => {
    const { row, first } = f.send();
    await f.settle();
    f.calls[0].answer(A.delivered());
    f.outbox.stop();
    f.outbox = new Outbox({
      db: () => f.db,
      now: () => f.clock.now,
      timers: f.clock.timers,
      client: {
        relay: () => {
          throw new Error("cloud-config.json's server_url is not a URL");
        },
      },
      list: { relay: () => f.relayState, noteNoRelay: () => {}, refresh: async () => f.listing },
      registration: () => f.registration,
      log: (level, message) => f.logs.push(`${level} ${message}`),
    });
    await first;
    const next = f.insert();
    const failing = f.outbox.enqueue(next);
    await expect(failing).rejects.toThrow(/server_url is not a URL/);
    expect(f.row(next.messageId).state).toBe('held');
    expect(f.row(row.messageId).state).toBe('accepted');
    expect(f.logs.some((l) => l.startsWith('ERROR') && l.includes('stays held'))).toBe(true);
  });
});

// ===========================================================================
// The record
// ===========================================================================

describe('the record of every relay call', () => {
  it('one row per call, retries included, with the addresses, id and size, and no body; rate-limited calls counted', async () => {
    f.answers(DEVVM, A.offline(), A.cloudRateLimited(10), A.delivered());
    const row = f.insert();
    f.outbox.start();
    await f.settle();
    await f.advance(5 * SECOND);
    await f.advance(10 * SECOND);
    const records = store.listRecords(f.db).reverse();
    expect(records.map((r) => [r.outcome, r.reason, r.aggregate])).toEqual([
      ['unavailable', 'tower-offline', false],
      ['refused', 'rate-limited', true],
      ['delivered', null, false],
    ]);
    expect(records[0]).toMatchObject({
      direction: 'outbound',
      kind: 'message',
      peerTowerId: DEVVM,
      peerSlug: 'devvm',
      messageId: row.messageId,
      fromAddress: 'codev:architect:main',
      toAddress: 'afx://devvm/codev:architect:local',
      payloadSize: row.payload.length,
    });
    expect(JSON.stringify(store.listRecords(f.db))).not.toContain('sentAt');
  });
});
