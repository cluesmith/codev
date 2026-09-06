/**
 * Bounded-patience force coordinator (Issue #1481 — `afx send --interrupt-after <seconds>`).
 *
 * ## The semantic
 *
 * Three send shapes now exist, and the difference between them is *when* the no-force rule is
 * suspended, not whether the message is durable:
 *
 *   - a normal send **holds** until the render gate proves the recipient's prompt is empty —
 *     forever, if that never happens;
 *   - `--interrupt` **forces now**: Ctrl+C, a fixed settle, then the body, ungated;
 *   - `--interrupt-after <s>` behaves EXACTLY like a normal send for `<s>` seconds, and only
 *     then — if the row is still held — initiates the same force `--interrupt` performs.
 *
 * So this module never enqueues a message, never re-runs the send path, and never creates a
 * second row. It coordinates OWNERSHIP of a row that already exists and has been competing for
 * ordinary gated delivery the whole time.
 *
 * ## What the deadline does and does not promise
 *
 * It bounds the INITIATION of the escalation. It does not bound event-loop latency, the wait for
 * preceding operator submissions on that terminal (unbounded by design — see
 * `session-submit.ts`), the duration of the paced write itself, or anything about the agent
 * reading the message. `--interrupt-after 5` means "after five seconds, stop being patient",
 * never "delivered within five seconds".
 *
 * ## Lifetime, and why force does not survive a restart
 *
 * The message BODY is durable: it is an ordinary mailbox row and delivers through the gate
 * whenever the prompt clears, restart or not. The FORCE is not. At start every leftover armed
 * row is retired to `skipped-restart` before any writer runs, even when its deadline is still in
 * the future. The operator asked to interrupt a particular turn; a restart has already ended
 * that turn, and firing into whatever turn exists minutes later is a surprise nobody asked for.
 * This mirrors the delayed-`--interrupt` ^C nudge, which is also lifetime-scoped.
 *
 * A session that is gone or unwritable at the deadline, or has been REPLACED while our
 * submission queued, is skipped for the same reason rather than retargeted at the next session.
 *
 * ## Why the claim happens at the write edge, in one guarded statement
 *
 * Everything can change while a force waits for a terminal lock: the gate may deliver the row,
 * an operator may dismiss it, the session may die. So the coordinator re-checks the row, the
 * lifecycle generation, the session identity and its writability INSIDE the submission callback,
 * then claims the row (`held → delivered`) and writes with NO await in between. A claim that
 * finds zero rows means someone else won and nothing is written — not even the Ctrl+C.
 *
 * Claim-before-write is the same loss-over-duplicate trade immediate `--interrupt` makes: a
 * crash after the claim leaves a row reading `delivered` for a body that may never have landed.
 * `interrupt_outcome` says exactly that (`claimed` = claimed, not received). Re-holding instead
 * would let the backstop gate-deliver a second copy of a body already forced onto the line.
 */

import type Database from 'better-sqlite3';
import path from 'node:path';
import type { DbMailbox, MailboxInterruptOutcome } from '../db/types.js';
import {
  claimForForcedInterrupt,
  disarmInterruptsOnRestart,
  getById,
  setForcedInterruptOutcome,
  skipForcedInterrupt,
} from '../db/mailbox.js';
import { MAX_DELAY_SECONDS } from './delayed-send.js';
import { writeInterruptToSession } from './message-write.js';
import {
  OPERATOR_SUBMIT_WAIT_CEILING_MS,
  submitToSession,
  type SubmitClock,
} from './session-submit.js';
import {
  tryAcquireRowWrite,
  whenRowWriteSettles,
  type RowWriteHandle,
  type RowWriteOutcome,
} from './row-write-ownership.js';

