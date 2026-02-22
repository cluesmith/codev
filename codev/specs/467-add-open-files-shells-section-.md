# Specification: Add Open Files & Shells Section to Workspace Overview

## Metadata
- **ID**: spec-2026-02-21-open-files-shells
- **Status**: draft
- **Created**: 2026-02-21
- **GitHub Issue**: #467

## Clarifying Questions Asked

1. **Q: Should shells and files be in one combined section or two separate sections?**
   A: One combined section titled "Open Files & Shells" positioned below Builders, with sub-groups for each.

2. **Q: What data is already available on the frontend?**
   A: `DashboardState.utils[]` provides shell terminals (id, name, pid). `DashboardState.annotations[]` provides open files (id, file path, parent). Both are already polled via `/api/state` every 1s with SSE-triggered refreshes.

3. **Q: Is shell idle time currently tracked?**
   A: Partially. `PtySession` already tracks `lastInputAt` (user keyboard input timestamp) via `recordUserInput()` and exposes `isUserIdle(thresholdMs)`. However, this tracks **user input** only, not **PTY output** (process activity). A shell running a long compilation would show "idle" by input metrics despite being actively running. The spec extends this with `lastDataAt` for output-based activity tracking.

4. **Q: Should the section be collapsible like other Work view sections?**
   A: No — follows the "Recently Closed" pattern: hidden entirely when empty, no placeholder text. (Contrast with "Builders" which shows "No active builders" when empty.)

## Problem Statement

The workspace overview (Work view) shows builders, PRs, backlog, and recently closed issues — but provides no visibility into active shells and open files. Users must switch away from the Work view to discover what shells are running or which files are open in the annotation viewer. This creates unnecessary context-switching.

## Current State

- **Shells**: Active shell sessions are visible only in the terminal tab bar. No summary exists in the Work view.
- **Open files**: Files open in the annotation viewer appear as tabs and in the collapsible File panel, but not in the main Work view content area.
- Both data sources (`utils[]` and `annotations[]`) are already fetched via `/api/state` and available in the `DashboardState` prop passed to `WorkView`.
- `PtySession` already tracks `lastInputAt` for user input idle detection (used by the message delivery system).

## Desired State

A new "Open Files & Shells" section in the Work view, positioned immediately after the Builders section, that:
- Lists active shell sessions with name, running/idle status indicator, and idle duration
- Lists files currently open in the annotation viewer with their file path
- Allows clicking a shell entry to switch to that terminal tab
- Allows clicking a file entry to open/focus it in the annotation viewer
- Auto-updates as shells/files are opened or closed (via existing 1s polling + SSE)
- Is hidden entirely when there are no open shells or files (follows "Recently Closed" pattern)

## Stakeholders
- **Primary Users**: Developers using the Codev dashboard
- **Technical Team**: Codev maintainers

## Success Criteria
- [ ] New section appears in Work view below Builders, above Needs Attention
- [ ] Shell entries display: name, status indicator (running/idle), idle duration
- [ ] File entries display: file basename and relative path (relative to workspace root)
- [ ] Clicking a shell entry calls `onSelectTab` with `util.id` (the tab system ID)
- [ ] Clicking a file entry calls `onSelectTab` with `annotation.id` (the tab system ID)
- [ ] Section is hidden when no shells or files are open
- [ ] Section auto-updates via existing polling + SSE mechanism
- [ ] Status indicator visually distinguishes running vs idle shells (green dot for running, gray dot for idle)
- [ ] All tests pass with >90% coverage for new code
- [ ] Existing E2E tests continue to pass

## Constraints

### Technical Constraints
- `UtilTerminal` interface currently has no idle/status fields — needs `lastDataAt` extension.
- `PtySession` tracks `lastInputAt` (user input) but not `lastDataAt` (PTY output). Both serve different purposes: input-idle is used by the message delivery system; output-activity is what users care about for "is my shell doing something."
- Dashboard state polling interval is 1s (`POLL_INTERVAL_MS = 1000`) — idle duration will have that granularity.
- Must use existing CSS variable system and Work view styling patterns.
- `Annotation.file` provides absolute paths; relative path must be computed (from workspace root).

### Scope Boundary
- Shell idle tracking requires a lightweight backend change (timestamp on last PTY output event) plus API surface extension. This is in scope.
- Deep process introspection (e.g., detecting if a command is running inside the shell) is out of scope.

## Assumptions
- A shell is "running" if it has produced PTY output within a recent threshold (30 seconds)
- A shell is "idle" if it has not produced PTY output beyond that threshold
- Newly spawned shells default to "running" status (`lastDataAt` initialized to `Date.now()` at session creation)
- `onSelectTab(util.id)` switches to the shell tab; `onSelectTab(annotation.id)` switches to the file tab (confirmed by `useTabs.ts` tab construction)
- The `annotations[]` array represents all currently open file tabs

## Solution Approaches

### Approach 1: Lightweight PTY Output Activity Tracking (Recommended)
**Description**: Track `lastDataAt` timestamp on each PTY session alongside existing `lastInputAt`. Expose it through the `/api/state` response by extending `UtilTerminal` with a `lastDataAt` field. The frontend computes idle duration and running/idle status from the timestamp using a 30s threshold.

