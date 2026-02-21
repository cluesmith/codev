# Plan: Dashboard Statistics Tab in Right Panel

## Metadata
- **ID**: plan-2026-02-21-dashboard-statistics-tab
- **Status**: draft
- **Specification**: codev/specs/456-dashboard-statistics-tab-in-ri.md
- **Created**: 2026-02-21

## Executive Summary

Implement a Statistics tab in the dashboard right panel that aggregates project health metrics from three data sources: GitHub (PRs, issues), consultation metrics DB, and the existing overview endpoint. The implementation is split into three phases: backend data layer, API endpoint, and frontend UI. Each phase builds on the previous and is independently testable.

## Success Metrics
- [ ] Stats tab appears in dashboard right panel after Work tab
- [ ] Time range selector (7d/30d/all) re-fetches data
- [ ] GitHub metrics match `gh search` CLI output
- [ ] Consultation metrics match `consult stats --days <N>` output
- [ ] Per-model breakdown, review-type/protocol distribution, and cost-per-project display correctly
- [ ] Graceful degradation when GitHub or metrics DB unavailable
- [ ] No auto-polling — refresh on tab activation, range change, or Refresh button
- [ ] Tab loads in under 3 seconds on a project with 200+ issues
- [ ] Test coverage >90% for new code

## Phases (Machine Readable)

<!-- REQUIRED: porch uses this JSON to track phase progress. Update this when adding/removing phases. -->

```json
{
  "phases": [
    {"id": "data_layer", "title": "Backend Data Layer"},
    {"id": "api_endpoint", "title": "API Endpoint and Caching"},
    {"id": "dashboard_ui", "title": "Dashboard UI"}
  ]
}
```

## Phase Breakdown

### Phase 1: Backend Data Layer
**Dependencies**: None

#### Objectives
- Add GitHub search functions for historical PR/issue data with date filtering
- Extend MetricsDB with per-project cost query
- Create a statistics service that aggregates data from all sources

#### Deliverables
- [ ] `fetchMergedPRs(since, cwd)` function in `github.ts`
- [ ] `fetchClosedIssues(since, cwd)` function in `github.ts`
- [ ] `costByProject(filters)` method on `MetricsDB`
- [ ] `statistics.ts` service module with `computeStatistics(workspaceRoot, range)` function
- [ ] Unit tests for all new functions
- [ ] Type definitions for `StatisticsResponse`

#### Implementation Details

**New GitHub functions** (`packages/codev/src/lib/github.ts`):

```typescript
// Fetch merged PRs using gh search with date filtering
async function fetchMergedPRs(
  since: string | null,  // ISO date string or null for "all"
  cwd?: string
): Promise<MergedPR[]>
// Uses: gh search prs --repo OWNER/REPO --state merged --merged ">=YYYY-MM-DD" --json number,title,createdAt,mergedAt,body --limit 1000

// Fetch closed issues using gh search with date filtering
async function fetchClosedIssues(
  since: string | null,  // ISO date string or null for "all"
  cwd?: string
): Promise<ClosedIssue[]>
// Uses: gh search issues --repo OWNER/REPO --state closed --closed ">=YYYY-MM-DD" --json number,title,createdAt,closedAt,labels --limit 1000
```

New types needed:
```typescript
interface MergedPR {
  number: number;
  title: string;
  createdAt: string;
  mergedAt: string;
  body: string;
}

interface ClosedIssue {
  number: number;
  title: string;
  createdAt: string;
  closedAt: string;
  labels: Array<{ name: string }>;
}
```

**MetricsDB extension** (`packages/codev/src/commands/consult/metrics.ts`):

Add a `costByProject(filters: StatsFilters)` method that returns:
```typescript
Array<{ projectId: string; totalCost: number }>
```
Query: `SELECT project_id, SUM(cost_usd) as total_cost FROM consultation_metrics WHERE project_id IS NOT NULL AND cost_usd IS NOT NULL GROUP BY project_id ORDER BY total_cost DESC LIMIT 10`, filtered by time range.

**Statistics service** (`packages/codev/src/agent-farm/servers/statistics.ts`):

