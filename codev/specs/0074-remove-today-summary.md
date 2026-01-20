# Specification: Remove Today Summary Feature (Spec 0059)

**Project ID**: 0074
**Status**: Ready for Final Review
**Created**: 2026-01-20
**Protocol**: SPIDER
**Author**: AI (Claude)

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

#### Project Tracking Updates

**`codev/projectlist.md`:**
- Update Spec 0059 status from "integrated" to "removed" with note about this spec

#### Tests

**Confirmed**: No tests exist for the Today Summary feature. Verified via:
```bash
grep -r "activity|today.*summary|0059" tests/     # 0 matches
grep -r "activity|today.*summary|0059" **/*.test.ts  # 0 matches
grep -r "activity|today.*summary|0059" **/*.bats     # 0 matches
```

If any tests are discovered during implementation, they should be removed.

### Out of Scope

- Backend server file itself (kept, only removing activity-related code)
- Other dashboard functionality (including other summary buttons)
- The `consult` CLI tool (used elsewhere)
- The `gh` CLI dependency (used elsewhere)
- User communication (feature was unused, no migration needed)
- Cache busting (dashboard assets are served fresh, no service workers)

## Dependency Verification

The following helper functions are **ONLY** used within the Today Summary feature and are safe to remove:

| Function | Used By | Safe to Remove |
|----------|---------|----------------|
| `escapeShellArg()` | `getGitCommits()`, `getModifiedFiles()`, `generateAISummary()` | Yes |
| `findConsultPath()` | `generateAISummary()` | Yes |

**Verification**: `grep -r "escapeShellArg\|findConsultPath" packages/codev/src/` returns only hits within activity-related code blocks (lines 640-1051).

## Environment Variables

**No environment variables** are specific to the Today Summary feature. The feature uses:
- `gh` CLI (system-installed, credentials managed externally)
- `consult` CLI (system-installed, credentials managed externally)

No cleanup of env vars or credentials required.

## Acceptance Criteria

### MUST Have
- [ ] All 5 files listed for deletion are removed
- [ ] Dashboard loads without errors after removal
- [ ] No JavaScript errors in browser console
- [ ] No TypeScript compilation errors
- [ ] No orphaned references to activity/today summary in codebase
- [ ] Documentation updated to remove references

### SHOULD Have
- [ ] All existing tests pass (`npm test`)
- [ ] Lint passes (`npm run lint`)

### Expected Grep Results After Removal

After removal, these greps should return **no matches**:
```bash
grep -r "activity-summary" packages/codev/     # 0 matches expected
grep -r "ActivitySummary" packages/codev/      # 0 matches expected
grep -r "activityData" packages/codev/         # 0 matches expected
grep -r "showActivitySummary" packages/codev/  # 0 matches expected
grep -r "0059" codev/                          # 0 matches expected
```

**Note**: The word "activity" alone may still appear in legitimate contexts (CSS transitions, etc.) - this is acceptable.

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

### First Consultation (2026-01-20)

**Gemini Pro**:
- **Verdict**: APPROVE
- **Summary**: Comprehensive plan to remove unused "Today Summary" feature; covers all touched files and functions correctly.
- **Confidence**: HIGH
- **Key Issues**: None

**GPT-5 Codex**:
- **Verdict**: REQUEST_CHANGES
- **Summary**: File/function deletion list is strong, but tracking updates, dependency confirmation, testing, and cleanup details need clarification.
- **Confidence**: MEDIUM
- **Key Issues**:
  1. Missing instructions for updating canonical tracking (projectlist.md)
  2. No confirmation that shared helpers being removed aren't used elsewhere
  3. Insufficient testing/verification guidance beyond build + manual check
  4. No plan to clean up credentials/env vars or communicate removal to users

**Changes Made in Response**:
1. Added "Project Tracking Updates" section for `codev/projectlist.md`
2. Added "Dependency Verification" section confirming `escapeShellArg()` and `findConsultPath()` are only used in activity code
3. Expanded "Acceptance Criteria" with specific test/lint requirements and expected grep results
4. Added "Environment Variables" section confirming no env var cleanup needed
5. Added note that no user communication needed (feature unused, no migration)

---

## Changelog

- **2026-01-20**: Initial specification draft
- **2026-01-20**: Incorporated multi-agent consultation feedback (Codex REQUEST_CHANGES addressed)
- **2026-01-20**: Incorporated user clarifications:
  - Scope: ALL references across entire codebase
  - Reason: Feature not used
  - UI: Remove entirely (not hide)
  - Other summary buttons: Keep
  - Tests: Remove any found (confirmed none exist)
