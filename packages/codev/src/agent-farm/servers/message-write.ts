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
