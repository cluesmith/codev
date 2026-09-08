/**
 * Paced message writing for PTY sessions (Bugfix #584, Issue #1567).
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

const SIMPLE_ENTER_DELAY_MS = 50;

/**
 * Issue #1567 — why long frames are no longer handed to the PTY in one write.
 *
 * The kernel splits a large master-side write at the slave's input-queue high-water mark
 * (TTYHOG − 2 = 1022 bytes on macOS). The receiving TUI reads the first ~1 KB as one chunk,
 * its paste heuristic classifies that chunk as a paste and DISCARDS it, then types the
 * remainder and the Enter normally — so the agent saw a mid-sentence tail-only fragment
 * while every `write()` reported success. Measured on claude 2.1.263 (harness in
 * `scripts/bugfix-1567-head-loss-harness.mts`, evidence in `codev/evidence/1567-head-loss/`):
 * a 1,172-byte 3-line frame lost its head 14/20 times on an IDLE composer; a 1,000-byte frame
 * never did. Two independent changes each measured 0 losses, and both are applied:
 *
 *   1. **No single write exceeds {@link PASTE_CHUNK_BYTES}** — comfortably under the queue
 *      limit, so the kernel never splits a read and the reader drains between writes.
 *   2. **Long frames travel as ONE explicit bracketed paste** (`ESC[200~` … `ESC[201~`), so the
 *      TUI's paste heuristic never runs on chunk boundaries and newlines inside the body can
 *      never be read as Enter. The Enter is a separate write OUTSIDE the bracket, after a
 *      settle. Inside the bracket newlines travel as `\r`, which is what a terminal emulator
 *      emits on paste (xterm.js) and what claude's composer expects there — the same convention
 *      `apps/vscode/src/review-queue/queue.ts` already uses to type a review into a builder.
 *
 * This replaces the #584-era per-line pacing for frames of {@link BRACKET_MIN_LINES} lines or
 * more, which was tuned against an older TUI's heuristic. Short frames keep the pre-existing
 * single write + delayed Enter, byte for byte, so `--raw` slash commands and short sends are
 * untouched.
 */
export const PASTE_CHUNK_BYTES = 512;
/** Gap between consecutive chunk writes; the reader drains a chunk in well under this. */
export const PASTE_CHUNK_GAP_MS = 5;
/** Settle between the paste's closing marker and the Enter that submits it (measured: 0/29 losses). */
export const PASTE_ENTER_DELAY_MS = 80;
/**
 * Frames LONGER than this many bytes, or of {@link BRACKET_MIN_LINES} lines or more, are
 * bracketed and chunked. Well under the 1,022-byte queue limit where the loss starts: the
 * field's smallest confirmed truncations were ~500-byte bodies, and a bracketed short paste
 * costs nothing on the measured harnesses.
 */
export const BRACKET_MIN_BYTES = 256;
/** The #584 threshold, kept: any frame of this many lines or more is never typed line by line. */
export const BRACKET_MIN_LINES = 4;
/** Gap between line pieces on the non-bracketed (opt-out) strategy — the #584 pacing. */
const INTER_LINE_DELAY_MS = 10;

export const PASTE_BEGIN = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/**
 * Per-harness write strategy (Issue #1567). Bracketed paste is measured safe on claude
 * (2.1.263) and codex (0.146.0); a harness that has not been measured can opt out and gets the
 * pre-#1567 per-line semantics, still chunked so no write exceeds the PTY input queue.
 */
export interface WriteStrategy {
  /** Wrap long frames in bracketed-paste markers (with `\n` → `\r` inside). */
  bracketedPaste: boolean;
}

export const BRACKETED_PASTE: WriteStrategy = { bracketedPaste: true };
export const PLAIN_CHUNKED: WriteStrategy = { bracketedPaste: false };

/**
 * The write strategy for a gate profile's `app`. agy is the one modeled harness whose paste
 * handling was not measurable (unauthenticated), so it keeps the per-line shape; anything
 * else is bracketed. Unknown apps never reach the write edge (the gate holds `no-profile`).
 */
export function writeStrategyForApp(app: string | undefined): WriteStrategy {
  return app === 'agy' ? PLAIN_CHUNKED : BRACKETED_PASTE;
}

/** Does this frame take the bracketed/chunked path rather than the single short write? */
export function isLongFrame(message: string): boolean {
  return message.split('\n').length >= BRACKET_MIN_LINES || Buffer.byteLength(message, 'utf8') > BRACKET_MIN_BYTES;
}

/**
 * Split `text` into pieces of at most `max` bytes, never inside a UTF-8 sequence (a split
 * continuation byte would reach the TUI as two invalid characters).
 */
