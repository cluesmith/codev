/**
 * Spec 1313 integration review — the dropped-PTY-write silent-loss fix.
 *
 * `PtySession.write()` returns false when the write was dropped (#1198: a shellper
 * socket that died still reports status 'running', yet its writes silently no-op).
 * Before this fix `WritableSession.write()` was typed `void`, so the paced writer
 * discarded the boolean and resolved on a pure timer — a message could be reported
 * `delivered` while zero bytes reached the terminal.
 *
 * The write edge threads the per-write result and reports `dropped` when ANY scheduled
 * write dropped. The load-bearing property the architect called out is that this must catch
 * BOTH the first (synchronous) write AND the DELAYED writes — the trailing Enter and the
 * per-line writes of a multi-line message — because a socket can die anywhere across the
 * 10–130ms+ paced sequence, not only at t=0. These tests drive the real pacing under fake
 * timers and assert the aggregate for each drop position.
 *
 * Issue #1365 re-pointed them from the retired `writeMessagePaced` onto `submitMessagePaced`,
 * which is the same paced write performed under the per-terminal submission lock. The
 * drop-threading contract is unchanged — only its vocabulary is (`written`/`dropped` instead
 * of a bare boolean) — so these keep guarding the silent-loss fix at the live write edge
 * rather than at a function nothing calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { submitMessagePaced } from '../servers/message-write.js';
import type { WritableSession } from '../servers/message-write.js';
import { resetSubmissionChains } from '../servers/session-submit.js';

/**
 * A WritableSession fake whose `write` returns false (a dropped write) whenever
 * `shouldDrop(data, callIndex)` is true, recording every attempted write.
 */
function makeSession(
  shouldDrop: (data: string, callIndex: number) => boolean = () => false,
): WritableSession & { id: string; writes: string[] } {
  const writes: string[] = [];
  return {
    id: 'term-drop',
    write: (data: string): boolean => {
      const idx = writes.length;
      writes.push(data);
      return !shouldDrop(data, idx);
    },
    writes,
  };
}

/**
 * Drive the write edge to completion and report whether the whole submit landed.
 *
 * `runAllTimersAsync` covers both the paced writes and the submission lock's own
 * completion sleep, which is scheduled on the same (fake) clock.
 */
async function settle(p: Promise<{ status: string }>): Promise<boolean> {
  await vi.runAllTimersAsync();
  return (await p).status === 'written';
}

/** The write edge as mailbox-wiring binds it: no in-lock refusal, so the write always runs. */
function write(session: WritableSession & { id: string }, message: string, noEnter: boolean) {
  return submitMessagePaced(session, message, noEnter, () => null);
}

describe('submitMessagePaced — dropped-write threading (Spec 1313 silent-loss fix)', () => {
  beforeEach(() => {
    resetSubmissionChains();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  describe('short message (single write + delayed Enter)', () => {
    it('all writes land → resolves true, text + Enter both on the wire', async () => {
      const session = makeSession();
      const result = await settle(write(session, 'hello', false));

      expect(result).toBe(true);
      expect(session.writes).toEqual(['hello', '\r']);
    });

    it('the FIRST (synchronous) write drops → resolves false', async () => {
      // The socket is already dead when the text write fires at t=0.
      const session = makeSession((_d, i) => i === 0);
      const result = await settle(write(session, 'hello', false));

      expect(result).toBe(false);
      expect(session.writes[0]).toBe('hello'); // it WAS attempted
    });

    it('the DELAYED Enter drops (text landed) → resolves false', async () => {
      // The critical case the t=0 `writable` precheck cannot see: text writes fine, then
      // the socket dies before the Enter fires 50ms later, so the submit never completes.
      const session = makeSession((d) => d === '\r');
      const result = await settle(write(session, 'hello', false));

      expect(result).toBe(false);
      expect(session.writes).toContain('\r'); // the Enter was attempted (and dropped)
    });

    it('noEnter, text lands → resolves true, no Enter written', async () => {
      const session = makeSession();
      const result = await settle(write(session, 'hi', true));

      expect(result).toBe(true);
      expect(session.writes).toEqual(['hi']);
    });

    it('noEnter, text drops → resolves false', async () => {
      const session = makeSession((_d, i) => i === 0);
      const result = await settle(write(session, 'hi', true));

      expect(result).toBe(false);
    });
  });

  describe('multi-line message (paced line-by-line + delayed Enter)', () => {
    const MSG = 'a\nb\nc\nd'; // 4 lines → crosses the paste-avoidance pacing threshold

    it('all lines + Enter land → resolves true, Enter last', async () => {
      const session = makeSession();
      const result = await settle(write(session, MSG, false));

      expect(result).toBe(true);
      expect(session.writes.at(-1)).toBe('\r'); // Enter delivered after every line
      expect(session.writes).toContain('a\n');
      expect(session.writes).toContain('d');
    });

    it('a DELAYED middle line drops → resolves false', async () => {
      // Line 2 ("b\n") fires ~10ms in — a delayed write, not the synchronous first one.
      const session = makeSession((d) => d === 'b\n');
      const result = await settle(write(session, MSG, false));

      expect(result).toBe(false);
      expect(session.writes).toContain('b\n'); // attempted mid-pace, dropped
    });

    it('the DELAYED trailing Enter drops (all lines landed) → resolves false', async () => {
      const session = makeSession((d) => d === '\r');
      const result = await settle(write(session, MSG, false));

      expect(result).toBe(false);
      expect(session.writes).toContain('a\n'); // the lines themselves went out
      expect(session.writes).toContain('\r'); // the Enter was attempted (and dropped)
    });
  });
});
