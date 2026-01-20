# Plan: Remove Today Summary Feature

## Metadata
- **ID**: plan-2026-01-20-remove-today-summary
- **Status**: draft
- **Specification**: [codev/specs/0074-remove-today-summary.md](../specs/0074-remove-today-summary.md)
- **Created**: 2026-01-20

## Executive Summary

This plan removes the unused "Today Summary" feature (Spec 0059) from the codebase. The removal is organized into three phases:
1. **Backend removal** - Remove all TypeScript code from dashboard-server.ts
2. **Frontend removal** - Remove HTML elements, CSS, JS files, and related state
3. **Documentation cleanup** - Remove spec/plan/review files and update references

The work is sequenced so that backend removal happens first (API endpoint removed), then frontend (which depended on that API), then documentation (cleanup).

## Success Metrics
- [ ] All 5 files listed for deletion are removed
- [ ] Dashboard loads without errors after removal
- [ ] No JavaScript errors in browser console
- [ ] No TypeScript compilation errors
- [ ] No orphaned references to activity/today summary in codebase
- [ ] Documentation updated to remove references
- [ ] `codev/projectlist-archive.md` updated with removal status for Spec 0059
- [ ] Other dashboard tabs still render correctly (no tab index regression)
- [ ] All existing tests pass (`npm test`)
- [ ] Lint passes (`npm run lint`)

## Phase Breakdown

### Phase 1: Backend Removal
**Dependencies**: None

#### Objectives
- Remove all activity-related TypeScript code from `packages/codev/src/agent-farm/servers/dashboard-server.ts`
- Ensure the dashboard server compiles and runs without the activity endpoint

#### Deliverables
- [ ] Remove type definitions: `Commit`, `PullRequest`, `BuilderActivity`, `ProjectChange`, `TimeTracking`, `ActivitySummary`, `TimeInterval`
- [ ] Remove functions: `escapeShellArg()`, `getGitCommits()`, `getModifiedFiles()`, `getGitHubPRs()`, `getProjectChanges()`, `getBuilderActivity()`, `mergeIntervals()`, `calculateTimeTracking()`, `findConsultPath()`, `generateAISummary()`, `collectActivitySummary()`
- [ ] Remove API endpoint handler for `GET /api/activity-summary`
- [ ] TypeScript compiles without errors

#### Implementation Details
- File: `packages/codev/src/agent-farm/servers/dashboard-server.ts`
- Lines to remove: approximately 640-1095 (type definitions + helper functions) and ~1993-2008 (API handler)
- Total removal: ~450+ lines of TypeScript code

**Key code sections to remove:**
1. Interfaces (lines ~596-636): `Commit`, `PullRequest`, `BuilderActivity`, `ProjectChange`, `TimeTracking`, `ActivitySummary`, `TimeInterval`
2. Helper functions (lines ~640-1095): All activity-related functions listed above
3. API route handler (lines ~1993-2008): The `/api/activity-summary` GET handler

#### Acceptance Criteria
- [ ] `npm run build` succeeds
- [ ] `grep -r "ActivitySummary" packages/codev/src/` returns no matches
- [ ] `grep -r "activity-summary" packages/codev/src/` returns no matches
- [ ] Dashboard server starts without errors

#### Test Plan
- **Unit Tests**: No existing tests for this feature (verified in spec)
- **Automated Tests**: Run `npm test` to ensure no regressions
- **Lint Check**: Run `npm run lint` to verify code quality
- **Manual Testing**: Start dashboard (`af start`) and verify it loads

#### Rollback Strategy
- Git revert the commit for this phase

#### Risks
- **Risk**: Removing helper functions that are used elsewhere
  - **Mitigation**: Verified via grep that `escapeShellArg()` and `findConsultPath()` are ONLY used in activity code

---

### Phase 2: Frontend Removal
**Dependencies**: Phase 1 (API endpoint no longer exists)

#### Objectives
- Remove all activity-related frontend code (HTML, CSS, JS)
- Clean up state variables and event listeners

#### Deliverables
- [ ] Delete `packages/codev/templates/dashboard/css/activity.css` (151 lines)
- [ ] Delete `packages/codev/templates/dashboard/js/activity.js` (~51 lines)
- [ ] Update `packages/codev/templates/dashboard/index.html`:
  - Remove CSS import for `activity.css`
  - Remove JS import for `activity.js`
  - Remove "🕐 Today" button from header
  - Remove activity modal dialog element
- [ ] Update `packages/codev/templates/dashboard/js/state.js`:
  - Remove `activityData` variable
