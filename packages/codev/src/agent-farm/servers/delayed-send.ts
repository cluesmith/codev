/**
 * Delayed message delivery for `afx send --delay` (Spec 1307).
 *
 * Holds a due-time timer per scheduled message and nothing else. The *decision*
 * of how to deliver — write now, or hand to the typing-aware send buffer — is
 * deliberately NOT made here: it is re-made at delivery time by the same code
 * the immediate path uses. See `deliverOrBuffer` in tower-routes.ts.
 *
 * ## Why the registry exists at all
 *
 * A bare `setTimeout` would work until Tower shuts down, at which point the
 * process would either hang on a pending timer or exit with a message
 * half-scheduled and no record of it. The registry makes shutdown explicit.
 *
 * ## Shutdown DROPS, it does not flush
 *
 * This is the one place this module deliberately disagrees with `SendBuffer`,
 * whose `stop()` performs a final flush. That is right for the buffer: those
 * messages were accepted for *immediate* delivery and merely held back because
 * someone was typing, so delivering them late is better than losing them.
 *
 * A delayed message is the opposite. Its whole content is "deliver this at a
 * moment that has not arrived yet", and the moment is chosen relative to a
 * world (a session mid-clear, a turn about to end) that a Tower restart has
 * already invalidated. Flushing on shutdown would fire `/arch-init` into a
 * session that never got cleared, or into one that has moved on to other work.
 * Dropping is recoverable — a human re-sends one message — and Spec 1307's
 * design explicitly accepts that trade.
 */

/** A scheduled delivery, retained so shutdown can cancel it. */
interface PendingDelayedSend {
  timer: ReturnType<typeof setTimeout>;
  /** Terminal this message is bound for. Diagnostics only. */
  terminalId: string;
  /** Epoch ms the message becomes due. Diagnostics only. */
  dueAt: number;
}

const pending = new Set<PendingDelayedSend>();

/*
 * NOTE: this module no longer serialises deliveries. It used to hold a
 * per-terminal promise chain; Spec 1273's `submitToSession` now owns that, and
 * every due message re-enters `deliverOrBuffer`, which submits under the lock.
 * One mechanism, not two — per the architect's ruling that this project adopts
 * the primitive rather than keeping a rival.
 */

/**
 * Incremented by every shutdown. Each scheduled send captures the value current
 * when it was scheduled and re-checks it immediately before delivering.
 *
 * Clearing `chains` is NOT sufficient to stop work: once a delivery has been
 * appended to a chain with `.then()`, that callback is already attached to a
 * promise and will run when its predecessor settles, whatever the map says. So
 * a message due-but-not-yet-started — queued behind a slow delivery to the same
 * terminal — would still be written AFTER shutdown, which is exactly what
 * "shutdown drops pending delayed sends" promises it will not do.
 *
 * A generation check is the cheapest way to make an already-scheduled callback
 * a no-op.
 */
let generation = 0;

/**
 * Upper bound on `--delay`, in seconds.
 *
 * One hour. Not a meaningful workflow limit — it exists so a typo (`--delay
 * 1500` when 15 was meant) cannot park a message for 25 minutes with no way to
 * see or cancel it. Listing and cancelling pending sends are deliberately out
 * of scope for Spec 1307, which is exactly why the ceiling matters.
 */
export const MAX_DELAY_SECONDS = 3600;

/**
 * Validate a delay in seconds, returning null when acceptable or an error
 * string naming the problem.
 *
 * `Number.isInteger` rather than a bare comparison chain: `NaN > 0` and
 * `NaN <= 0` are both false, so a NaN slips through any single comparison
 * written the obvious way and yields a `setTimeout` that fires immediately —
 * silently converting a delayed send into an immediate one. Infinity is
 * rejected for the same class of reason.
 */
export function validateDelaySeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return `delay must be a whole number of seconds, got '${String(value)}'`;
  }
  if (value <= 0) {
    return `delay must be greater than zero, got ${value}`;
  }
  if (value > MAX_DELAY_SECONDS) {
    return `delay must be at most ${MAX_DELAY_SECONDS} seconds (1 hour), got ${value}`;
  }
  return null;
}

/**
 * Schedule `deliver` to run after `delaySeconds`.
 *
 * The callback is responsible for re-resolving the session and re-deciding how
 * to deliver; this module guarantees only *when* it is invoked, and that it is
 * invoked at most once.
 */
export function scheduleDelayedSend(
  delaySeconds: number,
  terminalId: string,
  /**
   * Return value is ignored — the immediate path's `deliverOrBuffer` reports
   * whether it buffered, and that answer has no consumer once delivery is
   * asynchronous. Typed loosely so callers need not discard it at every site.
   */
  deliver: () => unknown,
): void {
  const entry: PendingDelayedSend = {
    terminalId,
    dueAt: Date.now() + delaySeconds * 1000,
    // Assigned below; the object must exist first so the callback can
    // deregister itself by identity.
    timer: undefined as unknown as ReturnType<typeof setTimeout>,
  };

  const scheduledGeneration = generation;

  entry.timer = setTimeout(() => {
    // Deregister BEFORE delivering. If delivery throws, the entry must not be
    // left behind as a phantom pending send that shutdown would then report.
    pending.delete(entry);

    void (async () => {
      // Generation re-checked at DELIVERY time, not timer time: delivery now
      // queues behind the session's submission lock, so the wait to actually
      // write can outlast a shutdown.
      if (generation !== scheduledGeneration) return;
      try {
        await deliver();
      } catch {
        // Delivery reports its own failures through the route's logger. A
        // throw here would otherwise become an unhandled rejection and take
        // Tower down over one undeliverable message.
      }
    })();
  }, delaySeconds * 1000);

  pending.add(entry);
}

/**
 * Cancel every pending delayed send without delivering. Returns the count
 * dropped, so shutdown can log it rather than losing messages silently.
 */
export function shutdownDelayedSends(): number {
  const count = pending.size;
  for (const entry of pending) {
    clearTimeout(entry.timer);
  }
  pending.clear();
  // Invalidate deliveries whose timer already fired but which have not started
  // yet — clearing `chains` cannot cancel an attached `.then()`.
  generation++;
  return count;
}

/** Number of pending delayed sends. Diagnostics and tests. */
export function pendingDelayedSendCount(): number {
  return pending.size;
}
