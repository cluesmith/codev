/**
 * `afx send --delay` — Tower-side deferred delivery (Spec 1307), re-homed onto the
 * Spec 1313 mailbox.
 *
 * These tests exercise the `delayed-send.ts` timer registry that survives the
 * re-homing unchanged: delay validation, at-most-once due-time scheduling, and the
 * shutdown-DROP (never flush) semantics. The `--delay` due-time callback in
 * `handleSend` now enqueues to the mailbox and triggers a gated drain, so a delayed
 * message delivers onto a render-verified empty prompt like any normal send.
 *
 * The original SendBuffer-coupled ORDERING suites (the `/clear` → delayed
 * `/arch-init` inversion that `hasPending` used to guard) were removed with the
 * SendBuffer: the mailbox delivers `held[0]` oldest-first through the gate, so a
 * delayed message enqueued at due time cannot overtake an earlier held one by
 * construction — the inversion is designed out, not guarded. Route-level `--delay`
 * behavior is covered against the live handler in tower-routes.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  scheduleDelayedSend,
  shutdownDelayedSends,
  pendingDelayedSendCount,
  validateDelaySeconds,
  MAX_DELAY_SECONDS,
} from '../servers/delayed-send.js';

// ============================================================================
// Delay validation
// ============================================================================

describe('validateDelaySeconds', () => {
  it('accepts a whole number of seconds inside the bound', () => {
    expect(validateDelaySeconds(1)).toBeNull();
    expect(validateDelaySeconds(15)).toBeNull();
    expect(validateDelaySeconds(MAX_DELAY_SECONDS)).toBeNull();
  });

  it('rejects zero and negatives', () => {
    expect(validateDelaySeconds(0)).toMatch(/greater than zero/);
    expect(validateDelaySeconds(-5)).toMatch(/greater than zero/);
  });

  it('rejects non-integers', () => {
    expect(validateDelaySeconds(1.5)).toMatch(/whole number/);
  });

  it('rejects NaN', () => {
    // The case a naive `value > 0` check lets through: NaN fails every
    // comparison, so it would reach setTimeout and fire IMMEDIATELY — silently
    // converting a delayed send into an instant one.
    expect(validateDelaySeconds(NaN)).toMatch(/whole number/);
  });

  it('rejects Infinity', () => {
    expect(validateDelaySeconds(Infinity)).toMatch(/whole number/);
  });

  it('rejects values above the maximum', () => {
    expect(validateDelaySeconds(MAX_DELAY_SECONDS + 1)).toMatch(/at most/);
  });

  it('rejects non-numbers', () => {
    expect(validateDelaySeconds('15')).toMatch(/whole number/);
    expect(validateDelaySeconds(null)).toMatch(/whole number/);
    expect(validateDelaySeconds(undefined)).toMatch(/whole number/);
  });
});

// ============================================================================
// Scheduling and shutdown
// ============================================================================

describe('scheduleDelayedSend', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    shutdownDelayedSends();
  });

  afterEach(() => {
    shutdownDelayedSends();
    vi.useRealTimers();
  });

  it('does not deliver before the delay elapses', () => {
    const deliver = vi.fn();
    scheduleDelayedSend(15, 'term-1', deliver);

    vi.advanceTimersByTime(14_000);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('delivers once the delay elapses', async () => {
    const deliver = vi.fn();
    scheduleDelayedSend(15, 'term-1', deliver);

    // Async advance: delivery runs through the per-terminal chain, so the
    // callback fires in a microtask rather than synchronously in the timer.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('delivers exactly once', async () => {
    const deliver = vi.fn();
    scheduleDelayedSend(5, 'term-1', deliver);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('deregisters after delivery, leaving no phantom pending send', async () => {
    scheduleDelayedSend(5, 'term-1', () => {});
    expect(pendingDelayedSendCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(pendingDelayedSendCount()).toBe(0);
  });

  it('deregisters even when delivery throws', async () => {
    scheduleDelayedSend(5, 'term-1', () => {
      throw new Error('delivery blew up');
    });

    await expect(vi.advanceTimersByTimeAsync(5_000)).resolves.not.toThrow();
    expect(pendingDelayedSendCount()).toBe(0);
  });

  it('survives a rejected async delivery without an unhandled rejection', async () => {
    // One undeliverable message must not be able to take Tower down.
    scheduleDelayedSend(5, 'term-1', async () => {
      throw new Error('async delivery blew up');
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(pendingDelayedSendCount()).toBe(0);
  });

  it('tracks several pending sends independently', async () => {
    scheduleDelayedSend(5, 'term-1', () => {});
    scheduleDelayedSend(10, 'term-2', () => {});
    expect(pendingDelayedSendCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(pendingDelayedSendCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(pendingDelayedSendCount()).toBe(0);
  });
});

describe('shutdownDelayedSends', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    shutdownDelayedSends();
  });

  afterEach(() => {
    shutdownDelayedSends();
    vi.useRealTimers();
  });

  it('DROPS pending sends rather than flushing them', async () => {
    // The deliberate disagreement with SendBuffer.stop(), which flushes. A
    // delayed message's timing was chosen against a world a restart has already
    // invalidated — flushing would land `/arch-init` in a session that was
    // never cleared. Dropping is recoverable by re-sending.
    const deliver = vi.fn();
    scheduleDelayedSend(15, 'term-1', deliver);

    const dropped = shutdownDelayedSends();

    expect(dropped).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('reports how many were dropped so shutdown can log it', () => {
    scheduleDelayedSend(5, 'a', () => {});
    scheduleDelayedSend(5, 'b', () => {});
    scheduleDelayedSend(5, 'c', () => {});

    expect(shutdownDelayedSends()).toBe(3);
  });

  it('leaves no timers behind', () => {
    scheduleDelayedSend(5, 'term-1', () => {});
    shutdownDelayedSends();

    expect(pendingDelayedSendCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is safe to call with nothing pending', () => {
    expect(shutdownDelayedSends()).toBe(0);
  });

  it('cancels a delivery whose timer has not fired yet', async () => {
    // The generation guard still matters after the chain was removed: a
    // delivery can now be waiting on the SUBMISSION LOCK rather than on a
    // predecessor in this module, and shutdown must still stop it. The
    // observable case that remains here is the simpler one — a scheduled send
    // whose due time arrives after shutdown must not deliver.
    const ran: string[] = [];
    scheduleDelayedSend(5, 'term-1', () => { ran.push('early'); });
    scheduleDelayedSend(30, 'term-1', () => { ran.push('late'); });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(ran).toEqual(['early']);

    shutdownDelayedSends();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(ran).toEqual(['early']);
  });

  it('cancels a delivery whose lock wait outlasts a shutdown (isStillLive)', async () => {
    // Codex's finding: the timer-time generation check passes, delivery reaches
    // the mailbox write site, and THERE it can block on submitToSession behind an
    // in-flight write to the same session. If shutdown fires during that block,
    // the write must still be cancelled — the timer check already passed, so only
    // the write-time `isStillLive()` re-check catches it.
    let liveWhenWritten: boolean | undefined;
    scheduleDelayedSend(5, 'term-1', (isStillLive) => {
      // Simulate reaching the write site (as the mailbox delivery path does
      // inside the lock) only after shutdown has run.
      shutdownDelayedSends();
      liveWhenWritten = isStillLive();
    });

    await vi.advanceTimersByTimeAsync(5_000);

    // The predicate the write site consults reports "not live", so the callback's
    // `if (!isStillLive()) return` skips the write.
    expect(liveWhenWritten).toBe(false);
  });

  it('does not cancel deliveries scheduled AFTER a shutdown', async () => {
    // The generation guard must not poison the next Tower lifetime.
    shutdownDelayedSends();

    const ran: string[] = [];
    scheduleDelayedSend(5, 'term-1', () => { ran.push('after'); });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(ran).toEqual(['after']);
  });
});

// ============================================================================
// FIFO — the ordering guarantee
// ============================================================================

describe('per-terminal delivery chain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    shutdownDelayedSends();
  });

  afterEach(() => {
    shutdownDelayedSends();
    vi.useRealTimers();
  });

  it('does NOT serialise on its own — that is the submission lock\'s job now', () => {
    // This module used to hold a per-terminal promise chain. Spec 1273's
    // `submitToSession` now owns serialisation, and every due message re-enters
    // the mailbox delivery path, which submits under the lock. One mechanism, not two.
    //
    // So scheduling alone is deliberately concurrent here. The property that
    // two same-terminal deliveries do not interleave is REAL but lives in the
    // per-agent delivery serializer, where the real writes happen — see
    // send-delivery.test.ts "deliverAgentMailSerialized — concurrent-send
    // serialization", which drives the KeyedSerializer directly. Asserting it here
    // again would re-create the replica-test mistake this project hit four times.
    const started: string[] = [];
    scheduleDelayedSend(5, 'term-1', () => { started.push('a'); });
    scheduleDelayedSend(5, 'term-1', () => { started.push('b'); });

    vi.advanceTimersByTime(5_000);

    // Both timers fired; ordering of the WRITES is the lock's guarantee.
    expect(started.sort()).toEqual(['a', 'b']);
  });

  it('does not serialise across different terminals', async () => {
    // Chaining is per-terminal; an unrelated session must not be held up.
    const order: string[] = [];
    const slowDeliver = (label: string) => async () => {
      order.push(`start:${label}`);
      await new Promise(resolve => setTimeout(resolve, 50));
      order.push(`end:${label}`);
    };

    scheduleDelayedSend(5, 'term-1', slowDeliver('a'));
    scheduleDelayedSend(5, 'term-2', slowDeliver('b'));

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(200);

    // Both started before either finished.
    expect(order.slice(0, 2).sort()).toEqual(['start:a', 'start:b']);
  });

  it('delivers by DUE time, not request order, when delays differ', async () => {
    // Deliberate and worth pinning: `--delay 30` then `--delay 5` delivers the
    // 5s one first, because that is what the caller asked for. The ordering
    // guarantee this feature makes is narrower — a delayed message never
    // overtakes one already QUEUED for the session — not "request order wins".
    // That narrow, load-bearing guarantee (the /clear-then-delayed-/arch-init case)
    // is verified end-to-end against the mailbox drain in send-delivery.test.ts
    // "delayed sends never overtake already-queued mail (Spec 1307 ordering)".
    const order: string[] = [];
    scheduleDelayedSend(30, 'term-1', () => { order.push('long'); });
    scheduleDelayedSend(5, 'term-1', () => { order.push('short'); });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(order).toEqual(['short', 'long']);
  });

  it('a failing delivery does not strand later messages on the same terminal', async () => {
    const order: string[] = [];
    scheduleDelayedSend(5, 'term-1', () => { throw new Error('boom'); });
    scheduleDelayedSend(5, 'term-1', () => { order.push('second'); });

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(100);

    expect(order).toEqual(['second']);
  });
});
