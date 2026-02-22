/**
 * Tests for PtySession.lastDataAt tracking (Spec 467)
 *
 * Tests lastDataAt initialization and update behavior via the private
 * onPtyData method, without needing to spawn a real PTY process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node-pty to avoid native module dependency
vi.mock('node-pty', () => ({
  spawn: () => ({
    onData: () => {},
    onExit: () => {},
    write: () => {},
    resize: () => {},
    kill: () => {},
    pid: 12345,
  }),
}));

const { PtySession } = await import('../../terminal/pty-session.js');

function createSession(): InstanceType<typeof PtySession> {
  return new PtySession({
    id: 'test-session',
    label: 'Test Shell',
    command: '/bin/bash',
    args: [],
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    logDir: '/tmp',
    env: {},
  });
}

describe('PtySession.lastDataAt (Spec 467)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-21T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('initializes lastDataAt to Date.now() at construction', () => {
    const session = createSession();
    expect(session.lastDataAt).toBe(Date.now());
  });

  it('initializes lastDataAt differently from lastInputAt', () => {
    const session = createSession();
    // lastInputAt starts at 0, lastDataAt starts at Date.now()
    // This ensures new shells appear as "running" not "idle"
    expect(session.lastInputAt).toBe(0);
    expect(session.lastDataAt).toBeGreaterThan(0);
  });

  it('updates lastDataAt when onPtyData is called', () => {
    const session = createSession();
    const initialTime = session.lastDataAt;

    // Advance time by 5 seconds
    vi.advanceTimersByTime(5000);

    // Trigger onPtyData directly (bypasses need for spawn/node-pty)
    (session as any).onPtyData('some output data');

    expect(session.lastDataAt).toBe(initialTime + 5000);
  });

  it('does not update lastDataAt without PTY output', () => {
    const session = createSession();
    const initialTime = session.lastDataAt;

    // Advance time by 60 seconds — no PTY output
    vi.advanceTimersByTime(60000);

    expect(session.lastDataAt).toBe(initialTime);
  });

  it('updates lastDataAt on each PTY output event', () => {
    const session = createSession();

    vi.advanceTimersByTime(1000);
    (session as any).onPtyData('output 1');
    const time1 = session.lastDataAt;

    vi.advanceTimersByTime(2000);
    (session as any).onPtyData('output 2');
    const time2 = session.lastDataAt;

    expect(time2).toBe(time1 + 2000);
  });
});
