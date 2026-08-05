# Phase 3 — Rebuttals, iteration 3

Both `REQUEST_CHANGES`. **Both accepted and fixed** in `905bc9f4`. Nothing disputed — both
were real, both were regressions I introduced adopting the submission lock, and one was a
false claim in my own review.

---

## 1. Shutdown-flush regression (Codex)

**Accepted — I made an existing guarantee weaker and did not notice.**

Before the lock adoption, `SendBuffer.stop()`'s final `flush(true)` at least *scheduled* its
writes synchronously. Routing the drain through `submitToSession` means a batch can now be
*queued behind an in-flight write* and not yet delivered when `stop()` returns — after which
graceful shutdown tears down terminals and exits, losing a buffered message that was accepted
for delivery. Plus the voided submission promise could surface as an unhandled rejection.

**Fixed** by restoring what I broke: `SubmitFn` returns its promise; `flush(forceAll)` awaits
its submissions; `stop()` and `stopSendBuffer()` are async; `gracefulShutdown` awaits
`stopSendBuffer()` *before* terminal teardown. The injected submit `.catch()`es, covering the
unhandled-rejection note too. New `send-buffer.ts` test: `stop()` does not resolve until the
injected submission settles.

This is in scope precisely because it is a *restoration*, not a new guarantee — I weakened
shutdown-flush by adopting the lock, so fixing it is finishing the adoption.

## 2. Route-site `stillLive` guard untested — and I claimed it verified (Claude)

**Accepted, and this is the project's own lesson committed one more time.**

The iteration-2 `stillLive` guard at the production call site was untested: deleting it kept
the whole suite green. My unit test checked only `delayed-send.ts`'s predicate *return value*
via a synthetic callback — the replica-test pattern, the exact thing I have now hit five
times — not that `deliverOrBuffer` actually skips the write. Worse, I wrote "every
cancellation guard is mutation-verified" into the review, which was **false for this guard**.

**Fixed** with a route-level test that occupies the session's submission lock, fires a delayed
send that queues behind it, calls `shutdownDelayedSends()` during the wait, and asserts the
message never reaches the session. **Mutation-verified**: disabling the guard fails it. The
review's overclaim is corrected in place, and I named it there as an instance of the very
failure mode the lessons section is about — because a review that hides its own gap is worse
than one that admits it.

---

## The pattern, stated plainly

Every blocking finding in phase 3's three review rounds was a regression I introduced while
adopting Spec 1273's lock, and each was the same shape: **a guarantee asserted (in a comment,
or a review, or a too-weak test) before the code fully backed it.** The lock adoption touched
the seam between the new delayed path and the existing buffer/shutdown machinery, and — as the
review's own lesson 1 predicts — that seam is where every defect lived. The mutation check is
what finally closed each one; I am now running it *before* claiming a fix, which is how the
last two were caught by me rather than by a third review round.

## Nothing disputed

No false positives. The live e2e and 15s calibration remain the architect-scheduled verify
items, disclosed in the review.
