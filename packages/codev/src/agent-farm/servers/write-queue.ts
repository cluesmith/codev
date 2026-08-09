/**
 * Per-key FIFO serialization with completion chaining (Spec 1313, Phase 4).
 *
 * `run(key, fn)` runs `fn` only after every earlier `run(key, …)` for the same
 * key has fully settled, and resolves with `fn`'s result. Different keys run
 * concurrently. This is the "a message's text + its Enter are one unit, and
 * concurrent sends to one session never interleave" primitive: the send path and
 * the backstop drainer both funnel per-agent delivery through one serializer, so a
 * pick → gate → write → mark critical section can never overlap another for the
 * same agent — which is what makes the spike `w1a` blob (two concurrent sends
 * fusing into one submit) impossible by construction.
 *
 * Chaining is **completion-based**, not fire-and-forget: the next `fn` starts only
 * after the previous one settles. When `fn` awaits the paced-write completion
 * (text + trailing Enter fully written), the following delivery therefore observes
 * the line only after the prior submit is entirely on the wire.
 *
 * Robustness invariants:
 * - A rejected `fn` never wedges the key: the successor runs regardless of the
 *   predecessor's outcome, and the original caller still observes the rejection on
 *   its own returned promise.
 * - The per-key tail is dropped once it settles with no successor queued, so the
 *   map never grows unbounded across many short-lived keys (one per agent).
 */
export class KeyedSerializer {
  private readonly tails = new Map<string, Promise<unknown>>();

  /**
   * Queue `fn` behind any in-flight/queued work for `key`. Returns a promise that
   * settles with `fn`'s result (or rejection). `fn` is not invoked until its turn.
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    // Run fn once prev settles, regardless of whether prev resolved or rejected
    // (the stored tail below already swallows outcomes, so prev never rejects —
    // passing fn as both handlers is defensive and keeps the chain moving).
    const result = prev.then(fn, fn);
    // The tail successors chain after. Swallow its settlement so (a) a rejected
    // fn never surfaces as an unhandled rejection here, and (b) the successor is
    // never blocked by the predecessor's failure.
    const tail = result.then(
      () => {},
      () => {}
    );
    this.tails.set(key, tail);
    // GC: once this tail settles, drop the key IFF nothing chained after it. If a
    // successor was queued in the meantime, `tails.get(key)` is that newer tail,
    // so we leave it in place.
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** True while any work is queued or in flight for `key` (tests/telemetry). */
  isActive(key: string): boolean {
    return this.tails.has(key);
  }
}
