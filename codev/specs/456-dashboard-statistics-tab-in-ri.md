# Spec 456: Dashboard Statistics Tab in Right Panel

## Problem

The dashboard currently shows real-time operational state (active builders, pending PRs, backlog, recently closed) through the Work tab but provides no historical or aggregate metrics. There is no way to answer questions like:

- How many PRs were merged this week?
- How long do bug fixes take on average?
- What's our builder throughput?
- How much are we spending on AI consultations?
- Is the bug backlog growing or shrinking?
- What's the verdict distribution across consultation reviews?

The data to answer these questions exists across multiple sources (GitHub API, porch project state, consultation metrics DB) but is not aggregated or presented in the dashboard.

## Motivation

- **Project health visibility**: Knowing trends (throughput, backlog growth, cycle time) enables proactive decisions about what to prioritize.
- **Cost awareness**: Consultation costs are tracked in `~/.codev/metrics.db` (Spec 0115) but are only accessible via `consult stats` CLI. Surfacing them in the dashboard makes cost trends visible during daily work.
- **Performance insight**: Wall-clock time and agent time for bug fixes reveal process bottlenecks. If bugs consistently take 2+ hours of agent time, the issue templates or spec quality may need improvement.
- **Builder throughput**: Tracking projects completed per period shows whether the architect-builder workflow is scaling.
- **Consultation insight**: Understanding cost per model, verdict distribution, and latency helps optimize the multi-agent consultation workflow.

## Requirements

### R1: Statistics tab in the right panel
<!-- REVIEW(@architect): MAybe Analytics rather than statistics? -->

Add a new `statistics` tab type to the dashboard tab system. It should:

- Appear as a persistent, non-closable tab immediately after the Work tab (before any dynamic tabs)
- Use the `∿` glyph to match the existing icon style (unicode text-presentation characters)
- Be labeled "Stats"
- Support deep linking via `?tab=statistics`

**Tab registration**: Add `'statistics'` to the `Tab['type']` union in `hooks/useTabs.ts`, register the icon in `TabBar.tsx`, and add a rendering branch in `App.tsx`. The tab should be constructed in `buildTabs()` as a static entry similar to the `work` tab.

### R2: Time range selector

Provide a time range selector at the top of the statistics view with three options:

- **7d** (default) — last 7 calendar days (rolling window from current UTC time)
<!-- REVIEW(@architect): 24h as well -->
- **30d** — last 30 calendar days (rolling window from current UTC time)
- **All** — all available data (no time filter)

Time ranges use a rolling window: "7d" means `now - 7*24h` to `now`, not "this calendar week."

The selector should be a simple segmented button row. Changing the time range re-fetches statistics for the new period.

### R3: GitHub metrics section

Display the following metrics derived from GitHub API data:

| Metric | Source | Computation |
|--------|--------|-------------|
| **PRs merged** | `gh search prs --merged ">=DATE"` | Count of PRs merged within the time range |
| **Avg time to merge** | Merged PR `createdAt` → `mergedAt` | Mean wall-clock time from PR creation to merge |
| **Bug backlog** | `gh issue list --label bug` | Count of open issues with `bug` label |
| **Non-bug backlog** | `gh issue list` minus bug-labeled | Count of open issues without `bug` label (includes features, docs, etc.) |
| **Issues closed** | `gh search issues --closed ">=DATE"` | Count of issues closed within the time range |
| **Avg time to close (bugs)** | Closed bug issues `createdAt` → `closedAt` | Mean wall-clock time from issue creation to close for bug-labeled issues |

**Data fetching**: The server-side endpoint must use `gh search prs` and `gh search issues` (which support native date filtering via `--merged` and `--closed` qualifiers) rather than `gh pr list` or `gh issue list` for historical queries. The search commands let GitHub filter server-side, avoiding the need to fetch and filter all items locally.

- For backlog counts (current open items), continue using `gh issue list` which is appropriate.
- For historical data (merged PRs, closed issues), use `gh search` with date qualifiers.
- The `all` time range omits the date qualifier, returning all results up to GitHub's search limit (1000 items). Note that averages for `all` are approximate on repos with 1000+ merged PRs or closed issues.

**Null handling**: When no items exist in the time range, average fields return `null` (not `0`). The UI should display "—" for null averages.

### R4: Builder metrics section

Display builder throughput and performance metrics:

| Metric | Source | Computation |
|--------|--------|-------------|
| **Projects completed** | Merged PRs via `parseLinkedIssue` | Count of distinct issue numbers extracted from PRs merged in the time range |
| **Throughput** | Projects completed / weeks in range | Projects per week (displayed as "X/wk"); for 7d range, this equals projects completed |
| **Active builders** | Overview endpoint | Current count (real-time, not historical) |

