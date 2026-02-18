# Review: Dashboard Chrome Cleanup

## Summary

Cleaned up dashboard chrome: replaced "Agent Farm" branding with `<project-name> dashboard` in header and tab title, removed redundant footer status bar. Also cleaned up legacy Playwright tests that referenced non-existent UI elements.

## Spec Compliance
- [x] Header displays `<project-name> dashboard` instead of "Agent Farm" + builder count badge
- [x] Footer/status bar completely removed (HTML + CSS)
- [x] Browser tab title shows `<project-name> dashboard`
- [x] Fallback behavior works when workspace name is unavailable (falsy → just "dashboard")
- [x] `index.html` initial `<title>` updated to prevent branding flash before React hydrates
- [x] Existing Playwright tests updated to match changes

## Deviations from Plan
- **Phase 2 (test_updates)**: Removed entire `Bug #3: Layout matches legacy dashboard` test suite from `dashboard-bugs.test.ts` (8 tests). These tested selectors (`.projects-info`, `.dashboard-header`, `.section-tabs`, `.section-files`, `.section-projects`) that no longer exist in the current React UI. Preserved the split-pane layout test as it tests actual current architecture. This was more aggressive than the plan's "audit" language but all three consultants approved.
- **Playwright E2E run**: Could not execute Playwright tests in the builder worktree (requires running tower instance). This must be verified by the architect before merge.

## Lessons Learned

### What Went Well
- Spec was clear and prescriptive, making implementation straightforward
- Codebase exploration via subagent found all relevant files quickly
- All three consultants caught useful issues during spec phase (empty string edge case, `index.html` title, legacy test concerns)

### Challenges Encountered
- `consult` command disambiguation: Required `--issue 425` flag when multiple projects exist in `codev/projects/`
- Gemini PR discovery: `--type impl` consultation failed initially because no PR existed. Had to create a draft PR first. Even then, Gemini had intermittent failures finding the PR.
- Builder worktree limitations: Cannot run Playwright E2E tests (no tower instance)

### What Would Be Done Differently
- Create the draft PR earlier (before implementation consultations) to avoid the "No PR found" issue

## Technical Debt
- `.app-header` CSS still has `justify-content: space-between` which is harmless with a single child element. Not worth a separate change.
- `API_URL` constant in `dashboard-bugs.test.ts` is unused (pre-existing, not introduced by this spec)

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini (APPROVE)
- **Concern**: `dashboard-bugs.test.ts` references legacy UI elements that don't exist in current codebase
  - **Addressed**: Added audit step to plan, removed legacy tests in Phase 2

#### Codex (COMMENT)
- **Concern**: Missing explicit formatting/overflow expectations
  - **Addressed**: Added lowercase "dashboard", header height stays 40px, explicit CSS cleanup to spec

#### Claude (APPROVE)
- **Concern**: `index.html` has `<title>Agent Farm Dashboard</title>` that flashes before hydration
  - **Addressed**: Added `index.html` title update to plan Phase 1
- **Concern**: Empty string edge case for `workspaceName`
  - **Addressed**: Added falsy fallback rule to spec

### Plan Phase (Round 1)

#### Gemini (REQUEST_CHANGES)
- **Concern**: `dashboard-bugs.test.ts` legacy tests will fail on rebuild
  - **Addressed**: Added audit/cleanup step to Phase 2

#### Codex (REQUEST_CHANGES)
- **Concern**: Missing explicit Playwright execution step and layout regression check
  - **Addressed**: Added both to plan

#### Claude (COMMENT)
- **Concern**: `index.html` title not addressed
  - **Addressed**: Added to Phase 1

### Implementation: chrome_cleanup (Round 1)

#### Gemini (APPROVE)
- No concerns

#### Codex (APPROVE)
- No concerns

#### Claude (APPROVE)
- No concerns

### Implementation: test_updates (Round 1)

#### Gemini (APPROVE)
- No concerns

#### Codex (REQUEST_CHANGES)
- **Concern**: Missing required Playwright E2E run evidence
  - **Rebutted**: Playwright requires running tower instance; not available in builder worktree. Must be verified by architect before merge.

#### Claude (APPROVE)
- Noted same Playwright concern as non-blocking

## Architecture Updates

No architecture updates needed. This was a cosmetic UI cleanup — no new subsystems, data flows, or architectural changes.

## Lessons Learned Updates

No lessons learned updates needed. Straightforward implementation with no novel insights beyond existing entries.

## Follow-up Items
- Architect should run Playwright E2E tests (`npx playwright test tower-integration dashboard-bugs`) before merge to verify the test changes work against a live tower
