# Specification: Remove Today Summary Feature (Spec 0059)

**Project ID**: 0074
**Status**: Draft
**Created**: 2026-01-20
**Protocol**: SPIDER

## Problem Statement

The "Today Summary" feature (implemented in Spec 0059) provides a dashboard button displaying daily activity including commits, PRs, builder activity, and AI-generated summaries. This feature is **not being used** and adds unnecessary complexity to the codebase.

### Current State
- A "🕐 Today" button exists in the Agent Farm dashboard header
- Clicking it shows a modal with daily activity summary
- Backend collects commits, PRs, modified files, and generates AI summaries via the `consult` CLI
- The feature spans ~1,000 lines across frontend (HTML, CSS, JS) and backend (TypeScript)

### Desired State
- Complete removal of all "Today Summary" functionality
- Cleaner codebase with reduced maintenance burden
- No orphaned code, tests, or documentation references

## Stakeholders

- **Primary**: Codev maintainers (reduced maintenance burden)
- **Impact**: Agent Farm users (feature removal - minimal impact since unused)

## Solution

**Approach**: Complete removal of all code, tests, and documentation related to Spec 0059.

This is a straightforward deletion task with no alternative approaches needed. The feature is unused, so there are no migration concerns.

## Scope

### In Scope

#### Files to Delete Entirely (5 files)
| File | Lines | Purpose |
|------|-------|---------|
| `codev/specs/0059-daily-activity-summary.md` | ~120 | Feature specification |
| `codev/plans/0059-daily-activity-summary.md` | ~150 | Implementation plan |
| `codev/reviews/0059-daily-activity-summary.md` | ~104 | Review document |
| `packages/codev/templates/dashboard/css/activity.css` | 151 | Modal/tab styling |
| `packages/codev/templates/dashboard/js/activity.js` | ~51 | Activity rendering |

#### Backend Changes (`packages/codev/src/agent-farm/servers/dashboard-server.ts`)

**Remove type definitions:**
- `Commit` interface
- `PullRequest` interface
- `BuilderActivity` interface
- `ProjectChange` interface
- `TimeTracking` interface
- `ActivitySummary` interface
- `TimeInterval` interface

**Remove functions:**
- `escapeShellArg()`
- `getGitCommits()`
- `getModifiedFiles()`
- `getGitHubPRs()`
- `getProjectChanges()`
- `getBuilderActivity()`
- `mergeIntervals()`
- `calculateTimeTracking()`
- `findConsultPath()`
- `generateAISummary()`
- `collectActivitySummary()`

**Remove API endpoint:**
- `GET /api/activity-summary`

#### Frontend Changes

**`packages/codev/templates/dashboard/index.html`:**
- Remove "🕐 Today" button from header
- Remove activity modal dialog element
- Remove CSS import for `activity.css`
- Remove JS import for `activity.js`

**`packages/codev/templates/dashboard/js/state.js`:**
- Remove `activityData` variable

**`packages/codev/templates/dashboard/js/main.js`:**
- Remove activity modal escape key handler
- Remove `setupActivityModalListeners()` function

**`packages/codev/templates/dashboard/js/tabs.js`:**
- Remove activity tab preservation logic
- Remove activity tab special rendering case

**`packages/codev/templates/dashboard/js/utils.js`:**
- Remove `formatActivityTime()` function
- Remove `renderActivityContentHtml()` function

#### Documentation Updates

**`codev/resources/arch.md`:**
- Remove `/api/activity-summary` from API endpoints table
- Remove `activity.css` and `activity.js` from file listings
- Remove "Activity tab (daily summary)" from features
- Remove "Daily Activity Summary (Spec 0059)" references

**`codev/projectlist-archive.md`:**
- Update Spec 0059 status to indicate removal

**`codev/maintain/0004.md`:**
- Remove references to Spec 0059 commit and deduplication notes

**`codev/resources/lessons-learned.md`:**
- Remove any references to Spec 0059

### Out of Scope

- Backend server file itself (kept, only removing activity-related code)
- Other dashboard functionality
- The `consult` CLI tool (used elsewhere)
- The `gh` CLI dependency (used elsewhere)

## Acceptance Criteria

### MUST Have
- [ ] All 5 files listed for deletion are removed
- [ ] Dashboard loads without errors after removal
- [ ] No JavaScript errors in browser console
- [ ] No TypeScript compilation errors
- [ ] No orphaned references to activity/today summary in codebase
- [ ] Documentation updated to remove references

### SHOULD Have
- [ ] All tests pass (any activity-related tests removed)
- [ ] `grep -r "activity" packages/codev/templates/dashboard/` returns no false positives (only legitimate uses like CSS transitions)

### Verification Commands
```bash
# Ensure no TypeScript errors
npm run build

# Check for orphaned references
grep -r "activity-summary" packages/codev/
grep -r "ActivitySummary" packages/codev/
grep -r "activityData" packages/codev/
grep -r "showActivitySummary" packages/codev/
grep -r "0059" codev/

# Manual: Open dashboard and verify no errors
af start
# Check browser console for errors
```

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Orphaned code references | Low | Low | Grep verification |
| Breaking other dashboard features | Low | Medium | Test dashboard after removal |
| Missing documentation updates | Medium | Low | Comprehensive doc scan |

## Estimation

**Complexity**: Low
**Files affected**: ~15 files
**Lines removed**: ~1,000+

---

## Consultation Log

### Initial Consultation (Pending)
*To be filled after multi-agent consultation*

---

## Changelog

- **2026-01-20**: Initial specification draft
