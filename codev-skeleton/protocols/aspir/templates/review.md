# Review: [Feature/Project Name]

## Summary

[1-3 sentences: what was built, how many phases, net outcome.]

## Spec Compliance

- [x] AC1: [Description] (Phase N)
- [x] AC2: [Description] (Phase N)
- [ ] ACn: [Not met — reason]

## Deviations from Plan

- **Phase N**: [What changed and why]

## Key Metrics

- **Commits**: [N] on the branch
- **Tests**: [N] passing ([N] existing + [N] new)
- **Files created**: [list]
- **Files deleted**: [list]
- **Net LOC impact**: [+/-N lines]

## Timelog

All times [timezone], [date range].

| Time | Event |
|------|-------|
| HH:MM | First commit: [description] |
| HH:MM | [Phase/milestone] |
| — | **GATE: [gate-name]** (human approval required) |
| HH:MM | Implementation begins |
| HH:MM | Phase N complete after N iterations |
| HH:MM | **GATE: pr** |

### Autonomous Operation

| Period | Duration | Activity |
|--------|----------|----------|
| Spec + Plan | ~Nm | [Summary] |
| Human gate wait | ~Nh Nm | Idle — waiting for approval |
| Implementation → PR | ~Nh Nm | N phases, N consultation rounds |

**Total wall clock** (first commit to pr): **Xh Ym**
**Total autonomous work time** (excluding gate waits): **~Xh Ym**
**Context window resets**: [N] (resumed automatically / required manual restart)

## Consultation Iteration Summary

[N] consultation files produced ([N] rounds x [N] models). [N] APPROVE, [N] REQUEST_CHANGES, [N] COMMENT.

| Phase | Iters | Who Blocked | What They Caught |
|-------|-------|-------------|------------------|
| Specify | N | [Model] | [Brief description] |
| Plan | N | [Model] | [Brief description] |
| Phase 1 | N | [Model] | [Brief description] |
| Phase N | N | [Model] | [Brief description] |
| Review | N | [Model] | [Brief description] |

**Most frequent blocker**: [Model] — blocked in N of N rounds, focused on: [pattern].

### Avoidable Iterations

Iterations that could have been prevented with better builder behavior:

1. **[Pattern]**: [Specific thing the builder should have done without needing reviewer feedback. E.g., "Run exhaustive grep before claiming all instances fixed."]

2. **[Pattern]**: [Another avoidable iteration pattern.]

## Consultation Feedback

[For each phase that had consultation, summarize every reviewer's concerns and how the builder responded. Use **Addressed** (fixed), **Rebutted** (disagreed with reasoning), or **N/A** (out of scope/moot) for each concern. If all reviewers approved with no concerns: "No concerns raised — all consultations approved."]

### [Phase] Phase (Round N)

#### Gemini
- **Concern**: [Summary of concern]
  - **Addressed**: [What was changed]

#### Codex
- **Concern**: [Summary of concern]
  - **Rebutted**: [Why current approach is correct]

#### Claude
- No concerns raised (APPROVE)

## Lessons Learned

### What Went Well
- [Specific positive observation — what worked and why]

### Challenges Encountered
- **[Challenge]**: [How it was resolved. How many iterations it cost.]

### What Would Be Done Differently
- [Actionable improvement for future builders]

## Architecture Updates

[What was added/changed in `codev/resources/arch.md`, or why no changes were needed.]

- Updated: [section name] — [what was added/changed]
- Or: "No architecture updates needed — [brief reason]"

## Lessons Learned Updates

[What was added/changed in `codev/resources/lessons-learned.md`, or why no changes were needed.]

- Added: [category] — [lesson summary]
- Or: "No lessons learned updates needed — [brief reason]"

## Technical Debt

- [Any shortcuts taken or inconsistencies introduced]

## Follow-up Items

- [Items identified for future work, outside this spec's scope]
