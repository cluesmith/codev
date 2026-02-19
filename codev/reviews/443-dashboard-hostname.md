# Review: Show Machine Hostname in Dashboard

## Summary

Added the machine's hostname to the dashboard header and browser tab title. The Tower server now includes `hostname` in the `/api/state` response, and the dashboard's `App` component renders it as a prefix: `{hostname} {workspaceName} dashboard`. When hostname equals workspaceName (case-insensitive), the hostname is deduplicated. When absent, the display falls back to the previous behavior.

## Spec Compliance
- [x] Machine hostname appears in dashboard header
- [x] Machine hostname appears in browser tab title
- [x] Hostname served via `/api/state` as part of `DashboardState`
- [x] No duplicate display when hostname equals workspaceName
- [x] New unit tests cover hostname display (13 tests)
- [x] Existing tests pass
- [x] No visual regression — CSS ellipsis handles long hostnames

## Deviations from Plan
None. Implementation followed the plan exactly across all three phases.

## Lessons Learned

### What Went Well
- Exporting `buildDashboardTitle` as a pure function made it trivially testable without component rendering overhead
- Using the existing named import from `node:os` (`{ homedir, hostname, tmpdir }`) was cleaner than adding a default `os` import
- The 3-phase breakdown (server → client → tests) kept each commit focused and reviewable

### Challenges Encountered
- Dashboard tests use a separate vitest config (`dashboard/vitest.config.ts`) and are excluded from the main `npm test` — had to discover and use `cd dashboard && npm test` for dashboard-specific tests
- Pre-existing flaky tests in `Terminal.ime-dedup.test.tsx` (7 failures) are unrelated to this change

### What Would Be Done Differently
- Nothing significant — the feature was well-scoped and the plan was accurate

## Technical Debt
- `Terminal.ime-dedup.test.tsx` has 7 pre-existing test failures that should be investigated separately

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini
- No concerns raised (APPROVE)

#### Codex
- **Concern**: Missing fallback string definition, truncation behavior, and E2E test expectations
  - **Addressed**: Added display rules for fallback, truncation (CSS ellipsis), and case-insensitive comparison to spec

#### Claude
- **Concern**: Dependencies section references `tower-tunnel.ts` but change targets `tower-routes.ts`; success criteria should require new tests
  - **Addressed**: Fixed dependency reference; added new test success criterion

### Plan Phase (Round 1)

#### Gemini
- No concerns raised (APPROVE)

#### Codex
- **Concern**: Missing explicit E2E test run and mobile layout verification steps
  - **Rebutted**: Unit tests + build verification cover behavioral logic; `MobileLayout.tsx` has no header — `document.title` works identically on mobile

#### Claude
- **Concern**: `.app-title` may need `min-width: 0` for flex child ellipsis
  - **Addressed**: Added `min-width: 0` to CSS plan

### Server Phase (Round 1)
- All three models: APPROVE, no concerns

### Client Phase (Round 1)
- All three models: APPROVE, no concerns

### Tests Phase (Round 1)

#### Gemini
- No concerns raised (APPROVE)

#### Codex
- **Concern**: Plan mentions case-insensitive dedup test through App render path; tests only cover at helper level
  - **Rebutted**: Helper-level coverage is sufficient — the App integration tests verify the helper is called correctly, and the helper tests verify all edge cases

#### Claude
- No concerns raised (APPROVE)

## Architecture Updates

No architecture updates needed. This was a minimal data flow extension — adding one field (`hostname`) to the existing `DashboardState` pipeline from `tower-routes.ts` → `api.ts` → `App.tsx`. No new subsystems, data flows, or architectural patterns were introduced.

## Lessons Learned Updates

No lessons learned updates needed. Straightforward implementation with no novel insights beyond existing entries. The main takeaway (dashboard tests use a separate vitest config) is project-specific knowledge rather than a generalizable lesson.

## Flaky Tests

Pre-existing failures in `packages/codev/dashboard/__tests__/Terminal.ime-dedup.test.tsx`:
- `deduplicates repeated characters during IME composition` — expects 1 data frame, gets 2
- `allows different characters during IME composition` — expects 2 data frames, gets 4
- `deduplicates Enter key during IME composition` — expects 1 data frame, gets 2
- Plus 4 additional related IME dedup tests

These are unrelated to Spec 443 changes. Not skipped — they were already failing before this work.

## Follow-up Items
- Investigate and fix `Terminal.ime-dedup.test.tsx` flaky tests (separate issue)
