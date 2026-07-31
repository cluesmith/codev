/**
 * `afx send --delay` — Tower-side deferred delivery (Spec 1307, phase 1).
 *
 * The tests that matter here are the ORDERING ones. `--delay` is otherwise a
 * thin scheduling parameter, but it introduces a second delivery path alongside
 * the existing typing-aware `SendBuffer`, and the seam between them is where
 * this feature can silently destroy work:
 *
 *   T+0    /clear sent → user typing → BUFFERED (up to 60s)
 *   T+15   /arch-init due → written directly → LANDS FIRST
 *   T+40   buffer flushes → /clear lands → wipes the recovered context
 *
 * That inversion is not recoverable by re-sending (the re-send re-runs the
 * race), so it is the one hazard in Spec 1307's design that had to be designed
 * out rather than accepted. `hasPending` is what closes it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SendBuffer, type BufferedMessage } from '../servers/send-buffer.js';
import {
  scheduleDelayedSend,
  shutdownDelayedSends,
  pendingDelayedSendCount,
  validateDelaySeconds,
  MAX_DELAY_SECONDS,
} from '../servers/delayed-send.js';

// ============================================================================
// Fakes
// ============================================================================

/** Minimal stand-in for PtySession: only what the delivery path touches. */
class FakeSession {
  writes: string[] = [];
  writable = true;
  private lastInputAt: number;

  constructor(opts?: { lastInputAt?: number }) {
    this.lastInputAt = opts?.lastInputAt ?? 0;
  }

  write(data: string): void {
    this.writes.push(data);
  }

  isUserIdle(thresholdMs: number): boolean {
    return Date.now() - this.lastInputAt >= thresholdMs;
  }

  /** Simulate the user typing right now. */
  type(): void {
    this.lastInputAt = Date.now();
  }

  /** Simulate the user having stopped typing long enough to count as idle. */
  goIdle(): void {
    this.lastInputAt = 0;
  }
}

