/**
 * The sending Tower's outbox (Spec 1967, plan phase 8; contract sections 4 and 6, Decision
 * 5): the per-peer queue over `peer_outbox`.
 *
 * - **One message relay call in flight per peer, in acceptance order.** Only a peer's oldest
 *   held row, its head, is ever sent; the rows behind it wait. So a peer's mail leaves in the
 *   order it was accepted, whether or not anything is held, and a refused message simply
 *   leaves the order.
 * - **Each answer resolves the row as section 6's table says** ({@link decide}): `delivered`
 *   and `held` at the recipient end it accepted, a duplicate as the state it reports; a
 *   refusal ends it refused; `not-verified`, the cloud's `unavailable` and anything that is
 *   not the contract's answer leave it held, to be retried.
 * - **Rate-limited mail (C4).** A `rate-limited` refusal, from the cloud or the recipient,
 *   ends a send only while its sender still waits for the answer. Mail already held stays
 *   held, and the queue waits `retryAfterSec`, or the next back-off interval without one,
 *   then retries the same row first.
 * - **Back-off.** A held head is retried 5 seconds after its first held answer, doubling to a
 *   cap of 2 minutes, whatever the listing says. When that answer said the peer or the route
 *   was gone (`tower-offline`, or the cloud unreachable), a listing fetched since, at the
 *   holding budget, that shows the peer online brings the retry forward.
 * - **The lifetime.** A row 30 days past its `sentAt` is marked expired and never sent.
 * - **Runs (G10, G12, G15).** Each answer a message gets extends or ends its peer's run in
 *   `peer_answer_runs`: five `not-verified` in a row mark the peer "not verifying", five
 *   `cloud-error` "cloud error", and one `clock-skew` "clock out of range", each until a
 *   message to that peer gets any other answer ({@link readPeerMarks}). An answer this Tower
 *   could not read as the contract's (no answer, or one without the body) neither extends
 *   nor ends a run: it says nothing about the peer.
 * - **The registration.** An answer is used only when this Tower's registration (server URL
 *   and Tower id) is still the one the call was made under. Otherwise it says nothing of the
 *   current registration: the row stays held and is retried.
 * - **Held mail leaves only while this Tower would accept the send now**: the switch on, a
 *   registration not marked deregistered, and a cloud that may have a relay. While one of
 *   them fails nothing is sent, nothing is counted as an attempt, and the queue looks again
 *   at the capped interval, or at once on {@link Outbox.wake}.
 * - **Restart.** All a queue needs is in its rows (acceptance order, attempts, when to try
 *   next, the last answer), so {@link Outbox.start} resumes every queue from them.
 *
 * A fresh send ({@link Outbox.enqueue}) waits for its row's first answer, unless held mail
 * for the same peer is ahead of it: then it queues behind, and is told so at once (Decision
 * 5). When an attempt leaves a row held, every send still waiting behind it is told the same.
 *
 * Every relay call is recorded (`records.ts`), and none of this logs a payload or a key. All
 * timers are injected, so every rule here runs on a controlled clock.
 */

import type Database from 'better-sqlite3';
import { PEER_MESSAGE_LIFETIME_MS } from '@cluesmith/codev-types';
import { parseAddress } from '@cluesmith/codev-sdk/address';
import { LISTING_HOLDING_INTERVAL_MS, UNREF_TIMERS, type CloudClient, type CloudTimers } from './cloud-client.js';
import type { ClassifiedAnswer } from './contract.js';
import { listingScope, type OwnRegistration, type PeerList } from './peer-list.js';
import { recordOutbound } from './records.js';
import {
  listHeldOutbox,
  listPeerAnswerRuns,
  notePeerAnswer,
  recordOutboxAttempt,
  resolveOutbox,
  type PeerOutboxRow,
  type PeerRunAnswer,
} from './store.js';
import { isRemoteMessagingOn } from './switch.js';

