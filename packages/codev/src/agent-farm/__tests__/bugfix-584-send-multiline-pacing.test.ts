/**
 * Regression test for Bugfix #584: afx send multi-line messages (>3 lines)
 * treated as paste, final Enter swallowed.
 *
 * The #584 property is that the Enter is never swallowed: it is always a SEPARATE write
 * after the body has landed. How the body itself travels changed in Issue #1567 — a frame
 * of 4+ lines is now one explicit bracketed paste (newlines as `\r` inside) rather than
 * line-by-line writes — so the multi-line cases here pin that shape; the short-message
 * single write is unchanged. Also tests delayOffset serialization to prevent interleaved
 * writes when multiple messages flush to the same session.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  writeMessageToSession,
  PASTE_BEGIN,
  PASTE_END,
  PASTE_ENTER_DELAY_MS,
} from '../servers/message-write.js';

/** The one-piece bracketed form of a short multi-line body (Issue #1567). */
const pasted = (body: string) => PASTE_BEGIN + body.replace(/\n/g, '\r') + PASTE_END;
import type { PtySession } from '../../terminal/pty-session.js';

function makeSession(): PtySession & { writeCalls: string[] } {
  const writeCalls: string[] = [];
  return {
    write: vi.fn((data: string) => writeCalls.push(data)),
    writeCalls,
  } as unknown as PtySession & { writeCalls: string[] };
}

