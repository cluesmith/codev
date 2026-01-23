# Plan 0074: Remove Today Summary Feature

## Overview

This plan implements the removal of the Today Summary feature (Spec 0059) from the agent-farm dashboard. The removal is organized to minimize risk by deleting files and code in dependency order.

## Phase 1: Remove Frontend Files

Delete the self-contained frontend files that have no dependents.

### Files to Delete
- `packages/codev/templates/dashboard/js/activity.js`
- `packages/codev/templates/dashboard/css/activity.css`

### Verification
- Files no longer exist on disk

---

## Phase 2: Remove HTML References

Remove references to deleted files and UI elements from the dashboard HTML.

### File: `packages/codev/templates/dashboard/index.html`

**Remove**:
1. Clock button in header (lines 22-24): `<button id="clock-btn">🕐 Today</button>`
2. Activity Summary modal (lines 126-144): The entire `<dialog id="activity-dialog">` element
3. Script tag: `<script src="js/activity.js"></script>`
4. Link tag: `<link rel="stylesheet" href="css/activity.css">`

### Verification
- No references to `activity.js` or `activity.css` in HTML
- No `clock-btn` or `activity-dialog` elements

---

## Phase 3: Remove Utils Functions

Remove activity-related utility functions from the shared utils file.

### File: `packages/codev/templates/dashboard/js/utils.js`

**Remove**:
1. `formatActivityTime()` function (lines 175-179)
2. `renderActivityContentHtml()` function (lines 190-256)

### Verification
- Functions no longer exist in utils.js
- No orphaned comments or empty blocks

---

## Phase 4: Remove Backend Code

Remove the API endpoint and all supporting functions from the dashboard server.

### File: `packages/codev/src/agent-farm/servers/dashboard-server.ts`

**Remove in order** (to avoid reference errors during editing):

1. **Route handler** (lines 1993-2004): `/api/activity-summary` endpoint
2. **Orchestrator function** (lines 1056-1089): `collectActivitySummary()`
3. **AI summary function** (lines 1006-1051): `generateAISummary()`
4. **Time tracking functions** (lines 906-981):
   - `mergeIntervals()` (lines 906-930)
   - `calculateTimeTracking()` (lines 935-981)
5. **Data collection functions** (lines 648-901):
   - `getGitCommits()` (lines 648-693)
   - `getModifiedFiles()` (lines 698-720)
   - `getGitHubPRs()` (lines 726-778)
   - `getBuilderActivity()` (lines 785-801)
   - `getProjectChanges()` (lines 807-901)
6. **Helper function** (lines 640-643): `escapeShellArg()`
7. **Type definitions** (lines 586-634): `Commit`, `PullRequest`, `BuilderActivity`, `ProjectChange`, `TimeTracking`, `ActivitySummary`

### Verification
- No compile errors (`npm run build` succeeds)
- No references to removed functions

---

## Phase 5: Final Verification

Comprehensive verification that removal is complete and dashboard works.

### Automated Checks
```bash
# Build succeeds
cd packages/codev && npm run build

# No references to activity functions
grep -r "activity" packages/codev/templates/dashboard/ || echo "Clean"
grep -r "ActivitySummary\|getGitCommits\|collectActivitySummary" packages/codev/src/
```

### Manual Checks
1. Start dashboard: `af start`
2. Verify header has no clock button
3. Verify no console errors
4. Verify terminals and file viewer still work
5. Verify `/api/activity-summary` returns 404

### Acceptance Criteria Checklist
- [ ] Dashboard loads without errors
- [ ] No JavaScript console errors
- [ ] No broken CSS references
- [ ] `/api/activity-summary` returns 404
- [ ] Existing functionality works (terminals, builders, file open)
- [ ] No dead code remains
- [ ] Clock button not visible in header
- [ ] Activity modal not accessible

---

## Commit Strategy

Single commit after all phases complete:
```
[Spec 0074] Remove Today Summary feature

- Delete activity.js and activity.css
- Remove modal and button from dashboard HTML
- Remove utility functions from utils.js
- Remove API endpoint and backend functions
```

## Risk Mitigation

- **Low risk**: Feature is self-contained with no dependencies from other features
- **Verification**: `escapeShellArg` usage confirmed limited to activity functions
- **Rollback**: Git history preserves all removed code if needed