/** The back-off's first interval (contract section 6). */
export const OUTBOX_BACKOFF_BASE_MS = 5_000;
/** The back-off's cap as a multiple of its base: 2 minutes for the protocol's 5 seconds. */
const BACKOFF_CAP_FACTOR = 24;
/** How many like answers in a row mark a peer "not verifying" or "cloud error" (G10, G15). */
export const PEER_RUN_MARK_LENGTH = 5;
/** The answers after which a listing showing the peer online brings the retry forward. */
const GONE_REASONS: ReadonlySet<string> = new Set(['tower-offline', 'cloud-unreachable']);

/**
 * The wait after the `failedAttempts`-th held answer in a row: the base, doubling, capped at
 * 24 times the base (5 s, 10 s, 20 s, 40 s, 80 s, then 2 minutes).
 */
export function backoffDelayMs(failedAttempts: number, baseMs: number = OUTBOX_BACKOFF_BASE_MS): number {
  if (!Number.isSafeInteger(failedAttempts) || failedAttempts < 1) {
    throw new Error(`outbox: a back-off follows at least one attempt, got ${failedAttempts}`);
  }
  return Math.min(baseMs * BACKOFF_CAP_FACTOR, baseMs * 2 ** Math.min(failedAttempts - 1, 30));
}

/** What a fresh send is told once its row's first attempt is over, or it queued behind held mail. */
export type FirstAnswer =
  /** The peer accepted it (delivered, or held there), or it was refused. */
  | { kind: 'resolved'; state: 'accepted' | 'refused'; answer: ClassifiedAnswer }
  /**
   * Held here, waiting for its peer: `reason` is why the queue holds (an answer's reason, or
   * why held mail cannot leave now). `answer` is the answer this row got, when it got one
   * that counted; `ahead` is how many of the peer's held rows are before it.
   */
  | { kind: 'held'; reason: string; answer: ClassifiedAnswer | null; ahead: number }
  /** Ended without an answer before its first attempt. */
  | { kind: 'ended'; state: 'expired' };

/** A mark on a peer, shown in `afx peer list`, the Peers panel and the record (phases 11, 12). */
export type PeerMarkKind = 'not-verifying' | 'cloud-error' | 'clock-out-of-range';

export interface PeerMark {
  peerTowerId: string;
  mark: PeerMarkKind;
  /** How many answers in a row set it, and when the first and latest came. */
  run: number;
  since: number;
  lastAt: number;
}

/** The marks set now: a peer's run of like answers, once it is long enough to show. */
export function readPeerMarks(db: Database.Database, peerTowerId?: string): PeerMark[] {
  const marks: PeerMark[] = [];
  for (const run of listPeerAnswerRuns(db, peerTowerId)) {
    const mark = markOf(run.answer, run.run);
    if (mark !== null) marks.push({ peerTowerId: run.peerTowerId, mark, run: run.run, since: run.firstAt, lastAt: run.lastAt });
  }
  return marks;
}

function markOf(answer: PeerRunAnswer, run: number): PeerMarkKind | null {
  switch (answer) {
    case 'not-verified':
      return run >= PEER_RUN_MARK_LENGTH ? 'not-verifying' : null;
    case 'cloud-error':
      return run >= PEER_RUN_MARK_LENGTH ? 'cloud-error' : null;
    case 'clock-skew':
      return 'clock-out-of-range';
  }
}

/**
 * What an answer does to its peer's run: one of the run answers, `null` for any other
 * answer (which ends a run), or `'none'` for an answer this Tower could not read as the
 * contract's, which says nothing about the peer.
 */
function runAnswerOf(answer: ClassifiedAnswer): PeerRunAnswer | null | 'none' {
  if (answer.reason === 'cloud-unreachable' || answer.reason === 'no-relay') return 'none';
  if (answer.outcome === 'not-verified') return 'not-verified';
  if (answer.reason === 'cloud-error') return 'cloud-error';
  if (answer.reason === 'clock-skew') return 'clock-skew';
  return null;
}

