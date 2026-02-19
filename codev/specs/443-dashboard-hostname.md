# Spec 443: Show Machine Hostname in Dashboard

## Metadata
- **ID**: spec-443-dashboard-hostname
- **Status**: draft
- **Created**: 2026-02-19

## Problem Statement

When managing multiple machines through cloud.codevos.ai tunnels, the dashboard provides no indication of which machine you're connected to. The header shows the workspace name + "dashboard" and the browser tab shows the same. If you have two machines tunneled (e.g., a Mac laptop and a GCP instance), you can't tell which dashboard tab belongs to which machine without checking the URL.

## Current State

- Dashboard header renders: `{workspaceName} dashboard` (App.tsx)
- Browser tab title renders: `{workspaceName} dashboard` (document.title in useEffect)
- The Tower server already retrieves `os.hostname()` in the tunnel status endpoint but does not expose it in the main dashboard state
- The `DashboardState` interface has `workspaceName` and `version` but no hostname field

## Desired State

The machine's hostname should be visible in two places:

1. **Dashboard header**: Display hostname before the workspace name — e.g., "Mac-Pro codev-public dashboard"
2. **Browser tab title**: Include hostname in the tab name — e.g., "Mac-Pro codev-public dashboard"

### Display Rules

- **Always show hostname** regardless of local or remote access. The hostname is useful context even locally (it tells you which machine this Tower instance runs on). Keeping the logic unconditional also avoids complexity around detecting access method.
- Format: `{hostname} {workspaceName} dashboard`
- If hostname equals the workspaceName (unlikely but possible), show it once: `{workspaceName} dashboard`
- Hostname comparison should be **case-insensitive** with leading/trailing whitespace trimmed
- **Fallback when hostname is absent**: Revert to current behavior — `{workspaceName} dashboard`
- **Long hostnames**: The header text should use CSS `text-overflow: ellipsis` with `overflow: hidden` to truncate gracefully. No explicit character limit — let the layout handle it.

## Stakeholders
- **Primary Users**: Developers using cloud.codevos.ai to manage multiple machines
- **Secondary Users**: Any dashboard user (hostname is informational, non-intrusive)

## Success Criteria
- [ ] Machine hostname appears in the dashboard header
- [ ] Machine hostname appears in the browser tab title
- [ ] Hostname is served via the existing `/api/state` endpoint as part of `DashboardState`
- [ ] No duplicate display when hostname equals workspaceName
- [ ] New unit tests cover hostname display in header and tab title
- [ ] Existing unit and E2E tests pass
- [ ] No visual regression in dashboard header layout

## Constraints

### Technical Constraints
- Hostname must come from `os.hostname()` on the Tower server side
- Must use the existing `DashboardState` data flow (no new endpoints)
- Dashboard polls `/api/state` every 1 second — hostname will appear on first poll

### Business Constraints
- Minimal visual disruption to existing header layout
- Must not break mobile layout

## Assumptions
- `os.hostname()` returns a human-readable name on most systems (it does on macOS and Linux)
- The hostname is not sensitive information (it's already exposed in the tunnel status API)

## Solution Approaches

### Approach 1: Add hostname to DashboardState (Recommended)

**Description**: Add a `hostname` field to the `DashboardState` object returned by `GET /api/state`. The dashboard reads it and prepends it to the header and tab title.

**Pros**:
- Uses existing data flow, no new API calls
- Consistent with how `workspaceName` and `version` are already passed
- Single source of truth

**Cons**:
- None significant

**Estimated Complexity**: Low
**Risk Level**: Low

## Open Questions

None — requirements are clear.

## Performance Requirements
- No measurable performance impact. `os.hostname()` is a synchronous libc call that returns in microseconds.

## Security Considerations
- Hostname is already exposed via `GET /api/tunnel/status`. Adding it to dashboard state doesn't increase the attack surface.

## Test Scenarios

### Functional Tests
1. Dashboard header displays hostname when present in state
2. Browser tab title includes hostname when present in state
3. Hostname is omitted from display when it equals workspaceName
4. Header and tab title fall back gracefully when hostname is absent (backward compatibility)

### Non-Functional Tests
1. No visual regression on desktop layout
2. No visual regression on mobile layout

## Dependencies
- **Internal**: `os` module (Node.js built-in — already imported in tower-tunnel.ts; will also need importing in tower-routes.ts where `/api/state` is handled)
- **Data flow**: `GET /api/state` → `DashboardState` → App component

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Hostname is ugly/long on some systems | Low | Low | CSS truncation with ellipsis if needed |
| Breaks existing header layout | Low | Medium | Test on desktop and mobile before merge |
