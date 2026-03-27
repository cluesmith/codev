# Plan: Show GitHub Author in Backlog and PR Views

## Metadata
- **ID**: plan-2026-03-27-show-github-author
- **Status**: draft
- **Specification**: codev/specs/637-show-github-author-in-backlog-.md
- **Created**: 2026-03-27

## Executive Summary

Add the `author` field end-to-end: forge concept shell scripts → forge contracts → backend overview types/mapping → dashboard API types → React components. Each layer gets one optional field. The work is split into two phases: backend data pipeline, then frontend rendering.

## Success Metrics
- [ ] All specification criteria met
- [ ] Existing tests pass
- [ ] New unit tests for author mapping in `deriveBacklog` and PR mapping
- [ ] Non-GitHub forges degrade gracefully (missing author renders without error)

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "data_pipeline", "title": "Data Pipeline: Forge Scripts, Contracts, and Backend Types"},
    {"id": "frontend_rendering", "title": "Frontend: Dashboard Types and Component Rendering"}
  ]
}
```

## Phase Breakdown

### Phase 1: Data Pipeline
**Dependencies**: None

#### Objectives
- Add `author` to forge concept commands so the data is fetched from GitHub
- Update type definitions through the entire backend stack
- Wire author through the overview mapping functions

#### Deliverables
- [ ] `issue-list.sh` fetches `author` field
- [ ] `pr-list.sh` fetches `author` field
- [ ] `IssueListItem` in `forge-contracts.ts` includes optional `author`
- [ ] `PrListItem` in `forge-contracts.ts` includes optional `author`
- [ ] `BacklogItem` in `overview.ts` includes optional `author`
- [ ] `PROverview` in `overview.ts` includes optional `author`
- [ ] `deriveBacklog()` maps `issue.author?.login` to `BacklogItem.author`
- [ ] PR mapping in `getOverview()` maps `pr.author?.login` to `PROverview.author`
- [ ] Unit tests for author mapping (present and absent cases)

#### Implementation Details

**Files to modify:**
- `packages/codev/scripts/forge/github/issue-list.sh` — Add `author` to `--json` field list
- `packages/codev/scripts/forge/github/pr-list.sh` — Add `author` to `--json` field list
- `packages/codev/src/lib/forge-contracts.ts` — Add `author?: { login: string }` to `IssueListItem` and `PrListItem`
- `packages/codev/src/agent-farm/servers/overview.ts` — Add `author?: string` to `BacklogItem` and `PROverview`; update `deriveBacklog()` and PR mapping in `getOverview()`

**Key decisions:**
- `author` is optional (`?`) in all types to handle non-GitHub forges and deleted users (`ghost`)
- Use `issue.author?.login` with optional chaining for null safety
- The `RecentlyClosedResult` type aliases `IssueListItem[]`, so it inherits the optional field without breaking

#### Test Plan
- **Unit Tests**: Test `deriveBacklog()` with issues that have author and without. Test PR mapping similarly.
- **Manual Testing**: Run `gh issue list --json number,title,author` locally to verify field shape

---

### Phase 2: Frontend Rendering
**Dependencies**: Phase 1

#### Objectives
- Add author to dashboard API types
- Render author in BacklogList and PRList components

#### Deliverables
- [ ] `OverviewBacklogItem` in dashboard `api.ts` includes optional `author`
- [ ] `OverviewPR` in dashboard `api.ts` includes optional `author`
- [ ] `BacklogList.tsx` renders author (e.g., `@username`) in each backlog row
- [ ] `PRList.tsx` renders author in each PR row
- [ ] CSS styling for the author element (subtle, muted color)

#### Implementation Details

**Files to modify:**
- `packages/codev/dashboard/src/lib/api.ts` — Add `author?: string` to `OverviewBacklogItem` and `OverviewPR`
- `packages/codev/dashboard/src/components/BacklogList.tsx` — Add `<span className="backlog-row-author">@{item.author}</span>` (conditionally rendered)
- `packages/codev/dashboard/src/components/PRList.tsx` — Add `<span className="pr-row-author">@{pr.author}</span>` (conditionally rendered)
- `packages/codev/dashboard/src/index.css` — Add styles for `.backlog-row-author` and `.pr-row-author`

**Key decisions:**
- Prefix with `@` for visual clarity
- Use muted/dim color to avoid visual clutter
- Conditionally render: if `author` is undefined, render nothing (no empty span)
- Position after the age element, right-aligned

#### Test Plan
- **Manual Testing**: Build the dashboard, verify author appears in both backlog and PR rows
- **Edge case**: Verify rows without author still render correctly

## Dependency Map
```
Phase 1 (Data Pipeline) ──→ Phase 2 (Frontend Rendering)
```

## Risk Analysis
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Non-GitHub forges don't return `author` | Medium | Low | Field is optional; conditional rendering |
| Deleted GitHub users return null author | Low | Low | Optional chaining (`author?.login`) |
