# Rebuttal: Spec 456, Specify Iteration 1

## Gemini (REQUEST_CHANGES)

### 1. Flawed GitHub Data Fetching
**Accepted.** Switched from `gh pr list --state merged` to `gh search prs --merged ">=DATE"` and `gh search issues --closed ">=DATE"` throughout R3. This lets GitHub filter server-side and avoids fetching all items locally. Backlog counts (open issues) still use `gh issue list` since those don't need date filtering.

### 2. Contradictory Builder Metrics Source
**Accepted.** Removed the reference to porch project state in R4. Clarified that the sole source of truth for completed projects is distinct issue numbers from merged PRs via `parseLinkedIssue()`. Also documented edge cases: PRs without linked issues are excluded, PRs linking to multiple issues count each distinct issue once.

### 3. "All" Time Range Feasibility
**Accepted.** Noted that `all` range uses GitHub search without date qualifier, subject to the 1000-item search limit. Updated SC9 to note that `all` range may exceed the 3-second target on very large repos. Averages are documented as approximate for repos with 1000+ items.

### 4. Missing Testing Strategy
**Accepted.** Added a full "Testing Strategy" section covering backend unit tests (mocked gh CLI, test metrics.db fixture, cache behavior), frontend component tests (loading/error/null states, time range switching), and E2E coverage.

## Codex (REQUEST_CHANGES)

### 1. Time Range Semantics
**Accepted.** Clarified in R2 that time ranges use a rolling window from current UTC time (e.g., "7d" = `now - 7*24h` to `now`), not calendar week/month boundaries.

### 2. Default Error Values
**Accepted.** Added explicit default values in R6 for every field when GitHub is unavailable and when metrics.db is unavailable. Each field's default is specified (0 for counts, null for averages/costs, empty arrays/objects for collections).

### 3. PR-to-Project Mapping Edge Cases
**Accepted.** Documented in R4: PRs without a linked issue are excluded from projects-completed count. PRs linking to multiple issues count each distinct issue once.

### 4. Testing Strategy
**Accepted.** See Gemini #4 above — added Testing Strategy section with concrete test requirements.

## Claude (COMMENT)

### 1. Nullability Inconsistency
**Accepted.** Changed `avgLatencySeconds` and `successRate` to `number | null` in the response type. When there are zero consultations in the time range, these return null.

### 2. "All" Time Range Safeguard
**Accepted.** See Gemini #3 above — documented the GitHub search 1000-item limit and updated the SLA note.

### 3. `days` Parameter Name
**Accepted.** Renamed the query parameter from `days` to `range` (matching `timeRange` in the response). Endpoint is now `GET /api/statistics?range=<7|30|all>`.

### 4. Cache Bypass Mechanism
**Accepted.** Added explicit cache bypass: `GET /api/statistics?range=7&refresh=1`. The `refresh=1` parameter bypasses the 60-second server-side cache.

### 5. Feature Backlog Definition
**Accepted.** Renamed to "Non-bug backlog" with clarification that it includes all open issues without the `bug` label (features, docs, etc.).

### 6. Tab Ordering
**Accepted.** Specified in R1 that the Stats tab appears "immediately after the Work tab (before any dynamic tabs)."

## Architect Feedback (Issue #460 — Consultation Stats)

**Partially accepted.** The architect requested: total by model, cost breakdown, avg latency, verdict distribution, cost per project, trends.

- **Total by model, cost breakdown, avg latency by model**: Added per-model breakdown sub-table in R5 with count, cost, avg latency, and success rate per model. This reuses `MetricsDB.summary().byModel`.
- **Verdict distribution**: Added distribution by `review_type` (spec/plan/pr) and `protocol` (spir/tick/bugfix) from the metrics DB. Note: the DB does not store the actual verdict text (APPROVE/REQUEST_CHANGES/COMMENT) — only exit_code. Added this limitation to Out of Scope with a note that adding a verdict column would be a separate spec.
- **Cost per project**: Added top-10 cost-per-project list grouped by `project_id`.
- **Trends**: Deferred to v2 — the spec explicitly excludes sparklines/charts. Trend visualization is listed in Out of Scope.
- **`af bench` results**: Moved to Out of Scope. Bench results are standalone timing files not in the metrics DB. Integrating them requires either parsing text files or adding bench data to the DB, which is a separate enhancement.