function bufferedMessage(sessionId: string, text: string): BufferedMessage {
  return {
    sessionId,
    formattedMessage: text,
    noEnter: false,
    timestamp: Date.now(),
    broadcastPayload: {
      type: 'message',
      from: { project: 'p', agent: 'architect' },
      to: { project: 'p', agent: 'architect' },
      content: text,
      metadata: {},
      timestamp: new Date().toISOString(),
    },
    logMessage: `sent ${text}`,
  };
}

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

  it('cancels a DUE-but-not-started delivery waiting behind a slow one', async () => {
    // The case clearing `chains` cannot handle. Once a delivery has been
    // appended with `.then()`, that callback is attached to a promise and will
    // run when its predecessor settles — no matter what the map says. So the
    // second message here is past its timer (already removed from `pending`)
    // and merely waiting on the first. Without a generation guard it would be
    // written AFTER shutdown, which is precisely what "shutdown drops pending
    // delayed sends" promises cannot happen.
    const ran: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstStarted = new Promise<void>(resolve => { releaseFirst = resolve; });

    scheduleDelayedSend(5, 'term-1', async () => {
      ran.push('first');
      await firstStarted; // hold the chain open
    });
    scheduleDelayedSend(5, 'term-1', () => { ran.push('second'); });

    // Both timers fire; 'first' starts and blocks, 'second' queues behind it.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ran).toEqual(['first']);

    // Shutdown reports 0 pending — both timers had already fired — yet the
    // queued 'second' must still be cancelled.
    shutdownDelayedSends();

    releaseFirst();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(ran).toEqual(['first']);
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

  it('serialises two same-terminal messages due at the same instant', async () => {
    // Each scheduled message owns its own timer, so two due together would
    // otherwise start delivering concurrently. Delivery is not atomic —
    // writeMessageToSession paces multi-line output across several timeouts —
    // so concurrent deliveries to one PTY interleave LINES, producing two
    // mangled messages instead of two messages.
    const order: string[] = [];
    const slowDeliver = (label: string) => async () => {
      order.push(`start:${label}`);
      await new Promise(resolve => setTimeout(resolve, 50));
      order.push(`end:${label}`);
    };

    scheduleDelayedSend(5, 'term-1', slowDeliver('a'));
    scheduleDelayedSend(5, 'term-1', slowDeliver('b'));

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(200);

    // 'a' must fully finish before 'b' starts — no interleaving.
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
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

describe('SendBuffer.hasPending (per-session FIFO for delayed sends)', () => {
  let buffer: SendBuffer;

  beforeEach(() => {
    buffer = new SendBuffer();
  });

  it('reports nothing pending for an untouched session', () => {
    expect(buffer.hasPending('term-1')).toBe(false);
  });

  it('reports pending once a message is queued', () => {
    buffer.enqueue(bufferedMessage('term-1', '/clear'));
    expect(buffer.hasPending('term-1')).toBe(true);
  });

  it('scopes pending state per session', () => {
    buffer.enqueue(bufferedMessage('term-1', '/clear'));
    expect(buffer.hasPending('term-2')).toBe(false);
  });

  it('reports nothing pending after the queue is flushed', () => {
    const session = new FakeSession({ lastInputAt: 0 });
    buffer.enqueue(bufferedMessage('term-1', '/clear'));
    buffer.start(
      () => session as never,
      (s, msg) => {
        (s as unknown as FakeSession).write(msg.formattedMessage);
        return 0;
      },
      () => {},
    );

    buffer.flush();

    expect(buffer.hasPending('term-1')).toBe(false);
    buffer.stop();
  });
});

describe('delivery ordering under buffering (the inversion this design prevents)', () => {
  let buffer: SendBuffer;
  let session: FakeSession;

  /**
   * The delivery decision as `deliverOrBuffer` makes it: buffer when the user
   * is typing, or — for DELAYED deliveries only — when this session already has
   * something queued. Otherwise write straight through.
   *
   * Reproduced here rather than imported because the real function is bound to
   * the route's module-level terminal manager and logger.
   *
   * IMPORTANT — this is a SIMPLIFICATION, not a copy. It omits the shipped
   * predicate's interrupt handling entirely. These tests document the FIFO rule
   * readably; they are NOT the regression guard for it. That guard lives in
   * `tower-routes.test.ts` ("ORDERING: ..."), runs against the real route and
   * the real SendBuffer, and is mutation-verified. Review caught this file
   * standing in for that one.
   *
   * `enforceFifo` is scoped to delayed sends on purpose: Spec 1307 requires
   * undelayed sends to behave exactly as before, and applying the FIFO term to
   * every send changes immediate-path behaviour (it did — three existing
   * tower-routes tests caught it).
   */
  function deliver(text: string, enforceFifo = false): 'buffered' | 'written' {
    const shouldDefer = !session.isUserIdle(3000)
      || (enforceFifo && buffer.hasPending('term-1'));
    if (shouldDefer) {
      buffer.enqueue(bufferedMessage('term-1', text));
      return 'buffered';
    }
    session.write(text);
    return 'written';
  }

  /** A delayed delivery coming due. */
  function deliverDelayed(text: string): 'buffered' | 'written' {
    return deliver(text, true);
  }

  beforeEach(() => {
    buffer = new SendBuffer();
    session = new FakeSession({ lastInputAt: 0 });
    buffer.start(
      () => session as never,
      (s, msg) => {
        (s as unknown as FakeSession).write(msg.formattedMessage);
        return 0;
      },
      () => {},
    );
  });

  afterEach(() => {
    buffer.stop();
  });

  it('writes straight through when the session is idle and nothing is queued', () => {
    expect(deliver('hello')).toBe('written');
    expect(session.writes).toEqual(['hello']);
  });

  it('buffers when the user is typing', () => {
    session.type();
    expect(deliver('/clear')).toBe('buffered');
    expect(session.writes).toEqual([]);
  });

  it('does NOT let a DELAYED message overtake an earlier buffered one', () => {
    // The regression this whole mechanism exists for — the /arch-save sequence.
    session.type();
    expect(deliver('/clear')).toBe('buffered');

    // The user stops typing; 15s later the delayed /arch-init comes due. Without
    // the FIFO term it would find the session idle and write directly — landing
    // BEFORE the /clear still sitting in the buffer, after which the clear wipes
    // the context that just recovered.
    session.goIdle();
    expect(deliverDelayed('/arch-init main')).toBe('buffered');

    // Nothing written yet; both are queued in order.
    expect(session.writes).toEqual([]);

    buffer.flush();
    expect(session.writes).toEqual(['/clear', '/arch-init main']);
  });

  it('leaves the IMMEDIATE path unchanged: an idle session is written directly even with a queue', () => {
    // The other half of the contract. Spec 1307 requires undelayed sends to
    // behave exactly as before; applying the FIFO term to every send changed
    // immediate-path behaviour and broke three existing tower-routes tests.
    session.type();
    expect(deliver('queued-earlier')).toBe('buffered');

    session.goIdle();
    expect(deliver('immediate')).toBe('written');
  });

  it('preserves order across three delayed messages with mixed idle states', () => {
    session.type();
    deliverDelayed('first');
    session.goIdle();
    deliverDelayed('second');
    deliverDelayed('third');

    buffer.flush();
    expect(session.writes).toEqual(['first', 'second', 'third']);
  });

  it('resumes direct writes once the queue has drained', () => {
    session.type();
    deliverDelayed('queued');

    // The buffer only releases once the user is idle — flushing while they are
    // still typing correctly holds the message, which is the behaviour the
    // inversion test above depends on.
    session.goIdle();
    buffer.flush();
    expect(session.writes).toEqual(['queued']);

    expect(deliverDelayed('direct')).toBe('written');
    expect(session.writes).toEqual(['queued', 'direct']);
  });
});
