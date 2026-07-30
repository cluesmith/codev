/**
 * Paced message writing for PTY sessions (Bugfix #584).
 *
 * Extracted to a shared module to avoid circular imports between
 * tower-routes.ts and tower-cron.ts.
 */

/** Minimal writable session interface — avoids coupling to PtySession. */
export interface WritableSession {
  write(data: string): void;
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
