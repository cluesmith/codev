# Review: `/arch-save` — packaged save→clear→re-init for architects (Spec 1307)

## Summary

`/arch-save` packages the manual architect-refresh recipe — save state → clear → re-init —
into a single skill, backed by one new primitive: `afx send --delay`, a Tower-side deferred
send. The skill sequences: stop your own monitors → write a pruned state file → `--raw
'/clear'` → `--delay 15 --raw '/arch-init <name>'` → stop. Tower holds the last message past
the clear that would otherwise have destroyed the sender, and `/arch-init` recovers from the
state file.

**What this project is not, by the time it shipped:** the Tower-owned job orchestrator,
`--begin`/`--boundary` handshake, verification gates and bounded-window machinery that the
first two CMAP rounds hardened. The owner descoped all of it. The feature is one send
parameter and a document, and the descope is the single most important design decision in
the record — see Lessons.

## What shipped

- **`afx send --delay <seconds>`** (Tower-side deferred delivery): authorised at request
  time, delivered later, so the sending process can exit — the capability that makes the
  cycle's third leg possible from inside a session about to be cleared. Bounds 1–3600s,
  validated at CLI and server; not persisted (a restart drops pending sends, by design);
  reports "scheduled", not "sent".
- **`/arch-save` skill** in all four trees (`.claude`, `.codex`, and both `codev-skeleton`
  mirrors), guarded against drift and content-regression by
  `spec-1307-arch-save-skill.test.ts`.
- **`/arch-init` updated** so it no longer documents a competing manual-only loop; the
  manual path remains as the Tower-unavailable fallback.
- **Adoption of Spec 1273's submission lock** (`submitToSession`): every write from
  `deliverOrBuffer` — immediate and delayed — goes through it, so a message is *submitted*
  (Enter included) before the next write to that session begins. This project's three
  narrower mechanisms (`writeCompletesInMs` wait, `SendBuffer.busyUntil`, the per-terminal
  chain in `delayed-send.ts`) were deleted in favour of it. One mechanism, not two.
- **Ordering guarantees**, tested at the route level and mutation-verified: a delayed
  message never overtakes one already queued for a session; concurrent deliveries do not
  interleave; a delayed message (including a `--interrupt`) due mid-flush queues behind the
  flush rather than writing into it. Request-order across *differing* delays is explicitly
  not guaranteed.

## Architecture Updates

Nothing in `arch.md`/`arch-critical.md` needs changing: no new subsystem, no new invariant.
`--delay` is a parameter on the existing send pipeline; `/arch-save` is a skill resolved
through the existing four-tier chain. The one cross-cutting fact worth carrying forward —
that submission atomicity is now a shared Tower primitive (`submitToSession`) rather than
per-caller — belongs to Spec 1273's review, which owns the primitive.

## Lessons Learned Updates

