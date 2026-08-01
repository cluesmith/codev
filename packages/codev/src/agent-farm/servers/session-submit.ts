/**
 * Per-session submission lock (Spec 1273, verify phase).
 *
 * ## The bug this exists to make impossible
 *
 * `writeMessageToSession` writes text to the PTY and schedules the Enter that
 * submits it **50–80ms later** (`message-write.ts`). The write functions return
 * that completion offset but do not wait for it, and `/api/send` responded as
 * soon as the write was *scheduled*. So an awaited send resolved before its own
 * message had been submitted.
 *
 * In production (`afx reset`, 2026-07-31) that gap swallowed a `/clear`
 * entirely. Reset awaited the raw write of `/clear`, then wrote the
 * re-orientation — landing inside the 50ms window, into the same composer,
 * ahead of the Enter. One Enter then submitted both as a single message
 * beginning `/clear### [ARCHITECT INSTRUCTION...`. The slash command was never
 * executed, the builder's context was never cleared, and every layer reported
 * success.
 *
 * ## Ordering is not atomicity
 *
 * `SendBuffer` already serializes messages *within one flush* by threading a
 * delay offset between them, and per-session FIFO (Spec 1307) fixes the *order*
 * in which queued messages are delivered. Neither would have prevented this: the
 * two writes were correctly ordered and still coalesced, because being second is
 * not the same as being separate. What was missing is a guarantee that a
 * submission completes — Enter included — before the next write to that session
 * begins.
 *
 * ## What this provides
 *
 * A promise chain per session key. Each submission waits for the previous one to
 * finish (including its Enter), so concurrent `/api/send` requests to the same
 * terminal cannot interleave in the composer. `await submitToSession(...)` means
 * *submitted*, not *scheduled* — which is what every caller already assumed it
 * meant.
 *
 * Deliberately keyed by session id rather than holding a session object: Tower
 * re-fetches sessions by id, and a lock that outlived its session would pin a
 * dead reference.
 *
 * ## Exactly what it covers — this is NOT blanket per-session atomicity
 *
 * A lock only serialises writers that take it. Currently that is the `escape`
 * and immediate-delivery paths of `/api/send`. Every other PTY writer still
 * writes directly, and it is worth being precise about why:
 *
 *   - `tower-routes.ts` `deliverBufferedMessage` (buffer flush) — NOT covered.
 *     Adopting it is Spec 1307's work; the batch form
 *     (`write` performing the whole drain and returning the final offset) is
 *     supported and tested, so no API change is needed when they wire it.
 *   - `tower-cron.ts` cron delivery — NOT covered. Same shape as the buffered
 *     path; a scheduled message can land beside an in-flight submission.
 *   - `POST /api/terminals/:id/write` — NOT covered. It is a raw passthrough
 *     with no Enter semantics of its own.
 *   - `tower-websocket.ts` keystrokes and the shellper frame relay — DELIBERATELY
 *     not covered. That is a human typing into their own terminal; serialising
 *     it behind an agent's message would make the UI feel stuck, and the human
 *     is the composer's owner.
 *
 * So the guarantee is: **two `/api/send` deliveries to one session cannot
 * interleave**, which is the failure that reached production. Anything stronger
 * requires the remaining writers to take the lock too.
 */

/**
 * Tail of the in-flight submission chain per session.
 *
 * A session's entry is deleted once its chain drains, so this cannot grow
 * without bound across a long-lived Tower.
 */
const chains = new Map<string, Promise<void>>();

/** Injectable for tests; real timers otherwise. */
export interface SubmitClock {
  sleep(ms: number): Promise<void>;
}

const realClock: SubmitClock = {
  sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
};

/**
 * Run a write against a session so that it completes before any other
 * submission to the same session begins.
 *
 * @param sessionId  terminal/session id — the lock's granularity
 * @param write      performs the write; returns ms from now until the final
 *                   keystroke (the Enter) has been written. This is exactly what
 *                   `writeMessageToSession` / `writeEscapeToSession` already
 *                   return, so callers pass them through unchanged.
 * @returns resolves once the submission is complete
 */
export function submitToSession(
  sessionId: string,
  write: () => number,
  clock: SubmitClock = realClock,
): Promise<void> {
  const previous = chains.get(sessionId) ?? Promise.resolve();

  const current = previous
    // A failed predecessor must not poison the chain — the next submission is a
    // separate message and is still entitled to run.
    .catch(() => undefined)
    .then(async () => {
      const completesInMs = write();
      // Wait out the scheduled Enter. Zero means the write was fully synchronous
      // (`noEnter`), so there is nothing pending to wait for.
      if (completesInMs > 0) await clock.sleep(completesInMs);
    });

  chains.set(sessionId, current);

  // Drop the entry once this is the last submission in flight, so the map does
  // not accumulate one promise per session for the life of the process.
  //
  // The rejection is swallowed HERE and re-surfaced only through the returned
  // promise: without the catch, this bookkeeping branch would raise an
  // unhandled rejection for any failed write, even when the caller handled it.
  void current
    .then(
      () => undefined,
      () => undefined,
    )
    .then(() => {
      if (chains.get(sessionId) === current) chains.delete(sessionId);
    });

  return current;
}

/** Number of sessions with a submission in flight. Test/observability only. */
export function pendingSubmissionSessions(): number {
  return chains.size;
}

/** Drop all chains. Test-only; a live Tower should let them drain. */
export function resetSubmissionChains(): void {
  chains.clear();
}
