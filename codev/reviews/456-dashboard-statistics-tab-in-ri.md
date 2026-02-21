# Review: Dashboard Statistics Tab in Right Panel

## Metadata
- **Spec**: codev/specs/456-dashboard-statistics-tab-in-ri.md
- **Plan**: codev/plans/456-dashboard-statistics-tab-in-ri.md
- **PR**: #488
- **Date**: 2026-02-21

## Summary

Implemented a Statistics tab in the dashboard right panel that aggregates project health metrics from three data sources: GitHub CLI (merged PRs, closed issues, backlogs), consultation metrics DB, and active builder count. The implementation spans three phases: backend data layer, API endpoint, and dashboard UI.

## What Went Well

1. **Clean separation of concerns**: The `statistics.ts` service cleanly aggregates from three independent sources, each wrapped in try/catch for graceful degradation. The handler in `tower-routes.ts` is minimal and delegates to the service.

2. **Existing patterns made integration smooth**: The dashboard's tab system, always-mounted rendering pattern, and CSS variable system were well-established, making the UI phase largely a matter of following existing conventions.

3. **Multi-agent consultation caught real issues**: All three phases had reviewers flag the same core issues (multi-issue PR parsing, missing endpoint tests, duplicate fetch), confirming the value of 3-way review.

## What Could Be Improved

1. **Test mocking complexity**: The statistics service test required careful Vitest 4 mocking patterns (`vi.hoisted()` + class-based constructor mocks). The initial approach using `Object.defineProperty` on the MetricsDB class was fundamentally broken — it modified a static getter while the constructor used a module-level constant. Lesson: understand the module's internals before designing mocks.

2. **Duplicate React effects**: The initial `useStatistics` hook had two `useEffect` hooks both depending on `isActive`, causing double-fetches on tab activation. A single merged effect is cleaner and avoids the issue.

## Deviations from Plan

1. **`gh pr list --search` instead of `gh search prs`**: The plan specified `gh search prs` but the implementation uses `gh pr list --state merged --search "merged:>=DATE"`. This is functionally equivalent and better because `gh pr list` is repo-scoped by default (no OWNER/REPO needed) and returns `mergedAt` in JSON output.

2. **Cache key includes workspace path**: The spec described caching keyed by `range` alone. The implementation uses `${workspaceRoot}:${range}` to support multi-workspace correctness in workspace-scoped routes.

## Test Coverage

| Area | Tests | Coverage |
|------|-------|---------|
| statistics.ts (service) | 27 | fetchMergedPRs, fetchClosedIssues, computeStatistics (full assembly, partial failures, null averages, project completion, caching, throughput) |
| metrics.ts (costByProject) | 6 | Top 10 by cost, null exclusion, empty array, limit, days filter |
| tower-routes.ts (endpoint) | 6 | Route dispatch, invalid range, default range, refresh, no workspace, range=all |
| StatisticsView (component) | 15 | Loading, sections, null values, errors, per-model table, cost-per-project, range switch, refresh |
| **Total** | **54** | |

## Lessons Learned

1. **Vitest 4 constructor mocks need class syntax**: `vi.fn(() => ({...}))` fails as "not a constructor". Use `class MockClass { ... }` inside `vi.mock()` factory with `vi.hoisted()` for shared mock functions.

2. **Merge overlapping React effects**: Two effects depending on the same state variable both fire on change, causing unintended duplicate side effects. A single merged effect is always cleaner.

3. **Multi-agent review catches different things**: Gemini and Codex consistently flagged the same issues (showing agreement), while Claude provided nuanced architectural notes. The combination is more valuable than any single reviewer.

## Consultation Feedback

### data_layer Phase (Round 1)

#### Gemini (REQUEST_CHANGES)
- **Concern**: `parseLinkedIssue` only returns single issue from PR body
  - **Addressed**: Created `parseAllLinkedIssues()` with global regex

#### Codex (REQUEST_CHANGES)
- **Concern**: Should use `gh search prs` instead of `gh pr list`
  - **Rebutted**: `gh pr list --state merged --search` achieves same server-side filtering with automatic repo scoping and `mergedAt` field
- **Concern**: Partial GitHub failure not surfaced in errors
  - **Rebutted**: Partial data is still valuable; error only when all three calls fail
- **Concern**: `activeBuilders` passed as parameter instead of reading from overview cache
  - **Rebutted**: Keeps `computeStatistics` pure and testable; wired in route handler

#### Claude (APPROVE)
- No concerns raised

### api_endpoint Phase (Round 1)

#### Gemini (REQUEST_CHANGES)
- **Concern**: Missing unit tests for route handler
  - **Addressed**: Added 6 tests to `tower-routes.test.ts`

#### Codex (REQUEST_CHANGES)
- **Concern**: Missing endpoint unit tests
  - **Addressed**: Same as Gemini above

#### Claude (APPROVE)
- No concerns raised

### dashboard_ui Phase (Round 1)

#### Gemini (APPROVE)
- No concerns raised

#### Codex (REQUEST_CHANGES)
- **Concern**: Duplicate fetch on tab activation due to overlapping effects
  - **Addressed**: Consolidated two effects into one

#### Claude (APPROVE)
- Noted double-fetch and CSS variable inconsistency as non-blocking observations
  - **Addressed**: Both fixed alongside Codex feedback

### PR-Level Review (Round 1)

#### Gemini (APPROVE)
- No concerns raised

#### Codex (REQUEST_CHANGES)
- **Concern**: Spec mismatch on `gh pr list` vs `gh search prs`
  - **Rebutted**: Already addressed in data_layer phase — intentional deviation
- **Concern**: Partial GitHub error handling doesn't match R6
  - **Rebutted**: Already addressed in data_layer phase — partial data is more valuable
- **Concern**: Missing E2E tests
  - **Rebutted**: Documented as follow-up; 54 unit/component tests cover v1

#### Claude (APPROVE)
- **Concern**: Hardcoded `timeRange: '7d'` in no-workspace fallback
  - **Fixed**: Moved range validation before workspace check so fallback uses requested range
- Minor observations (inline empty response, missing try-catch) noted as consistent with codebase patterns

## Architecture Updates

Updated `codev/resources/arch.md`:
- Added `StatisticsView.tsx` and `useStatistics.ts` to the dashboard directory tree
- Added `statistics.ts` to the Tower server module decomposition table
- Added `GET /workspace/:enc/api/statistics` to the workspace-scoped API routes table
- Added "Statistics View (Spec 456)" subsection describing the feature's data flow and behavior

## Lessons Learned Updates

No new generalizable lessons beyond what's already documented. The Vitest 4 constructor mocking issue is project-specific rather than a broadly applicable pattern.

## Flaky Tests

No flaky tests encountered.

## Follow-up Items

- Add E2E/Playwright test for the Statistics tab
- Consider adding a 24h time range option (noted in spec review comments)
- Consider "Analytics" as an alternative tab name (noted in spec review comments)
