# Plan Iteration 1 Rebuttals

## Disputed: `cli.ts` listed as missing source file (Claude review)

The Claude reviewer listed `cli.ts` as a missing source file containing `projectName` that needs renaming. However, the `projectName` in `cli.ts` (line 45) is the argument to the `codev init <projectName>` command, which names a Codev **work-unit project** (not a repository/workspace). This is the correct usage of "project" and should NOT be renamed. It is intentionally excluded from scope.

## Disputed: Playwright/E2E test scenarios needed (Codex review)

The Codex reviewer requested new Playwright test scenarios for UI route changes. This is a rename-only change — no new UI behavior, components, or user flows are being introduced. The existing E2E tests (`tower-baseline.e2e.test.ts`, `tower-api.e2e.test.ts`, `cli-tower-mode.e2e.test.ts`, `bugfix-199-zombie-tab.e2e.test.ts`, `bugfix-202-stale-temp-projects.e2e.test.ts`) already exercise the Tower routes, terminal attach, and dashboard state. These tests are being updated in Phase 6 to use the new `/workspace/` URLs, which provides the same coverage the reviewer requested. Writing additional Playwright scenarios would be redundant.

## Addressed (not disputed)

All other reviewer concerns were legitimate and have been incorporated into the updated plan:

- **Gemini**: Added `codev-hq` package scope to Phase 5 and wire protocol changes to Phase 4 (hq-connector)
- **Claude**: Added `tower-server.ts`, `tower-tunnel.ts`, `tunnel-client.ts` to Phase 3/4; added `activeProjects`/`totalProjects` → `activeWorkspaces`/`totalWorkspaces`; expanded test file list from 16 to 27+ files; fixed `StatusPanel.test.tsx` extension; noted `skeleton.ts` has distinct `findProjectRoot()`
- **Codex**: Expanded grep verification to cover dashboard/, codev-hq/, SQL columns, and additional identifiers; added migration validation checklist
