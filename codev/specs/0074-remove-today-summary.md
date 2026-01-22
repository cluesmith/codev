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
- Remove the "🕐 Today" button from the dashboard header
- Remove the Activity Summary Modal dialog
- Remove the CSS link to `activity.css`
- Remove the JS script link to `activity.js`

**Files to Delete**:
- `packages/codev/templates/dashboard/js/activity.js` (113 lines)
- `packages/codev/templates/dashboard/css/activity.css` (152 lines)

**Utility Cleanup** (`packages/codev/templates/dashboard/js/utils.js`):
- Remove `formatActivityTime()` function (lines 175-179)
- Remove `renderActivityContentHtml()` function (lines 190-256)

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

### 3. Global Variable Cleanup

**Frontend State** (`packages/codev/templates/dashboard/js/state.js`):
- Remove `activityData` global variable if present

### 4. Documentation Update

- Update any references to Today Summary in CLAUDE.md/AGENTS.md if present
- The original spec (0059) remains as historical documentation

## Technical Notes

The removal is straightforward code deletion. There are no database migrations or external dependencies to clean up. The `consult` CLI integration was only used for AI summary generation and is not affected.

## Acceptance Criteria

- [ ] Dashboard loads without the "Today" button in header
- [ ] No `activity-summary` API endpoint exists (returns 404)
- [ ] `activity.js` and `activity.css` files are deleted
- [ ] No activity-related code remains in dashboard-server.ts
- [ ] Build passes with no TypeScript errors
- [ ] E2E tests pass (if any reference activity features, remove those tests)
- [ ] No JavaScript errors in browser console when using dashboard

## Code Metrics

**Expected Net Change**: Approximately -500 lines of code
- activity.js: -113 lines
- activity.css: -152 lines
- dashboard-server.ts: ~-450 lines (functions + types)
- index.html: ~-25 lines
- utils.js: ~-70 lines
