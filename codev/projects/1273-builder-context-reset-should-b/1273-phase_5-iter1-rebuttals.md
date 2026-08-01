# Rebuttal — Phase 5 (Re-orientation assembly), iteration 1

**Verdicts**: Gemini APPROVE (HIGH) · Codex REQUEST_CHANGES (HIGH) · Claude REQUEST_CHANGES (HIGH)

All five findings accepted. One point is a plan requirement I wrote and then did not follow.

**A note on Claude's blocking issue**: it reviewed the working tree while I was already applying Codex's
fixes, so it observed an intermediate state where `buildResumeNotice` had become required but the test
helper had not yet been updated. Its finding was therefore correct as observed and is resolved by the
same change. Recorded here rather than waved away, because "the reviewer saw a transient state" is
exactly the excuse that hides a real breakage — the 20 failures were real at the moment they were seen.

---

## Codex — REQUEST_CHANGES

### Issue 1: "Assembly permits a partial porch/issue frame"

**Accepted.** `REQUIRED_INLINE_MARKERS` covered protocol, mode, worktree, branch, state file and
long-form pointer — but not `Project:`, `Issue:` or `porch next`. Those were produced when the context
happened to carry them and silently skipped when it did not, which is precisely the "optional, therefore
omittable" shape R3 forbids.

The gap mattered because it was invisible: a porch-driven builder could be re-oriented without its own
project identity, and nothing in the code or the tests would object. A reset builder that cannot name its
project cannot find its spec, plan or status file.

**Changed** — added `conditionalInlineMarkers(context)`: markers that are required *when the lane
supplies the corresponding fact*. A porch lane must carry `Project:` and `porch next`; any lane with a
known issue must carry `Issue:`. Validation now checks `[...REQUIRED, ...conditional]`. This keeps the
non-porch case honest — a task builder genuinely has no project — while making omission impossible
wherever the fact exists.

### Issue 2: "Restates the porch re-entry instruction instead of reusing `buildResumeNotice()` verbatim"

**Accepted, and this one is mine twice over** — the plan I wrote says "the porch re-entry wording in
`inline` reuses `buildResumeNotice()` **verbatim** rather than restating it, so there is exactly one copy
of that text", and I then wrote my own sentence.

Codex names the concrete cost: my restatement dropped the `porch init` fallback that `buildResumeNotice`
carries for when porch reports "not found". A builder that hits that case after a reset — with no
conversation history to fall back on — would have been left without the recovery instruction.

**Changed** — added a `ResumeNoticePort`, wired in phase 6 to the real `buildResumeNotice`. The long form
embeds its output **verbatim**, so there is one copy of the text and the `porch init` fallback survives.
The inline frame keeps a one-line `porch next` pointer and refers to the long form for the full guidance.

*Deviation from the plan's letter, stated plainly*: the plan said the verbatim reuse would sit inline. It
sits in the long form instead. `buildResumeNotice` opens with "This is a **resumed** builder session",
which is false after a reset — the session was cleared, not resumed — and it is seven lines in a frame
whose fitness for the paced message channel is itself a tested constraint. Putting it in the long form
preserves the property the plan was actually protecting (one copy, no drift, fallback intact) without
telling a freshly-reset builder something untrue about its own state. A porch lane with no notice
available now **aborts**.

### Issue 3: "Test coverage misses the invariant gap"

**Accepted.** The suite asserted against the marker list, and the list was the thing that was wrong — so
it would have passed with project, issue and porch re-entry all absent. A test that validates against the
same incomplete constant it is meant to police is not coverage.

**Changed** — tests now assert the conditional markers directly (porch lane requires `Project:` and
`porch next`; issue-bearing lane requires `Issue:`; non-porch lane requires neither), plus rendered-output
assertions for the project name and issue number, and an abort case for a porch lane with no notice.

---

## Claude — REQUEST_CHANGES

### Blocking: "20/28 tests fail — helper omits `buildResumeNotice`"

**Correct as observed, and resolved by the same change.** The `assemble()` helper and three direct
`assembleReorientation` call sites now supply a `resumeNoticePort` fixture that includes the `porch init`
fallback, so the tests exercise the real reuse path rather than a stub that merely satisfies the type.
35 tests pass.

### Minor 1: "`plan.name` not asserted, asymmetric with `spec`"

**Accepted.** The plan assertion checked only `path`. Reusing `specName` for the plan is intentional —
porch names spec and plan from the same stem — and an asymmetric assertion would let that convention
break unnoticed. Now asserts the whole object, symmetric with `spec`.

### Minor 2: "No test that the resume notice appears in `longForm`"

**Accepted.** Added two: the notice appears verbatim in the long form for a porch lane (asserting the
`porch init` fallback text specifically, since dropping it was the actual defect), and is absent on a
non-porch lane.

---

## Gemini — APPROVE

No issues raised. Worth noting it approved a frame with the porch/issue gap in it, which is why the
dissent was worth taking seriously rather than counting verdicts.

---

## Net effect

One real invariant hole closed (conditional markers), one single-source violation fixed with the dropped
`porch init` fallback restored, three test gaps closed. Tests 28 → 35.
