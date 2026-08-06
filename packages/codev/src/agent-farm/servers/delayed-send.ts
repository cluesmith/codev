/**
 * Delayed message delivery for `afx send --delay` (Spec 1307).
 *
 * Holds a due-time timer per scheduled message and nothing else. The *decision*
 * of how to deliver — deliver now onto a clean prompt, or persist and hold — is
 * deliberately NOT made here: it is re-made at delivery time by the same gated
 * path an immediate send uses. When the timer fires, the callback enqueues the
 * message into the durable mailbox and triggers the render-gated drain (the
 * `deliverAfter` branch of handleSend in tower-routes.ts).
 *
 * ## Why the registry exists at all
 *
 * A bare `setTimeout` would work until Tower shuts down, at which point the
 * process would either hang on a pending timer or exit with a message
 * half-scheduled and no record of it. The registry makes shutdown explicit.
 *
 * ## Shutdown DROPS, it does not flush
 *
 * A message already in the mailbox is durable: it is a persisted row and simply
 * survives a restart, delivering when the target's prompt is next clean. A pre-due
 * delayed send is the opposite — nothing is persisted yet, and its whole content is
 * "deliver this at a moment that has not arrived yet", a moment chosen relative to a
 * world (a session mid-clear, a turn about to end) that a Tower restart has already
 * invalidated. Flushing it on shutdown would fire `/arch-init` into a session that
 * never got cleared, or into one that has moved on to other work. Dropping is
 * recoverable — a human re-sends one message — and Spec 1307's design explicitly
 * accepts that trade. This is why the pre-due timer stays OUT of the durable mailbox
 * until it actually fires (the mailbox row is created by the fire-time callback).
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
 * every due message re-enters the mailbox delivery path, which submits under the
 * lock. One mechanism, not two — per the architect's ruling that this project
 * adopts the primitive rather than keeping a rival.
 */

/**
 * Incremented by every shutdown. Each scheduled send captures the value current
 * when it was scheduled and re-checks it at delivery.
 *
 * Clearing the pending timers is not sufficient on its own. A message whose
 * timer has already fired is out of `pending` but its delivery may not have
 * started yet — it can be waiting on the session's `submitToSession` lock
 * behind an in-flight write. That queued delivery would otherwise run AFTER
 * shutdown, which is exactly what "shutdown drops pending delayed sends"
 * promises it will not. The generation check re-read at delivery time makes
 * such an already-scheduled delivery a no-op.
 *
 * Honest bound: a delivery that has ALREADY begun its write when shutdown fires
 * still completes — the lock does not interrupt a write in progress. "Drops on
 * shutdown" therefore means "does not START anything new," not "aborts what is
 * mid-flight." See the shutdown function.
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
   * Invoked when the send comes due. Receives `isStillLive`, which it must
   * re-check at the moment it actually writes (inside the submission lock): a
   * delivery can acquire the lock only AFTER a shutdown that fired while it
   * queued, and the generation check below only guards the moment BEFORE it
   * enters the lock. Return value is ignored.
   */
  deliver: (isStillLive: () => boolean) => unknown,
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
        // Passed through to the write site, where it is re-checked while the
        // lock is held — closing the shutdown-during-lock-wait window.
        await deliver(() => generation === scheduledGeneration);
      } catch {
        // The mailbox delivery path logs a write failure at its own site with
        // terminal context; this catch is a last-resort guard so an unexpected
        // throw cannot become an unhandled rejection that takes Tower down over
        // one undeliverable message.
      }
    })();
  }, delaySeconds * 1000);

  pending.add(entry);
}

/**
 * Cancel every pending delayed send without delivering. Returns the count of
 * still-timing sends dropped, so shutdown can log it rather than losing
 * messages silently.
 *
 * Covers two states: sends still on their timer (cleared here) and sends whose
 * timer has fired but whose delivery has not started — invalidated by bumping
 * `generation`, which the delivery callback re-checks. A delivery already
 * writing when this runs is NOT interrupted; see `generation`'s note.
 */
export function shutdownDelayedSends(): number {
  const count = pending.size;
  for (const entry of pending) {
    clearTimeout(entry.timer);
  }
  pending.clear();
  generation++;
  return count;
}

/** Number of pending delayed sends. Diagnostics and tests. */
export function pendingDelayedSendCount(): number {
  return pending.size;
}
