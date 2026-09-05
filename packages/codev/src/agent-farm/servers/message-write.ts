/**
 * Paced message writing for PTY sessions (Bugfix #584).
 *
 * Extracted to a shared module to avoid circular imports between
 * tower-routes.ts and tower-cron.ts.
 */

import { trySubmitToSession, watchBypasses, type SubmitClock } from './session-submit.js';

/** Minimal writable session interface — avoids coupling to PtySession. */
export interface WritableSession {
  /**
   * Write input to the underlying PTY. Returns `false` when the write was dropped
   * (#1198: a shellper-backed session whose socket has died still reports status
   * 'running', yet its writes silently no-op). {@link submitMessagePaced} threads this
   * boolean so a mailbox delivery whose bytes never reached the terminal is held, not
   * marked delivered (Spec 1313 integration review — the silent-loss finding).
   */
  write(data: string): boolean;
}

/**
 * The session shape {@link submitMessagePaced} needs, over and above {@link WritableSession}
 * (Issue #1473).
 *
 * Kept SEPARATE from `WritableSession` rather than widening it: the escape/message helpers and
 * every fake behind them need only the one-arg `write`, and requiring an id + counter of them
 * would be churn for a field they never read.
 *
 * `write` takes the origin here because the delivery's own bytes must NOT move the gate's input
 * signal — the gate has just authorised precisely these bytes, and counting them would make
 * every delivery block the one after it. `'delivery'` is the only value this module ever passes,
 * so that is the only one it names; the full vocabulary is `WriteOrigin` in `pty-session.ts`,
 * which this module deliberately does not import (a one-arg `write` is still assignable here,
 * which is what keeps the delivery module's structural fakes working).
 */
export interface PacedWriteSession {
  /**
   * The per-terminal submission lock's key (Issue #1365). A double MUST supply a real, distinct
   * one — see the throw in {@link submitMessagePaced}.
   */
  readonly id: string;
  /**
   * The session's monotone input-change counter (Issue #1473). Sampled either side of the paced
   * write so a human keystroke that landed BETWEEN the first byte and the trailing Enter can be
   * REPORTED. It cannot be prevented — the bytes are already going out — so this is a reporting
   * signal, not a gate.
   */
  readonly inputSeq: number;
  write(data: string, origin?: 'delivery'): boolean;
}

// Messages longer than this threshold are written line-by-line with delays
// to prevent the receiving terminal from classifying the input as a paste
// and swallowing the final Enter.
const PACED_WRITE_LINE_THRESHOLD = 4;
const INTER_LINE_DELAY_MS = 10;
const PACED_ENTER_DELAY_MS = 80;
const SIMPLE_ENTER_DELAY_MS = 50;

/** ESC keystroke — ends the agent's current turn (Spec 1273). */
export const ESC = '\x1b';

/**
 * Delay between the ESC and the Enter that follows it. Matches the short-message
 * Enter delay: ESC has to be processed by the TUI before Enter is meaningful.
 */
export const ESCAPE_ENTER_DELAY_MS = SIMPLE_ENTER_DELAY_MS;

/**
 * Write a bare ESC keystroke to a PTY session (Spec 1273).
 *
 * This is the verified mid-turn recovery for a wedged agent: ESC interrupts the
 * running tool and ends the turn, after which queued messages process. It is the
 * command form of `afx send <builder> --raw "$(printf '\x1b')"`.
 *
 * The trailing Enter is sent by default and is load-bearing, not incidental —
 * it is what lets already-queued input through once ESC has ended the turn. Pass
 * `noEnter` to write ESC alone.
 *
 * Deliberately not routed through `writeMessageToSession`: ESC is a control byte,
 * not text, so line-pacing and paste-detection logic do not apply to it.
 *
 * @returns ms timestamp (from call time) when all writes complete
 */
export function writeEscapeToSession(session: WritableSession, noEnter: boolean): number {
  session.write(ESC);
  if (noEnter) return 0;
  setTimeout(() => session.write('\r'), ESCAPE_ENTER_DELAY_MS);
  return ESCAPE_ENTER_DELAY_MS;
}

