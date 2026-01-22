# Plan 0074: Remove Today Summary

## Overview

This plan implements the removal of the Today Summary feature (Spec 0059) from the Agent Farm dashboard. The work is organized into two phases: frontend removal followed by backend removal, with verification at each stage.

## Phase 1: Frontend Removal

**Objective**: Remove all frontend code related to Today Summary feature.

### Tasks

1. **Delete activity files**:
   - Delete `packages/codev/templates/dashboard/js/activity.js`
   - Delete `packages/codev/templates/dashboard/css/activity.css`

2. **Clean up index.html** (`packages/codev/templates/dashboard/index.html`):
   - Remove the "Today" button from header (`<button class="btn activity-summary-btn"...>`)
   - Remove the Activity Summary Modal (`<div class="dialog-overlay hidden" id="activity-modal">...</div>`)
   - Remove CSS link: `<link rel="stylesheet" href="/dashboard/css/activity.css">`
   - Remove JS script link: `<script src="/dashboard/js/activity.js"></script>`

3. **Clean up utils.js** (`packages/codev/templates/dashboard/js/utils.js`):
   - Remove `formatActivityTime()` function
   - Remove `renderActivityContentHtml()` function

4. **Clean up state.js** (`packages/codev/templates/dashboard/js/state.js`):
   - Search for and remove `activityData` global variable if present

5. **Search for remaining frontend references**:
   - `grep -r "activity" packages/codev/templates/dashboard/` to find any missed references
   - `grep -r "Activity" packages/codev/templates/dashboard/` for capitalized variants
   - Verify utility functions being removed (`formatActivityTime`, `renderActivityContentHtml`) are not called elsewhere
   - Clean up any orphaned code

### Done Criteria

- [ ] `activity.js` file deleted
- [ ] `activity.css` file deleted
- [ ] No activity-related elements in `index.html`
- [ ] No activity-related functions in `utils.js`
- [ ] Dashboard loads in browser without JavaScript errors

---

## Phase 2: Backend Removal

**Objective**: Remove all backend code related to Today Summary feature.

### Tasks

1. **Remove API endpoint** (`packages/codev/src/agent-farm/servers/dashboard-server.ts`):
   - Remove the `/api/activity-summary` route handler block

2. **Remove type definitions**:
   - `interface Commit`
   - `interface PullRequest`
   - `interface BuilderActivity`
   - `interface ProjectChange`
   - `interface TimeTracking`
   - `interface ActivitySummary`

3. **Remove helper functions**:
   - `getGitCommits()`
   - `getModifiedFiles()`
   - `getGitHubPRs()`
   - `getBuilderActivity()`
   - `getProjectChanges()`
   - `calculateTimeTracking()`
   - `generateAISummary()`
   - `collectActivitySummary()`

4. **Clean up imports**:
   - Review all imports at top of file
   - Remove any imports that are no longer used after function removal
   - Run TypeScript compiler to verify no missing imports elsewhere

5. **Search for any remaining activity references**:
   - `grep -r "activity" packages/codev/src/` to find any missed references
   - Clean up any orphaned code

### Done Criteria

- [ ] TypeScript compiles without errors (`npm run build`)
- [ ] No activity-related code in `dashboard-server.ts`
- [ ] No orphaned imports
- [ ] `/api/activity-summary` returns 404

---

## Phase 3: Verification and Cleanup

**Objective**: Verify the removal is complete and all tests pass.

### Tasks

1. **Run full build**:
   - `npm run build` - verify TypeScript compiles
   - `npm run lint` - verify no linting errors

2. **Search for activity tests**:
   - `grep -r "activity" tests/` to find any activity-related tests
   - Delete any tests that specifically test the removed feature

3. **Run test suite**:
   - `npm test` - verify all tests pass
   - E2E tests if available

4. **Manual verification**:
   - Start dashboard (`af start`)
   - Verify "Today" button is not present
   - Verify no console errors
   - Verify dashboard functionality is otherwise intact

5. **Documentation check**:
   - Search CLAUDE.md/AGENTS.md for "Today Summary" or "activity summary" references
   - Update if needed (likely no changes required)

### Done Criteria

- [ ] Build passes
- [ ] Lint passes
- [ ] All tests pass
- [ ] Manual verification complete
- [ ] Documentation updated (if needed)

---

## Files Modified

| File | Action |
|------|--------|
| `packages/codev/templates/dashboard/js/activity.js` | DELETE |
| `packages/codev/templates/dashboard/css/activity.css` | DELETE |
| `packages/codev/templates/dashboard/index.html` | EDIT (remove 4 elements) |
| `packages/codev/templates/dashboard/js/utils.js` | EDIT (remove 2 functions) |
| `packages/codev/templates/dashboard/js/state.js` | EDIT (remove variable if present) |
| `packages/codev/src/agent-farm/servers/dashboard-server.ts` | EDIT (remove ~450 lines) |

## Risk Assessment

**Low Risk**: This is pure code deletion with no behavioral changes to remaining functionality. Rollback is trivial via git revert.

## Dependencies

None. This work is self-contained.

---

## Consultation

### Summary

All three consultants reviewed this plan. Two approved outright (Gemini, Claude), one provided comments (Codex).

### Gemini (APPROVE)
> Plan correctly identifies all assets for removal and follows a logical, safe sequence with appropriate verification steps.

No issues raised.

### Codex (COMMENT)
Raised concern:
- **Missing frontend grep**: Plan only checks `state.js` explicitly but should have repo-wide frontend search for activity references

Addressed by adding Task 5 to Phase 1 with explicit grep commands for frontend.

### Claude (APPROVE)
> Well-organized removal plan with complete spec coverage and appropriate verification steps.

Noted same minor suggestion as Codex (frontend grep) - addressed in this revision.

### Resolution

Plan updated to add explicit frontend grep step (Phase 1, Task 5). Ready for approval.
