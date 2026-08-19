# Rebuttal — Spec 1470, Phase 2 (porch trigger) iteration 2

**Verdicts**: Codex REQUEST_CHANGES (3 issues) · Claude REQUEST_CHANGES (2 + 3 minor).

**All accepted except one that was already fixed before the review ran.** Between them the two
reviewers found a still-vacuous safety test and a real behavioral defect in this repo's own default
workflow.

---

## Codex 1 — the `#1408` test was STILL vacuous *(accepted; my error, and the worst kind)*

Codex: the test calls `next()` with `build_complete: false`, so porch returns a normal build task
without re-entering any recorded transition.

**Verified: correct.** `baseState()` defaults `build_complete` to false and my fixture did not
override it. So the test asserted "no refresh fired" about a call that could not have produced one —
in the single test I had explicitly called out as the important one, guarding the exact failure
class (#1408's transition loop) that motivates recording boundaries at all.

This is the **fifth** instance of one pattern in this project. The others: Phase 1's `null` test
that codified the wrong behavior; `spirLike(undefined)` silently declaring every boundary; the
fixture missing `build`/`verify` so nine tests ran through `handleOncePhase`; and the vacuous
negatives that gap created.

**Changed**: the test now drives a genuine approving verify round that ADVANCES into a boundary
already present in `context_refreshes`, and asserts two things a return-value check cannot:

- the transition still happens (`current_plan_phase` moves) — suppressing the refresh must not
  suppress protocol progress, which is the failure mode a naive "just don't fire" guard would
  introduce;
- the record is neither re-appended nor overwritten, checked via the **original timestamp**
  surviving.

A second case covers an entry boundary re-entered after a reset.

## Codex 2 — required transition paths uncovered *(accepted)*

Correct: only the gate-approved route was driven end to end.

**Changed**: an 8-case parameterized matrix, each case naming the **route** as well as the
boundary — because the same boundary reached by a different route is a different code path. That
distinction is not academic: it is exactly how the first plan draft shipped three of four routes
while its boundary list looked complete.

**The matrix earned itself on its first run**, failing the `pre-approved: plan → implement` case.
Cause was a fixture bug of mine — `writeApprovedArtifact('plans')` overwrote the file `writePlan()`
had just written, so the phases JSON vanished and `extractPlanPhases` fell back to inventing a
`phase_1`. Now `writePlan(ids, approved)` emits frontmatter and phases as one file.

*(Side observation, not in scope: `extractPlanPhases` silently invents a `phase_1` for a plan with
no phases JSON rather than reporting its absence. Noted for the review artifact.)*

## Codex 3 — no assertion of one write per transition *(accepted)*

Correct, and the reason matters: inspecting only the final state cannot distinguish one atomic
write from a transition write followed by a separate boundary write — and **that distinction is
the entire at-most-once mechanism.** If the record could land in a second write, a crash between
the two would leave a project transitioned but unmarked, and the next `porch next` would clear the
builder again.

**Changed**: a `writeStateAndCommit` spy counts calls; the atomicity tests and every matrix case
assert exactly one write per boundary transition.

---

## Claude 1 — pre-approval chains fire two refreshes back to back *(accepted; a real defect)*

The most consequential finding of the round, and it lands in **this repo's documented default
shape**: "Approved specs and plans need frontmatter and must be committed to `main` before
spawning."

Such a project skips `specify` and then `plan` on consecutive `porch next` calls. Both sites fired,
so the builder would be told to clear twice in a row **with no work between** — violating the spec's
"a refresh task is never emitted twice in a row" and the plan's "never fire back to back, at any
site". And at both moments the builder's context is near-empty, so the inherited ≥1000-byte save
gate would either be padded to pass or abort outright.

**Reproduced before fixing** — two failing tests first, then the change.

**Fix, taking Claude's recommended option: a SKIP IS NOT WORK.** No refresh at the pre-approval
site. That branch only runs at iteration 1 with `build_complete` false — i.e. *before* the builder
has done anything in the phase being skipped — so there is no context to refresh.

The boundary that matters is not lost, and this is what makes the fix safe rather than merely
quiet: whenever the builder **actually writes the plan**, `enter:implement` still fires from the
gate-approved transition. Both directions are now pinned:

- both artifacts pre-approved → zero refreshes, but the transition completes fully (phase
  `implement`, plan phases extracted, `current_plan_phase` set);
- spec pre-approved, plan written by the builder → no refresh on the skip, refresh on the real
  transition into `implement`.

**On authority**: this narrows Phase 2's "wire all four sites" to "wire all four sites, but a skip
is not work". It *satisfies* the spec criterion rather than contradicting it, so I implemented it
rather than blocking, and reported it to the architect for the record.

**Worth noting the arc across the two reviews**, because it looks like a contradiction and is not:
iteration 1 said the pre-approval site was *missing* and had to be wired; iteration 2 says it must
not *fire*. Both are right. The site genuinely needed its gate approval and `plan_phases`
extraction — that half was a real gap — but not the refresh. "Wire the site" and "fire the
boundary" turned out to be two questions, and I had merged them into one.

## Claude 2 — iteration 2's test work is uncommitted *(already resolved)*

The only item I am not acting on, because it was fixed before the review ran. The write-counter,
the 8-case matrix, the atomicity tests and the second `#1408` case are commit `1d9581595`,
made while the consultation was still running. Claude reviewed a stale snapshot — a normal
artifact of parallel review, not an error on its part.

The related sub-point **is** actioned: the two untracked `*-iter2-context.md` files are not
gitignored (the consult `.txt` outputs are), so they belong in the artifact trail and are now
committed.

## Claude — minor items

- **`moveToReview` hardcodes `'review'`** for both the phase assignment and the boundary id.
  *Taken as a comment.* The hardcoded assignment is pre-existing, and because the boundary derives
  from the same literal the record and the event cannot disagree — but a protocol whose
  `per_plan_phase` phase transitions to a differently-named successor would silently mis-target
  **both**. The comment says to change them together or derive both from `getNextPhase`.
- **`shouldRefresh(state, declared, boundary)` argument order.** *Acknowledged, not changed.*
  Claude marked it cosmetic; reordering churns three call sites in code whose ordering properties
  are the safety-critical part of this phase. Not worth the diff noise against zero behavioral
  gain.
- **Not re-raised by Claude, and correctly so**: the `afx self-refresh` forward reference (Phase 4),
  the plan-vs-spec wording contradiction (implementation follows the spec), and the ASPIR fix scope
  (architect ruled: ship here, reference #1503).

---

## Net

4 substantive changes: the `#1408` test made real, the transition matrix, the one-write atomicity
assertion, and the pre-approval refresh suppressed. 1 item already resolved before review. 1 minor
documented, 1 declined as cosmetic.

The pattern I keep paying for is now explicit enough to state as a rule for the remaining phases:
**a test must assert an observable effect of the thing it names — a state mutation, a step in an
ordered log — never only the shape of a return value.** Five vacuous tests in two phases all had
the same tell: they would have passed against a no-op. Phase 3 is where this matters most, since
its tests decide whether a builder's context is destroyed; every abort path there must assert that
no `clear` step was ever appended, not merely that an error was returned.