/**
 * Validate an `--interrupt-after` value in seconds, returning null when acceptable or an error
 * string naming the problem.
 *
 * DELIBERATELY NOT `validateDelaySeconds`. That one requires `Number.isInteger`, and a patience
 * budget is a genuinely different quantity: sub-second and fractional budgets ("wait 1.5s for a
 * clean prompt, then force") are meaningful here and meaningless for a scheduled delivery. Only
 * the CEILING is shared — one hour, imported rather than re-typed, because two hardcoded bounds
 * drift and the CLI would then accept a value Tower rejects.
 *
 * `Number.isFinite` rather than a comparison chain: `NaN > 0` and `NaN <= 0` are both false, so
 * NaN slips through any single comparison written the obvious way and becomes a timer that fires
 * immediately — silently converting bounded patience into an immediate interrupt, which is the
 * one thing this flag exists NOT to be. Infinity is rejected for the same class of reason.
 */
export function validateInterruptAfterSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `interrupt-after must be a finite number of seconds, got '${String(value)}'`;
  }
  if (value <= 0) {
    return `interrupt-after must be greater than zero, got ${value} (use --interrupt to force immediately)`;
  }
  if (value > MAX_DELAY_SECONDS) {
    return `interrupt-after must be at most ${MAX_DELAY_SECONDS} seconds (1 hour), got ${value}`;
  }
  return null;
}

/** The minimum a force needs from a live session: an identity, writability, and a write. */
export interface InterruptSession {
  readonly id: string;
  readonly writable: boolean;
  write(data: string): boolean;
}

/** Feed frame for a forced delivery — the same shape the gated path broadcasts, plus the audit. */
export interface ForcedDeliveryBroadcast {
  workspacePath: string;
  toAgent: string;
  fromAgent: string | null;
  fromWorkspace: string | null;
  body: string;
  timestamp: number;
  /** The force's final audit state. NEVER receipt — see `MailboxInterruptOutcome`. */
  outcome: MailboxInterruptOutcome;
  /** True when an ordinary write for this row may already have emitted bytes. */
  priorPartial: boolean;
}

/** What a completed, failed or skipped force reports to the human-facing surfaces. */
export interface ForceOutcomeInfo {
  workspacePath: string;
  toAgent: string;
  mailboxId: string;
  terminalId: string | null;
  outcome: MailboxInterruptOutcome;
  priorPartial: boolean;
}

/** Injected edges. Mirrors `DeliveryPorts` so the live wiring and the unit fakes look alike. */
export interface InterruptPorts {
  /** The currently-live writable session for an agent, or null. */
  getSessionForAgent(workspacePath: string, toAgent: string): InterruptSession | null;
  /** Message/activity feed frame, emitted once per forced delivery that wrote a body. */
  broadcast(frame: ForcedDeliveryBroadcast): void;
  /** Held-set change → overview refresh. Fired once per claim, skip sweep, or skip. */
  onHeldStateChange(): void;
  /** Distinct outcome-update notification: a force that failed, was degraded, or was skipped. */
  onForceOutcome(info: ForceOutcomeInfo): void;
  log(message: string, level?: 'INFO' | 'WARN' | 'ERROR'): void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Injectable sleeper for the submission lock; real timers when omitted. */
  submitClock?: SubmitClock;
}

/**
 * Loop guard on how many times ONE row's force may enter the submission lock.
 *
 * Only a dispatch that writes NOTHING can recur — a claim ends the lifecycle, so this can never
 * multiply forced bodies. It bounds the pathological case where the row's ownership is handed
 * straight from one non-writing owner to the next. On exhaustion the force is abandoned in
 * memory and the row is left `armed` in the database: truthful (we never claimed it), and
 * harmless, because a past-deadline armed row no longer suppresses the starvation alarm and the
 * next restart retires it to `skipped-restart`.
 */
const MAX_FORCE_DISPATCHES = 4;

interface ArmedEntry {
  rowId: string;
  workspacePath: string;
  toAgent: string;
  deadlineAt: number;
  timer: unknown | null;
  /** The coordinator lifecycle this entry belongs to; a stop() bump invalidates it. */
  generation: number;
  dispatches: number;
}

/**
 * Owns the armed deadlines for one Tower lifetime.
 *
 * A class rather than module functions because the lifecycle is the point: `stop()` must be able
 * to invalidate work that is already queued behind a terminal lock, which needs a generation
 * counter with an owner.
 */