- [ ] Update `packages/codev/templates/dashboard/js/main.js`:
  - Remove `setupActivityModalListeners()` function
  - Remove activity modal escape key handler
- [ ] Update `packages/codev/templates/dashboard/js/tabs.js`:
  - Remove activity tab preservation in `buildTabsFromState()`
  - Remove activity tab special case in `renderTabContent()`
- [ ] Update `packages/codev/templates/dashboard/js/utils.js`:
  - Remove `formatActivityTime()` function
  - Remove `renderActivityContentHtml()` function

#### Implementation Details
**Files to delete entirely:**
- `packages/codev/templates/dashboard/css/activity.css`
- `packages/codev/templates/dashboard/js/activity.js`

**Files to modify:**

1. **index.html** - Remove:
   - Line 13: `<link rel="stylesheet" href="/dashboard/css/activity.css">`
   - Lines 22-25: The "🕐 Today" button div
   - Lines 126-144: The activity modal dialog
   - Line 172: `<script src="/dashboard/js/activity.js"></script>`

2. **state.js** - Remove:
   - Lines 49-50: `activityData` variable and comment

3. **main.js** - Remove:
   - Line 14: `setupActivityModalListeners();` call
   - Lines 253-256: Activity modal escape key handler
   - Lines 315-325: `setupActivityModalListeners()` function

4. **tabs.js** - Remove:
   - Line 49: `const clientSideTabs = tabs.filter(t => t.type === 'activity');`
   - Lines 96-98: Re-adding preserved client-side tabs
   - Lines 276-284: Activity tab special case in `renderTabContent()`

5. **utils.js** - Remove:
   - Lines 174-179: `formatActivityTime()` function
   - Lines 190-256: `renderActivityContentHtml()` function

#### Acceptance Criteria
- [ ] Dashboard loads without JavaScript errors
- [ ] No "🕐 Today" button visible in header
- [ ] Activity modal no longer exists in DOM
- [ ] All other tabs (Dashboard, files, builders, shells) work correctly
- [ ] `grep -r "activityData" packages/codev/templates/` returns no matches
- [ ] `grep -r "showActivitySummary" packages/codev/templates/` returns no matches

#### Test Plan
- **Automated Tests**: Run `npm test` to ensure no regressions
- **Lint Check**: Run `npm run lint` to verify code quality
- **Manual Testing**:
  - Open dashboard, check browser console for errors
  - Click through all tabs
  - Verify escape key works for other dialogs (file picker, close confirmation)
  - Verify tab switching works (Ctrl+Tab)

#### Rollback Strategy
- Git revert the commit for this phase

#### Risks
- **Risk**: Breaking other tabs or dialogs
  - **Mitigation**: Test all dashboard functionality manually

---

### Phase 3: Documentation Cleanup
**Dependencies**: Phase 2 (feature fully removed from code)

#### Objectives
- Delete Spec 0059 artifacts
- Update documentation to remove references

#### Deliverables
- [ ] Delete `codev/specs/0059-daily-activity-summary.md`
- [ ] Delete `codev/plans/0059-daily-activity-summary.md`
- [ ] Delete `codev/reviews/0059-daily-activity-summary.md`
- [ ] Update `codev/resources/arch.md`:
  - Remove `/api/activity-summary` from API endpoints table
  - Remove `activity.css` and `activity.js` from file listings
  - Remove "Activity tab (daily summary)" from features
  - Remove "Daily Activity Summary (Spec 0059)" references
- [ ] Update `codev/projectlist-archive.md`:
  - Update Spec 0059 entry to status "removed" with note "Removed by Spec 0074 - feature was unused"
- [ ] Update `codev/maintain/0004.md`:
  - Remove references to Spec 0059 commit and deduplication notes
- [ ] Update `codev/resources/lessons-learned.md`:
  - Remove any references to Spec 0059

#### Implementation Details
**Files to delete:**
- `codev/specs/0059-daily-activity-summary.md`
- `codev/plans/0059-daily-activity-summary.md`
- `codev/reviews/0059-daily-activity-summary.md`

**Files to modify:**
- `codev/resources/arch.md` - Remove activity-related entries
- `codev/projectlist-archive.md` - Mark Spec 0059 as removed
- `codev/maintain/0004.md` - Remove Spec 0059 references
- `codev/resources/lessons-learned.md` - Remove Spec 0059 references (if any)

#### Acceptance Criteria
- [ ] `grep -r "0059" codev/` returns ONLY matches in this spec (0074) and its plan - no other files should reference 0059
- [ ] No orphaned references to "activity-summary" in documentation
- [ ] projectlist-archive.md shows 0059 as "removed"