1. **Descoping concentrates risk into the seams; review the seams hardest.** The feature
   shrank from a job orchestrator to a send flag, and every genuine defect across eight
   review rounds lived where the *new* delivery path met the *existing* one — `SendBuffer`,
   the paced-write window, the submission lock's boundaries. Smaller did not mean simpler to
   get right; it meant the remaining risk pooled at the integration points. (Pairs with
   1273's own lesson: proportionate machinery.)

2. **An artifact can assert something adjacent to the truth, and pass self-review because
   it exists.** This recurred in six materials this project: a test asserting against a
   copied predicate; a test against a replica helper; a test against a synthetic callback; a
   test whose *timing* missed the window it was named for; a shutdown-flush test given too
   few ticks to actually exercise the wait; and a *spec* claiming a request-order guarantee
   the code did not make. Plus comments — and one review claim — crediting a guarantee the
   code did not yet back. The cheap check that catches all of them: **mutate the guard,
   confirm the test fails.** The lesson is not that I learned it once; it is that I had to
   apply it repeatedly, and the times it caught the defect before a reviewer did were the
   times I ran it *before* claiming the fix rather than after.

3. **A stale CI green is the same failure one level up.** A merge landed on main whose
   July-6 green predated the parity guards the repo had since grown — true when produced,
   false when used. The standing rule that came out of it (re-validate a stale green against
   current main's guards before merge) is the CI-level version of the mutation check.

4. **Verify a reviewer's factual claim against source before acting on it.** Codex made
   several claims about the codebase (`tower-cron`'s tick, `lastDataAt`'s semantics, the
   `session-submit` API); checking each before acting confirmed them fast enough to act with
   confidence, and separately let me catch a *sibling's* false datum (`_lastInputAt` bumped
   by Tower's own writes) before either of us built on it.

## Deviations from the plan

- The spec's Approach 2 (Tower-owned job) was rejected wholesale by owner directive before
  implementation; the plan was rewritten to match. Recorded in the spec's Notes.
- `--delay` documentation was removed from `CLAUDE.md`/`AGENTS.md` and placed only in the
  command reference, per architect ruling — Spec 1280's Phase 1 restructured `CLAUDE.md` so
  per-flag CLI detail no longer belongs in the always-on surface. The spec's byte-identical
  criterion was amended in place with a dated supersession note.
- The `afx` skill does **not** gain `--delay`; that drift is #1318's to reconcile, per the
  same ruling Spec 1273 received.

## Known gaps

- **The live end-to-end run has not happened.** It is scheduled for the verify phase (see
  below), and this is disclosed here rather than discovered later — the explicit lesson from
  1273, which shipped a non-functional `/clear` because no one ran the headline path.
  Unverified until the verify run: that `/clear` actually *executes* (not merely arrives),
  canary loss, identity recovery from the state file, monitor reconciliation, and the manual
  re-send recovery path.
- **The 15-second default is uncalibrated** — it is the value the proposing workspace uses in
  manual practice, not one measured against the send→session-ready-after-clear interval. The
  verify run calibrates it.

## Verify-phase plan (the live e2e)

`/arch-save` is an architect-session skill: its step 1 makes a *builder* refuse, so the
builder that implemented this feature cannot run its own live cycle, and running it clears a
real architect's context. The run is therefore an architect action in verify, shaped exactly
as Spec 1273's successful probe retest:

1. After merge, the next batched install lands (`submitToSession` and this project's code in
   one running Tower).
2. Architect creates a throwaway sibling: `afx workspace add-architect --name probe-1307`
   (architect-only, from the main root).
3. Plant a canary — a distinctive fact — in the sibling's context.
4. The sibling invokes `/arch-save`. Verify, in order: the state file was written and pruned;
   `/clear` *executed* (harness clear announcement; canary gone; `/clear` not welded to the
   front of another message); `/arch-init` arrived and recovered identity from the state
   file; monitors reconciled.
5. Exercise the recovery path deliberately: drop the delayed `/arch-init`, re-send it by
   hand, confirm recovery.
6. Set the documented default delay from the measured send→session-ready interval.
7. `afx workspace remove-architect probe-1307`.

The runbook with the exact checks is in the plan's phase 3.

## Per-phase review history (including phase_3's force-advance)

Stated explicitly so the gate reader needs no `status.yaml` archaeology.

| Phase | Rounds | Outcome |
|---|---|---|
| phase_1 (`--delay`) | 8 iterations | Clean: iter-3 recorded double-review resolution; six of the eight found real defects |
| phase_2 (skill) | 2 iterations | Clean double-approve |
| phase_3 (adoption + docs) | 3 iterations **+ confirming round** | **Force-advanced at porch's 3-iteration cap** |

**phase_3 did not reach a clean double-APPROVE within the cap.** Its three iterations each
returned `REQUEST_CHANGES` from both lanes; every finding was a real regression introduced
adopting Spec 1273's submission lock, each fixed with mutation-verification, but porch's
`max_iterations: 3` was reached before a fourth consult could confirm the iter-3 fixes.
Porch force-advanced (recorded in `status.yaml` as `force_advanced`), which is its designed
behaviour at the cap — it hands adjudication to the human gate rather than looping.

Because force-advance is not approval, a **confirming review round** was run after the cap
(architect ruling, 2026-08-02): both lanes returned `REQUEST_CHANGES` on the iter-3 state —
a vacuous shutdown-flush test and a shutdown-ordering race — which were treated as a real
fourth iteration, fixed (`await`-drain of all in-flight submissions; `shutdownDelayedSends`
ordered before the buffer flush; both fixes mutation-verified), and re-confirmed clean
before this PR was prepared. The full round-by-round record and rebuttals are in
`codev/projects/1307-arch-save-packaged-save-clear-/`.

The honest read: the lock adoption was a leaky seam and took more than three rounds to
settle. Nothing here shipped on the strength of a force-advance alone.

## Flaky Tests

None introduced. One self-inflicted test-isolation issue found and fixed: delayed-send tests
sharing a session id poisoned each other once `submitToSession` serialised per session (a
chain abandoned under fake timers never drains). Each test now uses its own id — correct
hygiene, and reported to 1273 as a note about their primitive (benign in production, where
writes complete).

## Testing

- Full suite green: 4186 passed, 0 failed, 48 skipped.
- New coverage: `spec-1307-send-delay.test.ts` (validation, scheduling, shutdown-drop,
  shutdown-during-lock-wait, FIFO), `spec-1307-arch-save-skill.test.ts` (four-tree drift +
  content), and route-level `ORDERING:` tests (buffered-inversion, two-simultaneous-delayed,
  mid-flush, mid-flush-interrupt), plus core-side `tower-client-send.test.ts` for the wire
  contract.
- Every ordering and cancellation guard is mutation-verified: the fix is confirmed to be the
  thing the test depends on, not incidental. This includes the route-site `stillLive`
  cancellation guard, which an earlier draft of this review claimed was mutation-verified
  when it was not — the test then covered only the predicate's return value, not that the
  write was skipped. That gap (Claude, phase-3 iter 3) is now closed by a route-level test
  that drives `deliverOrBuffer` with a shutdown landing during the `submitToSession` wait,
  and deleting the guard fails it. Recorded because claiming a check that did not exist is
  precisely the failure mode lesson 2 is about.