export class MailboxInterruptCoordinator {
  private ports: InterruptPorts | undefined;
  private db: Database.Database | undefined;
  private readonly armed = new Map<string, ArmedEntry>();
  private generation = 0;

  /**
   * Begin a lifetime: retire every leftover armed force, then accept new ones.
   *
   * The disarm sweep runs FIRST, before any writer can start, so there is no window in which a
   * row this Tower never armed could be forced by it.
   */
  start(ports: InterruptPorts, db: Database.Database): void {
    this.stop();
    this.ports = ports;
    this.db = db;
    const retired = disarmInterruptsOnRestart(db, ports.now());
    if (retired > 0) {
      ports.log(
        `[mailbox] disarmed ${retired} pending --interrupt-after escalation(s) left by a previous Tower ` +
          `lifetime — their message bodies remain held and deliver through the gate as usual`,
        'WARN',
      );
      // ONE refresh for the whole sweep: those rows stop suppressing the starvation alarm.
      ports.onHeldStateChange();
    }
  }

  /**
   * End the lifetime: cancel every timer and invalidate callbacks already queued behind a lock.
   *
   * Clearing timers alone is not enough — a fired timer whose submission is waiting on a
   * terminal lock is no longer in any map, and would otherwise write after shutdown. The
   * generation bump is re-read inside the lock, immediately before the claim.
   */
  stop(): void {
    const ports = this.ports;
    for (const entry of this.armed.values()) {
      if (entry.timer !== null) ports?.clearTimer(entry.timer);
    }
    this.armed.clear();
    this.ports = undefined;
    this.db = undefined;
    this.generation++;
  }

  /** Row ids with a live armed deadline. Test/observability only. */
  get pending(): ReadonlyArray<string> {
    return [...this.armed.keys()];
  }

  /**
   * Arm a persisted row's deadline.
   *
   * Called immediately after the row is enqueued and BEFORE the caller awaits its first gated
   * delivery attempt: the patience budget is measured from the send, so it must not start
   * ticking after a slow initial classify. The absolute deadline is what the timer targets, so
   * an already-past deadline fires at once rather than granting a fresh window.
   *
   * A no-op when the coordinator is stopped — a Tower with no running lifetime has no authority
   * to force anything, and the row's `armed` state will be retired by the next start().
   */
  arm(row: Pick<DbMailbox, 'id' | 'workspace_path' | 'to_agent' | 'interrupt_at' | 'interrupt_outcome'>): void {
    const ports = this.ports;
    if (!ports || !this.db) return;
    if (row.interrupt_at === null || row.interrupt_outcome !== 'armed') return;
    if (this.armed.has(row.id)) return;
    const entry: ArmedEntry = {
      rowId: row.id,
      workspacePath: row.workspace_path,
      toAgent: row.to_agent,
      deadlineAt: row.interrupt_at,
      timer: null,
      generation: this.generation,
      dispatches: 0,
    };
    this.armed.set(row.id, entry);
    this.schedule(entry);
  }

  private schedule(entry: ArmedEntry): void {
    const ports = this.ports;
    if (!ports) return;
    // Relative delay against an ABSOLUTE deadline, re-derived on every (re)schedule. A forward
    // clock jump cannot wake an OS timer early, so the honest promise is "not before the
    // deadline", and a backward jump is handled by the re-check at firing rather than pretended
    // away here.
    const delay = Math.max(0, entry.deadlineAt - ports.now());
    entry.timer = ports.setTimer(() => {
      entry.timer = null;
      void this.fire(entry);
    }, delay);
  }

  /** Timer entry point: re-validate the clock and the lifetime, then attempt the escalation. */
  private async fire(entry: ArmedEntry): Promise<void> {
    const ports = this.ports;
    if (!ports || entry.generation !== this.generation) return;
    if (this.armed.get(entry.rowId) !== entry) return; // cancelled or superseded while queued
    if (ports.now() < entry.deadlineAt) {
      // The wall clock moved backward under us; honour the deadline we promised, not the timer.
      this.schedule(entry);
      return;
    }
    await this.attempt(entry);
  }