/** What one answer does to the row it answers (section 6, "How S resolves its row"). */
type Decision =
  | { act: 'accept' }
  | { act: 'refuse' }
  /** Still held; retried after `waitMs`, or the next back-off interval when `null`. */
  | { act: 'hold'; waitMs: number | null };

/**
 * The table, for a message. `fresh` is whether its sender still waits for this answer,
 * which is what decides a `rate-limited` refusal (C4). A `retryAfterSec` of 0 is waited as
 * one second, so a cloud that keeps answering 0 cannot spin the queue.
 */
export function decide(answer: ClassifiedAnswer, fresh: boolean): Decision {
  switch (answer.outcome) {
    case 'delivered':
    case 'held':
      return { act: 'accept' };
    case 'refused': {
      if (answer.reason !== 'rate-limited' || fresh) return { act: 'refuse' };
      const after = answer.answer !== null && 'retryAfterSec' in answer.answer ? answer.answer.retryAfterSec : undefined;
      return { act: 'hold', waitMs: after === undefined ? null : Math.max(1, after) * 1000 };
    }
    case 'not-verified':
    case 'unavailable':
      return { act: 'hold', waitMs: null };
    case 'answered':
      throw new Error("outbox: a message's answer was a discovery answer, which the contract's reading never gives");
  }
}

/** Why a held row waits, as a send queued behind it is told. */
function holdReasonOf(row: PeerOutboxRow): string {
  return row.lastReason ?? (row.lastOutcome === 'not-verified' ? 'not-verified' : 'queued');
}

/** The Tower an outbox row's address names (the record's `peerSlug`); the row was written from a parsed address. */
function towerOf(row: PeerOutboxRow): string {
  const parsed = parseAddress(row.toAddress);
  if (!parsed.ok || parsed.address.tower === undefined) {
    throw new Error(`outbox: message ${row.messageId} is stored with an address that names no Tower`);
  }
  return parsed.address.tower;
}

/** `enqueue` on an outbox that has stopped (Tower is shutting down). The row stays held. */
export class OutboxStoppedError extends Error {
  constructor() {
    super('outbox: a message was queued after the outbox stopped');
    this.name = 'OutboxStoppedError';
  }
}

function errorKind(err: unknown): string {
  return err instanceof Error ? err.message : typeof err;
}

export type OutboxLogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface OutboxDeps {
  db(): Database.Database;
  now(): number;
  /** Default: real timers, unreferenced. */
  timers?: CloudTimers;
  client: Pick<CloudClient, 'relay'>;
  list: Pick<PeerList, 'refresh' | 'relay' | 'noteNoRelay'>;
  /** This Tower's registration, read on every use; `null` when it has none. */
  registration(): OwnRegistration | null;
  /** The back-off's base: the protocol's 5 seconds; layer B passes milliseconds. */
  backoffBaseMs?: number;
  log(level: OutboxLogLevel, message: string): void;
  /** Mail waiting for a peer was added, sent or resolved: refresh what shows it. */
  onChanged?(): void;
}

interface Waiter {
  resolve(answer: FirstAnswer): void;
  reject(err: Error): void;
}

interface PeerQueue {
  peerTowerId: string;
  /** The relay call in flight for this peer, if any: at most one. */
  inFlight: { messageId: string; done: Promise<void> } | null;
  timer: unknown;
  /** Nothing is sent before this: set when held mail could not leave, or no call could be made. */
  notBefore: number;
  /** Set by a listing that shows the peer back: the next look sends the head at once. */
  bringForward: boolean;
  /** Fresh sends still waiting for their first answer, by message id. */
  waiters: Map<string, Waiter>;
}

