# Rebuttal: Plan 456, Plan Iteration 1

## Gemini (COMMENT)

### 1. TAB_ICONS Doesn't Exist
**Accepted.** Verified — `TabBar.tsx` has no `TAB_ICONS` map. Updated plan to prepend the `∿` glyph to the label string: `label: '∿ Stats'`. Removed all references to `TAB_ICONS`.

### 2. Active Builder Count via Terminal Sessions
**Noted.** The plan currently reads from the overview cache. During implementation, if accessing `getWorkspaceTerminalsEntry().builders.size` is simpler and avoids circular dependencies, we'll use that approach instead.

## Codex (REQUEST_CHANGES)

### 1. Cache Key Differs from Spec
**Accepted as intentional deviation.** The spec says cache keyed by `range`, but workspace-scoped routes require including the workspace root to avoid cross-workspace collisions. Added explicit note in plan's Notes section documenting this deviation and the reason.

### 2. `--limit 500` Conflicts with Spec's 1000-Item Expectation
**Accepted.** Bumped `--limit` from 500 to 1000 in both `fetchMergedPRs` and `fetchClosedIssues` to match GitHub's search limit and the spec's note.

### 3. `parseLinkedIssue()` Not Explicit
**Accepted.** Added explicit detail in Phase 1's `computeStatistics` description: calls `parseLinkedIssue(pr.body, pr.title)` on each merged PR, counts distinct non-null issue numbers, excludes PRs without linked issues, handles multiple issues per PR.

### 4. Missing Playwright Reference and Test Gaps
**Accepted.**
- Updated E2E test reference to explicitly mention Playwright and `codev/resources/testing-guide.md`.
- Added unit tests for: `parseLinkedIssue` integration (no-link exclusion, multi-issue dedup), `avgTimeToCloseBugsHours` bug-label filtering, and `costByModel` derivation from `summary.byModel`.
- Reclassified "integration test" for route registration as unit test (structural assertion).

## Claude (COMMENT)

### 1. Tab Activation Doesn't Trigger Re-fetch
**Accepted.** This was the most important gap. Updated plan:
- `useStatistics` now accepts an `isActive` param
- `App.tsx` passes `isActive` prop to `StatisticsView` based on whether the statistics tab is currently selected
- `useStatistics` triggers a re-fetch when `isActive` transitions from `false` to `true`
- Added "Tab activation triggers data refresh" to acceptance criteria

### 2. TAB_ICONS Doesn't Exist
**Accepted.** Same fix as Gemini #1 — using label string.

### 3. `costByModel` Field Not Explicitly Addressed
**Accepted.** Added explicit detail in Phase 1: `costByModel` is derived from `summary.byModel` by mapping `model → totalCost` into a `Record<string, number>`.

## Additional Changes
- Added risks: `gh search` 30 req/min rate limit, UI/API range mapping mismatch
- Added Notes: shared types approach (local interface in api.ts), mobile layout compatibility, cache key deviation
