# pir-967 thread — CI: run vscode + dashboard vitest unit suites

## Plan phase (2026-06-04)

Investigated `.github/workflows/test.yml` + the two uncovered suites.

Key findings (all from running locally on a clean tree):
- **dashboard** (`@cluesmith/codev-dashboard`, `pnpm test` = `vitest run`): 317 passed / 1 skipped, exit 0. Clean.
- **vscode** (`codev-vscode`, `pnpm test:unit` = `vitest run`): needs `@cluesmith/codev-types` BUILT first.
  Clean tree (no types/dist) → 2 failures (terminal-adapter, reconnect-link-provider) with
  "Failed to resolve entry for @cluesmith/codev-types". After `pnpm --filter @cluesmith/codev-types build` → 284/284.
  Cause: types export map resolves `default` → ./dist/index.js for vscode's node-env vitest.
  (dashboard resolves types from src via Vite, so doesn't strictly need the build.)
- **The issue's flagged failing test** (`scrollController ... warns on unexpected scroll-to-top`) NO LONGER EXISTS —
  replaced by `accepts scroll-to-top without auto-correcting or warning (Issue #630)`. scrollController passes 45/45.
  No quarantine/fix needed.
- Neither suite needs codev's forks-pool tee/grep teardown shim — both exit 0.

Plan decisions: fold both into the existing `unit` job (suites are <2s; reuse install+core build;
add one types-build step). No coverage thresholds (match core's no-threshold precedent). Plain `vitest run`.

Plan written, committed, awaiting plan-approval gate.

## Implement phase (2026-06-05)

Rebased onto origin/main first (18 commits; none touched the workflows or relevant packages). Plan re-verified accurate.

Edited `.github/workflows/test.yml` `unit` job only:
- Added "Build types package" step (pnpm build in packages/types) after the core build — required by vscode suite.
- Added "Run dashboard unit tests" (packages/dashboard, `pnpm test`) and "Run vscode unit tests" (packages/vscode, `pnpm test:unit`) after the codev coverage step.

Verified locally (reproducing the CI steps): core+types build, dashboard 317 passed/1 skipped exit 0, vscode 284 passed exit 0. YAML validated. No source/test changes.

Committed + pushed. Awaiting dev-approval gate.
