/**
 * Paced message writing for PTY sessions (Bugfix #584).
 *
 * Extracted to a shared module to avoid circular imports between
 * tower-routes.ts and tower-cron.ts.
 */

/** Minimal writable session interface — avoids coupling to PtySession. */
export interface WritableSession {
  /**
   * Write input to the underlying PTY. Returns `false` when the write was dropped
   * (#1198: a shellper-backed session whose socket has died still reports status
   * 'running', yet its writes silently no-op). {@link writeMessagePaced} threads this
   * boolean so a mailbox delivery whose bytes never reached the terminal is held, not
   * marked delivered (Spec 1313 integration review — the silent-loss finding).
   */
  write(data: string): boolean;
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
 * Per-harness pacing override (Issue #1201). Some CLIs have a longer
 * paste-detection window than the defaults assume — Kimi silently swallows an
 * Enter that arrives 80ms after the message body (1s works, observed), so
 * messages to a Kimi PTY never submit under the default delays. When set,
 * `enterDelayMs` replaces BOTH default Enter delays; all other timing
 * (line pacing, thresholds) is unchanged.
 */
export interface MessagePacing {
  enterDelayMs?: number;
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
 * @param pacing       optional per-harness timing override (Issue #1201)
 * @returns            ms timestamp (from call time) when all writes complete
 */
export function writeMessageToSession(
  session: WritableSession, message: string, noEnter: boolean, delayOffset = 0,
  pacing?: MessagePacing,
): number {
  const lines = message.split('\n');

  if (lines.length < PACED_WRITE_LINE_THRESHOLD) {
    // Short messages: single write (existing behavior, works fine)
    if (delayOffset === 0) {
      session.write(message);
    } else {
      setTimeout(() => session.write(message), delayOffset);
    }
    const enterTime = delayOffset + (pacing?.enterDelayMs ?? SIMPLE_ENTER_DELAY_MS);
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
    const enterTime = lastLineTime + (pacing?.enterDelayMs ?? PACED_ENTER_DELAY_MS);
    setTimeout(() => session.write('\r'), enterTime);
    return enterTime;
  }
  return lastLineTime;
}

/**
 * Paced write of a message (text + trailing Enter unless `noEnter`) that reports
 * whether every byte reached the PTY. Resolves `true` when the whole submit landed,
 * `false` when ANY scheduled write was dropped (#1198: a shellper socket that died
 * mid-pace). This is the delivery layer's authoritative success signal — a mailbox
 * delivery holds a row whose bytes never made it instead of marking it delivered
 * (Spec 1313 integration review — the silent-loss finding).
 *
 * `writeMessageToSession` fires the text, any subsequent lines, and the trailing
 * Enter across `setTimeout` gaps (10–130ms+), and a t=0 `writable` precheck cannot
 * see a socket that dies *during* that sequence. So wrap the session and record
 * whether any of those writes returned false. The returned promise resolves at the
 * final scheduled offset (`doneMs`); `writeMessageToSession` registers the Enter's
 * `setTimeout` at that same offset *before* this resolve is scheduled, so the Enter
 * executes first and its result is observed by resolution time.
 *
 * Awaiting the promise is also what makes the per-agent write serializer's
 * completion-chaining real — the next delivery cannot begin until this submit
 * (Enter included) is entirely on the wire.
 *
 * `pacing` (Issue #1201) is the per-harness timing override; the mailbox wiring
 * resolves it from the target session's harness. It only moves the Enter later,
 * so the promise still resolves at whatever `doneMs` this call actually
 * scheduled — a slower Enter is awaited, never raced.
 */
export function writeMessagePaced(
  session: WritableSession, message: string, noEnter: boolean,
  pacing?: MessagePacing,
): Promise<boolean> {
  let delivered = true;
  const tracked: WritableSession = {
    write: (data: string): boolean => {
      const ok = session.write(data);
      if (!ok) delivered = false;
      return ok;
    },
  };
  const doneMs = writeMessageToSession(tracked, message, noEnter, 0, pacing);
  return new Promise((resolve) => setTimeout(() => resolve(delivered), doneMs));
}