Create a `computeStatistics(workspaceRoot: string, range: '7' | '30' | 'all')` function that:
1. Determines `since` date from range (rolling window from now)
2. Calls `fetchMergedPRs(since, workspaceRoot)` and `fetchClosedIssues(since, workspaceRoot)`
3. Computes GitHub metrics:
   - Counts merged PRs and closed issues in range
   - Computes average time-to-merge from `createdAt`/`mergedAt` timestamps
   - Computes average time-to-close for bug-labeled closed issues only (filter by `bug` label)
   - Gets current open backlogs via existing `fetchIssueList()` from `src/lib/github.ts`
   - Derives projects completed by calling `parseLinkedIssue(pr.body, pr.title)` on each merged PR and counting distinct non-null issue numbers; PRs without linked issues are excluded, PRs linking to multiple issues count each distinct issue once
   - Derives `costByModel` as `Record<string, number>` from `summary.byModel` (mapping model → totalCost)
4. Calls `MetricsDB.summary({ days })` and `MetricsDB.costByProject({ days })`
5. Gets active builder count from existing overview cache
6. Assembles and returns `StatisticsResponse`

Each data source (GitHub, metrics DB) is wrapped in try/catch for independent failure.

Also define the `StatisticsResponse` TypeScript interface in this file (matching R6 of the spec).

#### Acceptance Criteria
- [ ] `fetchMergedPRs` returns correct results for 7d/30d/all ranges
- [ ] `fetchClosedIssues` returns correct results with label data
- [ ] `costByProject` returns top 10 projects by cost
- [ ] `computeStatistics` assembles all data sources correctly
- [ ] GitHub failure returns error field + defaults (not a throw)
- [ ] MetricsDB failure returns error field + defaults (not a throw)

#### Test Plan
- **Unit Tests**: Mock `gh` CLI output (spawn) for `fetchMergedPRs` and `fetchClosedIssues`. Test date filter construction, empty results, error handling.
- **Unit Tests**: Use a test SQLite fixture for `costByProject`. Test with data, empty DB, missing DB file.
- **Unit Tests**: Mock all data sources for `computeStatistics`. Test full aggregation, partial failures, null averages when no data.
- **Unit Tests**: Test `parseLinkedIssue` integration in `computeStatistics` — verify PRs with no linked issue are excluded, PRs linking to multiple issues count each issue once, and `costByModel` is correctly derived from `summary.byModel`.
- **Unit Tests**: Test `avgTimeToCloseBugsHours` only includes closed issues with the `bug` label.

#### Rollback Strategy
New functions are additive — no existing code is modified except adding `costByProject` to MetricsDB. Revert the commit to roll back.

#### Risks
- **Risk**: `gh search` CLI may have different output format across `gh` versions
  - **Mitigation**: Pin expected JSON fields, test against actual `gh search` output

---

### Phase 2: API Endpoint and Caching
**Dependencies**: Phase 1

#### Objectives
- Register a new `/api/statistics` route in the tower
- Add 60-second response caching with cache bypass support
- Wire up the statistics service to the HTTP layer

#### Deliverables
- [ ] `GET /api/statistics?range=<7|30|all>` route in tower-routes.ts
- [ ] Response caching (60s, keyed by range)
- [ ] Cache bypass via `refresh=1` query parameter
- [ ] Input validation for `range` parameter
- [ ] Unit tests for the endpoint

#### Implementation Details

**Route registration** (`packages/codev/src/agent-farm/servers/tower-routes.ts`):

Add to the `ROUTES` dispatch table:
```typescript
'GET /api/statistics': (_req, res, url) => handleStatistics(res, url),
```

Also add to the workspace-scoped block (~line 1201):
```typescript
if (req.method === 'GET' && apiPath === 'statistics') {
  return handleStatistics(res, url, workspacePath);
}
```

**Handler function** (in `tower-routes.ts` or imported from `statistics.ts`):

```typescript
async function handleStatistics(
  res: http.ServerResponse,
  url: URL,
  workspaceOverride?: string
): Promise<void>
```

1. Parse `range` from query params — validate as `'7' | '30' | 'all'`, default to `'7'`
2. Parse `refresh` flag from query params
3. Check cache (keyed by `${workspaceRoot}:${range}`) — if valid and no refresh, return cached
4. Call `computeStatistics(workspaceRoot, range)`
5. Cache result with timestamp
6. Return JSON response with `Content-Type: application/json`

**Cache implementation**: Simple in-memory `Map<string, { data: StatisticsResponse; timestamp: number }>` with 60-second TTL. Define as a module-level variable in `statistics.ts` alongside `computeStatistics`.

#### Acceptance Criteria
- [ ] `GET /api/statistics?range=7` returns valid `StatisticsResponse` JSON
- [ ] Invalid range values rejected with 400 status
- [ ] Second request within 60s returns cached data
- [ ] `refresh=1` bypasses cache
- [ ] Workspace-scoped route works correctly

