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
   A: `DashboardState.utils[]` provides shell terminals (id, name, pid). `DashboardState.annotations[]` provides open files (id, file path, parent). Both are already polled via `/api/state` every 2.5s with SSE-triggered refreshes.

3. **Q: Is shell idle time currently tracked?**
   A: No. The `UtilTerminal` interface has no idle or status fields. Builder idle time (`idleMs`) is computed from gate wait periods — a different concept. True shell idle time (time since last user input/output) is not tracked anywhere.

4. **Q: Should the section be collapsible like other Work view sections?**
   A: No — Work view sections (Builders, Needs Attention, Backlog) are not collapsible. This section follows the same pattern: always visible when populated, hidden when empty.

## Problem Statement

The workspace overview (Work view) shows builders, PRs, backlog, and recently closed issues — but provides no visibility into active shells and open files. Users must switch away from the Work view to discover what shells are running or which files are open in the annotation viewer. This creates unnecessary context-switching.

## Current State

- **Shells**: Active shell sessions are visible only in the terminal tab bar. No summary exists in the Work view.
- **Open files**: Files open in the annotation viewer appear as tabs and in the collapsible File panel, but not in the main Work view content area.
- Both data sources (`utils[]` and `annotations[]`) are already fetched via `/api/state` and available in the `DashboardState` prop passed to `WorkView`.

## Desired State

A new "Open Files & Shells" section in the Work view, positioned immediately after the Builders section, that:
- Lists active shell sessions with name, running/idle status indicator, and idle duration
- Lists files currently open in the annotation viewer with their file path
- Allows clicking a shell entry to switch to that terminal tab
- Allows clicking a file entry to open/focus it in the annotation viewer
- Auto-updates as shells/files are opened or closed (via existing polling + SSE)
- Is hidden entirely when there are no open shells or files

## Stakeholders
- **Primary Users**: Developers using the Codev dashboard
- **Technical Team**: Codev maintainers

## Success Criteria
- [ ] New section appears in Work view below Builders, above Needs Attention
- [ ] Shell entries display: name, status indicator (running/idle), idle duration
- [ ] File entries display: file name and relative path
- [ ] Clicking a shell entry calls `onSelectTab` with the shell's tab ID
- [ ] Clicking a file entry calls `onSelectTab` with the annotation's tab ID
- [ ] Section is hidden when no shells or files are open
- [ ] Section auto-updates via existing polling + SSE mechanism
- [ ] Status indicator visually distinguishes running vs idle shells
- [ ] All tests pass with >90% coverage for new code
- [ ] Existing E2E tests continue to pass

## Constraints

### Technical Constraints
- Shell idle time is NOT currently tracked. The `UtilTerminal` interface only contains: `id`, `name`, `port`, `pid`, `terminalId`, `persistent`. Some backend extension is needed to expose last-activity timestamps.
- The terminal PTY layer (`TerminalManager`) manages node-pty sessions but does not currently emit or track idle events.
- Dashboard state polling interval is 2.5s — idle duration will have that granularity at best.
- Must use existing CSS variable system and Work view styling patterns.

### Scope Boundary
- Shell idle tracking requires a lightweight backend change (timestamp on last PTY data event) plus API surface extension. This is in scope.
- Deep process introspection (e.g., detecting if a command is running inside the shell) is out of scope. "Running" means the PTY process is alive; "idle" means no recent PTY data output.

## Assumptions
- A shell is "running" if it has produced PTY output within a recent threshold (e.g., 30 seconds)
- A shell is "idle" if it has not produced PTY output beyond that threshold
- The `onSelectTab` callback in `WorkView` already handles switching to any tab by ID
- The `annotations[]` array represents all currently open file tabs

## Solution Approaches

### Approach 1: Lightweight PTY Last-Activity Tracking (Recommended)
**Description**: Track `lastDataAt` timestamp on each PTY session in `TerminalManager`. Expose it through the `/api/state` response by extending `UtilTerminal` with `lastDataAt` and `status` fields. The frontend computes idle duration from the timestamp.

**Pros**:
- Minimal backend change — single timestamp update on PTY data events
- Frontend computes relative idle time, avoiding clock sync issues
- Leverages existing polling for updates

**Cons**:
- 2.5s polling granularity means idle time display can lag slightly

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
- [x] Idle threshold duration — 30 seconds is reasonable. PTY output within 30s = running; beyond = idle.

### Nice-to-Know (Optimization)
- [ ] Should idle time show as relative ("2m ago") or absolute? Recommend relative.

## Performance Requirements
- **Rendering**: Section must render within the existing 2.5s poll cycle without additional API calls
- **No new endpoints**: Uses existing `/api/state` data
- **Backend overhead**: Tracking `lastDataAt` on PTY data events must be negligible (single timestamp assignment)

## Security Considerations
- No new authentication or authorization needed — uses existing dashboard auth
- File paths displayed are already exposed via the `/api/state` endpoint

## Test Scenarios

### Functional Tests
1. Section renders with shells when `utils[]` is non-empty
2. Section renders with files when `annotations[]` is non-empty
3. Section is hidden when both `utils[]` and `annotations[]` are empty
4. Clicking a shell entry calls `onSelectTab` with correct ID
5. Clicking a file entry calls `onSelectTab` with correct ID
6. Shell status indicator shows "running" for recently active shells
7. Shell status indicator shows "idle" with duration for inactive shells
8. File entry displays basename and relative path

### Non-Functional Tests
1. Component renders correctly with large number of shells/files (10+)
2. E2E: Section appears in dashboard Work view and responds to clicks

## Dependencies
- **Existing**: `DashboardState` from `/api/state` endpoint
- **New**: `lastDataAt` field on PTY session tracking (backend)

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| PTY data event frequency causes performance overhead | Low | Low | Single timestamp assignment per event — negligible cost |
| Shell idle threshold too aggressive/lenient | Low | Low | Use 30s default; can be tuned later |

## Notes

The recommended approach (Approach 1) is a small feature with clear boundaries:
- ~1 new React component
- ~1 backend extension (lastDataAt on PTY sessions)
- ~1 API type extension (UtilTerminal gets lastDataAt)
- Integration into existing WorkView layout
