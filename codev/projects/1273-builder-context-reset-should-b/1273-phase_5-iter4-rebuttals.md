# Rebuttal — Phase 5 (Re-orientation assembly), iteration 4

**Verdicts**: Gemini APPROVE (HIGH) · Claude APPROVE (HIGH) · Codex REQUEST_CHANGES (HIGH)

Accepted. This finding is different in kind from the previous three: it is a hole in the **enforcement
mechanism**, not in the frame content.

---

## Codex — REQUEST_CHANGES

### Issue: "An incomplete porch identity frame still assembles instead of aborting"

**Accepted.** `assembleReorientation` hard-required only top-level fields — `builderId`, `worktree`,
`branch`, `protocol`, `mode`, `statePath`. If `context.porch` existed but `projectId`, `projectName` or
`phase` was empty, assembly succeeded and emitted:

```
- Project ID:
- Project:  (phase: )
```

**Why the marker validation could not catch it.** `REQUIRED_INLINE_MARKERS` and
`conditionalInlineMarkers` match on **labels**: `'Project ID:'`, `'Project:'`, `'porch next'`. An empty
`projectId` still renders the literal `Project ID:` and satisfies the check. So the mechanism I built to
make partial frames impossible was structurally blind to a partial frame — it verified that the *slots*
existed, never that anything was in them.

That is worse than the three earlier phase-5 findings, which were missing content. This one is the
guarantee itself being weaker than advertised: a reset would have cleared a live builder's context and
handed back a frame that passed every completeness check while telling it nothing about its project.
**Presence of a label is not presence of a value.**

**Changed** — porch identity is validated field by field before assembly, with named errors
(`porch.projectId`, `porch.projectName`, `porch.phase`), alongside the existing top-level requirements.

**One field deliberately excluded**: `currentPlanPhase`. A porch lane sitting between plan phases
genuinely has none — phase 4 already models it as nullable and reads a literal `null` from `status.yaml`
as absent. Sweeping it into the required set would abort valid resets, which is the opposite failure. A
test pins that a null `currentPlanPhase` still assembles.

### Issue: "Tests do not cover that gap"

**Accepted** — the abort-path tests covered missing top-level fields, the missing resume notice and a
spawn-prompt failure, but never an empty porch subfield.

**Changed** — four tests added: one abort case per porch subfield (`projectId`, `projectName`, `phase`),
each asserting the named error, plus the null-`currentPlanPhase` case above.

---

## Gemini — APPROVE

No issues raised.

## Claude — APPROVE

No issues raised.

---

## Note on this phase's iteration count

Four rounds, four genuine defects, all found by the same reviewer. The pattern across them is worth
carrying into the review: **every one was a case of my tests validating what the code did rather than what
the spec required** — the marker list that omitted project/issue, the forwarding test that stopped at
spec/plan, the identity assertions that matched the weaker string, and now a completeness check that
matched labels instead of values. Absorbing four rounds here is the right trade against shipping a reset
that clears a live builder's context and returns an empty frame.

---

## Net effect

The completeness guarantee now checks values, not just slots. Tests 42 → 46.
