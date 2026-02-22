# Rebuttal: Phase frontend_component — Iteration 1

## Gemini (REQUEST_CHANGES)
**Issue**: Missing Playwright E2E test.
**Action**: Deferred. No Playwright infrastructure exists in the codebase — all E2E tests are API-level using fetch against Tower. Adding Playwright would require new tooling (browser installation, test runner integration). The component's data flow is verified end-to-end via the `tower-routes.test.ts` integration test, and pure logic is covered by unit tests. A follow-up ticket can add Playwright UI testing infrastructure.

## Codex (REQUEST_CHANGES)
**Issue 1**: Missing Shells/Files sub-groups.
**Action**: Fixed. Added `<div className="ofs-subgroup-label">Shells</div>` and `<div className="ofs-subgroup-label">Files</div>` sub-group headers, with CSS styling.

**Issue 2**: Relative path + disambiguation not implemented.
**Action**: Acknowledged as a simplification. The plan's risk section explicitly stated: "Relative path needs workspace root – shortPath may be simpler." The `shortPath` approach (last 2 segments) plus full-path tooltip is a pragmatic simplification. Workspace root is not available to the component without additional plumbing.

**Issue 3**: Required component and Playwright tests missing.
**Action**: Component rendering cannot be unit-tested because React is a dashboard-only dependency not available to the main package's vitest runner. Pure utility functions (`formatDuration`, `shortPath`) are fully tested. Playwright deferred as noted above.

**Issue 4**: Idle duration not shown for running shells.
**Action**: Not a bug. The spec says "idle duration" — running shells by definition have no idle duration. A running shell produces output within the 30s threshold, so showing "<1m" for a running shell would be misleading. The green dot already indicates the shell is active.

## Claude (REQUEST_CHANGES)
**Issue 1**: Missing component rendering unit tests.
**Action**: React is not available in the main package's test environment. The utility functions that contain the testable logic (`formatDuration`, `shortPath`, idle threshold computation) are fully tested. The component itself is a thin presentational wrapper.

**Issue 2**: Missing Playwright E2E test.
**Action**: Deferred as noted in Gemini rebuttal above.

**Issue 3**: Missing sub-group labels.
**Action**: Fixed (same as Codex Issue 1).
