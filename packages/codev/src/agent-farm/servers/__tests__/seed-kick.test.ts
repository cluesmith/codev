/**
 * Tests for the seed-kick module (Issue #1201) — readiness-gated,
 * store-verified first-message delivery for seed-style builder harnesses.
 *
 * The state machine under test: wait for sentinel → grace → write kick →
 * poll store for submission → (re-send Enter → re-send kick once → loud warn).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { armSeedKick, parseSeedKick, type SeedKickOptions } from '../seed-kick.js';
import type { KimiSessionState } from '../../utils/kimi-session-discovery.js';

class FakeSession extends EventEmitter {
  writes: string[] = [];
  write(data: string): void {
    this.writes.push(data);
  }
}

const SENTINEL = '__CODEV_KIMI_SEED_DONE__';

function opts(overrides?: Partial<SeedKickOptions>): SeedKickOptions {
  return {
    sentinel: SENTINEL,
    message: 'BEGIN',
    graceMs: 2500,
    enterDelayMs: 1000,
    verify: { kind: 'kimi-session-store', worktreePath: '/tmp/wt' },
    ...overrides,
  };
}

describe('parseSeedKick', () => {
  it('accepts a full valid payload', () => {
    expect(parseSeedKick({
      sentinel: SENTINEL, message: 'BEGIN', graceMs: 2000, enterDelayMs: 900,
      verify: { kind: 'kimi-session-store', worktreePath: '/wt' },
    })).toEqual({
      sentinel: SENTINEL, message: 'BEGIN', graceMs: 2000, enterDelayMs: 900,
      verify: { kind: 'kimi-session-store', worktreePath: '/wt' },
    });
  });

  it('rejects malformed payloads (null, missing fields, wrong types) without throwing', () => {
    expect(parseSeedKick(undefined)).toBeNull();
    expect(parseSeedKick(null)).toBeNull();
    expect(parseSeedKick('BEGIN')).toBeNull();
    expect(parseSeedKick({ message: 'BEGIN' })).toBeNull();
    expect(parseSeedKick({ sentinel: SENTINEL })).toBeNull();
    expect(parseSeedKick({ sentinel: '', message: 'BEGIN' })).toBeNull();
  });

  it('drops an unknown verify kind but keeps the kick', () => {
    const parsed = parseSeedKick({
      sentinel: SENTINEL, message: 'BEGIN',
      verify: { kind: 'something-else', worktreePath: '/wt' },
    });
    expect(parsed).toEqual({ sentinel: SENTINEL, message: 'BEGIN' });
  });
});

describe('armSeedKick', () => {
  let session: FakeSession;
  let log: ReturnType<typeof vi.fn>;
  let storeState: KimiSessionState | null;
  const readSessionState = vi.fn((_id: string) => storeState);

  beforeEach(() => {
    vi.useFakeTimers();
    session = new FakeSession();
    log = vi.fn();
    storeState = null;
    readSessionState.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function arm(o: SeedKickOptions = opts()): void {
    armSeedKick(session, o, log, { readSessionState });
  }

  /** All bytes written so far, concatenated. */
  const written = () => session.writes.join('');

  it('writes NOTHING before the sentinel (seed-window write-loss regression)', () => {
    arm();
    session.emit('data', 'Seeding Kimi session...\r\n');
    vi.advanceTimersByTime(60_000);
    expect(session.writes).toEqual([]);
  });

  it('delivers the kick after sentinel + grace, with the harness Enter delay', () => {
    arm();
    session.emit('data', `${SENTINEL} session_abc-123\r\n`);
    // Inside the grace window: still nothing.
    vi.advanceTimersByTime(2_499);
    expect(session.writes).toEqual([]);
    // Grace elapses → message body written; Enter comes after enterDelayMs.
    vi.advanceTimersByTime(1);
    expect(written()).toBe('BEGIN');
    vi.advanceTimersByTime(999);
    expect(written()).toBe('BEGIN');
    vi.advanceTimersByTime(1);
    expect(written()).toBe('BEGIN\r');
  });

  it('detects the sentinel across chunked data events', () => {
    arm();
    session.emit('data', '__CODEV_KIMI_SEED');
    session.emit('data', '_DONE__ session_split');
    session.emit('data', '-id\r\n');
    vi.advanceTimersByTime(2_500 + 1_000);
    expect(written()).toBe('BEGIN\r');
  });

  it('stops polling and logs success once the store confirms submission', () => {
    arm();
    session.emit('data', `${SENTINEL} session_ok\r\n`);
    vi.advanceTimersByTime(2_500 + 1_000); // kick fully written
    storeState = { workDir: '/tmp/wt', updatedAt: '2026-07-18T10:00:00Z', lastPrompt: 'BEGIN' };
    vi.advanceTimersByTime(1_000); // first poll
    expect(readSessionState).toHaveBeenCalledWith('session_ok');
    expect(log).toHaveBeenCalledWith('INFO', expect.stringContaining('confirmed submitted'));
    const writesAtConfirm = session.writes.length;
    vi.advanceTimersByTime(60_000);
    expect(session.writes.length).toBe(writesAtConfirm); // no retries after confirm
  });

  it('escalates: re-send Enter → re-send kick once → loud warn', () => {
    arm();
    session.emit('data', `${SENTINEL} session_stuck\r\n`);
    vi.advanceTimersByTime(2_500 + 1_000);
    expect(written()).toBe('BEGIN\r');

    // Stage 1 exhausts (8 polls @1s) → bare Enter re-sent.
    vi.advanceTimersByTime(8_000);
    expect(written()).toBe('BEGIN\r\r');
    expect(log).toHaveBeenCalledWith('WARN', expect.stringContaining('re-sending Enter'));

    // Stage 2 exhausts → the whole kick re-sent once.
    vi.advanceTimersByTime(8_000 + 1_000);
    expect(written()).toContain('BEGIN\r\rBEGIN');

    // Stage 3 exhausts → loud final warning, no further writes.
    const before = session.writes.length;
    vi.advanceTimersByTime(8_000);
    expect(log).toHaveBeenCalledWith('WARN', expect.stringContaining('Could not confirm delivery'));
    vi.advanceTimersByTime(60_000);
    expect(session.writes.length).toBe(before);
  });

  it('a swallowed Enter is healed by the Enter re-send (dominant failure mode)', () => {
    arm();
    session.emit('data', `${SENTINEL} session_swallow\r\n`);
    vi.advanceTimersByTime(2_500 + 1_000);
    // Body sat in the composer; only after the Enter re-send does the store confirm.
    vi.advanceTimersByTime(8_000); // Enter re-sent here
    storeState = { workDir: '/tmp/wt', updatedAt: '2026-07-18T10:00:05Z', lastPrompt: 'BEGIN' };
    vi.advanceTimersByTime(1_000);
    expect(log).toHaveBeenCalledWith('INFO', expect.stringContaining('confirmed submitted'));
    // Never escalated to a kick re-send.
    expect(written()).toBe('BEGIN\r\r');
  });

  it('the SEED prompt containing the kick word is NOT confirmation (fresh-spawn false-positive regression)', () => {
    // PR-consultation finding (codex, PIR #1201): on a fresh spawn,
    // lastPrompt initially holds the SEED prompt, whose ack-and-wait wrapper
    // mentions BEGIN ("wait for BEGIN"). A substring check would report the
    // kick submitted before it was ever written, so a swallowed Enter would
    // never be healed. Confirmation must require normalized EQUALITY.
    arm();
    session.emit('data', `${SENTINEL} session_seeded\r\n`);
    // Store state as the seed leaves it: lastPrompt = the full seed prompt.
    storeState = {
      workDir: '/tmp/wt',
      updatedAt: '2026-07-18T10:00:00Z',
      lastPrompt: 'Strict discipline: wait. You will receive a message "BEGIN" in a later turn.\n=== TASK BRIEFING (do not act until BEGIN) ===\ndo the thing',
    };
    vi.advanceTimersByTime(2_500 + 1_000);
    // The kick's Enter was swallowed; lastPrompt stays the seed prompt.
    // Stage 1 must exhaust and re-send Enter — NOT report success.
    vi.advanceTimersByTime(8_000);
    expect(log).not.toHaveBeenCalledWith('INFO', expect.stringContaining('confirmed submitted'));
    expect(log).toHaveBeenCalledWith('WARN', expect.stringContaining('re-sending Enter'));
    expect(written()).toBe('BEGIN\r\r');
    // The re-sent Enter lands the kick: lastPrompt becomes exactly BEGIN.
    storeState = { workDir: '/tmp/wt', updatedAt: '2026-07-18T10:00:20Z', lastPrompt: 'BEGIN' };
    vi.advanceTimersByTime(1_000);
    expect(log).toHaveBeenCalledWith('INFO', expect.stringContaining('confirmed submitted'));
  });

  it('confirmation tolerates the observed newline-flattening of submitted messages', () => {
    // Submitted multi-line messages land in lastPrompt with newlines
    // flattened to spaces (observed on kimi 0.27.0) — normalized equality
    // must still confirm a multi-line kick payload.
    arm(opts({ message: 'line one\nline two' }));
    session.emit('data', `${SENTINEL} session_flat\r\n`);
    vi.advanceTimersByTime(2_500 + 1_000);
    storeState = { workDir: '/tmp/wt', updatedAt: '2026-07-18T10:00:05Z', lastPrompt: 'line one line two' };
    vi.advanceTimersByTime(1_000);
    expect(log).toHaveBeenCalledWith('INFO', expect.stringContaining('confirmed submitted'));
  });

  it('updatedAt movement alone is NOT treated as confirmation', () => {
    arm();
    session.emit('data', `${SENTINEL} session_touch\r\n`);
    vi.advanceTimersByTime(2_500 + 1_000);
    // Store touched by the TUI opening — lastPrompt still absent.
    storeState = { workDir: '/tmp/wt', updatedAt: '2026-07-18T10:00:09Z', lastPrompt: null };
    vi.advanceTimersByTime(8_000);
    expect(log).toHaveBeenCalledWith('WARN', expect.stringContaining('re-sending Enter'));
  });

  it('skips verification when no verify descriptor is present', () => {
    arm(opts({ verify: undefined }));
    session.emit('data', `${SENTINEL} session_noverify\r\n`);
    vi.advanceTimersByTime(2_500 + 1_000);
    expect(written()).toBe('BEGIN\r');
    vi.advanceTimersByTime(60_000);
    expect(readSessionState).not.toHaveBeenCalled();
    expect(session.writes.length).toBe(2); // body + Enter, no retries
  });

  it('warns loudly when the sentinel never appears', () => {
    arm();
    session.emit('data', 'ERROR: Kimi seed failed\r\n');
    vi.advanceTimersByTime(180_000);
    expect(log).toHaveBeenCalledWith('WARN', expect.stringContaining('sentinel never appeared'));
    expect(session.writes).toEqual([]);
    // A late sentinel after the timeout must not trigger a zombie kick.
    session.emit('data', `${SENTINEL} session_late\r\n`);
    vi.advanceTimersByTime(60_000);
    expect(session.writes).toEqual([]);
  });
});