**Data source**: Builder throughput is derived entirely from merged PRs. Each PR is mapped to a project via `parseLinkedIssue()` from `src/lib/github.ts`. PRs that don't link to an issue are excluded from the projects-completed count. PRs linking to multiple issues count each distinct issue once. Active builder count comes from the existing overview endpoint.

**Note**: Active builders is a real-time value and is included in the 60-second cache along with other metrics.

### R5: Consultation metrics section

Display consultation cost and performance metrics from `~/.codev/metrics.db` (the database created by Spec 0115). This section uses the existing `MetricsDB` class and its `summary()` method from `src/commands/consult/metrics.ts`.

#### Core metrics

| Metric | Source | Computation |
|--------|--------|-------------|
| **Total consultations** | `consultation_metrics` table | Count of rows in time range |
| **Total cost** | `consultation_metrics.cost_usd` | Sum of cost_usd where not null |
| **Avg latency** | `consultation_metrics.duration_seconds` | Mean duration per consultation |
| **Success rate** | `consultation_metrics.exit_code` | Percentage with exit_code = 0 |

#### Per-model breakdown

| Metric | Source | Computation |
|--------|--------|-------------|
| **Count by model** | `consultation_metrics` grouped by `model` | Count per model (gemini, codex, claude) |
| **Cost by model** | `consultation_metrics` grouped by `model` | Sum of cost_usd per model |
| **Avg latency by model** | `consultation_metrics` grouped by `model` | Mean duration_seconds per model |
| **Success rate by model** | `consultation_metrics` grouped by `model` | Percentage with exit_code = 0 per model |

#### Verdict distribution (from review output)

| Metric | Source | Computation |
|--------|--------|-------------|
| **By review type** | `consultation_metrics` grouped by `review_type` | Count per review type (spec, plan, pr) |
| **By protocol** | `consultation_metrics` grouped by `protocol` | Count per protocol (spir, tick, bugfix) |

**Note**: The `consultation_metrics` table does not store the actual verdict text (APPROVE/REQUEST_CHANGES/COMMENT) — only the `exit_code` (0 = success, non-zero = failure). Verdict distribution in this context means distribution by review type and protocol, not by verdict outcome. If verdict tracking is needed, that's a separate spec to add a `verdict` column.

#### Cost per project

| Metric | Source | Computation |
|--------|--------|-------------|
| **Cost per project** | `consultation_metrics` grouped by `project_id` | Sum of cost_usd per project_id (top 10 by cost, descending) |

Display as a compact list: `#42 — $1.23`, `#73 — $0.89`, etc. Only show projects with non-null cost data.

**Data access**: The server must read `~/.codev/metrics.db` directly using `better-sqlite3`. Reuse the `MetricsDB` class and its `summary(filters)` method for core metrics and per-model breakdown. The per-project cost and review-type/protocol breakdowns require additional queries beyond what `summary()` provides — add these as new methods on `MetricsDB` or as standalone queries in the statistics endpoint.

### R6: REST API endpoint

Create a new endpoint: `GET /api/statistics?range=<7|30|all>`

The query parameter is `range` (not `days`) since it accepts both numeric and string values.

**Response shape**:
```typescript
interface StatisticsResponse {
  timeRange: '7d' | '30d' | 'all';
  github: {
    prsMerged: number;
    avgTimeToMergeHours: number | null;
    bugBacklog: number;
    nonBugBacklog: number;
    issuesClosed: number;
    avgTimeToCloseBugsHours: number | null;
  };
  builders: {
    projectsCompleted: number;
    throughputPerWeek: number;
    activeBuilders: number;
  };
  consultation: {
    totalCount: number;
    totalCostUsd: number | null;
    costByModel: Record<string, number>;
    avgLatencySeconds: number | null;
    successRate: number | null;
    byModel: Array<{
      model: string;
      count: number;
      avgLatency: number;
      totalCost: number | null;
      successRate: number;
    }>;
    byReviewType: Record<string, number>;
    byProtocol: Record<string, number>;
    costByProject: Array<{
      projectId: string;
      totalCost: number;
    }>;
  };
  errors?: {
    github?: string;
    consultation?: string;
  };
}
```

**Error handling**: Each data source (GitHub, metrics DB) should fail independently. If `gh` CLI is unavailable or fails, return the `errors.github` field with an error message and the following defaults for GitHub metrics:
- `prsMerged`: 0
- `avgTimeToMergeHours`: null
- `bugBacklog`: 0
- `nonBugBacklog`: 0
- `issuesClosed`: 0
- `avgTimeToCloseBugsHours`: null

