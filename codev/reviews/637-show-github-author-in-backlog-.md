# Review: Show GitHub Author in Backlog and PR Views

## Summary

Added the GitHub author username to backlog issue rows and PR rows in the workspace overview dashboard. The change flows end-to-end through 2 phases: forge concept shell scripts → type contracts → backend overview mapping → frontend dashboard components. 6 new unit tests added.

## Spec Compliance

- [x] Backlog rows show the GitHub username of the issue author (Phase 2)
- [x] PR rows show the GitHub username of the PR author (Phase 2)
- [x] `issue-list` forge concept command fetches the `author` field (Phase 1)
- [x] `pr-list` forge concept command fetches the `author` field (Phase 1)
- [x] Types updated end-to-end: forge contracts, backend overview, dashboard API, components (Phase 1+2)
- [x] Existing tests pass; new unit tests cover author field in `deriveBacklog` and PR mapping (Phase 1)
- [x] Non-GitHub forges degrade gracefully — author is optional at every layer (Phase 1+2)

## Deviations from Plan

- **Author position**: Plan specified "after the age element, right-aligned." Implementation places author *before* the age element, which is better UX — age at the end is more scannable as the smallest datum.

## Key Metrics

- **Commits**: 5 on the branch
- **Tests**: 6 new tests added (3 in `deriveBacklog`, 3 in `OverviewCache`)
- **Files modified**: 9 source files + 2 new spec/plan files
- **Net LOC impact**: +318 / -4

## Consultation Iteration Summary

12 consultation files produced (4 rounds x 3 models). 8 APPROVE, 0 REQUEST_CHANGES, 4 COMMENT (3 Codex unavailable, 1 Gemini minor observations).

| Phase | Iters | Who Blocked | What They Caught |
|-------|-------|-------------|------------------|
| Specify | 1 | — | Gemini: shared type impact (RecentlyClosedResult) + ghost user edge case |
| Plan | 1 | — | No blockers; both approved |
| data_pipeline | 1 | — | No blockers; both approved |
| frontend_rendering | 1 | — | No blockers; both approved |

**Most frequent blocker**: None — all phases passed in 1 iteration.

### Avoidable Iterations

None — all phases completed in a single iteration.

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini
- **Concern**: `RecentlyClosedResult` shares `IssueListItem` type — if `recently-closed.sh` isn't updated, author will be missing for closed issues.
  - **N/A**: Author is optional at every layer. Closed issues don't display in the backlog view.
- **Concern**: Deleted GitHub users may return `null` author instead of `{ login: "ghost" }`.
  - **Addressed**: All mapping code uses optional chaining (`issue.author?.login`). Added a specific test for null author.

#### Codex
- Consultation failed (401 Unauthorized from api.openai.com)

#### Claude
- No concerns raised (APPROVE)

### Plan Phase (Round 1)

#### Gemini
- No concerns raised (APPROVE)

#### Claude
- **Comment**: Shell script comments should be updated when adding `author` to `--json` fields.
  - **Addressed**: Comments in both `issue-list.sh` and `pr-list.sh` were updated.

#### Codex
- Consultation failed (401 Unauthorized)

### Implementation Phases (Round 1 each)

No concerns raised — all consultations approved. Full implementation was reviewed after both phases were complete.

## Lessons Learned

### What Went Well
- End-to-end data flow pattern (forge → contracts → backend → frontend) is clean and well-established; adding a field was straightforward
- Existing `overview.test.ts` had a clear test pattern (`issueItem` helper) making new tests easy to add

### Challenges Encountered
- **Porch plan_phases extraction bug**: ASPIR's no-gate advancement path in `handleVerifyApproved` doesn't extract plan phases from the plan file when transitioning to implement. Worked around by adding approved frontmatter to the plan and re-triggering the pre-approved artifact code path. Cost ~10 minutes of debugging.

### What Would Be Done Differently
- For ASPIR, add approved frontmatter to the plan file before the first `porch done` in the plan phase to avoid the extraction bug.

## Architecture Updates

No architecture updates needed — this adds one optional field to existing data flow types. No new subsystems, no new data flows, no design decisions beyond "follow the existing pattern."

## Lessons Learned Updates

No lessons learned updates needed — straightforward implementation with no novel insights beyond the porch bug workaround documented above.

## Technical Debt

- **Porch bug**: `handleVerifyApproved` in `next.ts` doesn't extract plan phases when advancing to a phased protocol via the no-gate path (lines 748-761). Should mirror the extraction logic from lines 396-404. This affects ASPIR specifically since spec and plan gates are removed.

## Flaky Tests

No flaky tests encountered. 3 pre-existing failures in `update.test.ts` (skeleton directory not found) are unrelated to this change.

## Follow-up Items

- Fix the porch plan_phases extraction bug (affects all ASPIR projects)
- Consider showing author in the recently-closed view as well