export class Outbox {
  private readonly timers: CloudTimers;
  private readonly baseMs: number;
  private readonly capMs: number;
  private readonly queues = new Map<string, PeerQueue>();
  private watchTimer: unknown = null;
  private watching: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly deps: OutboxDeps) {
    this.timers = deps.timers ?? UNREF_TIMERS;
    this.baseMs = deps.backoffBaseMs ?? OUTBOX_BACKOFF_BASE_MS;
    if (!Number.isSafeInteger(this.baseMs) || this.baseMs < 1) {
      throw new Error(`outbox: the back-off base must be a positive number of milliseconds, got ${this.baseMs}`);
    }
    this.capMs = this.baseMs * BACKOFF_CAP_FACTOR;
  }

  // -------------------------------------------------------------------------
  // The surface
  // -------------------------------------------------------------------------

  /** Resume every peer's queue from its durable rows (Tower start). */
  start(): void {
    this.stopped = false;
    this.wake();
  }

  /** Stop: no timer fires and nothing new is sent. A call in flight finishes and is applied. */
  stop(): void {
    this.stopped = true;
    for (const queue of this.queues.values()) this.clearTimer(queue);
    if (this.watchTimer !== null) this.timers.clearTimeout(this.watchTimer);
    this.watchTimer = null;
  }

  /**
   * Look at every peer with held mail now: something changed that may let it leave (the
   * switch turned on, a new registration). Each head still waits out its own back-off.
   */
  wake(): void {
    if (this.stopped) return;
    const peers = new Set(listHeldOutbox(this.deps.db()).map((row) => row.peerTowerId));
    for (const peer of peers) {
      this.queueFor(peer).notBefore = 0;
      this.pump(peer);
    }
  }

  /**
   * Queue a row the sender has just persisted. Resolves with its first answer, or at once
   * as held when held mail for the same peer is ahead of it. Rejects when the attempt itself
   * failed in this Tower (an unreadable registration), which is the sender's error, or when
   * the outbox has stopped; either way the row stays held, and is sent once the outbox runs.
   */
  enqueue(row: PeerOutboxRow): Promise<FirstAnswer> {
    if (this.stopped) return Promise.reject(new OutboxStoppedError());
    const queue = this.queueFor(row.peerTowerId);
    const first = new Promise<FirstAnswer>((resolve, reject) => queue.waiters.set(row.messageId, { resolve, reject }));
    const ahead = listHeldOutbox(this.deps.db(), row.peerTowerId).filter((r) => r.seq < row.seq);
    // A row ahead with no sender waiting on it is held mail; a send behind it queues.
    if (ahead.some((r) => !queue.waiters.has(r.messageId))) {
      this.settle(queue, row.messageId, { kind: 'held', reason: holdReasonOf(ahead[0]), answer: null, ahead: ahead.length });
    }
    this.deps.onChanged?.();
    this.pump(row.peerTowerId);
    return first;
  }

  /** Resolves once no relay call or listing is in flight (tests, shutdown). */
  async settled(): Promise<void> {
    for (;;) {
      const pending: Promise<void>[] = [];
      for (const queue of this.queues.values()) if (queue.inFlight !== null) pending.push(queue.inFlight.done);
      if (this.watching !== null) pending.push(this.watching);
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  /** The message whose relay call is in flight for this peer, if any. */
  inFlightFor(peerTowerId: string): string | null {
    return this.queues.get(peerTowerId)?.inFlight?.messageId ?? null;
  }

  // -------------------------------------------------------------------------
  // One peer's queue
  // -------------------------------------------------------------------------

  private queueFor(peerTowerId: string): PeerQueue {
    let queue = this.queues.get(peerTowerId);
    if (queue === undefined) {
      queue = { peerTowerId, inFlight: null, timer: null, notBefore: 0, bringForward: false, waiters: new Map() };
      this.queues.set(peerTowerId, queue);
    }
    return queue;
  }

  private clearTimer(queue: PeerQueue): void {
    if (queue.timer !== null) this.timers.clearTimeout(queue.timer);
    queue.timer = null;
  }

  private wakeAt(queue: PeerQueue, at: number): void {
    this.clearTimer(queue);
    queue.timer = this.timers.setTimeout(() => {
      queue.timer = null;
      this.pump(queue.peerTowerId);
    }, Math.max(0, at - this.deps.now()));
  }

  /** Tell a waiting sender, once. */
  private settle(queue: PeerQueue, messageId: string, answer: FirstAnswer): void {
    const waiter = queue.waiters.get(messageId);
    if (waiter === undefined) return;
    queue.waiters.delete(messageId);
    waiter.resolve(answer);
  }

  /**
   * The peer's queue holds: every send still waiting on a row of it is told so, with how
   * many held rows are before its own. `answered` is the row whose attempt just left it
   * held, which is told its own answer.
   */
  private holdWaiters(queue: PeerQueue, reason: string, answered?: { messageId: string; answer: ClassifiedAnswer | null }): void {
    if (queue.waiters.size === 0) return;
    const held = listHeldOutbox(this.deps.db(), queue.peerTowerId);
    for (const [index, row] of held.entries()) {
      const answer = answered?.messageId === row.messageId ? answered.answer : null;
      this.settle(queue, row.messageId, { kind: 'held', reason, answer, ahead: index });
    }
  }

  /** Why held mail cannot leave now, or `null` when it may (checks 1 to 4 of the sender's). */
  private blocked(): string | null {
    if (!isRemoteMessagingOn(this.deps.db())) return 'remote-off';
    const registration = this.deps.registration();
    if (registration === null) return 'not-connected';
    if (registration.deregistered) return 'not-registered';
    if (this.deps.list.relay().state === 'none') return 'no-relay';
    return null;
  }

  /** Look at a peer's queue: expire what has run out, then send the head if it is due. */
  private pump(peerTowerId: string): void {
    if (this.stopped) return;
    const queue = this.queues.get(peerTowerId);
    if (queue === undefined || queue.inFlight !== null) return;
    this.clearTimer(queue);
    try {
      this.look(queue);
    } catch (err) {
      this.failed(queue, err);
    }
  }

  private look(queue: PeerQueue): void {
    const db = this.deps.db();
    const now = this.deps.now();
    this.expire(queue, db, now);
    const held = listHeldOutbox(db, queue.peerTowerId);
    if (held.length === 0) {
      if (queue.waiters.size === 0) this.queues.delete(queue.peerTowerId);
      return;
    }
    const head = held[0];
    const earliestExpiry = Math.min(...held.map((row) => row.sentAt)) + PEER_MESSAGE_LIFETIME_MS;
    // A fresh head goes at once: its sender has just passed the checks that `notBefore`
    // waits out for held mail, and is waiting for the answer.
    const fresh = queue.waiters.has(head.messageId);
    const due = queue.bringForward || fresh ? now : Math.max(head.nextAttemptAt ?? now, queue.notBefore);
    queue.bringForward = false;
    if (due > now) {
      this.wakeAt(queue, Math.min(due, earliestExpiry));
      this.scheduleWatch();
      return;
    }
    const blocked = this.blocked();
    if (blocked !== null) {
      queue.notBefore = now + this.capMs;
      this.deps.log('INFO', `Peer: mail for ${queue.peerTowerId} is held (${blocked}); looked at again in ${this.capMs / 1000} s`);
      this.holdWaiters(queue, blocked);
      this.wakeAt(queue, Math.min(queue.notBefore, earliestExpiry));
      return;
    }
    const done = this.attempt(queue, head)
      .catch((err: unknown) => this.failed(queue, err))
      .finally(() => {
        queue.inFlight = null;
        this.pump(queue.peerTowerId);
      });
    queue.inFlight = { messageId: head.messageId, done };
  }

  /** Mark expired every held row of this peer whose 30 days have run out. */
  private expire(queue: PeerQueue, db: Database.Database, now: number): void {
    let changed = false;
    for (const row of listHeldOutbox(db, queue.peerTowerId)) {
      if (now < row.sentAt + PEER_MESSAGE_LIFETIME_MS) continue;
      if (resolveOutbox(db, row.messageId, { state: 'expired', outcome: null, reason: null, attempted: false }, now)) {
        changed = true;
        this.deps.log('INFO', `Peer: message ${row.messageId} to ${queue.peerTowerId} expired after 30 days, never accepted`);
        this.settle(queue, row.messageId, { kind: 'ended', state: 'expired' });
      }
    }
    if (changed) this.deps.onChanged?.();
  }

  /** Something in this Tower failed (an unreadable registration, the database): loud, and held. */
  private failed(queue: PeerQueue, err: unknown): void {
    this.deps.log('ERROR', `Peer: the queue for ${queue.peerTowerId} failed (${errorKind(err)}); its mail stays held`);
    const error = err instanceof Error ? err : new Error(String(err));
    for (const waiter of queue.waiters.values()) waiter.reject(error);
    queue.waiters.clear();
    queue.notBefore = this.deps.now() + this.capMs;
    if (!this.stopped && queue.inFlight === null) this.wakeAt(queue, queue.notBefore);
  }

  // -------------------------------------------------------------------------
  // One attempt
  // -------------------------------------------------------------------------

  private async attempt(queue: PeerQueue, row: PeerOutboxRow): Promise<void> {
    const before = this.deps.registration();
    const startedAt = this.deps.now();
    const call = await this.deps.client.relay({
      kind: 'message',
      toTowerId: row.peerTowerId,
      requestId: row.messageId,
      payload: row.payload,
    });
    const db = this.deps.db();
    const now = this.deps.now();

    if (!call.called) {
      // The registration went, or its cloud fails the TLS rule, since `blocked()` looked.
      const reason = call.reason === 'insecure' ? 'no-relay' : 'not-connected';
      queue.notBefore = now + this.capMs;
      this.holdWaiters(queue, reason);
      return;
    }

    const { answer } = call;
    const fresh = queue.waiters.has(row.messageId);
    this.record(db, row, answer, startedAt);

    const after = this.deps.registration();
    if (before === null || after === null || listingScope(before) !== listingScope(after)) {
      this.deps.log('INFO', `Peer: message ${row.messageId}: this Tower's registration changed while it was sent; that answer is not used`);
      this.hold(queue, row, { outcome: 'unavailable', reason: 'registration-changed' }, null, now, null);
      return;
    }

    const run = runAnswerOf(answer);
    if (run !== 'none') notePeerAnswer(db, row.peerTowerId, run, now);
    if (answer.reason === 'no-relay') this.deps.list.noteNoRelay();

    const decision = decide(answer, fresh);
    if (decision.act === 'hold') {
      this.hold(queue, row, { outcome: answer.outcome, reason: answer.reason }, answer, now, decision.waitMs);
      return;
    }
    const state = decision.act === 'accept' ? 'accepted' : 'refused';
    const resolved = resolveOutbox(db, row.messageId, { state, outcome: answer.outcome, reason: answer.reason, attempted: true }, now);
    if (!resolved) {
      this.deps.log('WARN', `Peer: message ${row.messageId} was resolved elsewhere while it was sent; the answer was ${describe(answer)}`);
    } else {
      this.deps.log('INFO', `Peer: message ${row.messageId} to ${towerOf(row)}: ${describe(answer)}`);
    }
    this.settle(queue, row.messageId, { kind: 'resolved', state, answer });
    this.deps.onChanged?.();
  }

  /** The row stays held: note the attempt and when to try again, and tell whoever waits. */
  private hold(
    queue: PeerQueue,
    row: PeerOutboxRow,
    noted: { outcome: ClassifiedAnswer['outcome']; reason: string | null },
    answer: ClassifiedAnswer | null,
    now: number,
    waitMs: number | null,
  ): void {
    const wait = waitMs ?? backoffDelayMs(row.attempts + 1, this.baseMs);
    recordOutboxAttempt(this.deps.db(), row.messageId, { ...noted, nextAttemptAt: now + wait }, now);
    const reason = noted.reason ?? noted.outcome;
    this.deps.log('INFO', `Peer: message ${row.messageId} to ${towerOf(row)} is held here (${reason}); tried again in ${Math.round(wait / 100) / 10} s`);
    this.holdWaiters(queue, reason, { messageId: row.messageId, answer });
    this.deps.onChanged?.();
  }

  /** One relay call in the record. Its failure never changes what the answer does. */
  private record(db: Database.Database, row: PeerOutboxRow, answer: ClassifiedAnswer, at: number): void {
    try {
      recordOutbound(
        db,
        {
          at,
          kind: 'message',
          peerTowerId: row.peerTowerId,
          peerSlug: towerOf(row),
          messageId: row.messageId,
          fromAddress: row.fromAddress,
          toAddress: row.toAddress,
          payloadSize: row.payload.length,
        },
        answer.outcome,
        answer.reason,
      );
    } catch (err) {
      this.deps.log('WARN', `Peer: message ${row.messageId}'s relay call was not recorded (${err instanceof Error ? err.constructor.name : typeof err})`);
    }
  }

  // -------------------------------------------------------------------------
  // The listing, while mail waits for a peer that has gone
  // -------------------------------------------------------------------------

  /** The queues waiting out a back-off after an answer that said the peer, or the route, was gone. */
  private awaitingReturn(): Array<{ queue: PeerQueue; head: PeerOutboxRow }> {
    const db = this.deps.db();
    const now = this.deps.now();
    const found: Array<{ queue: PeerQueue; head: PeerOutboxRow }> = [];
    for (const queue of this.queues.values()) {
      if (queue.inFlight !== null) continue;
      const head = listHeldOutbox(db, queue.peerTowerId)[0];
      if (head === undefined || head.lastReason === null || !GONE_REASONS.has(head.lastReason)) continue;
      if ((head.nextAttemptAt ?? now) > now) found.push({ queue, head });
    }
    return found;
  }

  /** While a queue awaits its peer's return, ask the listing at the holding budget (every 30 s). */
  private scheduleWatch(): void {
    if (this.stopped || this.watchTimer !== null || this.watching !== null) return;
    if (this.awaitingReturn().length === 0) return;
    this.watchTimer = this.timers.setTimeout(() => {
      this.watchTimer = null;
      this.watching = this.watch().finally(() => {
        this.watching = null;
        this.scheduleWatch();
      });
    }, LISTING_HOLDING_INTERVAL_MS);
  }

  /**
   * A listing fetched after a head's last answer that shows its peer online brings that
   * head's retry forward. Within the budget the refresh answers from the cached list, which
   * counts if it was fetched since that answer.
   */
  private async watch(): Promise<void> {
    if (this.stopped) return;
    let listing;
    try {
      listing = (await this.deps.list.refresh('holding')).listing;
    } catch (err) {
      this.deps.log('WARN', `Peer: the peer list could not be read while mail waits (${errorKind(err)})`);
      return;
    }
    if (listing.refreshedAt === null) return;
    for (const { queue, head } of this.awaitingReturn()) {
      const tower = listing.towers.find((t) => t.towerId === queue.peerTowerId);
      if (tower === undefined || !tower.online || listing.refreshedAt <= head.updatedAt) continue;
      this.deps.log('INFO', `Peer: ${tower.slug} is listed online again; its held mail is tried now`);
      queue.bringForward = true;
      this.pump(queue.peerTowerId);
    }
  }
}

function describe(answer: ClassifiedAnswer): string {
  const parts: string[] = [answer.outcome];
  if (answer.reason !== null) parts.push(answer.reason);
  if (answer.answer?.duplicate === true) parts.push('duplicate');
  return parts.join(', ');
}