/**
 * Write a message to a PTY session, pacing multi-line output to prevent
 * the terminal from treating it as a paste (Bugfix #584).
 *
 * Short messages (≤3 lines): single write + delayed Enter.
 * Long messages (>3 lines): line-by-line writes with 10ms gaps, then Enter
 * after all lines are delivered.
 *
 * @param delayOffset  ms offset for all scheduled writes (used to serialize
 *                     multiple messages to the same session without interleaving)
 * @returns            ms timestamp (from call time) when all writes complete
 */
export function writeMessageToSession(
  session: WritableSession, message: string, noEnter: boolean, delayOffset = 0,
): number {
  const lines = message.split('\n');

  if (lines.length < PACED_WRITE_LINE_THRESHOLD) {
    // Short messages: single write (existing behavior, works fine)
    if (delayOffset === 0) {
      session.write(message);
    } else {
      setTimeout(() => session.write(message), delayOffset);
    }
    const enterTime = delayOffset + SIMPLE_ENTER_DELAY_MS;
    if (!noEnter) {
      setTimeout(() => session.write('\r'), enterTime);
    }
    return enterTime;
  }

  // Multi-line: pace output line-by-line to avoid paste detection.
  // Writing all lines in a single write() causes the terminal to treat it
  // as a paste, swallowing the final Enter.
  for (let i = 0; i < lines.length; i++) {
    const text = i < lines.length - 1 ? lines[i] + '\n' : lines[i];
    const lineDelay = delayOffset + i * INTER_LINE_DELAY_MS;
    if (lineDelay === 0) {
      session.write(text);
    } else {
      setTimeout(() => session.write(text), lineDelay);
    }
  }

  const lastLineTime = delayOffset + (lines.length - 1) * INTER_LINE_DELAY_MS;
  if (!noEnter) {
    const enterTime = lastLineTime + PACED_ENTER_DELAY_MS;
    setTimeout(() => session.write('\r'), enterTime);
    return enterTime;
  }
  return lastLineTime;
}

/**
 * Outcome of a {@link submitMessagePaced} attempt. Generic in the caller's own abort
 * vocabulary so this module stays free of mailbox concepts — the delivery layer
 * instantiates `A` with its hold reasons.
 */
export type PacedSubmitResult<A> =
  /**
   * The whole submit — text and, unless `noEnter`, the trailing Enter — reached the PTY.
   *
   * `racedByInput` (Issue #1473) means the terminal's input counter moved between the first
   * byte and the last: a human typed while our body was going out, so it may have been
   * TRUNCATED (`^U`/`^W`/`^C`) or SUBMITTED EARLY (their Enter carrying our partial text). It is
   * a FLAG, not a hold — the bytes are already on the wire, and re-writing a message that
   * landed is the #1584 re-injection failure this module is forbidden to reproduce.
   *
   * OMITTED when false, never `racedByInput: false`, so exact `{ status: 'written' }` equality
   * assertions keep meaning what they meant.
   */
  | { status: 'written'; racedByInput?: boolean }
  /** #1198: a scheduled write was dropped mid-pace (the shellper socket died). */
  | { status: 'dropped' }
  /**
   * The bytes went out, but an operator submission bypassed the lock while they did
   * (the ceiling-expired degraded path), so this submit cannot be trusted to have
   * landed intact.
   */
  | { status: 'preempted' }
  /** Another submission held the terminal. NOTHING was written; the caller may retry later. */
  | { status: 'contended' }
  /** The caller's in-lock precheck refused. NOTHING was written. */
  | { status: 'aborted'; abort: A };