**Note on grep expectation**: The spec states `grep -r "0059" codev/` should return 0 matches. However, this spec (0074) and this plan necessarily reference "0059" as the feature being removed. The *intent* is that no other codev files should reference 0059. After implementation, the only matches should be in `codev/specs/0074-*.md` and `codev/plans/0074-*.md`.

#### Test Plan
- **Automated Tests**: Run `npm test` to ensure no regressions
- **Lint Check**: Run `npm run lint` to verify code quality
- **Manual Testing**: Run verification greps from spec
- **Review**: Check updated documentation for consistency

#### Rollback Strategy
- Git revert the commit for this phase

#### Risks
- **Risk**: Missing documentation references
  - **Mitigation**: Comprehensive grep verification

---

## Dependency Map
```
Phase 1 (Backend) ──→ Phase 2 (Frontend) ──→ Phase 3 (Documentation)
```

## Resource Requirements
### Development Resources
- Single builder in worktree

### Infrastructure
- No database changes
- No new services
- No configuration changes

## Integration Points
None - this is a removal operation with no external dependencies.

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Orphaned code references | Low | Low | Grep verification after each phase |
| Breaking other dashboard features | Low | Medium | Manual testing after Phase 2 |
| Missing documentation updates | Medium | Low | Comprehensive doc scan in Phase 3 |

## Validation Checkpoints
1. **After Phase 1**: `npm run build` succeeds, `npm test` passes, `npm run lint` passes, server starts
2. **After Phase 2**: `npm test` passes, `npm run lint` passes, Dashboard loads, no console errors, all tabs work
3. **After Phase 3**: `npm test` passes, `npm run lint` passes, all verification greps pass

## Verification Commands (Post-Implementation)
```bash
# Ensure no TypeScript errors
npm run build

# Check for orphaned references
grep -r "activity-summary" packages/codev/     # 0 matches expected
grep -r "ActivitySummary" packages/codev/      # 0 matches expected
grep -r "activityData" packages/codev/         # 0 matches expected
grep -r "showActivitySummary" packages/codev/  # 0 matches expected
grep -r "0059" codev/                          # Only 0074 spec/plan should match

# Manual: Open dashboard and verify no errors
af start
# Check browser console for errors
```

## Documentation Updates Required
- [ ] codev/resources/arch.md - Remove activity references
- [ ] codev/projectlist-archive.md - Mark 0059 as removed
- [ ] codev/maintain/0004.md - Remove 0059 references
- [ ] codev/resources/lessons-learned.md - Remove 0059 references (if any)

## Post-Implementation Tasks
- [ ] Run all verification greps
- [ ] Manual dashboard smoke test
- [ ] Review phase before merging

## Consultation Log

### First Consultation (After Draft) - 2026-01-20

**Gemini Pro**:
- **Verdict**: APPROVE
- **Confidence**: HIGH
- **Summary**: Comprehensive and well-structured plan that accurately reflects the specification with clear phases and verification steps.
- **Key Issues**: None

**GPT-5 Codex**:
- **Verdict**: REQUEST_CHANGES
- **Confidence**: HIGH
- **Summary**: Resolve the contradictory grep requirement, document when lint/tests run, and complete the consultation log before approval.
- **Key Issues**:
  1. Acceptance criteria conflict with spec regarding `grep -r "0059"` (Plan Phase 3 vs Spec "Expected Grep Results")
  2. Automated test/lint execution not anchored to any phase/test plan
  3. Consultation log left empty despite being a required artifact

**Changes Made in Response**:
1. **Clarified grep expectation**: Added note in Phase 3 acceptance criteria explaining that 0074 spec/plan will reference "0059" as the feature being removed, so the intent is no *other* files should reference it
2. **Added test/lint to all phases**: Updated each phase's Test Plan section to include explicit `npm test` and `npm run lint` execution
3. **Updated Validation Checkpoints**: Added test/lint requirements to all three validation checkpoints
4. **Filled Consultation Log**: This section now documents the consultation results

**Not Incorporated**: None - all feedback addressed

## Approval
- [ ] Multi-agent consultation complete
- [ ] Human review complete

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-01-20 | Initial plan draft | Created implementation plan | AI |
| 2026-01-20 | Incorporated consultation feedback | Address Codex REQUEST_CHANGES | AI |

---

## Amendment History

This section tracks all TICK amendments to this plan. TICKs modify both the spec and plan together as an atomic unit.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
