/**
 * Per-session submission lock (Spec 1273, verify phase).
 *
 * The regression under test is the one that reached production: two sends to
 * one session coalescing into a single submission, because the first send's
 * Enter was still pending when the second write landed in the composer.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  submitToSession,
  resetSubmissionChains,
  pendingSubmissionSessions,
  type SubmitClock,
} from '../servers/session-submit.js';

/**
 * A composer that models the real failure.
 *
 * `write` appends to a pending buffer; `enter` submits whatever has
 * accumulated. That is the PTY's actual behaviour, and it is why an unawaited
 * Enter is dangerous: anything written before it joins the same submission.
 */
function makeComposer() {
  let pending = '';
  const submitted: string[] = [];
  return {
    submitted,
    write(text: string) {
      pending += text;
    },
    enter() {
      submitted.push(pending);
      pending = '';
    },
  };
}

/**
 * Real timers with a short delay.
 *
 * A virtual clock proved more fragile than the thing it was testing — the
 * property here is "the second write does not start until the first Enter has
 * fired", which real timers demonstrate directly and cheaply.
 */
const clock: SubmitClock = { sleep: ms => new Promise(r => setTimeout(r, ms)) };

const ENTER_DELAY = 20;

/**
 * Yield past the chain's internal microtasks so the in-flight write has run,
 * while staying well inside ENTER_DELAY so the NEXT one cannot have started.
 * A bare `Promise.resolve()` is not enough: the chain adds ticks of its own.
 */
const afterCurrentWrite = () => new Promise(r => setTimeout(r, 0));

describe('Spec 1273 — submission lock', () => {
  beforeEach(() => resetSubmissionChains());

  it('keeps two sends to one session as two separate submissions', async () => {
    // THE PRODUCTION BUG. Without the lock the second write joins the first's
    // pending text and one Enter submits `/clear## CONTEXT RESET…` as a single
    // message — exactly what reached the live probe builder.
    const composer = makeComposer();

    const write = (text: string) => () => {
      composer.write(text);
      setTimeout(() => composer.enter(), 0);
      return ENTER_DELAY;
    };

    const first = submitToSession('term-1', write('/clear'), clock);
    const second = submitToSession('term-1', write('## CONTEXT RESET'), clock);

    await first;
    await second;
    await new Promise(r => setTimeout(r, 0));

    expect(composer.submitted).toEqual(['/clear', '## CONTEXT RESET']);
    // The decisive assertion: never welded together.
    expect(composer.submitted.some(m => m.startsWith('/clear#'))).toBe(false);
  });

  it('does not let the second write begin before the first has submitted', async () => {
    const order: string[] = [];

    const first = submitToSession('term-1', () => { order.push('first'); return ENTER_DELAY; }, clock);
    const second = submitToSession('term-1', () => { order.push('second'); return ENTER_DELAY; }, clock);

    // The first write has run; the second is held behind the pending Enter.
    await afterCurrentWrite();
    expect(order).toEqual(['first']);

    await Promise.all([first, second]);

    expect(order).toEqual(['first', 'second']);
  });

  it('resolves only after the scheduled Enter, not when the write is scheduled', async () => {
    // `await send(...)` must mean SUBMITTED. Responding on "scheduled" is the
    // root cause: the HTTP 200 came back ~50ms before the message existed.
    let resolved = false;

    const submission = submitToSession('term-1', () => ENTER_DELAY, clock).then(() => {
      resolved = true;
    });

    await afterCurrentWrite();
    expect(resolved).toBe(false);

    await submission;
    expect(resolved).toBe(true);
  });

  it('does not serialize across different sessions', async () => {
    // The lock is per session; unrelated terminals must not queue behind a busy
    // one, or one slow builder would stall messaging workspace-wide.
    const order: string[] = [];

    const a = submitToSession('term-a', () => { order.push('a'); return ENTER_DELAY; }, clock);
    const b = submitToSession('term-b', () => { order.push('b'); return ENTER_DELAY; }, clock);

    await afterCurrentWrite();
    expect([...order].sort()).toEqual(['a', 'b']);

    await Promise.all([a, b]);
  });

  it('returns immediately when there is no Enter to wait for', async () => {
    // noEnter writes report 0; waiting on them would stall the chain forever.
    await expect(submitToSession('term-1', () => 0)).resolves.toBeUndefined();
  });

  it('a throwing submission does not poison the chain', async () => {
    // The next message is a separate submission and is still entitled to run.
    let ran = false;

    const bad = submitToSession('term-1', () => {
      throw new Error('write failed');
    }, clock);
    const good = submitToSession('term-1', () => { ran = true; return ENTER_DELAY; }, clock);

    await expect(bad).rejects.toThrow('write failed');
    await good;
    expect(ran).toBe(true);
  });

  it('drains its bookkeeping so a long-lived Tower does not leak', async () => {
    await submitToSession('term-1', () => 0);
    await new Promise(r => setTimeout(r, 0));
    expect(pendingSubmissionSessions()).toBe(0);
  });
});
