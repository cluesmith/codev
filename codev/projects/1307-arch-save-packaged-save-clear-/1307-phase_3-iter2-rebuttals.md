# Phase 3 — Rebuttals, iteration 2

Both `REQUEST_CHANGES`. **Both blocking findings accepted and fixed** in `27029541`; the
review file is written (`a0c1709b`). Nothing disputed — both reviewers were right, and both
findings were regressions I introduced adopting the submission lock.

---

## 1. Delayed `--interrupt` wrote Ctrl+C outside the lock (both reviewers)

**Accepted; a real regression from my `busyUntil` deletion, empirically reproduced by both.**

`deliverOrBuffer` wrote the Ctrl+C *directly* — before the `submitToSession` reservation —
then awaited 100ms, then submitted the payload. That was safe under `busyUntil`, which kept a
mid-flush session "pending". With `busyUntil` gone and `hasPending` back to queue-only, a
delayed `--interrupt` due mid-flush put its Ctrl+C into the middle of the flush's stream,
split from its own payload (Claude: `ctrlC=50, lastClear=150, arch=152`; Codex: same site).

**Fixed** by folding the whole delivery into one reservation: the Ctrl+C, its 100ms pause,
and the payload+Enter now run inside a single `submitToSession` thunk, mirroring
`deliverBufferedMessage`'s `interruptFirst`. An interrupt due mid-flush therefore queues
behind the flush's own reservation as a unit. This let me delete the pre-lock write, the
`await`, the `wroteInterrupt` flag, and the `queueAhead` re-check — machinery that existed
only to compensate for writing before the lock. New route test
`ORDERING: a delayed --interrupt due MID-FLUSH does not split into the flush`, and
**mutation-verified**: moving the Ctrl+C back outside the lock fails it.

## 2. Generation checked before the lock, not at the write (Codex)

**Accepted.** The timer-time generation check in `delayed-send.ts` fires before delivery
enters `submitToSession`. A delivery that then blocks on the lock behind an in-flight write
could have shutdown land in that wait and still write afterward — contradicting the "shutdown
starts nothing new" bound I had just written into the comments.

**Fixed** by threading an `isStillLive()` predicate from `scheduleDelayedSend` through to the
write site, re-checked *inside* the reservation immediately before writing. Unit test added
for the timer-fired-but-lock-blocked case. The immediate path passes no predicate and is
unaffected.

## 3. Review file absent (both, non-blocking)

**Written** (`a0c1709b`): `codev/reviews/1307-arch-save-packaged-save-clear-.md`, with the
verify-phase live-run plan and the unrun-e2e disclosure in it, as required before the PR
gate. It was a Review-phase deliverable, not expected during implement, but both reviewers
were right that it must exist before the gate — so it does now.

---

## The verify-phase items remain verify-phase items

The live e2e and the 15s calibration are still unrun. That is by architect ruling (modified
option c, 2026-08-02), not oversight, and is now disclosed in the review's Known Gaps and
laid out in its Verify-phase plan. Not disputed — correctly identified, deliberately
deferred.

## Nothing disputed

Every finding is fixed or a correctly-identified verify-phase item. No false positives. Both
blocking items this round were mine — regressions from the lock adoption — and both are the
project's recurring shape: a guarantee stated in a comment before the code fully backed it.