  /**
   * One escalation attempt: re-check everything, claim at the write edge, write, then record.
   *
   * A timeout callback STARTING is not a claim. Every fact that could have changed while this
   * was queued is re-read inside the submission lock, immediately before the claim.
   */
  private async attempt(entry: ArmedEntry): Promise<void> {
    const ports = this.ports;
    const db = this.db;
    if (!ports || !db || entry.generation !== this.generation) return;
    if (this.armed.get(entry.rowId) !== entry) return;

    entry.dispatches += 1;
    if (entry.dispatches > MAX_FORCE_DISPATCHES) {
      ports.log(
        `[mailbox] --interrupt-after for ${entry.rowId.slice(0, 8)}… → ${entry.toAgent} gave up after ` +
          `${MAX_FORCE_DISPATCHES} attempts that could not take the row (another writer held it each time); ` +
          `the body remains held and delivers through the gate`,
        'WARN',
      );
      this.disarm(entry);
      return;
    }

    const row = getById(db, entry.rowId);
    if (!row || row.status !== 'held' || row.interrupt_outcome !== 'armed') {
      // Delivered, dismissed, superseded, or already resolved by another force: row status is
      // authoritative for cancellation, and the row keeps whatever outcome it carried.
      this.disarm(entry);
      return;
    }

    const session = ports.getSessionForAgent(row.workspace_path, row.to_agent);
    if (!session || !session.writable) {
      this.recordSkip(entry, row, 'skipped-offline', null);
      return;
    }
    const dispatchSessionId = session.id;

    // Mutated inside the submission callback and read after it completes. Held on ONE object,
    // not as separate `let`s: TypeScript narrows a captured `let` to the literal type it was
    // initialised with and cannot see the closure's assignments, so every read afterwards would
    // need a cast that silently outlives whatever it was written for.
    const state: {
      degraded: boolean;
      claimed: boolean;
      wroteBytes: boolean;
      writesAccepted: boolean;
      deferredToRowOwner: boolean;
      skip: 'skipped-offline' | 'skipped-session-replaced' | null;
      rowWrite: RowWriteHandle | null;
    } = {
      degraded: false,
      claimed: false,
      wroteBytes: false,
      writesAccepted: true,
      deferredToRowOwner: false,
      skip: null,
      rowWrite: null,
    };

    try {
      await submitToSession(
        dispatchSessionId,
        () => {
          // THE WRITE EDGE. Everything below is synchronous and runs inside the per-terminal
          // lock, so no other lock-taking writer can interleave with the claim or the bytes.
          if (entry.generation !== this.generation) return 0; // stopped while we queued
          const live = getById(db, entry.rowId);
          if (!live || live.status !== 'held' || live.interrupt_outcome !== 'armed') return 0;
          const current = ports.getSessionForAgent(row.workspace_path, row.to_agent);
          if (!current || !current.writable) {
            state.skip = 'skipped-offline';
            return 0;
          }
          if (current.id !== dispatchSessionId) {
            // The agent's session was replaced while we waited. Forcing into the NEW one would
            // interrupt a turn that has nothing to do with the one the operator meant.
            state.skip = 'skipped-session-replaced';
            return 0;
          }
          // Non-blocking, and last: an ordinary delivery may be mid-write on this very row
          // (the row still reads `held` throughout its paced write). We write NOTHING, claim
          // NOTHING, and bump no bypass counter — a degraded no-op raced nobody — then wait for
          // that attempt's real outcome outside every lock.
          state.rowWrite = tryAcquireRowWrite(entry.rowId);
          if (!state.rowWrite) {
            state.deferredToRowOwner = true;
            return 0;
          }
          // The claim and the first byte are one uninterrupted sequence. `claimed-degraded`
          // records a degraded ENTRY even if the completion update never lands.
          if (!claimForForcedInterrupt(db, entry.rowId, state.degraded ? 'claimed-degraded' : 'claimed', ports.now())) {
            state.rowWrite.settle('no-bytes');
            state.rowWrite = null;
            return 0;
          }
          state.claimed = true;
          const tracked: InterruptSession = {
            id: current.id,
            writable: current.writable,
            write: (data: string): boolean => {
              const ok = current.write(data);
              if (!ok) state.writesAccepted = false;
              return ok;
            },
          };
          state.wroteBytes = true;
          return writeInterruptToSession(tracked, live.formatted_message, live.no_enter === 1);
        },
        ports.submitClock,
        {
          kind: 'operator',
          waitCeilingMs: OPERATOR_SUBMIT_WAIT_CEILING_MS,
          // Fires synchronously before the write callback, so the claim statement above can
          // record the degradation in the same UPDATE that makes the row terminal.
          onDegradedEntry: () => {
            state.degraded = true;
          },
          onCeilingExpired: (waitedMs) =>
            ports.log(
              `[mailbox] --interrupt-after force → ${entry.toAgent} (terminal ${dispatchSessionId.slice(0, 8)}…) ` +
                `waited ${waitedMs}ms for an in-flight write and proceeded UNSERIALIZED — it may interleave ` +
                `with that write.`,
              'WARN',
            ),
          // A dispatch that declined ownership or found the row resolved wrote nothing, and must
          // not make a concurrent delivery report `preempted` and re-deliver for nothing.
          wroteBytes: () => state.wroteBytes,
        },
      );
    } catch (err) {
      // The bytes (if any) are already out and the row is already claimed — un-claiming would
      // risk a second body. Record the failure honestly instead.
      ports.log(
        `[mailbox] --interrupt-after force failed for ${entry.rowId.slice(0, 8)}… → ${entry.toAgent}: ${String(err)}`,
        'ERROR',
      );
      if (state.claimed) {
        this.recordCompletion(entry, row, dispatchSessionId, state.degraded ? 'degraded-failed' : 'failed');
      } else {
        this.disarm(entry);
      }
      return;
    } finally {
      // Release row ownership only once the paced write has completed (the submit resolves
      // after the trailing Enter), so no other writer can start a body for this row mid-pace.
      // A claimed row is TERMINAL even if the write threw: it can never be written again.
      state.rowWrite?.settle(state.claimed ? 'terminal' : 'no-bytes');
    }

    if (state.deferredToRowOwner) {
      this.waitForRowOwner(entry);
      return;
    }
    if (state.skip !== null) {
      this.recordSkip(entry, row, state.skip, dispatchSessionId);
      return;
    }
    if (!state.claimed) {
      // The row was resolved between dispatch and the write edge, or another force won it.
      this.disarm(entry);
      return;
    }
    this.recordCompletion(
      entry,
      row,
      dispatchSessionId,
      state.writesAccepted
        ? state.degraded
          ? 'degraded-written-unverified'
          : 'written-unverified'
        : state.degraded
          ? 'degraded-failed'
          : 'failed',
    );
  }

