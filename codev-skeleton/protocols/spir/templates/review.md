# Review: [Feature/Project Name]

## Summary

1–3 sentences: what was built, how many phases, the net outcome.

## Spec Compliance

Each acceptance criterion and whether it was met, with the phase that delivered it.

- [x] AC1: [Description] (Phase N)
- [ ] ACn: [Not met — reason]

## Deviations from Plan

What changed from the plan, per phase, and why. "None" if the plan held.

## Consultation Feedback

Per phase that had consultation, each reviewer's concerns and how you responded — **Addressed** (changed), **Rebutted** (why it does not apply), or **N/A** (out of scope / moot). "No concerns raised — all consultations approved" when that is true; note COMMENT verdicts and any `CONSULT_ERROR`.

### [Phase] Phase (Round N)

#### Gemini
- **Concern**: … → **Addressed** / **Rebutted** / **N/A**: …

## Lessons Learned

### What Went Well

### Challenges Encountered

What was hard and how it resolved.

### What Would Be Done Differently

### Methodology Improvements

Suggested improvements to the SPIR protocol or the tooling.

## Architecture Updates

What you routed where — HOT `codev/resources/arch-critical.md` (tiny, capped, always-injected) vs COLD `codev/resources/arch.md` (reference) — or why no change was needed. Note any hot-tier demotion made to respect the cap.

- Routed: [hot | cold] — [fact] — [what changed]
- Or: "No architecture updates needed — [reason]"

## Lessons Learned Updates

What you routed where — HOT `codev/resources/lessons-critical.md` (capped) vs COLD `codev/resources/lessons-learned.md` (reference) — or why no change was needed.

- Routed: [hot | cold] — [category] — [lesson]
- Or: "No lessons learned updates needed — [reason]"

## Flaky Tests

Pre-existing tests skipped as flaky during this project — name, file path, observed failure mode. "No flaky tests encountered" if none.

## Follow-up Items

Work identified for later, outside this spec's scope.