describe('writeMessageToSession (Bugfix #584)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes short messages (≤3 lines) in a single call', () => {
    const session = makeSession();
    const msg = 'line1\nline2\nline3';

    const endTime = writeMessageToSession(session, msg, false);

    // Message written in one shot
    expect(session.writeCalls).toEqual([msg]);

    // Enter arrives after 50ms
    vi.advanceTimersByTime(50);
    expect(session.writeCalls).toEqual([msg, '\r']);
    expect(endTime).toBe(50);
  });

  it('sends multi-line messages (>3 lines) as one bracketed paste, Enter separate', () => {
    const session = makeSession();
    const msg = 'line1\nline2\nline3\nline4';

    const endTime = writeMessageToSession(session, msg, false);

    // The whole body goes out as ONE bracketed piece (it is well under the chunk size)…
    expect(session.writeCalls).toEqual([pasted(msg)]);

    // …and the Enter is a separate write after the settle — never inside the paste, so a
    // TUI that treats the burst as a paste cannot swallow it (the #584 failure).
    vi.advanceTimersByTime(PASTE_ENTER_DELAY_MS - 1);
    expect(session.writeCalls).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(session.writeCalls).toEqual([pasted(msg), '\r']);
    expect(endTime).toBe(PASTE_ENTER_DELAY_MS);
  });

  it('respects noEnter=true for short messages', () => {
    const session = makeSession();
    const endTime = writeMessageToSession(session, 'short', true);

    vi.advanceTimersByTime(200);
    expect(session.writeCalls).toEqual(['short']);
    expect(endTime).toBe(50); // duration still reported
  });

  it('respects noEnter=true for multi-line messages', () => {
    const session = makeSession();
    const msg = 'l1\nl2\nl3\nl4\nl5';

    const endTime = writeMessageToSession(session, msg, true);
    vi.advanceTimersByTime(500);

    // The paste went out, but no \r
    expect(session.writeCalls).toEqual([pasted(msg)]);
    expect(endTime).toBe(0); // one piece, written synchronously
  });

  it('handles formatted architect message (realistic multi-line)', () => {
    const session = makeSession();
    // Realistic formatted message: header + 2 content lines + footer = 4 lines
    const msg = '### [ARCHITECT INSTRUCTION | 2026-04-04T00:00:00.000Z] ###\nDo this thing\nAnd that thing\n###############################';

    const endTime = writeMessageToSession(session, msg, false);

    // The header opens the paste, immediately
    expect(session.writeCalls[0]).toBe(pasted(msg));
    expect(session.writeCalls[0].startsWith(PASTE_BEGIN + '### [ARCHITECT INSTRUCTION')).toBe(true);

    // Enter delivered after the settle
    vi.advanceTimersByTime(PASTE_ENTER_DELAY_MS);
    expect(session.writeCalls[session.writeCalls.length - 1]).toBe('\r');
    expect(endTime).toBe(PASTE_ENTER_DELAY_MS);
  });

  it('single-line message written in one shot without pacing', () => {
    const session = makeSession();
    const endTime = writeMessageToSession(session, 'hello', false);

    expect(session.writeCalls).toEqual(['hello']);
    vi.advanceTimersByTime(50);
    expect(session.writeCalls).toEqual(['hello', '\r']);
    expect(endTime).toBe(50);
  });

  describe('delayOffset serialization (prevents interleaving)', () => {
    it('short message with delayOffset defers the initial write', () => {
      const session = makeSession();
      const endTime = writeMessageToSession(session, 'hello', false, 100);

      // Nothing written yet
      expect(session.writeCalls).toEqual([]);

      // Message arrives at offset
      vi.advanceTimersByTime(100);
      expect(session.writeCalls).toEqual(['hello']);

      // Enter arrives at offset + 50ms
      vi.advanceTimersByTime(50);
      expect(session.writeCalls).toEqual(['hello', '\r']);
      expect(endTime).toBe(150);
    });

    it('multi-line message with delayOffset defers the paste', () => {
      const session = makeSession();
      const msg = 'a\nb\nc\nd';
      const endTime = writeMessageToSession(session, msg, false, 200);

      // Nothing written before offset
      expect(session.writeCalls).toEqual([]);

      // The paste at 200ms
      vi.advanceTimersByTime(200);
      expect(session.writeCalls).toEqual([pasted(msg)]);

      // Enter at 200 + 80 = 280ms from start
      vi.advanceTimersByTime(PASTE_ENTER_DELAY_MS);
      expect(session.writeCalls).toEqual([pasted(msg), '\r']);
      expect(endTime).toBe(200 + PASTE_ENTER_DELAY_MS);
    });

    it('two multi-line messages in sequence do not interleave', () => {
      const session = makeSession();
      const msg1 = 'A1\nA2\nA3\nA4';
      const msg2 = 'B1\nB2\nB3\nB4';

      // Simulate what SendBuffer.flush does: chain offsets
      const end1 = writeMessageToSession(session, msg1, false, 0);
      const end2 = writeMessageToSession(session, msg2, false, end1);

      // Advance through all timers
      vi.advanceTimersByTime(end2 + 100);

      // Verify message 1's paste and Enter come before message 2's paste
      const writes = session.writeCalls;
      const aIdx = writes.indexOf(pasted(msg1));
      const enterAfterA = writes.indexOf('\r');
      const bIdx = writes.indexOf(pasted(msg2));

      expect(aIdx).toBeLessThan(enterAfterA);
      expect(enterAfterA).toBeLessThan(bIdx);

      // Both messages fully delivered with their own Enters
      const enterCount = writes.filter(w => w === '\r').length;
      expect(enterCount).toBe(2);
    });
  });

  // =========================================================================
  // Issue #1201 — per-harness Enter-delay override. Kimi's paste-detection
  // window outlasts the 50/80ms defaults (an 80ms Enter is swallowed; 1s
  // submits — observed), so callers pass pacing.enterDelayMs for kimi targets.
  // =========================================================================

  describe('per-harness enterDelayMs override (Issue #1201)', () => {
    it('short message: Enter waits for the overridden delay', () => {
      const session = makeSession();
      const msg = 'BEGIN';

      const endTime = writeMessageToSession(session, msg, false, 0, { enterDelayMs: 1000 });
      expect(endTime).toBe(1000);

      // Default delay elapses — Enter must NOT have fired yet.
      vi.advanceTimersByTime(50);
      expect(session.writeCalls).toEqual([msg]);

      vi.advanceTimersByTime(950);
      expect(session.writeCalls).toEqual([msg, '\r']);
    });

    it('multi-line message: final Enter waits for the overridden delay after the last line', () => {
      const session = makeSession();
      const msg = 'line1\nline2\nline3\nline4';

      const endTime = writeMessageToSession(session, msg, false, 0, { enterDelayMs: 1000 });
      // Last line lands at 3 * 10ms; Enter at lastLine + 1000.
      expect(endTime).toBe(30 + 1000);

      vi.advanceTimersByTime(30 + 80);
      expect(session.writeCalls).not.toContain('\r');

      vi.advanceTimersByTime(1000 - 80);
      expect(session.writeCalls).toContain('\r');
    });

    it('no pacing argument → default delays unchanged (regression)', () => {
      const session = makeSession();
      expect(writeMessageToSession(session, 'hi', false)).toBe(50);
      const paced = makeSession();
      expect(writeMessageToSession(paced, 'a\nb\nc\nd', false)).toBe(30 + 80);
    });

    it('noEnter suppresses the Enter even with an override', () => {
      const session = makeSession();
      writeMessageToSession(session, 'BEGIN', true, 0, { enterDelayMs: 1000 });
      vi.advanceTimersByTime(5000);
      expect(session.writeCalls).toEqual(['BEGIN']);
    });
  });
});
