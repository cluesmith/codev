# PR Review — Iteration 1 Rebuttals

**Verdicts**: codex `REQUEST_CHANGES` (HIGH) · claude `APPROVE` (HIGH)

All three codex findings accepted and fixed. Claude's three non-blocking points are recorded as
known limitations in the review rather than fixed — reasons below. Nothing rebutted.

---

## codex 1 (blocking) — `satisfies` catches removals, not additions

> `as const satisfies readonly ModelReasoningEffort[]` catches values removed from the SDK union,
> but not values added to it. An SDK addition would compile while `validateReasoningEffort`
> continued rejecting the new valid value, violating the spec requirement.

**Accepted, and this one stings**: the comment directly above that line claimed the binding caught
"adds/removes/renames", and the code caught two of the three. The claim was the only thing holding
the third. Same failure as every phase_6 docs defect — an assertion written from intent rather than
from mechanism — this time in a load-bearing comment rather than a document.

The failure mode is the worse direction, too: a *removal* breaks the build loudly, whereas an
*addition* fails open — Codev silently hard-rejects a value the SDK considers legal, and the spec
required drift in either direction to break the build.

**Fix**: a reverse exhaustiveness check alongside `satisfies`.

```ts
type UncoveredEffort = Exclude<ModelReasoningEffort, (typeof REASONING_EFFORTS)[number]>;
const _REASONING_EFFORTS_ARE_EXHAUSTIVE: UncoveredEffort extends never ? true : never = true;
```

**Mutation-verified**, since a type-level guard that never fires is indistinguishable from no guard.
Removing `'xhigh'` from the list (simulating an SDK member the list fails to cover) produces:

```
src/lib/consult-lanes.ts(56,7): error TS2322: Type 'true' is not assignable to type 'never'.
```

Baseline is clean; restored after.

## codex 2 (blocking) — the associated test is circular

> `consult-lanes.test.ts:142-145` claims to accept every SDK enum value but iterates
> `REASONING_EFFORTS`, the local list being tested.

**Accepted.** The test validated the list against itself: it passes for any contents and can never
detect a value the SDK has and we lack. The fourth structurally-unable-to-fail assertion this
project has produced.

Split the concern rather than patching it. The runtime test now pins the accepted values as
**literals** (so an accidental edit to the list fails it), and SDK drift is carried by the
compile-time `UncoveredEffort` check. **No runtime test can enumerate a union that exists only at
compile time** — attempting it is precisely what made the original circular.

## codex 3 (blocking) — the review's own metadata was inaccurate

> The review says all phases were unanimously approved and reports 93 commits. `status.yaml`
> records phase 6 ending with codex `REQUEST_CHANGES` and a force advance, while `main...HEAD`
> contains 96 commits.

**Accepted; both wrong, and this is the most important of the three.** Verified against
`status.yaml`: phase 6 ended at iteration 3 with codex `REQUEST_CHANGES` / claude `APPROVE`, hit
`max_iterations: 3`, and was **force-advanced**. My iter3 fixes were committed but never
re-reviewed. Commit count is 96.

Nobody misled me — I summarized my own project from memory instead of reading the state file, which
is the identical habit that produced every phase_6 docs defect. I had even written that lesson down
in this project's thread, then closed the phase by writing its outcome from memory.

**Force-advance is not approval.** Blurring them removes exactly the signal the pr-gate reader needs
to judge what a human still has to check. Corrected in both the review and the thread file, and the
review now states precisely which changes went unreviewed (the iter3 docs fixes: JSON examples made
parseable, real pricing rates, PIR example consistency) and how I verified them myself.

On codex's note that it could not rerun the suite (`EPERM` under `node_modules/.vite-temp` in a
read-only environment): all results quoted here were produced locally, and the mutation result above
is stated explicitly rather than left as "tests pass".

---

## claude (APPROVE, three non-blocking) — recorded, not fixed

All three are legitimate; none is fixed here, because each would mean overriding a spec requirement
or widening scope at the PR gate without an architect decision. All three are now written into the
review under **Known limitations and follow-up candidates** so they survive the merge:

1. **`byProtocol` name validation is workspace-scoped while config can be global.** A
   `byProtocol.<name>` set in `~/.codev/config.json` for a protocol that exists in only one
   workspace hard-fails `loadConfig` elsewhere on the same machine. This follows directly from the
   spec's "unknown keys are errors, never warnings"; softening it by config layer is a design change
   and the architect's call, not mine.
2. **`model_id` is write-only** — populated by every lane, not yet surfaced by `consult stats`.
   Scenario 13 required recording it and keeping `model` as the grouping key; surfacing it is a
   clean follow-up with the data already in place from merge day.
3. **Cosmetic**: repeated `loadConfig` calls per codex consultation and `listReviewTypes` recomputed
   inside the `byProtocol` loop. Cheap and off the hot path; noted so a later reader knows it was
   seen rather than missed.

---

## Verification

`tsc --noEmit` 0 · exhaustiveness guard mutation-verified · 83 lane tests green · full review-phase
checks green (`pr_exists`, `review_has_arch_updates`, `review_has_lessons_updates`, `e2e_tests`).
