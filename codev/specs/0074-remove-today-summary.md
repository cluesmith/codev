# Spec 0074: Remove Today Summary Feature

## Summary

Remove the Today Summary feature (Spec 0059) from the agent-farm dashboard. The feature adds complexity without providing sufficient value to justify its maintenance cost.

## Motivation

The Today Summary feature was implemented in Spec 0059 to provide developers with a daily standup summary including git activity, PRs, builders, time tracking, and AI-generated narrative. However:

1. **Low usage**: The feature is not being actively used in daily workflows
2. **Maintenance burden**: The feature includes ~500 lines of backend code with multiple data collection functions, AI integration via consult CLI, and complex time interval calculations
3. **External dependencies**: Relies on `gh` CLI for PR data and `consult` CLI for AI summaries, adding failure points
4. **Scope creep**: The original intent was simple, but the implementation grew to include time tracking, project change detection, and AI narratives

Removing unused features keeps the codebase lean and reduces cognitive load for maintainers.

## Requirements

### Must Remove

1. **Dashboard HTML** (`packages/codev/templates/dashboard/index.html`)
   - Clock button ("🕐 Today") in the dashboard header (lines 22-24)
   - Activity Summary modal markup (lines 126-144)
   - `<script src="js/activity.js">` tag
   - `<link href="css/activity.css">` tag

2. **Frontend JavaScript**
   - `packages/codev/templates/dashboard/js/activity.js` - Delete entire file
   - `packages/codev/templates/dashboard/js/utils.js` - Remove functions:
     - `formatActivityTime()` (lines 175-179)
     - `renderActivityContentHtml()` (lines 190-256)

3. **Frontend CSS**
   - `packages/codev/templates/dashboard/css/activity.css` - Delete entire file

4. **Backend API** (`packages/codev/src/agent-farm/servers/dashboard-server.ts`)
   - `/api/activity-summary` endpoint route handler (lines 1993-2004)
   - Type definitions (lines 586-634): `Commit`, `PullRequest`, `BuilderActivity`, `ProjectChange`, `TimeTracking`, `ActivitySummary`
   - Helper function `escapeShellArg()` (lines 640-643)
   - Data collection functions:
     - `getGitCommits()` (lines 648-693)
     - `getModifiedFiles()` (lines 698-720)
     - `getGitHubPRs()` (lines 726-778)
     - `getBuilderActivity()` (lines 785-801)
     - `getProjectChanges()` (lines 807-901)
     - `mergeIntervals()` (lines 906-930)
     - `calculateTimeTracking()` (lines 935-981)
     - `generateAISummary()` (lines 1006-1051)
     - `collectActivitySummary()` (lines 1056-1089)

### Must NOT Remove

1. **Spec 0059 documentation** - Keep `codev/specs/0059-daily-activity-summary.md`, `codev/plans/0059-daily-activity-summary.md`, and `codev/reviews/0059-daily-activity-summary.md` for historical reference
2. **Other dashboard functionality** - The dashboard, terminals, builders, and file viewers must continue working
3. **Unrelated CSS/JS** - Do not modify styles or scripts unrelated to this feature

## Acceptance Criteria

1. Dashboard loads without errors after removal
2. No JavaScript console errors related to missing activity functions
3. No broken CSS references
4. `/api/activity-summary` returns 404 or endpoint does not exist
5. All existing dashboard functionality (terminals, builders, file open) works correctly
6. No dead code remains (unused imports, orphaned CSS selectors)
7. **UI Verification**: Clock button ("🕐 Today") no longer appears in dashboard header
8. **UI Verification**: Activity Summary modal is not accessible via any UI element

## Out of Scope

- Adding replacement features
- Refactoring other dashboard components
- Updating the projectlist.md status for Spec 0059 (this is a removal spec, not an amendment)

## Consultation

### Gemini 3 Pro

> **Verdict**: APPROVE (High Confidence)
>
> The specification provides a clear and comprehensive plan for removing the "Today Summary" feature. It correctly identifies the components to be removed across the stack (UI, Frontend JS/CSS, Backend API) and explicitly safeguards historical documentation. The acceptance criteria are well-defined and cover the potential side effects of removal.
>
> Minor observation: While the Consultation Summary mentions that ensuring the removal of script tag references was "incorporated," the "Must Remove" section did not explicitly list the `<script>` and `<link>` tags in HTML.

### GPT-5 Codex

> **Verdict**: COMMENT (Medium Confidence)
>
> Solid removal scope, but could be clearer on implementation touchpoints and validation. Key suggestions:
> 1. Specify exact files/markup/script tags to delete so builders aren't guessing
> 2. Add UI verification criteria (header button gone, modal inaccessible)
> 3. Add testing expectations - unit/UI/regression test expectations should be stated

### Claude

> **Verdict**: APPROVE (High Confidence)
>
> Well-structured removal specification for eliminating the Today Summary feature. The "Must Remove" and "Must NOT Remove" sections precisely enumerate all components. Documentation preservation is correctly noted. All six acceptance criteria are verifiable.
>
> Observations:
> - File paths weren't fully incorporated initially, but function names are specific enough
> - `escapeShellArg()` verified as only used by activity functions
> - The removal is straightforward with well-isolated code

### Consultation Summary

Two of three reviewers approved, one requested clarifications. Changes incorporated:
- **Added explicit file paths** with line numbers to Must Remove section (per Codex feedback)
- **Added UI verification acceptance criteria** (per Gemini and Codex feedback)
- **Added script/link tag references** to HTML removal list (per Gemini observation)
- Verified `escapeShellArg()` is only used by activity functions - safe to remove
- Git history serves as rollback mechanism (rollback plan not needed per Claude)