  /**
   * Stand aside for the ordinary write that owns this row, then decide once it has committed.
   *
   * Registered OUTSIDE every lock (the continuation runs on the owner's release path). The
   * decision is deliberately narrow: only an attempt that reached a terminal state cancels the
   * force. An attempt that wrote nothing leaves the escalation exactly as the operator asked
   * for it; an attempt that MAY have written some bytes leaves it armed too — the ordinary path
   * is itself still allowed to retry such a row, so disarming here would hold the escalation to
   * a stricter standard than the delivery it is escalating past. The row carries
   * `interrupt_prior_partial` from that moment on, so every surface can disclose that a forced
   * body may duplicate effects that already landed.
   */
  private waitForRowOwner(entry: ArmedEntry): void {
    const ports = this.ports;
    if (!ports) return;
    const generation = entry.generation;
    const onSettled = (outcome: RowWriteOutcome): void => {
      if (generation !== this.generation) return;
      if (this.armed.get(entry.rowId) !== entry) return;
      if (outcome === 'terminal') {
        ports.log(
          `[mailbox] --interrupt-after for ${entry.rowId.slice(0, 8)}… → ${entry.toAgent} cancelled: the ` +
            `ordinary gated delivery completed first`,
        );
        this.disarm(entry);
        return;
      }
      void this.attempt(entry);
    };
    // A `false` return means the owner released between our decline and this registration —
    // nothing to wait for, so re-attempt straight away rather than arming a dead continuation.
    if (!whenRowWriteSettles(entry.rowId, onSettled)) void this.attempt(entry);
  }