#### Test Plan
- **Unit Tests**: Test route handler with mocked `computeStatistics`. Verify caching (call twice, assert compute called once). Verify cache bypass. Verify range validation.
- **Unit Tests**: Verify route registration in both dispatch table and workspace-scoped block (structural assertions).

#### Rollback Strategy
Remove route entries from `tower-routes.ts` and the handler function. No other files are affected.

#### Risks
- **Risk**: Cache key collision if multiple workspaces share the same range
  - **Mitigation**: Key includes workspace root path

---

### Phase 3: Dashboard UI
**Dependencies**: Phase 2

#### Objectives
- Register the Statistics tab in the dashboard tab system
- Create the StatisticsView component with all three metric sections
- Implement time range selector and refresh behavior

#### Deliverables
- [ ] `'statistics'` added to `Tab['type']` union in `useTabs.ts`
- [ ] Statistics tab entry in `buildTabs()` (non-closable, after Work)
- [ ] `∿` glyph included in tab label in `useTabs.ts`
- [ ] Statistics rendering branch in `App.tsx`
- [ ] `fetchStatistics()` function in `api.ts`
- [ ] `useStatistics` hook in `hooks/useStatistics.ts`
- [ ] `StatisticsView` component in `components/StatisticsView.tsx`
- [ ] Component tests for StatisticsView

#### Implementation Details

**Tab registration**:

`packages/codev/dashboard/src/hooks/useTabs.ts`:
- Add `'statistics'` to the `Tab['type']` union
- In `buildTabs()`, add a static statistics tab entry immediately after the work tab:
  ```typescript
  { id: 'statistics', type: 'statistics', label: '∿ Stats', closable: false, persistent: true }
  ```
  Note: `TabBar.tsx` renders `tab.label` directly as text — there is no `TAB_ICONS` map. The `∿` glyph is prepended to the label string.

`packages/codev/dashboard/src/components/App.tsx`:
- Add rendering for `statistics` tab type. Use the same show/hide CSS pattern as `work` tab (always mounted, display toggled) to preserve collapse state across tab switches.
- Pass an `isActive` prop to `StatisticsView` indicating whether the statistics tab is currently selected. This is needed because the always-mounted pattern means the component doesn't unmount/remount on tab switch, so `useStatistics` must trigger a re-fetch when `isActive` transitions from `false` to `true` (fulfilling R8's "refresh on tab activation" requirement).

**API client** (`packages/codev/dashboard/src/lib/api.ts`):
```typescript
async function fetchStatistics(range: string, refresh?: boolean): Promise<StatisticsResponse>
// GET /api/statistics?range=<range>[&refresh=1]
```

Export the `StatisticsResponse` type (or define a matching interface).

**useStatistics hook** (`packages/codev/dashboard/src/hooks/useStatistics.ts`):
```typescript
function useStatistics(isActive: boolean): {
  data: StatisticsResponse | null;
  error: string | null;
  loading: boolean;
  range: '7d' | '30d' | 'all';
  setRange: (range: '7d' | '30d' | 'all') => void;
  refresh: () => void;
}
```
- Accepts `isActive` param — fetches when `isActive` transitions to `true` (tab activation refresh per R8)
- Fetches on mount (if active) and when range changes
- No auto-polling (unlike useOverview)
- `refresh()` calls `fetchStatistics(range, true)` to bypass cache
- Maps UI range values ('7d' → '7', '30d' → '30', 'all' → 'all') for the API

**StatisticsView component** (`packages/codev/dashboard/src/components/StatisticsView.tsx`):

