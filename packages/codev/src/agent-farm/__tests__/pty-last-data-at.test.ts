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

/**
 * Spec 1273: the tracking above has existed since Spec 467, but only as an
 * in-process getter — it never reached `info`, which is what
 * `GET /api/terminals/:id` serialises. Without it on the wire, a client cannot
 * measure output quiescence and `afx reset` would have to *assume* a builder's
 * turn had ended before typing `/clear` into its terminal. Invariant R4 requires
 * measuring instead of assuming, so these tests pin the field's presence on the
 * serialised shape, not merely on the class.
 */
describe('PtySession.info.lastDataAt (Spec 1273 — quiescence on the wire)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes lastDataAt on info as an epoch-ms number', () => {
    const session = createSession();

    expect(typeof session.info.lastDataAt).toBe('number');
    expect(session.info.lastDataAt).toBe(session.lastDataAt);
  });

  it('advances info.lastDataAt when the PTY produces output', () => {
    const session = createSession();
    const before = session.info.lastDataAt;

    vi.advanceTimersByTime(3000);
    (session as any).onPtyData('spinner frame');

    expect(session.info.lastDataAt).toBe(before + 3000);
  });

  it('holds info.lastDataAt steady while the PTY is silent — the quiescence signal', () => {
    const session = createSession();

    (session as any).onPtyData('turn output');
    const atLastOutput = session.info.lastDataAt;

    // A quiet stretch: this is exactly what reset waits for before typing.
    vi.advanceTimersByTime(10_000);

    expect(session.info.lastDataAt).toBe(atLastOutput);
    expect(Date.now() - session.info.lastDataAt).toBe(10_000);
  });

  it('keeps info.lastDataAt in sync with the getter across successive outputs', () => {
    const session = createSession();

    vi.advanceTimersByTime(1000);
    (session as any).onPtyData('one');
    expect(session.info.lastDataAt).toBe(session.lastDataAt);

    vi.advanceTimersByTime(1000);
    (session as any).onPtyData('two');
    expect(session.info.lastDataAt).toBe(session.lastDataAt);
  });
});

/**
 * PtySessionInfo.writable (Spec 1273)
 *
 * `afx reset` preflights on this field so it refuses a terminal it cannot write
 * to before touching anything. That only works if `writable` is actually
 * SERIALISED — the getter existed since #1198 but never reached `info`, so no
 * client could see it.
 */
describe('PtySessionInfo.writable (Spec 1273)', () => {
  it('is serialised in info, not just available as a getter', () => {
    const session = createSession();
    expect(session.info).toHaveProperty('writable');
  });

  it('agrees with the writable getter', () => {
    const session = createSession();
    expect(session.info.writable).toBe(session.writable);
  });

  it('reports false while status still says running — the #1198 disagreement', () => {
    // This is the exact shape reset preflights against, and it needs no
    // contrivance to produce: a session with no live backend has
    // `exitCode === undefined`, so `status` is 'running', while `writable` is
    // false because there is nothing to write to. A caller trusting `status`
    // would send into a void; reset reads `writable` instead.
    const session = createSession();

    expect(session.info.status).toBe('running');
    expect(session.info.writable).toBe(false);
  });
});
