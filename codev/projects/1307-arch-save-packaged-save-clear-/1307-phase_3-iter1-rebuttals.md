# Phase 3 — Rebuttals, iteration 1

Both `REQUEST_CHANGES`. **All actionable findings accepted and fixed** in `ddf02abf`; the
remainder are the verify-phase items the architect explicitly scheduled, disclosed here
rather than disputed.

Fix commit: `ddf02abf`. Suite 4180 passing, build clean.

---

## Code cleanup — accepted and done

### `writeCompletesInMs` never actually deleted (both reviewers)

**Accepted, and this was a real miss.** The plan named deleting it after `submitToSession`
integration. I made it a permanent `0` with an unreachable consumer instead of removing it
— the deletion in name, not in fact. Now gone entirely: the field, the settling-wait block,
the `@returns` clause, and the object return type. `deliverOrBuffer` returns a plain
boolean; the delayed scheduler just calls it, because the lock owns serialisation and there
is nothing left to wait out.

### Four comments credited deleted mechanisms (Claude)

**Accepted — the project's recurring failure, once more: an artifact describing a system
that no longer exists.**

- The `WHAT THIS GUARANTEES` block credited `SendBuffer.busyUntil` and the deleted
  per-terminal chain. Rewritten to the real split: `enforceFifo` decides *order*,
  `submitToSession` provides *atomicity*.
- Its `NOT COVERED — an IMMEDIATE direct write sets no busyUntil` caveat was **true under
  busyUntil and false under the lock** — the immediate path now takes the lock on the same
  key. Removed, because a stale caveat that understates a guarantee invites a redundant
  future guard (Claude's exact concern).
- The `@returns` doc crediting "the per-terminal chain" — gone with the return-type change.
- `delayed-send.ts`'s `generation` rationale, written entirely around the deleted `chains`
  map — rewritten onto the submission lock.

### Shutdown-drop promise was narrower than stated (Claude, non-blocking)

**Accepted and corrected in the docs rather than the code.** A delivery already *writing*
when shutdown fires still completes — the lock does not interrupt a write in progress. So
"drops on shutdown" means "starts nothing new," not "aborts what is mid-flight." Both the
`generation` note and the `shutdownDelayedSends` doc now say so. No behaviour change: the
window is sub-second and the outcome (a fully-delivered message) is harmless; the fix is
telling the truth about the bound.

---

## Verify-phase items — scheduled, not disputed (Codex)

Codex is correct that these are absent. They are absent *by architect ruling* (2026-08-02,
modified option c), not by oversight, and each is disclosed at the PR gate rather than
discovered later — the explicit 1273 lesson applied forward.

### The live e2e has not run

**Correct, and deferred to the verify phase by design.** `/arch-save` is an
architect-session skill; its step 1 makes a *builder* refuse. The builder implementing this
feature therefore cannot run its own live cycle, and running it would clear a real
architect's context. The run is a throwaway-sibling-architect probe executed in verify
(spec Test Scenarios, "Why the live e2e has the shape it does"). Until then, `/clear`
execution, canary loss, identity recovery, monitor restoration and manual re-send remain
recorded as **unverified**, stated plainly in the review's Known Gaps.

### The 15-second default is uncalibrated

**Correct.** It is the value the proposing workspace uses in manual practice, and the skill
now says exactly that rather than implying it was measured. Calibration needs the live
run's send→session-ready-after-clear measurement, which is a verify-phase deliverable. The
skill flags it as a starting default pending that measurement.

### The `codev/reviews/1307-*.md` artifact is absent

**Being written now**, as the Review-phase deliverable, with the verify plan and the
unrun-e2e disclosure in it. It was not expected during implement phase_3.

---

## Nothing disputed

Every finding is either fixed (`ddf02abf`) or a correctly-identified verify-phase item
whose deferral the architect authorized and which the review discloses. No false positives.