export function chunkForPty(text: string, max: number = PASTE_CHUNK_BYTES): string[] {
  const buf = Buffer.from(text, 'utf8');
  const out: string[] = [];
  for (let at = 0; at < buf.length; ) {
    let end = Math.min(buf.length, at + max);
    while (end < buf.length && end > at && (buf[end] & 0xc0) === 0x80) end--;
    out.push(buf.subarray(at, end).toString('utf8'));
    at = end;
  }
  return out;
}

/**
 * The pieces of a long frame, in write order, for a strategy. Bracketed: the body (newlines
 * as `\r`) chunked, with the opening marker on the first piece and the closing marker on the
 * last — the markers are never split across writes, so no chunk boundary can land inside an
 * escape sequence, and every piece INCLUDING its marker stays within {@link PASTE_CHUNK_BYTES}.
 * Plain: one piece per line (`\n` kept, as #584 wrote it), with any line over
 * the chunk size split further.
 */
export function framePieces(message: string, strategy: WriteStrategy): string[] {
  if (strategy.bracketedPaste) {
    // A literal paste marker inside the body (a pasted terminal log, say) would end or restart
    // the paste mid-frame and let the remainder be typed as keys; strip both so the bracket
    // we add is the only one the TUI sees.
    const body = message.replace(/\r?\n/g, '\r').split(PASTE_BEGIN).join('').split(PASTE_END).join('');
    // Chunk with room for the markers so NO write — first or last piece included — exceeds
    // PASTE_CHUNK_BYTES on the wire.
    const pieces = chunkForPty(body, PASTE_CHUNK_BYTES - PASTE_BEGIN.length - PASTE_END.length);
    pieces[0] = PASTE_BEGIN + pieces[0];
    pieces[pieces.length - 1] += PASTE_END;
    return pieces;
  }
  const lines = message.split('\n');
  return lines.flatMap((line, i) => chunkForPty(i < lines.length - 1 ? line + '\n' : line));
}

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
 * Write a message to a PTY session (Bugfix #584, Issue #1567).
 *
 * Short frames (under {@link BRACKET_MIN_LINES} lines AND at most {@link BRACKET_MIN_BYTES}
 * bytes): a single write, then Enter after 50 ms — unchanged since #584.
 *
 * Long frames: {@link framePieces} written {@link PASTE_CHUNK_GAP_MS} apart (bracketed by
 * default; see {@link WriteStrategy}), then Enter as its own write
 * {@link PASTE_ENTER_DELAY_MS} after the last piece. The Enter is always outside the paste
 * bracket, so a TUI that collapses the paste into a placard still submits it.
 *
 * @param delayOffset  ms offset for all scheduled writes (used to serialize
 *                     multiple messages to the same session without interleaving)
 * @returns            ms timestamp (from call time) when all writes complete
 */
export function writeMessageToSession(
  session: WritableSession,
  message: string,
  noEnter: boolean,
  delayOffset = 0,
  strategy: WriteStrategy = BRACKETED_PASTE,
): number {
  if (!isLongFrame(message)) {
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

  const pieces = framePieces(message, strategy);
  const gap = strategy.bracketedPaste ? PASTE_CHUNK_GAP_MS : INTER_LINE_DELAY_MS;
  for (let i = 0; i < pieces.length; i++) {
    const at = delayOffset + i * gap;
    if (at === 0) {
      session.write(pieces[i]);
    } else {
      setTimeout(() => session.write(pieces[i]), at);
    }
  }

  const lastPieceTime = delayOffset + (pieces.length - 1) * gap;
  if (noEnter) return lastPieceTime;
  const enterTime = lastPieceTime + PASTE_ENTER_DELAY_MS;
  setTimeout(() => session.write('\r'), enterTime);
  return enterTime;
}

/**
 * Outcome of a {@link submitMessagePaced} attempt. Generic in the caller's own abort
 * vocabulary so this module stays free of mailbox concepts — the delivery layer
 * instantiates `A` with its hold reasons.
 */
export type PacedSubmitResult<A> =
  /** The whole submit — text and, unless `noEnter`, the trailing Enter — reached the PTY. */
  | { status: 'written' }
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
  session: WritableSession & { id: string },
  message: string,
  noEnter: boolean,
  precheck: () => A | null,
  clock?: SubmitClock,
  strategy: WriteStrategy = BRACKETED_PASTE,
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
    const tracked: WritableSession = {
      write: (data: string): boolean => {
        const ok = session.write(data);
        if (!ok) delivered = false;
        return ok;
      },
    };

    const ran = await trySubmitToSession(
      session.id,
      () => {
        abort = precheck();
        if (abort !== null) return 0; // refused in-lock: not one byte goes out
        return writeMessageToSession(tracked, message, noEnter, 0, strategy);
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
    return { status: 'written' };
  } finally {
    bypasses.release();
  }
}
