/**
 * Regression test for Bugfix #584: afx send multi-line messages (>3 lines)
 * treated as paste, final Enter swallowed.
 *
 * Verifies that writeMessageToSession paces multi-line output line-by-line
 * with delays to prevent paste detection, while short messages are still
 * written in a single call.
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

    writeMessageToSession(session, msg, false);

    // Message written in one shot
    expect(session.writeCalls).toEqual([msg]);

    // Enter arrives after 50ms
    vi.advanceTimersByTime(50);
    expect(session.writeCalls).toEqual([msg, '\r']);
  });

  it('paces multi-line messages (>3 lines) line-by-line with delays', () => {
    const session = makeSession();
    const msg = 'line1\nline2\nline3\nline4';

    writeMessageToSession(session, msg, false);

    // First line written immediately
    expect(session.writeCalls).toEqual(['line1\n']);

    // Lines 2-4 arrive with 10ms, 20ms, 30ms delays
    vi.advanceTimersByTime(10);
    expect(session.writeCalls).toEqual(['line1\n', 'line2\n']);

    vi.advanceTimersByTime(10);
    expect(session.writeCalls).toEqual(['line1\n', 'line2\n', 'line3\n']);

    vi.advanceTimersByTime(10);
    expect(session.writeCalls).toEqual(['line1\n', 'line2\n', 'line3\n', 'line4']);

    // Enter arrives after totalPacing (30ms) + 80ms = at 110ms from start
    // We're at 30ms now, so advance 80ms more
    vi.advanceTimersByTime(80);
    expect(session.writeCalls).toEqual(['line1\n', 'line2\n', 'line3\n', 'line4', '\r']);
  });

  it('respects noEnter=true for short messages', () => {
    const session = makeSession();
    writeMessageToSession(session, 'short', true);

    vi.advanceTimersByTime(200);
    expect(session.writeCalls).toEqual(['short']);
  });

  it('respects noEnter=true for multi-line messages', () => {
    const session = makeSession();
    const msg = 'l1\nl2\nl3\nl4\nl5';

    writeMessageToSession(session, msg, true);
    vi.advanceTimersByTime(500);

    // All lines written, but no \r
    expect(session.writeCalls).toEqual(['l1\n', 'l2\n', 'l3\n', 'l4\n', 'l5']);
  });

  it('handles formatted architect message (realistic multi-line)', () => {
    const session = makeSession();
    // Realistic formatted message: header + 2 content lines + footer = 4 lines
    const msg = '### [ARCHITECT INSTRUCTION | 2026-04-04T00:00:00.000Z] ###\nDo this thing\nAnd that thing\n###############################';

    writeMessageToSession(session, msg, false);

    // First line immediately
    expect(session.writeCalls[0]).toBe('### [ARCHITECT INSTRUCTION | 2026-04-04T00:00:00.000Z] ###\n');

    // All lines delivered after enough time
    vi.advanceTimersByTime(30);
    expect(session.writeCalls).toHaveLength(4);

    // Enter delivered after pacing + 80ms
    vi.advanceTimersByTime(80);
    expect(session.writeCalls[session.writeCalls.length - 1]).toBe('\r');
  });

  it('single-line message written in one shot without pacing', () => {
    const session = makeSession();
    writeMessageToSession(session, 'hello', false);

    expect(session.writeCalls).toEqual(['hello']);
    vi.advanceTimersByTime(50);
    expect(session.writeCalls).toEqual(['hello', '\r']);
  });
});