/**
 * Paced write of a message (text + trailing Enter unless `noEnter`) performed as ONE
 * submission on the session's per-terminal lock (Issue #1365).
 *
 * This is the mailbox delivery path's write edge. Before #1365 it wrote directly, under
 * the per-agent serializer only, so a gated delivery could interleave with a concurrent
 * `--interrupt`/`--escape` on the same terminal: a `^C` or ESC landing between the text
 * and its Enter cleared or truncated the composer while every byte still reported
 * success, and the row was marked `delivered` for a message the agent never saw whole.
 * Taking the same lock those paths take is what makes that impossible.
 *
 * Two properties are load-bearing and easy to lose in a refactor:
 *
 *   - **`precheck` runs INSIDE the lock**, immediately before the first byte. Acquiring
 *     the lock without it would merely move the race: a delivery that classified a clean
 *     screen, then waited behind another submission, would write onto the screen that
 *     submission just changed. Returning non-null aborts with nothing written.
 *   - **Contention is declined, not queued** (see {@link trySubmitToSession}). The gated
 *     delivery path must never block, because the drainer walks agents sequentially.
 *
 * The completion semantics callers depend on are unchanged from the pre-#1365
 * `writeMessagePaced`: the returned promise resolves only after the trailing Enter has
 * been written. `writeMessageToSession` registers the Enter's `setTimeout` before
 * `submitToSession` schedules its own equal-offset sleep, so the Enter still executes
 * first — which is what makes the per-agent serializer's completion-chaining real.
 */
export async function submitMessagePaced<A>(
  session: PacedWriteSession,
  message: string,
  noEnter: boolean,
  precheck: () => A | null,
  clock?: SubmitClock,
): Promise<PacedSubmitResult<A>> {
  // Fail LOUD on a missing id rather than keying the lock on `undefined`. Sessions reach
  // this through structurally-typed ports, so a double without an id compiles fine and
  // would silently collapse every per-terminal lock into one global lock — serialization
  // that looks present and is not. A throw here surfaces as a held row (the delivery path
  // never marks a row delivered on a throw), which is the safe failure.
  if (typeof session.id !== 'string' || session.id === '') {
    throw new Error('submitMessagePaced: session.id must be a non-empty string (the per-terminal lock key)');
  }

  // The one thing the lock cannot stop is an operator submission whose wait ceiling expired
  // and wrote anyway. Watch the session's degraded-write counter across our own submission:
  // a bump means a `^C`/ESC bypassed us mid-write, so the composer may have been cleared or
  // truncated under our bytes. Cheaper and more direct than re-classifying the screen — and it
  // is the difference between re-holding the row and falsely reporting a delivery, which is
  // the whole point of Issue #1365. The watch also pins the counter against eviction for
  // exactly as long as we need to compare it; `finally` is what keeps that pin from leaking.
  const bypasses = watchBypasses(session.id);
  try {
    let delivered = true;
    let abort: A | null = null;
    // Sampled inside the lock, immediately before the first byte (below), so the comparison
    // spans exactly the paced write and not the lock wait that preceded it.
    let inputSeqBefore = session.inputSeq;
    // The origin is HARD-CODED here rather than forwarded through a parameter (Issue #1473).
    // A one-arg function is assignable to a two-arg function type, so a wrapper that forgot to
    // pass the origin along would compile cleanly — and its failure mode is the delivery
    // counting its own bytes as human input, i.e. "mail never delivers". Removing the parameter
    // removes the opportunity.
    const tracked: WritableSession = {
      write: (data: string): boolean => {
        const ok = session.write(data, 'delivery');
        if (!ok) delivered = false;
        return ok;
      },
    };

    const ran = await trySubmitToSession(
      session.id,
      () => {
        abort = precheck();
        if (abort !== null) return 0; // refused in-lock: not one byte goes out
        inputSeqBefore = session.inputSeq;
        return writeMessageToSession(tracked, message, noEnter);
      },
      clock,
    );

    if (!ran) return { status: 'contended' };
    // Read through a cast: both flags are assigned inside the callback above, which
    // TypeScript's flow analysis does not track back to this scope.
    const refused = abort as A | null;
    if (refused !== null) return { status: 'aborted', abort: refused };
    if (!(delivered as boolean)) return { status: 'dropped' };
    if (bypasses.raced()) return { status: 'preempted' };
    // The prechecks close everything up to the first byte; between the first byte and the
    // trailing Enter there is still an 80 ms-to-seconds window, and by then the bytes are out.
    // So this is a REPORTING signal — flag it and let the caller tell the operator, rather than
    // hold and re-write a message that may well have landed (#1584). Omitted when false.
    if (session.inputSeq !== inputSeqBefore) return { status: 'written', racedByInput: true };
    return { status: 'written' };
  } finally {
    bypasses.release();
  }
}
