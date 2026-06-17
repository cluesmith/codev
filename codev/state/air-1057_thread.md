# air-1057 — afx status: surface architect↔builder ownership

**Protocol**: AIR (strict). Issue #1057. Builder worktree `.builders/air-1057`.

## Goal
Surface `spawned_by_architect` (Spec 755 data already in `state.db.builders`) through `afx status`:
1. `owner` column on builder rows + sort by owner.
2. `afx status --json` — machine-readable, includes `spawnedByArchitect`.
3. `afx status --architect <name>` and `--mine` filters (`--mine` resolves current architect from `CODEV_ARCHITECT_NAME`).

## Investigation findings
- `afx status` lives in `packages/codev/src/agent-farm/commands/status.ts`; registered in `cli.ts` (~line 213).
- Builder ownership is in `state.db.builders.spawned_by_architect`, mapped to `Builder.spawnedByArchitect` via `dbBuilderToBuilder` and loaded by `loadState(workspacePath).builders`.
- Current status display has TWO paths: Tower-running (uses Tower API terminals, builders shown only as generic `Terminals:` rows) and Tower-down (renders a builders table from `loadState`). Neither shows owner.
- Current architect identity = `process.env.CODEV_ARCHITECT_NAME` (injected by Tower into architect terminals; spawn.ts already reads it; default `main`).
- Existing tests: `status-naming.test.ts` (legacy builder table order [spir-109, bugfix-42] + Spec 786 architect enumeration). Must not break.

## Design decisions
- Source builders for owner display from `state.db` (`loadState`) in BOTH paths — it's the canonical owner source. Hoist `loadState` to top, guard `state?.builders ?? []` (tower-running tests leave loadState mock undefined).
- Sort builders by owner with a STABLE comparator (unknown owner last); within an owner, preserve `started_at` order — keeps the legacy test's [spir-109, bugfix-42] order (both unknown → comparator 0 → stable).
- Add Owner as the 2nd column (ID stays first) so `status-naming.test.ts` assertions (col[0]=ID, width[0]=20) still hold.
- Tower-running path: render owner-aware Builders section from state.db; exclude builders from the generic `Terminals:` list (they get their own section).
- `--mine` resolves via new pure helper `currentArchitectName(env?)` in `utils/architect-name.ts`.
- JSON mode returns BEFORE any human chrome (single `console.log` of the payload).
- Scope: extend `afx status` only (issue offers `afx builders --mine` as an alternative, not a requirement). Keeps LOC tight.

## Status
- [x] Implement helper (`currentArchitectName`) + status.ts (owner column, sort, filters, JSON) + cli.ts options
- [x] Tests — `spec-1057-status-owner.test.ts` (17 pass incl. existing status-naming)
- [x] Worktree needed `pnpm install` (no node_modules on spawn); installed.
- [x] Build (`pnpm build`) clean; full agent-farm suite 1973 pass / 13 pre-existing skips.
- [x] E2E smoke: seeded a temp state.db, ran the BUILT `afx status --json/--architect/--mine` — owner sort, running flags, and both filters confirmed working end-to-end.
- [x] PR #1058 created (review embedded in body). porch PR-phase checks pass (pr_exists ✓, e2e_tests ✓).
- [x] Reached `pr` gate → STOPPED for human approval. Architect notified.

## Final state
PR: https://github.com/cluesmith/codev/pull/1058 — implements #1057.
Awaiting human approval at the `pr` gate (`porch approve 1057 pr`). Will not self-approve.

## Architect review follow-up (2026-06-16) — Codex 'merge it' + 2 nits folded in
1. JSON contract: `emitStatusJson()` now normalizes `workspace.name` to explicit `null`
   (was dropped as `undefined` for unregistered workspaces). Verified E2E: key present, value null.
2. Test gap: added Tower-RUNNING human-path tests (owner-aware Builders section renders from
   state.db; builders excluded from generic Terminals list; --architect honored) + a JSON
   null-name contract test. Suite now 21 pass (was 17).
Build clean; pushed to PR; re-running porch check.

## E2E note
`afx status` (human) only reaches the builder table when Tower is down OR the workspace is Tower-registered. Tower-running + unregistered-workspace early-returns at "not active in tower" (pre-existing). The real multi-architect case (Shannon) is registered, so the table renders there. `--json` is independent of registration — validated end-to-end.

## Implementation notes
- New file: `__tests__/spec-1057-status-owner.test.ts`.
- Touched: `commands/status.ts`, `cli.ts`, `utils/architect-name.ts`.
- Net diff well under 300 LOC. No new deps, no schema changes (data already in state.db).
- `currentArchitectName` is pure + injectable env for testability.
