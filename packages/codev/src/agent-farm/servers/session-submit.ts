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
 * The paced writer already threads a delay offset between consecutive writes, and the
 * mailbox delivery path serialises messages to one agent (`deliverAgentMailSerialized`
 * chains each delivery on the prior one's paced completion). Both fix the *order* in
 * which queued messages reach a session. Neither would have prevented this: the two
 * writes were correctly ordered and still coalesced, because being second is not the
 * same as being separate. What was missing is a guarantee that a submission completes —
 * Enter included — before the next write to that session begins.
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
 * A lock only serialises writers that take it. As of Issue #1365 that is every writer
 * that puts a *message* on a terminal:
 *
 *   - `escape` and `interrupt` on `/api/send`, and the delayed `--interrupt` `^C`
 *     (`tower-routes.ts`) — the explicit human gate-bypasses.
 *   - The mailbox delivery path (`deliverAgentMailSerialized`, Spec 1313) — every normal
 *     `/api/send`, every cron notification, every backstop drain. It takes this lock as a
 *     LEAF inside its own per-agent serializer, via `submitMessagePaced`.
 *
 * These stay deliberately uncovered:
 *
 *   - `POST /api/terminals/:id/write` — a raw passthrough with no Enter semantics of its own.
 *   - `tower-websocket.ts` keystrokes and the shellper frame relay — a human typing into
 *     their own terminal. Serialising that behind an agent's message would make the UI feel
 *     stuck, and the human is the composer's owner.
 *
 * ### Why the mailbox path was converged (Issue #1365)
 *
 * Until #1365 the delivery path held only its per-AGENT serializer — a disjoint lock — and
 * the resulting cross-path race was accepted on the grounds that a gated delivery only ever
 * writes onto a render-verified empty prompt and `interrupt` is an explicit human action.
 * That reasoning covered one ordering (a delivery landing inside the interrupt's `^C`→settle
 * →text window) and missed two:
 *
 *   - a `^C` landing inside the DELIVERY's own text→Enter window (50–130 ms+) cleared the
 *     composer, so the delivery's Enter submitted nothing — yet every byte had reached the
 *     PTY, so the write reported success and the row was marked `delivered`. Silent loss with
 *     a false audit record, which is the one outcome Spec 1313 exists to exclude;
 *   - `--escape` (ESC, then Enter 50 ms later) produced the truncated variant, and is the
 *     MORE likely trigger for a multi-line body, because the delivery's exposed window is
 *     longest exactly when the body is long.
 *
 * The "a human is standing at this terminal" premise also does not hold for the DELAYED
 * `^C`, which fires unattended on a timer.
 *
 * ### Lock order, and why there is no cycle
 *
 * Always per-agent → per-terminal. The delivery path takes this lock as a leaf inside
 * `KeyedSerializer`; the operator paths take only this one and never enter the per-agent
 * serializer. Re-entrancy is impossible in the other direction too: `PtySession.write()`
 * emits no `'submit'` signal (only `handleUserInput` does, for human keystrokes), so no
 * write from inside a lock can schedule a delivery synchronously.
 *
 * The lock is a leaf around the WRITE only, never the gate classify. `--interrupt` is the
 * human's escape hatch for a wedged agent; making it queue behind a screen classification
 * would be a real regression for the one action that must always get through.
 *
 * ### Asymmetric acquisition: deliveries decline, operators wait
 *
 * A delivery uses {@link trySubmitToSession} and abandons its turn on contention, because
 * `MailboxDrainer.tick` walks agents SEQUENTIALLY — one delivery parked on a terminal lock
 * would stall every other agent's mail, plus that tick's escalation and prune passes. It
 * costs nothing: a contended terminal means the delivery's in-lock precheck would have
 * aborted it anyway, and the row simply re-delivers on the next clean pass.
 *
 * Operators block — bounded by {@link OPERATOR_SUBMIT_WAIT_CEILING_MS}, because a paced
 * write runs `(lines−1)×10+80` ms and a body is capped only by `parseJsonBody`'s 1 MiB.
 *
 * ### What is guaranteed, and what is not
 *
 * **Serialization is the structural guarantee**: no lock-taking writer can put bytes on a
 * terminal while another lock-taking writer's submission is in flight. That is a property of
 * the lock, not of any check.
 *
 * The delivery path ALSO re-validates its preconditions inside the lock (`writable`, the
 * gate's `ringToken`, and the row's own status). That re-check narrows a window; it does not
 * close one, and it should not be described as if it did:
 *
 *   - `ringToken` counts OUTPUT bytes, so input written by an uncovered path (the raw
 *     passthrough, or a human's keystrokes) can sit un-echoed on the line and read as
 *     unchanged. That echo-lag residual survives this change by design — it is #1473's
 *     territory.
 *   - Its real structural value is that it makes the ACQUISITION POLICY a free choice: were
 *     the delivery ever switched from declining to waiting (e.g. to order an interrupt ahead
 *     of its own body, per #1481), the precheck is what would keep that safe.
 *
 * The one hole this lock opens is its own degraded path: an operator whose ceiling expires
 * writes unserialized. Rather than leave that as a second silent-loss route, degraded writes
 * are COUNTED per session ({@link unserializedWriteCount}); `submitMessagePaced` samples the
 * counter around its write and reports `preempted`, so the delivery holds its row for
 * redelivery instead of reporting a delivery that may have been clobbered. Deliberately no
 * screen re-classification — the question is only "did anyone bypass the lock while I held
 * it?", and a counter answers exactly that.
 */

/**
 * Tail of the in-flight submission chain per session.
 *
 * A session's entry is deleted once its chain drains, so this cannot grow
 * without bound across a long-lived Tower. Its presence is also the contention
 * signal both {@link isSubmissionInFlight} and {@link trySubmitToSession} read.
 */
const chains = new Map<string, Promise<void>>();

/** Injectable for tests; real timers otherwise. */
export interface SubmitClock {
  sleep(ms: number): Promise<void>;
}

const realClock: SubmitClock = {
  sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
};

/** Options for an operator submission that must not wait unboundedly (Issue #1365). */
export interface SubmitOptions {
  /**
   * Max ms to wait for an in-flight submission before proceeding UNSERIALIZED.
   * Omitted (the default) means wait as long as it takes.
   */
  waitCeilingMs?: number;
  /** Called instead of the write's serialization when {@link waitCeilingMs} expires. */
  onCeilingExpired?: (waitedMs: number) => void;
}

/** Marker resolved by the ceiling timer so the race can tell who won. */
const CEILING_EXPIRED = Symbol('ceiling-expired');

/**
 * How long an OPERATOR submission (`--interrupt`, `--escape`, the delayed `^C`) waits for an
 * in-flight submission before proceeding unserialized (Issue #1365).
 *
 * Needed because a paced write's duration is `(lines−1)×10+80` ms and a request body is capped
 * only by `parseJsonBody`'s 1 MiB, so a 48 KB `--file` of short lines is ~8 minutes on the wire.
 * Blocking `--interrupt` — the human's escape hatch for a wedged agent — behind that would be a
 * worse regression than the interleaving this lock closes. Two seconds comfortably covers every
 * realistic message while keeping the escape hatch responsive.
 */
export const OPERATOR_SUBMIT_WAIT_CEILING_MS = 2000;

/**
 * Per-session count of submissions that gave up waiting and wrote UNSERIALIZED
 * (Issue #1365 — the {@link OPERATOR_SUBMIT_WAIT_CEILING_MS} degraded path).
 *
 * A monotone counter, not a flag, so a concurrent writer can sample it before and after
 * its own write and detect a race that started *and* finished in between. Entries are
 * per session id and only ever created on the degraded path, which is rare by
 * construction — it needs a write long enough to hold the line past the ceiling AND a
 * concurrent operator action.
 */
const unserializedWrites = new Map<string, number>();

/**
 * How many unserialized (ceiling-expired) writes this session has seen.
 *
 * The point of comparison for a writer that wants to know whether its own submission was
 * raced: sample before the first byte, compare after the last. Cheaper and far more
 * direct than re-classifying the screen — it asks "did anyone bypass the lock while I
 * held it?", which is exactly the question, and needs no terminal rendering at all.
 */
export function unserializedWriteCount(sessionId: string): number {
  return unserializedWrites.get(sessionId) ?? 0;
}

/**
 * Whether a submission is queued or in flight for this session RIGHT NOW.
 *
 * Read by {@link trySubmitToSession} and exposed for telemetry. Safe to act on
 * without a lock of its own: the runtime is single-threaded and every mutation of
 * `chains` happens with no await in between, so a caller that observes `false`
 * cannot be beaten to the install by another caller in the same tick.
 */
export function isSubmissionInFlight(sessionId: string): boolean {
  return chains.has(sessionId);
}

/**
 * Run a write against a session so that it completes before any other
 * submission to the same session begins.
 *
 * @param sessionId  terminal/session id — the lock's granularity
 * @param write      performs the write; returns ms from now until the final
 *                   keystroke (the Enter) has been written. This is exactly what
 *                   `writeMessageToSession` / `writeEscapeToSession` already
 *                   return, so callers pass them through unchanged.
 * @param clock      injectable sleeper; real timers by default
 * @param options    {@link SubmitOptions} — the operator paths pass a wait ceiling
 * @returns resolves once the submission is complete
 */
export function submitToSession(
  sessionId: string,
  write: () => number,
  clock: SubmitClock = realClock,
  options: SubmitOptions = {},
): Promise<void> {
  const previous = chains.get(sessionId) ?? Promise.resolve();
  // A failed predecessor must not poison the chain — the next submission is a
  // separate message and is still entitled to run.
  const previousSettled = previous.then(
    () => undefined,
    () => undefined,
  );

  // Only a CONTENDED submission can wait, so an uncontended one must not arm a
  // ceiling timer it would then leave dangling for its whole duration.
  const contended = chains.has(sessionId);
  const ceilingMs = options.waitCeilingMs;
  const bounded = contended && ceilingMs !== undefined && ceilingMs >= 0;

  const current = (async () => {
    if (bounded) {
      const winner = await Promise.race([
        previousSettled,
        clock.sleep(ceilingMs).then(() => CEILING_EXPIRED),
      ]);
      // Ceiling expired → proceed WITHOUT serialization. This is a deliberate,
      // announced degradation to the pre-Issue-#1365 behaviour (where an operator
      // write never waited at all), taken only when the alternative is stalling
      // `--interrupt` — the human's escape hatch — behind a write that may run for
      // minutes. See the boundary comment above for why it is never worse than the
      // status quo.
      if (winner === CEILING_EXPIRED) {
        // Record it BEFORE the first byte so a delivery already holding the line sees the
        // bump when it re-samples after its own write, and re-holds its row instead of
        // reporting a delivery this write may have just clobbered.
        unserializedWrites.set(sessionId, unserializedWriteCount(sessionId) + 1);
        options.onCeilingExpired?.(ceilingMs);
      }
    } else {
      await previousSettled;
    }
    const completesInMs = write();
    // Wait out the scheduled Enter. Zero means the write was fully synchronous
    // (`noEnter`), so there is nothing pending to wait for.
    if (completesInMs > 0) await clock.sleep(completesInMs);
  })();

  // The stored tail settles only once BOTH this submission and its predecessor are
  // done. Identical to `current` on the normal path (current already awaited the
  // predecessor); it matters on the degraded path, where the predecessor is still
  // running — a third submission must not be released by our early finish.
  const tail = bounded
    ? Promise.all([previousSettled, current.then(() => undefined, () => undefined)]).then(() => undefined)
    : current.then(
        () => undefined,
        () => undefined,
      );

  chains.set(sessionId, tail);

  // Drop the entry once this is the last submission in flight, so the map does
  // not accumulate one promise per session for the life of the process.
  //
  // The tail already swallows both outcomes, so this bookkeeping branch can never
  // raise an unhandled rejection for a failed write — the rejection surfaces only
  // through the returned `current`.
  void tail.then(() => {
    if (chains.get(sessionId) === tail) chains.delete(sessionId);
  });

  return current;
}

/**
 * {@link submitToSession} for a writer that would rather skip its turn than wait
 * for one — the gated mailbox delivery path (Issue #1365).
 *
 * Resolves `false` **without writing anything** when another submission already
 * holds the session. That is the right trade for a gated delivery and the wrong one
 * for an operator action, which is why the two differ:
 *
 *   - A contended terminal means some other writer is mid-submission, so the
 *     delivery's in-lock precheck would have aborted it anyway (the screen has
 *     moved, or is about to). Nothing is lost by declining now: the row stays held
 *     and the backstop re-delivers within one tick.
 *   - Blocking instead would be a genuine liveness regression, because
 *     `MailboxDrainer.tick` walks agents SEQUENTIALLY — one agent parked on a
 *     terminal lock would stall every other agent's delivery, plus that tick's
 *     escalation, owner-notice and prune passes.
 *
 * @returns `true` when the write ran (and completed), `false` when the session was
 *          contended and nothing was written.
 */
export async function trySubmitToSession(
  sessionId: string,
  write: () => number,
  clock: SubmitClock = realClock,
): Promise<boolean> {
  if (isSubmissionInFlight(sessionId)) return false;
  await submitToSession(sessionId, write, clock);
  return true;
}

/** Number of sessions with a submission in flight. Test/observability only. */
export function pendingSubmissionSessions(): number {
  return chains.size;
}

/** Drop all chains and degraded-write counters. Test-only; a live Tower should let them drain. */
export function resetSubmissionChains(): void {
  chains.clear();
  unserializedWrites.clear();
}