Layout:
1. **Header row**: "Statistics" title + time range selector (segmented buttons: 7d / 30d / All) + Refresh button
2. **GitHub section**: Collapsible card with 6 metrics in a 2-column grid
3. **Builders section**: Collapsible card with 3 metrics
4. **Consultation section**: Collapsible card with:
   - Core metrics (4 items in a 2-column grid)
   - Per-model breakdown (compact table: model | count | cost | latency | success%)
   - Review type distribution (compact list)
   - Protocol distribution (compact list)
   - Cost per project (compact list: #ID — $X.XX)

Each metric displays: label, value, optional unit. Null values display as "—".

Loading state: Spinner or skeleton placeholders.
Error state: Per-section error message when `errors.github` or `errors.consultation` is set, still showing the section header.

Style: Use existing dashboard CSS patterns (inline styles or class-based, matching WorkView).

#### Acceptance Criteria
- [ ] Stats tab appears after Work tab with `∿` glyph in label
- [ ] Tab activation (switching to Stats tab) triggers data refresh
- [ ] Tab is non-closable and persistent
- [ ] Deep linking via `?tab=statistics` works
- [ ] Time range selector switches between 7d/30d/all
- [ ] Changing range triggers re-fetch
- [ ] Loading state displays while fetching
- [ ] All three metric sections render with correct data
- [ ] Per-model breakdown table renders correctly
- [ ] Cost-per-project list renders correctly
- [ ] Null values display as "—"
- [ ] Error states show per-section
- [ ] Refresh button triggers cache-bypassing fetch
- [ ] No auto-polling — data updates only on explicit action

#### Test Plan
- **Component Tests**: Mock `fetchStatistics` response. Test loading state, data rendering, null handling, error states, time range switching, refresh button click.
- **E2E (Playwright)**: Add Stats tab to existing dashboard Playwright E2E suite (`packages/codev/tests/e2e/`) — verify tab loads and shows sections. Follow patterns in `codev/resources/testing-guide.md`.

#### Rollback Strategy
Revert tab registration changes in useTabs/TabBar/App and remove new component/hook files.

#### Risks
- **Risk**: StatisticsView CSS conflicts with existing WorkView styles
  - **Mitigation**: Use scoped class names or CSS modules matching existing patterns

## Dependency Map
```
Phase 1 (Data Layer) ──→ Phase 2 (API Endpoint) ──→ Phase 3 (Dashboard UI)
```

Linear dependency chain — each phase builds on the previous.

## Integration Points

### External Systems
- **GitHub CLI (`gh`)**: Used for `gh search prs` and `gh search issues` queries
  - **Phase**: Phase 1
  - **Fallback**: Return error field + zero defaults in StatisticsResponse
- **Consultation Metrics DB** (`~/.codev/metrics.db`): Read via `better-sqlite3`
  - **Phase**: Phase 1
  - **Fallback**: Return error field + zero defaults in StatisticsResponse

### Internal Systems
- **Overview cache** (`overview.ts`): Active builder count
  - **Phase**: Phase 1 (read from existing cache)
- **Tab system** (`useTabs.ts`, `TabBar.tsx`, `App.tsx`): Tab registration
  - **Phase**: Phase 3

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| `gh search` rate limiting on large repos | M | M | 1000-item limit per query, 60s cache |
| `gh search` 30 req/min rate limit with rapid cache-bypass refreshes | L | L | 60s cache prevents most cases; `refresh=1` is manual user action |
| UI range ↔ API range mapping mismatch ('7d' → '7') | L | M | Explicit mapping function with unit test |
| `metrics.db` concurrent access during writes | L | L | WAL mode + 5s busy timeout already configured |
| `gh search` unavailable in older `gh` versions | L | H | Document minimum `gh` version requirement |

## Validation Checkpoints
1. **After Phase 1**: Run `computeStatistics` manually against a real repo, verify output matches `gh search` and `consult stats` CLI output
2. **After Phase 2**: `curl /api/statistics?range=7` returns valid JSON with correct data
3. **After Phase 3**: Dashboard Stats tab renders all sections correctly

## Documentation Updates Required
- [ ] `codev/resources/arch.md` — add Statistics tab and endpoint to architecture docs

## Change Log
| Date | Change | Reason |
|------|--------|--------|
| 2026-02-21 | Initial plan | Created from approved spec |

## Notes
- The `gh search` commands have a 1000-item limit imposed by GitHub. For repos with more than 1000 merged PRs or closed issues, the "all" range metrics are approximate.
- `af bench` results are out of scope for this implementation per spec decision.
- Verdict text (APPROVE/REQUEST_CHANGES/COMMENT) is not stored in the metrics DB and is out of scope.
- **Cache key deviation from spec**: The spec (R6) describes caching keyed by `range`. The implementation extends this to `${workspaceRoot}:${range}` to support workspace-scoped routes where multiple workspaces may be active. This is a necessary deviation for multi-workspace correctness.
- **Shared types**: `StatisticsResponse` is defined in the server-side `statistics.ts`. The dashboard defines a matching local interface in `api.ts` (same pattern used for `OverviewData`). No cross-package type sharing is needed.
- **Mobile layout**: The statistics tab works in mobile mode automatically — `MobileLayout` in `App.tsx` renders all tab types including the always-mounted pattern. No separate mobile handling is needed.

---

## Amendment History

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