  /** Record a completed/failed force: audit first, then exactly one of each downstream event. */
  private recordCompletion(
    entry: ArmedEntry,
    row: DbMailbox,
    terminalId: string,
    outcome: MailboxInterruptOutcome,
  ): void {
    const ports = this.ports;
    const db = this.db;
    if (!ports || !db) return;
    setForcedInterruptOutcome(db, entry.rowId, outcome, ports.now());
    const priorPartial = row.interrupt_prior_partial === 1;
    // The claim already removed the row from the held set; refresh the indicator ONCE, here,
    // rather than inside the claim→first-byte sequence.
    ports.onHeldStateChange();
    // ONE feed event for this transition, through the same broadcast path the gated delivery
    // uses. The outcome travels as metadata so the frame can never imply receipt.
    ports.broadcast({
      workspacePath: row.workspace_path,
      toAgent: row.to_agent,
      fromAgent: row.from_agent,
      fromWorkspace: row.from_workspace,
      body: row.body,
      timestamp: ports.now(),
      outcome,
      priorPartial,
    });
    ports.onForceOutcome({
      workspacePath: row.workspace_path,
      toAgent: row.to_agent,
      mailboxId: entry.rowId,
      terminalId,
      outcome,
      priorPartial,
    });
    ports.log(
      `[mailbox] --interrupt-after forced ${entry.rowId.slice(0, 8)}… → ${row.to_agent} @ ` +
        `${path.basename(row.workspace_path)} (terminal ${terminalId.slice(0, 8)}…, outcome ${outcome}` +
        `${priorPartial ? ', prior partial write — effects may be duplicated' : ''}) — claimed and written, ` +
        `NOT acknowledged`,
      outcome === 'written-unverified' ? 'INFO' : 'WARN',
    );
    this.disarm(entry);
  }

  /** Record a skipped force: the body stays held, and stops suppressing the starvation alarm. */
  private recordSkip(
    entry: ArmedEntry,
    row: DbMailbox,
    outcome: 'skipped-offline' | 'skipped-session-replaced',
    terminalId: string | null,
  ): void {
    const ports = this.ports;
    const db = this.db;
    if (!ports || !db) return;
    if (skipForcedInterrupt(db, entry.rowId, outcome, ports.now())) {
      // No body was written, so there is NO delivery/activity event — only the state refresh
      // (the row's alarm suppression just ended) and its own diagnostic.
      ports.onHeldStateChange();
      ports.onForceOutcome({
        workspacePath: row.workspace_path,
        toAgent: row.to_agent,
        mailboxId: entry.rowId,
        terminalId,
        outcome,
        priorPartial: row.interrupt_prior_partial === 1,
      });
      ports.log(
        `[mailbox] --interrupt-after for ${entry.rowId.slice(0, 8)}… → ${row.to_agent} @ ` +
          `${path.basename(row.workspace_path)} skipped (${outcome}); the message stays held and delivers ` +
          `through the gate on the next clean pass`,
        'WARN',
      );
    }
    this.disarm(entry);
  }

  /** Drop an entry and its timer. In-memory only — the row's audit state is already recorded. */
  private disarm(entry: ArmedEntry): void {
    if (entry.timer !== null) this.ports?.clearTimer(entry.timer);
    entry.timer = null;
    if (this.armed.get(entry.rowId) === entry) this.armed.delete(entry.rowId);
  }
}
