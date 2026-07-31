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

/**
 * Per-terminal delivery chain, so two due messages never interleave.
 *
 * Each message gets its own timer, so two scheduled for the same instant (or
 * near it) would otherwise both start delivering concurrently. Delivery is not
 * atomic — `writeMessageToSession` paces multi-line output across several
 * `setTimeout`s — so concurrent deliveries to one PTY can interleave *lines*,
 * producing two mangled messages rather than two messages.
 *
 * Chaining serialises them: each due delivery waits for the previous one to
 * this terminal to finish. Entries are removed once their chain drains, so this
 * map does not grow with terminal count over time.
 *
 * NOTE what this deliberately does NOT do: reorder by request time. Two sends
 * with different delays are meant to arrive at different times — `--delay 30`
 * followed by `--delay 5` delivers the 5s one first, because that is what the
 * caller asked for. The ordering guarantee this feature makes is narrower and
 * stated precisely in `deliverOrBuffer`: a delayed message never overtakes one
 * already QUEUED for that session.
 */
const chains = new Map<string, Promise<void>>();

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

  entry.timer = setTimeout(() => {
    // Deregister BEFORE delivering. If delivery throws, the entry must not be
    // left behind as a phantom pending send that shutdown would then report.
    pending.delete(entry);

    // Append to this terminal's chain so concurrent due messages serialise.
    const previous = chains.get(terminalId) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await deliver();
      } catch {
        // Delivery reports its own failures through the route's logger. A
        // throw here would otherwise become an unhandled rejection and take
        // Tower down over one undeliverable message. Swallowing also keeps the
        // chain alive: one failure must not strand later messages.
      }
    });
    chains.set(terminalId, next);
    // Drop the entry once drained, so the map tracks active chains only.
    void next.then(() => {
      if (chains.get(terminalId) === next) chains.delete(terminalId);
    });
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
  chains.clear();
  return count;
}

/** Number of pending delayed sends. Diagnostics and tests. */
export function pendingDelayedSendCount(): number {
  return pending.size;
}
