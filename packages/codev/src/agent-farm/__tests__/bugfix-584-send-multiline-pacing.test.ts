/**
 * Regression test for Bugfix #584: afx send multi-line messages (>3 lines)
 * treated as paste, final Enter swallowed.
 *
 * Verifies that writeMessageToSession paces multi-line output line-by-line
 * with delays to prevent paste detection, while short messages are still
 * written in a single call. Also tests delayOffset serialization to prevent
 * interleaved writes when multiple messages flush to the same session.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeMessageToSession } from '../servers/tower-routes.js';
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

  it('paces multi-line messages (>3 lines) line-by-line with delays', () => {
    const session = makeSession();
    const msg = 'line1\nline2\nline3\nline4';

    const endTime = writeMessageToSession(session, msg, false);

    // First line written immediately
    expect(session.writeCalls).toEqual(['line1\n']);

    // Lines 2-4 arrive with 10ms, 20ms, 30ms delays
    vi.advanceTimersByTime(10);
    expect(session.writeCalls).toEqual(['line1\n', 'line2\n']);

    vi.advanceTimersByTime(10);
    expect(session.writeCalls).toEqual(['line1\n', 'line2\n', 'line3\n']);

    vi.advanceTimersByTime(10);
    expect(session.writeCalls).toEqual(['line1\n', 'line2\n', 'line3\n', 'line4']);

    // Enter arrives after totalPacing (30ms) + 80ms = 110ms from start
    vi.advanceTimersByTime(80);
    expect(session.writeCalls).toEqual(['line1\n', 'line2\n', 'line3\n', 'line4', '\r']);
    expect(endTime).toBe(110);
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

    // All lines written, but no \r
    expect(session.writeCalls).toEqual(['l1\n', 'l2\n', 'l3\n', 'l4\n', 'l5']);
    expect(endTime).toBe(40); // (5-1) * 10 = 40ms for last line
  });

  it('handles formatted architect message (realistic multi-line)', () => {
    const session = makeSession();
    // Realistic formatted message: header + 2 content lines + footer = 4 lines
    const msg = '### [ARCHITECT INSTRUCTION | 2026-04-04T00:00:00.000Z] ###\nDo this thing\nAnd that thing\n###############################';

    const endTime = writeMessageToSession(session, msg, false);

    // First line immediately
    expect(session.writeCalls[0]).toBe('### [ARCHITECT INSTRUCTION | 2026-04-04T00:00:00.000Z] ###\n');

    // All lines delivered after enough time
    vi.advanceTimersByTime(30);
    expect(session.writeCalls).toHaveLength(4);

    // Enter delivered after pacing + 80ms
    vi.advanceTimersByTime(80);
    expect(session.writeCalls[session.writeCalls.length - 1]).toBe('\r');
    expect(endTime).toBe(110); // 30ms pacing + 80ms enter
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

    it('multi-line message with delayOffset defers all lines', () => {
      const session = makeSession();
      const msg = 'a\nb\nc\nd';
      const endTime = writeMessageToSession(session, msg, false, 200);

      // Nothing written before offset
      expect(session.writeCalls).toEqual([]);

      // First line at 200ms
      vi.advanceTimersByTime(200);
      expect(session.writeCalls).toEqual(['a\n']);

      // Remaining lines at 210, 220, 230ms
      vi.advanceTimersByTime(30);
      expect(session.writeCalls).toEqual(['a\n', 'b\n', 'c\n', 'd']);

      // Enter at 230 + 80 = 310ms from start
      vi.advanceTimersByTime(80);
      expect(session.writeCalls).toEqual(['a\n', 'b\n', 'c\n', 'd', '\r']);
      expect(endTime).toBe(310);
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

      // Verify message 1 lines come before message 2 lines
      const writes = session.writeCalls;
      const a4Idx = writes.indexOf('A4');
      const enterAfterA = writes.indexOf('\r');
      const b1Idx = writes.indexOf('B1\n');

      expect(a4Idx).toBeLessThan(enterAfterA);
      expect(enterAfterA).toBeLessThan(b1Idx);

      // Both messages fully delivered with their own Enters
      const enterCount = writes.filter(w => w === '\r').length;
      expect(enterCount).toBe(2);
    });
  });
});
