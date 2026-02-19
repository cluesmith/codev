# Plan: Show Machine Hostname in Dashboard

## Metadata
- **ID**: plan-443-dashboard-hostname
- **Status**: draft
- **Specification**: codev/specs/443-dashboard-hostname.md
- **Created**: 2026-02-19

## Executive Summary

Add the machine hostname to the dashboard header and browser tab title by extending the existing `DashboardState` data flow. The Tower server adds `hostname` to the `/api/state` response, and the dashboard's `App` component renders it alongside the workspace name.

## Success Metrics
- [ ] All specification criteria met
- [ ] New unit tests for hostname display (header + tab title + deduplication + fallback)
- [ ] Existing tests continue to pass
- [ ] No visual regression in header layout

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "server", "title": "Add hostname to Tower API state"},
    {"id": "client", "title": "Display hostname in dashboard header and tab title"},
    {"id": "tests", "title": "Add unit tests for hostname display"}
  ]
}
```

## Phase Breakdown

### Phase 1: Add hostname to Tower API state
**Dependencies**: None

#### Objectives
- Expose `os.hostname()` in the `/api/state` response so the dashboard can consume it

#### Deliverables
- [ ] Add `hostname` field to state object in `handleWorkspaceState()` in `tower-routes.ts`
- [ ] Import `os` module in `tower-routes.ts`

#### Implementation Details
- File: `packages/codev/src/agent-farm/servers/tower-routes.ts`
  - Add `import os from 'node:os';` at top
  - Add `hostname?: string` to the inline state type (line ~1257)
  - Add `hostname: os.hostname()` to the state initializer (line ~1264)

#### Acceptance Criteria
- [ ] `GET /api/state` response includes `hostname` field
- [ ] Build succeeds (`npm run build` from `packages/codev/`)

---

### Phase 2: Display hostname in dashboard header and tab title
**Dependencies**: Phase 1

#### Objectives
- Show hostname in the dashboard header and browser tab title using the format `{hostname} {workspaceName} dashboard`

#### Deliverables
- [ ] Add `hostname?: string` to `DashboardState` interface in `api.ts`
- [ ] Update header rendering in `App.tsx` to prepend hostname
- [ ] Update `document.title` useEffect in `App.tsx` to include hostname
- [ ] Add CSS overflow handling for long hostnames on `.app-title`

#### Implementation Details
- File: `packages/codev/dashboard/src/lib/api.ts`
  - Add `hostname?: string` to `DashboardState` interface (line ~48)

- File: `packages/codev/dashboard/src/components/App.tsx`
  - Create a helper to build the title string: if hostname is present and different from workspaceName (case-insensitive, trimmed), format as `{hostname} {workspaceName} dashboard`, otherwise `{workspaceName} dashboard`
  - Update the header `<h1>` (line ~170) to use the helper
  - Update the `document.title` useEffect (line ~44) to use the helper
  - Add `state?.hostname` to the useEffect dependency array

- File: `packages/codev/dashboard/src/index.css`
  - Add `overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;` to `.app-title` for long hostname handling (min-width: 0 required for ellipsis on flex children)

#### Acceptance Criteria
- [ ] Header shows `{hostname} {workspaceName} dashboard` when hostname is present
- [ ] Browser tab shows `{hostname} {workspaceName} dashboard` when hostname is present
- [ ] When hostname equals workspaceName (case-insensitive), only `{workspaceName} dashboard` is shown
- [ ] When hostname is absent, falls back to `{workspaceName} dashboard`
- [ ] Long hostnames truncate with ellipsis in the header
- [ ] Dashboard builds successfully (`npm run build` from `packages/codev/`)

---

### Phase 3: Add unit tests for hostname display
**Dependencies**: Phase 2

#### Objectives
- Add unit tests covering hostname display in the header and tab title

#### Deliverables
- [ ] New test file `packages/codev/dashboard/__tests__/App.hostname.test.tsx`

#### Implementation Details
- File: `packages/codev/dashboard/__tests__/App.hostname.test.tsx`
  - Follow existing test patterns (see `App.terminal-persistence.test.tsx` for mock setup)
  - Mock `useBuilderStatus` to return state with `hostname` field
  - Test cases:
    1. Header displays hostname when present — mock state with `hostname: 'Mac-Pro'`, assert header contains `Mac-Pro myproject dashboard`
    2. Tab title includes hostname — verify `document.title` is set to `Mac-Pro myproject dashboard`
    3. Hostname deduplication — mock state where `hostname === workspaceName`, assert hostname appears only once
    4. Fallback when hostname absent — mock state without hostname, assert header shows `myproject dashboard`
    5. Case-insensitive dedup — mock state where hostname is `MyProject` and workspaceName is `myproject`, assert dedup works

#### Acceptance Criteria
- [ ] All new tests pass
- [ ] All existing dashboard tests continue to pass (`npm test` from `packages/codev/`)
- [ ] Tests cover header display, tab title, deduplication, and fallback scenarios
- [ ] Run full build to verify no regressions (`npm run build` from `packages/codev/`)

## Dependency Map
```
Phase 1 (server) ──→ Phase 2 (client) ──→ Phase 3 (tests)
```

## Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Long/ugly hostnames break header layout | Low | Low | CSS ellipsis truncation |
| `os` import missing in tower-routes.ts | N/A | N/A | Explicitly listed in Phase 1 |
