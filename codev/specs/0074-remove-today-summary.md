# Spec 0074: Remove Today Summary

## Problem Statement

The "Today Summary" feature (Spec 0059) was added to help developers track daily activity and generate AI summaries for standup reports. However, in practice the feature is not being used and adds complexity to the dashboard codebase. The AI summary generation also incurs unnecessary API costs when triggered accidentally.

## Goals

- Remove the Today Summary feature entirely from the dashboard
- Remove all associated frontend code (HTML, CSS, JS)
- Remove all backend code (API endpoint, data collection functions, types)
- Clean up any dead code left behind (utility functions only used by this feature)

## Non-Goals

- Replacing Today Summary with alternative functionality
- Preserving any activity tracking infrastructure for future use
- Migrating data or providing deprecation warnings

## Requirements

### 1. Frontend Removal

**HTML Changes** (`packages/codev/templates/dashboard/index.html`):
- Remove the "Today" button from the dashboard header (contains `showActivitySummary()` onclick)
- Remove the Activity Summary Modal dialog (`id="activity-modal"`)
- Remove the CSS link to `activity.css`
- Remove the JS script link to `activity.js`

**Files to Delete**:
- `packages/codev/templates/dashboard/js/activity.js`
- `packages/codev/templates/dashboard/css/activity.css`

**Utility Cleanup** (`packages/codev/templates/dashboard/js/utils.js`):
- Remove `formatActivityTime()` function
- Remove `renderActivityContentHtml()` function

### 2. Backend Removal

**API Endpoint Removal** (`packages/codev/src/agent-farm/servers/dashboard-server.ts`):
- Remove the `/api/activity-summary` route handler

**Functions to Remove** (all in dashboard-server.ts):
- `getGitCommits()` - Git commit data collection
- `getModifiedFiles()` - File modification tracking
- `getGitHubPRs()` - GitHub PR data collection via `gh` CLI
- `getBuilderActivity()` - Builder session activity
- `getProjectChanges()` - Project status change tracking
- `calculateTimeTracking()` - Time interval calculation
- `generateAISummary()` - AI summary generation via consult
- `collectActivitySummary()` - Main orchestration function

**Type Definitions to Remove** (all in dashboard-server.ts):
- `interface Commit`
- `interface PullRequest`
- `interface BuilderActivity`
- `interface ProjectChange`
- `interface TimeTracking`
- `interface ActivitySummary`

**Import Cleanup** (dashboard-server.ts):
- Remove any imports that become unused after function deletion
- The builder should verify each import's usage and remove orphaned ones
- Note: `execa`, `consult`, and other utilities may have other uses - only remove if truly orphaned

### 3. Global Variable Cleanup

**Frontend State** (`packages/codev/templates/dashboard/js/state.js`):
- Search for and remove `activityData` global variable if present

### 4. Test Cleanup

**E2E Tests**:
- Search for any tests referencing "activity", "today summary", or the `/api/activity-summary` endpoint
- Delete any tests that specifically test the removed feature
- Verify remaining tests pass

**No regression tests needed**: Since we're removing functionality (not changing behavior), no new tests are required.

### 5. Documentation Update

**Scope**: Only update documentation if it directly references the Today Summary feature.

- CLAUDE.md/AGENTS.md: Update if any direct references exist (likely none)
- Cheatsheet/command reference: No changes needed (feature was UI-only)
- Spec 0059: Keep as historical documentation (no changes)
- projectlist.md: Keep 0059 entry unchanged (historical record)

## Technical Notes

The removal is straightforward code deletion. There are no database migrations, external dependencies, or configuration files to clean up. The `consult` CLI integration was only used for AI summary generation and remains available for other features.

## Acceptance Criteria

- [ ] Dashboard loads without the "Today" button in header
- [ ] No `/api/activity-summary` endpoint exists (returns 404)
- [ ] `activity.js` and `activity.css` files are deleted
- [ ] No activity-related functions/types remain in dashboard-server.ts
- [ ] No orphaned imports remain in dashboard-server.ts
- [ ] Build passes with no TypeScript errors
- [ ] All E2E tests pass (with activity-specific tests removed)
- [ ] No JavaScript errors in browser console when using dashboard

## Code Metrics

**Expected Net Change**: Approximately -500 lines of code
- activity.js: ~113 lines
- activity.css: ~152 lines
- dashboard-server.ts: ~450 lines (functions + types)
- index.html: ~25 lines
- utils.js: ~70 lines

---

## Consultation

### Summary

All three consultants reviewed this spec. Two approved outright (Gemini, Claude), one provided comments (Codex).

### Gemini (APPROVE)
> Comprehensive removal spec for an unused feature; clearly defines all assets to delete and accounts for dead code cleanup.

No issues raised.

### Codex (COMMENT)
Raised concerns about:
1. **Line number fragility**: Updated spec to reference function/component names instead
2. **Import/config cleanup scope**: Added explicit "Import Cleanup" section
3. **Test handling ambiguity**: Added explicit "Test Cleanup" section with clear guidance
4. **Documentation scope**: Clarified which docs need checking and noted most require no changes

All concerns addressed in this revision.

### Claude (APPROVE)
> Well-structured removal spec with explicit requirements; minor line-number fragility is acceptable given comprehensive function/file names.

Minor observations noted (line numbers, state.js uncertainty, import cleanup) - all addressed in this revision.

### Resolution

Spec updated to address all consultant feedback. Ready for approval.