**Pros**:
- Minimal backend change — single timestamp update on PTY data events, mirrors existing `lastInputAt` pattern
- Frontend computes both status and duration, avoiding redundant `status` field
- Leverages existing 1s polling for updates

**Cons**:
- None significant

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: No Idle Tracking (Simplified)
**Description**: Display shells and files without idle time or status indicator. Just show names and allow click-to-navigate.

**Pros**:
- Zero backend changes
- Simpler implementation

**Cons**:
- Does not satisfy the issue requirement for "status indicator" and "idle time"
- Less useful to users

**Estimated Complexity**: Low
**Risk Level**: Low

## Open Questions

### Critical (Blocks Progress)
- None — requirements are clear from the issue.

### Important (Affects Design)
- [x] Idle threshold duration — 30 seconds. PTY output within 30s = running; beyond = idle.
- [x] Input vs output tracking — Use output-based (`lastDataAt`) since it indicates whether the shell process is actively doing something, not whether the user recently typed.
- [x] Initial state for new shells — `lastDataAt = Date.now()` at session creation, so new shells start as "running."
- [x] Tab ID mapping — `util.id` for shells, `annotation.id` for files (confirmed from `useTabs.ts`).
- [x] Section visibility pattern — Hidden when empty (like "Recently Closed"), not placeholder (like "Builders").

### Nice-to-Know (Optimization)
- [x] Idle time display format — Relative: "2m", "1h", etc. No "ago" suffix to keep it compact.

## Performance Requirements
- **Rendering**: Section renders using data already available in `DashboardState` — no additional API calls
- **No new endpoints**: Uses existing `/api/state` data (polled every 1s)
- **Backend overhead**: Tracking `lastDataAt` on PTY output events is negligible (single timestamp assignment, mirrors existing `lastInputAt` pattern)

## Security Considerations
- No new authentication or authorization needed — uses existing dashboard auth
- File paths displayed are already exposed via the `/api/state` endpoint

## Test Scenarios

### Functional Tests
1. Section renders with shells when `utils[]` is non-empty
2. Section renders with files when `annotations[]` is non-empty
3. Section is hidden when both `utils[]` and `annotations[]` are empty
4. Clicking a shell entry calls `onSelectTab` with `util.id`
5. Clicking a file entry calls `onSelectTab` with `annotation.id`
6. Shell shows "running" (green dot) when `lastDataAt` is within 30s
7. Shell shows "idle" (gray dot) with duration when `lastDataAt` is beyond 30s
8. Shell with no `lastDataAt` (legacy/missing data) shows gracefully (no crash, treats as idle)
9. File entry displays basename and disambiguating relative path
10. Idle threshold boundary: shell at exactly 30s vs 31s

### Non-Functional Tests
1. Component renders correctly with large number of shells/files (10+)
2. `lastDataAt` correctly serializes through API round-trip (backend → API → frontend)
3. E2E: Section appears in dashboard Work view and responds to clicks

## Dependencies
- **Existing**: `DashboardState` from `/api/state` endpoint, `PtySession.lastInputAt` pattern
- **New**: `lastDataAt` field on `PtySession`, exposed through `UtilTerminal` API type

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| PTY data event frequency causes performance overhead | Low | Low | Single timestamp assignment per event — negligible cost |
| Shell idle threshold too aggressive/lenient | Low | Low | Use 30s default; can be tuned later |
| Missing `lastDataAt` on older sessions | Low | Low | Frontend handles `undefined` gracefully — shows as idle |

## Expert Consultation
**Date**: 2026-02-21
**Models Consulted**: Gemini, Codex, Claude

**Key feedback incorporated**:
- **Polling interval corrected**: `/api/state` is polled every 1s (not 2.5s) per `POLL_INTERVAL_MS = 1000`
- **Existing `lastInputAt` acknowledged**: `PtySession` already tracks user input timestamps; spec clarifies output-based tracking is intentionally different
- **Tab ID mapping specified**: `util.id` for shells, `annotation.id` for files (verified from `useTabs.ts`)
- **`lastDataAt` initialization**: New shells start with `lastDataAt = Date.now()` to avoid "idle" on spawn
- **`status` field eliminated**: Frontend computes status from `lastDataAt` — no redundant backend field
- **Section visibility pattern**: Follows "Recently Closed" (hidden when empty), not "Builders" (placeholder text)
- **Relative path**: Computed relative to workspace root; `Annotation.file` provides absolute paths
- **Graceful fallback**: Missing `lastDataAt` handled as idle (for backward compatibility)
- **Idle time format**: Compact relative format ("2m", "1h") without "ago" suffix

## Notes

The recommended approach (Approach 1) is a small feature with clear boundaries:
- ~1 new React component (`OpenFilesShellsSection`)
- ~1 backend extension (`lastDataAt` on `PtySession`, mirroring existing `lastInputAt`)
- ~1 API type extension (`UtilTerminal` gets `lastDataAt`)
- Integration into existing `WorkView` layout
