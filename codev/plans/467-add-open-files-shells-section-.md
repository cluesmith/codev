# Plan: Add Open Files & Shells Section to Workspace Overview

## Metadata
- **ID**: plan-2026-02-21-open-files-shells
- **Status**: draft
- **Specification**: `codev/specs/467-add-open-files-shells-section-.md`
- **Created**: 2026-02-21

## Executive Summary

Implement Approach 1 from the spec: lightweight PTY output activity tracking with a new React component. The work breaks into two phases: (1) backend extension to track and expose `lastDataAt`, and (2) frontend component and integration.

## Success Metrics
- [ ] All specification success criteria met
- [ ] Test coverage >90% for new code
- [ ] Existing E2E tests continue to pass

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "backend_last_data_at", "title": "Backend: PTY Last-Activity Tracking"},
    {"id": "frontend_component", "title": "Frontend: Open Files & Shells Component"}
  ]
}
```

## Phase Breakdown

### Phase 1: Backend: PTY Last-Activity Tracking
**Dependencies**: None

#### Objectives
- Track `lastDataAt` timestamp on PTY output events in `PtySession`
- Expose `lastDataAt` through the `/api/state` response for shell terminals

#### Deliverables
- [ ] `lastDataAt` property on `PtySession` (mirrors existing `lastInputAt` pattern)
- [ ] `lastDataAt` included in shell entries of `/api/state` response
- [ ] Inline type literal in `tower-routes.ts` updated to include `lastDataAt`
- [ ] `UtilTerminal` type in dashboard `api.ts` extended with `lastDataAt`
- [ ] Unit tests for `lastDataAt` tracking

#### Implementation Details

**`packages/codev/src/terminal/pty-session.ts`**:
- Add `private _lastDataAt: number` field, initialized to `Date.now()` in constructor (not `0` like `_lastInputAt` — new shells should start as "running")
- Update `onPtyData()` method (line ~244) to set `this._lastDataAt = Date.now()`
- Add getter `get lastDataAt(): number` (mirrors existing `get lastInputAt()`)
- Note: shellper replay data bypasses `onPtyData()` (goes through `ringBuffer.pushData()` directly at line 132), which is fine — `lastDataAt` starts at `Date.now()` so new sessions appear "running"

**`packages/codev/src/agent-farm/servers/tower-routes.ts`**:
- Update the inline type literal at line ~1341 to add `lastDataAt?: number` to the `utils` array type
- In `handleWorkspaceState()`, add `lastDataAt: session.lastDataAt` to each shell entry pushed to `state.utils` (line ~1373-1381)

**`packages/codev/dashboard/src/lib/api.ts`**:
- Add `lastDataAt?: number` to `UtilTerminal` interface

#### Acceptance Criteria
- [ ] `PtySession.lastDataAt` updates on every PTY output event
- [ ] New shells initialize `lastDataAt` to `Date.now()`
- [ ] `/api/state` response includes `lastDataAt` in each `utils[]` entry
- [ ] `UtilTerminal` type includes optional `lastDataAt` field
- [ ] Inline type in tower-routes.ts includes `lastDataAt`

#### Test Plan
- **Unit Tests**: Create new `packages/codev/tests/unit/pty-session.test.ts` (no existing test file for PtySession). Test that `lastDataAt` initializes to `Date.now()` and updates on `onPtyData`. Note: requires mocking `node-pty` (dynamic import at line 86 of pty-session.ts).
- **Unit Tests**: Test that `handleWorkspaceState` includes `lastDataAt` in shell entries

#### Risks
- **Risk**: PTY data events fire frequently during heavy output
  - **Mitigation**: Single `Date.now()` assignment — negligible cost, same pattern as existing `lastInputAt`

---

### Phase 2: Frontend: Open Files & Shells Component
**Dependencies**: Phase 1

#### Objectives
- Create `OpenFilesShellsSection` React component
- Integrate it into `WorkView` below the Builders section
- Display shells with running/idle status and files with relative paths

#### Deliverables
- [ ] New `OpenFilesShellsSection.tsx` component
- [ ] Integration into `WorkView.tsx`
- [ ] CSS styles for the new section
- [ ] Unit tests for the component
- [ ] Playwright E2E test for section visibility (per `codev/resources/testing-guide.md`)

#### Implementation Details

**`packages/codev/dashboard/src/components/OpenFilesShellsSection.tsx`** (new file):
- Props: `utils: UtilTerminal[]`, `annotations: Annotation[]`, `onSelectTab: (id: string) => void`, `workspaceName?: string`
- If both arrays are empty, return `null` (hidden-when-empty pattern, like `RecentlyClosedList`)
- Render two sub-groups: "Shells" (if any) and "Files" (if any)
- Each shell row: name, status dot (green for running, gray for idle), idle duration
- Each file row: basename + parent directory for disambiguation, full path as `title` attribute tooltip
- Click handler calls `onSelectTab(util.id)` for shells, `onSelectTab(annotation.id)` for files
- Idle status computed: `Date.now() - lastDataAt > 30_000` = idle; missing `lastDataAt` treated as idle
- Idle duration formatted as compact relative: "1m", "5m", "1h", etc.

**Relative path algorithm**: Extract a display-friendly short path from the absolute `Annotation.file`:
1. Split path by `/`, take basename and parent directory (e.g., `/a/b/src/components/App.tsx` → `components/App.tsx`)
2. If multiple files share the same basename, show enough parent segments to disambiguate
3. Full absolute path available via tooltip (`title` attribute)

**`packages/codev/dashboard/src/components/WorkView.tsx`**:
- Import `OpenFilesShellsSection`
- Add section between Builders and Needs Attention sections
- Pass `state.utils`, `state.annotations`, `onSelectTab`, and `state.workspaceName`

**`packages/codev/dashboard/src/index.css`**:
- Add styles for shell/file rows using existing CSS variable system
- Status dot: small circle with `--status-active` (green) or `--text-secondary` (gray)
- Row styling consistent with existing `builder-row` / `pr-row` patterns

#### Acceptance Criteria
- [ ] Section appears below Builders, above Needs Attention
- [ ] Section hidden when no shells or files open
- [ ] Shell entries show name, green/gray dot, idle duration
- [ ] File entries show basename with parent directory for disambiguation
- [ ] Clicking shell/file calls `onSelectTab` with correct ID
- [ ] Auto-updates via existing 1s polling + SSE
- [ ] Handles missing `lastDataAt` gracefully (treats as idle)

#### Test Plan
- **Unit Tests**: Component renders shells and files correctly
- **Unit Tests**: Component returns null when both arrays empty
- **Unit Tests**: Click handlers call `onSelectTab` with correct IDs
- **Unit Tests**: Running/idle status computed correctly from `lastDataAt` — use `vi.useFakeTimers()` for deterministic time control
- **Unit Tests**: Idle threshold boundary (30s vs 31s)
- **Unit Tests**: File path display shows basename + parent directory
- **Playwright E2E**: Section appears in dashboard Work view and responds to clicks (per `codev/resources/testing-guide.md`)

#### Risks
- **Risk**: Relative path computation may not cover all file path patterns
  - **Mitigation**: Use basename + parent directory extraction; full absolute path available as tooltip

---

## Dependency Map
```
Phase 1 (Backend) ──→ Phase 2 (Frontend)
```

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| PTY output frequency overhead | Low | Low | Single timestamp assignment per event |
| Missing lastDataAt on older sessions | Low | Low | Frontend treats undefined as idle |
| Relative path fragility | Low | Low | Basename + parent directory; tooltip with full path |

## Validation Checkpoints
1. **After Phase 1**: Verify `/api/state` returns `lastDataAt` for shells via curl or browser dev tools
2. **After Phase 2**: Visual check in dashboard + Playwright E2E test

## Documentation Updates Required
- [ ] Architecture docs updated if needed

## Expert Review
**Date**: 2026-02-21
**Models Consulted**: Gemini, Codex, Claude

**Key feedback incorporated**:
- **Inline type literal** (Claude): Added explicit mention of updating the `utils` inline type at tower-routes.ts:~1341
- **Relative path algorithm** (Codex, Claude): Specified deterministic algorithm (basename + parent directory) instead of vague "derived from workspace name"
- **New test file** (Claude): Noted that `pty-session.test.ts` must be created (no existing file), with `node-pty` mocking
- **Time mocking** (Claude): Specified `vi.useFakeTimers()` for idle threshold boundary tests
- **Playwright testing** (Codex): Added explicit Playwright E2E test requirement per `codev/resources/testing-guide.md`
- **Shellper replay edge case** (Claude): Documented that replay data bypasses `onPtyData()` — this is fine since `lastDataAt` initializes to `Date.now()`

## Notes

This is a small feature. Two phases keep backend and frontend concerns separated, each independently testable and committable.