If `metrics.db` doesn't exist or is unreadable, return `errors.consultation` with an error message and:
- `totalCount`: 0
- `totalCostUsd`: null
- `costByModel`: {}
- `avgLatencySeconds`: null
- `successRate`: null
- `byModel`: []
- `byReviewType`: {}
- `byProtocol`: {}
- `costByProject`: []

Builder metrics defaults when GitHub is unavailable:
- `projectsCompleted`: 0
- `throughputPerWeek`: 0
- `activeBuilders`: (still fetched from overview endpoint, independent of GitHub)

**Caching**: Cache the response for 60 seconds keyed by `range` value. The Refresh button sends `GET /api/statistics?range=7&refresh=1`, where the `refresh=1` query parameter bypasses the server-side cache and forces a fresh fetch.

### R7: Dashboard component

Create a `StatisticsView` component that:

- Fetches data from `/api/statistics?range=<range>` on mount and when the time range changes
- Displays metrics in a compact card-based layout grouped by section (GitHub, Builders, Consultation)
- Shows loading state while fetching
- Shows error states per-section when data sources are unavailable (display the error message from `errors.github` or `errors.consultation`)
- Provides a Refresh button to re-fetch with cache bypass (`refresh=1`)
- Displays `null` metric values as "—" (em dash)

**Layout**: Each section should be a collapsible card with a header and grid of metric values. Each metric shows:
- A label (e.g., "PRs Merged")
- A value (e.g., "12")
- Optional unit/context (e.g., "this week", "$", "hrs")

The Consultation section includes a per-model breakdown sub-table and a cost-per-project list.

No sparklines or charts in v1 — keep it to simple numbers. Charts can be added later if needed.

### R8: Data refresh behavior

- Statistics should NOT auto-poll (unlike Work view's 2.5s polling). This data is expensive to compute and doesn't change frequently.
- Refresh on: tab activation, time range change, manual Refresh button click.
- The 60-second server-side cache (R6) prevents redundant fetches on rapid tab switches.
- The Refresh button appends `refresh=1` to bypass the cache.

## Testing Strategy

### Backend (statistics endpoint)

- **Unit tests** for the statistics endpoint with mocked `gh` CLI output and a test `metrics.db` fixture:
  - Verify correct metric computation for each time range
  - Verify graceful degradation when `gh` CLI fails (error field populated, defaults returned)
  - Verify graceful degradation when `metrics.db` is missing
  - Verify cache behavior (second call within 60s returns cached data, `refresh=1` bypasses cache)
  - Verify `range` parameter validation (rejects invalid values)

### Frontend (StatisticsView component)

- **Component tests** for `StatisticsView`:
  - Renders loading state
  - Renders all three metric sections with mock data
  - Time range selector triggers re-fetch
  - Error states display per-section
  - Null values display as "—"
  - Refresh button triggers fetch with `refresh=1`

### E2E

- Add the Stats tab to the existing dashboard E2E test suite to verify it loads and displays data.

## Out of Scope

- **Sparklines or charts**: v1 is numbers-only. Trend visualization is a future enhancement.
- **Per-project drill-down**: Clicking a metric to see per-project breakdown is not in scope (except cost-per-project list which is inline).
- **Historical builder session data**: Porch project state files track current state, not historical snapshots. We only get builder throughput from merged PRs, not actual agent time per session.
- **Export/download**: No CSV or JSON export of statistics.
- **Custom date ranges**: Only the three preset time ranges (7d, 30d, all).
- **Verdict text tracking**: The metrics DB does not store verdict strings (APPROVE/REQUEST_CHANGES/COMMENT). Adding a verdict column is a separate spec.
- **`af bench` results**: Bench results are standalone timing files in `codev/resources/bench-results/` and are not in the metrics DB. Integrating bench data is a separate enhancement.

## Success Criteria

1. A "Stats" tab appears in the dashboard right panel immediately after the Work tab
2. Selecting the tab shows GitHub, Builder, and Consultation metrics sections
3. Time range selector switches between 7d/30d/all and re-fetches data
4. GitHub metrics show correct PR/issue counts validated against `gh search` CLI output
5. Consultation metrics match `consult stats --days <N>` output
6. Consultation section shows per-model breakdown, review-type distribution, protocol distribution, and cost-per-project
7. Graceful degradation when GitHub or metrics DB is unavailable (error messages shown, defaults used)
8. No auto-polling — data refreshes only on explicit user action
9. Tab loads in under 3 seconds on a project with 200+ issues (note: `all` range may exceed this on very large repos due to GitHub search limits)
