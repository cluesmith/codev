# Phase 4 — iter-1 CMAP Rebuttal

**Date**: 2026-05-22
**Reviewers**: Gemini (REQUEST_CHANGES), Codex (REQUEST_CHANGES), Claude (APPROVE)

---

## Summary

Two reviewers REQUEST_CHANGES, both addressed. Codex caught a real gap: the initial commit only emitted from `handleAddArchitect`/`handleRemoveArchitect` but missed two other remove paths added by #786 (dashboard close-button at `tower-routes.ts:1486-1499` and mobile TabBar close at `:2140-2157`). Gemini and Codex both wanted runtime behavior tests on the VSCode side (not just source-text grep). Both addressed.

---

## Gemini (REQUEST_CHANGES) — addressed (with a note on the plan's harness misdirection)

### G-P4.1-1. VSCode test harness

**Finding**: The plan iter-1 said "VSCode-side unit test in `packages/vscode/src/test/` (vscode-test harness per `packages/vscode/package.json` — NOT vitest, plan iter-1 Codex correction)." Initial commit instead used source-text grep in `src/__tests__/workspace.test.ts` (vitest).

**Verification of the plan's claim**: I re-verified the plan's "NOT vitest" guidance against the codebase. It is **inaccurate**:

- `packages/vscode/package.json` declares **two** test scripts: `"test": "vscode-test"` (Electron integration) AND `"test:unit": "vitest run"` (unit, added in #786 Phase 6).
- `packages/vscode/vitest.config.ts` explicitly says: *"Spec 786 Phase 6: vitest config for unit-level tests of VSCode extension code. The existing `src/test/` suite uses `vscode-test` (an Electron harness) for integration tests; this config covers pure-logic units that mock the `vscode` module entirely."*
- The existing #786 Phase 6 tests in `src/__tests__/` (`workspace.test.ts`, `terminal-manager.test.ts`) use **vitest with source-text grep**, with explicit docstrings explaining why ("instantiating `WorkspaceProvider` requires a `ConnectionManager`, `TerminalManager`, and `vscode.EventEmitter`. Rather than mock all of vscode for sentinel checks, this file verifies the tree-shape invariants at the source level").

The plan iter-1 Codex correction was over-specific — it said "NOT vitest" but `src/__tests__/` IS vitest. The right pattern is "vitest at `src/__tests__/` for unit-level tests, mocking `vscode` when behavior tests need it; vscode-test at `src/test/` for Electron integration." My initial Phase 4 commit followed the source-grep variant established in Phase 6.

**Resolution**: That said, both Gemini and Codex are right that source-grep doesn't catch all runtime regressions. Added a new file `packages/vscode/src/__tests__/workspace-sse-subscriber.test.ts` that uses `vi.mock('vscode', ...)` (the pattern vitest.config.ts intended) to:
- Set up a fake `EventEmitter` implementation with `event()` listener registration and `fire()` spy.
- Mock the heavy deps (`workspace-detector`, `dev-shared`, `load-worktree-config`, `codev-core/workspace`) so `WorkspaceProvider` constructs cleanly.
- Mock `ConnectionManager` so we can capture the `onSSEEvent` callback and deliver synthetic envelopes.
- Instantiate `WorkspaceProvider` and assert that `changeEmitter.fire` is called on matching events and not on others.

9 new behavior tests exercise the full subscriber matrix (see commit message). The existing source-grep tests in `workspace.test.ts` are kept as cheap structural guards.

**Where**: New file `packages/vscode/src/__tests__/workspace-sse-subscriber.test.ts`.

---

## Codex (REQUEST_CHANGES) — both findings addressed

### C-P4.1-1. Other remove paths weren't emitting

**Finding**: `tower-routes.ts:1487-1497` (`handleWorkspaceRoutes` DELETE `/api/architects/:name` — dashboard close-button + confirmation modal) and `tower-routes.ts:2147-2157` (`handleWorkspaceTabDelete` DELETE `/api/tabs/architect:<name>` — mobile TabBar close) both invoke `removeArchitect()` but do NOT emit `architects-updated`. Phase 4's contract was to emit on **all** architect mutation paths.

**Verification**: Confirmed by grepping `removeArchitect(` in `tower-routes.ts`:
- `handleRemoveArchitect` (`:390`) — emits ✓
- `handleWorkspaceRoutes` (`:1489`) — did NOT emit ✗
- `handleWorkspaceTabDelete` (`:2148`) — did NOT emit ✗

Without the emit, a user with VSCode open who clicks the close-button on a sibling architect tab (or closes it from mobile) would see the dashboard update (it polls) but the VSCode tree would stay stale until the next manual refresh.

**Resolution**: Added the same `ctx.broadcastNotification({ type: 'architects-updated', ... })` emit pattern to both sites. Both already had `ctx: RouteContext` in scope (no signature refactor needed). Emit only on success; failed removes do NOT emit.

**Where**: `tower-routes.ts:1490-1497` (handleWorkspaceRoutes) and `tower-routes.ts:2147-2156` (handleWorkspaceTabDelete).

### C-P4.1-2. VSCode test runtime coverage

**Finding**: Same as G-P4.1-1 (Codex framed it differently): the source-text test "would pass even if runtime wiring broke while the strings stayed in the file."

**Resolution**: Same as G-P4.1-1 — added the runtime behavior test file.

**Where**: `packages/vscode/src/__tests__/workspace-sse-subscriber.test.ts`.

---

## Claude (APPROVE) — no findings

All plan acceptance criteria pass; the implementation matches Option B precisely; SSE event shape correct; subscriber extension correct; verify-scenarios artifact updated. No issues.

---

## Net Phase 4 change summary (iter-1)

- **2 new emit sites** in `tower-routes.ts` (handleWorkspaceRoutes + handleWorkspaceTabDelete).
- **1 new runtime behavior test file** at `packages/vscode/src/__tests__/workspace-sse-subscriber.test.ts` (9 tests).
- **No source-grep tests removed** — kept as cheap structural guards alongside the new behavior tests (defence in depth).
- **No findings rejected.** The plan iter-1 "NOT vitest" guidance was noted as inaccurate against the actual codebase; the new behavior tests use the vitest harness as `vitest.config.ts` intended.

## Test count after corrections

- Tower-side `tower-routes.test.ts`: 76 tests pass (5 new Spec 823 tests).
- VSCode-side `workspace.test.ts`: 11 tests pass (4 new Spec 823 source-grep tests).
- VSCode-side `workspace-sse-subscriber.test.ts`: 9 tests pass (9 new Spec 823 runtime behavior tests).
- Total new Spec 823 Phase 4 tests: **18** (5 Tower-side + 4 source-grep + 9 runtime behavior).

## Iter-2 readiness

Phase 4 is ready for iter-2 CMAP. All three iter-1 findings addressed; Claude was already APPROVE. Iter-2 should converge to APPROVE across all three.
