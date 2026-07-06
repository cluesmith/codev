# PIR Plan: Preserve spawnedByArchitect across `afx workspace recover`

## Understanding

`afx workspace recover --apply` respawns dead builders by shelling out to `afx spawn <issue> --resume --protocol <p>`. The child process inherits the recovery shell's environment, so `spawn.ts`'s module-scope constant (`packages/codev/src/agent-farm/commands/spawn.ts:37-38`) resolves `CODEV_ARCHITECT_NAME` from whatever terminal the operator happened to run recovery in, and writes that into the respawned builder's `spawned_by_architect` column. Every recovered builder is therefore reattributed to the recovery shell's architect (typically `main`), breaking:

- `afx send architect` affinity routing from the builder
- the anti-spoofing check for `architect:<name>` addressing (`tower-messages.ts:213-218`)
- dashboard / VS Code Agents-view attribution
- sibling architects' per-team builder lists

Root cause confirmed in the code:

- `BuilderInfo` (`packages/codev/src/agent-farm/commands/workspace-recover.ts:130-134`) carries only `{ builderId, issueArg, cliProtocol }`.
- `deriveBuilderInfo` (`workspace-recover.ts:144-161`) builds it purely from porch `ProjectState`; the builder's `global.db` row is never consulted.
- `respawnBuilder` (`workspace-recover.ts:247-263`) spawns the child with `{ stdio: 'inherit' }` and no `env` override, so `CODEV_ARCHITECT_NAME` leaks through from the operator's shell.

Key discovery: the exact DB read we need already exists and is already unit-tested. `lookupBuilderSpawningArchitect(builderId, workspacePath)` in `packages/codev/src/agent-farm/state.ts:537-554` returns the recorded `spawned_by_architect` (`string`), `null` for legacy rows, or `undefined` when no row exists. It is the same helper the Phase 3 affinity resolver uses, so recover and message-routing stay on one source of truth. No new SQL is needed.

## Proposed Change

Three surgical edits to `workspace-recover.ts`, all consistent with the issue's fix sketch:

1. **Extend `BuilderInfo`** with a required `spawnedByArchitect: string | null` field. `deriveBuilderInfo` stays pure and always sets it to `null` (it has no DB access by design; `resolveWorktreePath` also calls it and does not care about attribution).

2. **Add a small injectable wrapper** that enriches the derived info with the DB value:

   ```ts
   export function deriveBuilderInfoWithArchitect(
     state: ProjectState,
     lookupArchitect: (builderId: string) => string | null | undefined,
   ): BuilderInfo | null {
     const base = deriveBuilderInfo(state);
     if (base === null) return null;
     return { ...base, spawnedByArchitect: lookupArchitect(base.builderId) ?? null };
   }
   ```

   `workspaceRecover` calls it with `(id) => lookupBuilderSpawningArchitect(id, config.workspaceRoot)`. The `?? null` collapses `undefined` (no DB row) into the same legacy fallback as a NULL column value. The lookup-as-parameter shape keeps the function unit-testable without a real global.db, matching the existing dependency-injection style of `evaluateEligibility` (`isProcessAlive` / `socketExists` are injected the same way).

   DB lifecycle note: `workspaceRecover` currently closes the global DB in a `finally` immediately after reading terminal sessions (`workspace-recover.ts:286-291`). The row-building loop that calls `deriveBuilderInfo` runs after that close; `getDb()` would lazily reopen the connection and leave it open across the child `afx spawn` processes. To keep the existing close-before-respawn discipline, the `try` block will be widened so both the sessions read and the `allRows` construction (which now performs the per-builder lookups) happen before `closeGlobalDb()` runs in `finally`.

3. **`respawnBuilder` sets the child env explicitly.** A new exported pure helper keeps it testable:

   ```ts
   export function respawnEnv(
     spawnedByArchitect: string | null,
     baseEnv: NodeJS.ProcessEnv,
   ): NodeJS.ProcessEnv {
     if (spawnedByArchitect === null) {
       return baseEnv;
     }
     return { ...baseEnv, CODEV_ARCHITECT_NAME: spawnedByArchitect };
   }
   ```

   `respawnBuilder` passes `env: respawnEnv(info.spawnedByArchitect, process.env)` to `child_process.spawn`. When the DB has a recorded architect, the child sees exactly that name. When the value is `null` (legacy / pre-Spec-755 rows), the caller's env passes through untouched, which reproduces today's behavior for those rows (they get the recovery shell's architect, and `spawn.ts` still falls back to `main` when the variable is absent or blank). This matches the issue's fallback chain without hardcoding a second copy of the `main` default in recover.

No changes to `afx spawn`, the DB schema, or recovery eligibility semantics. This is package source code, not framework docs, so there is no `codev-skeleton/` mirror to update.

## Files to Change

- `packages/codev/src/agent-farm/commands/workspace-recover.ts`
  - `:130-134` — add `spawnedByArchitect: string | null` to `BuilderInfo`
  - `:144-161` — `deriveBuilderInfo` returns `spawnedByArchitect: null` in both branches; new exported `deriveBuilderInfoWithArchitect(state, lookupArchitect)` wrapper directly below it
  - `:247-263` — new exported `respawnEnv` helper; `respawnBuilder` passes `env: respawnEnv(info.spawnedByArchitect, process.env)`
  - `:286-316` — widen the `try`/`finally` so the `allRows` construction (now using `deriveBuilderInfoWithArchitect` with a `lookupBuilderSpawningArchitect` closure) happens before `closeGlobalDb()`
  - import `lookupBuilderSpawningArchitect` from `../state.js`
- `packages/codev/src/agent-farm/__tests__/workspace-recover.test.ts`
  - update `makeBuilderInfo` and the `deriveBuilderInfo` expectations for the new field (`spawnedByArchitect: null`)
  - new `describe('deriveBuilderInfoWithArchitect')`: recorded name is carried through; `null` row stays `null`; `undefined` (no row) normalizes to `null`; unsupported protocol still returns `null` without invoking the lookup
  - new `describe('respawnEnv')`: recorded name overrides an inherited `CODEV_ARCHITECT_NAME`; recorded name is set even when the base env lacks the variable; `null` returns the base env unchanged (inherited value preserved, and no key invented when absent)

## Risks & Alternatives Considered

- **Risk**: reading `builders` rows for every project adds DB queries to recover. Mitigation: one indexed point-read per revivable project; `workspace recover` is a cold, operator-invoked path. The issue explicitly blesses this cost.
- **Risk**: widening the `try`/`finally` around `allRows` changes when `closeGlobalDb()` runs. Mitigation: the block still closes before any confirmation prompt or respawn, preserving the original intent (no open handle across child processes); all reads simply move inside it.
- **Alternative**: have `deriveBuilderInfo` itself query the DB. Rejected: it would break the function's purity, force DB setup into the existing unit tests, and couple `resolveWorktreePath` (which reuses it) to DB state it does not need.
- **Alternative**: pass `--architect <name>` as a new `afx spawn` flag instead of env. Rejected: out of scope per the issue ("no change to afx spawn"), and `CODEV_ARCHITECT_NAME` is already the established contract between Tower, spawn, and architect terminals.
- **Alternative**: hardcode `'main'` as the final fallback in `respawnEnv`. Rejected: `spawn.ts` already owns that default via `DEFAULT_ARCHITECT_NAME`; duplicating it in recover creates a second place to keep in sync. Passing the base env through gives identical behavior.

## Test Plan

- **Unit** (`pnpm --filter @cluesmith/codev test -- workspace-recover`, run from the worktree):
  - `deriveBuilderInfo` existing cases updated for the new field
  - `deriveBuilderInfoWithArchitect` covers string / null / undefined lookups and the multi-architect scenario (two builders with different recorded architects each keep their own)
  - `respawnEnv` covers override, set-when-absent, and null-passthrough cases
- **Manual** (reviewer, at the dev-approval gate):
  1. In a workspace with a sibling architect (e.g. `main` plus `vscode`), confirm `global.db` has a builder row with `spawned_by_architect = 'vscode'`: `sqlite3 ~/.agent-farm/global.db "SELECT id, spawned_by_architect FROM builders WHERE workspace_path = '<ws>'"`.
  2. Kill that builder's shellper (or reboot), then run `afx workspace recover --apply` from main's terminal.
  3. Re-run the same query: the respawned builder must still show `spawned_by_architect = 'vscode'`, not `main`.
  4. From the respawned builder pane, `afx send architect "ping"` should land on the vscode architect, and the VS Code Agents view should attribute the builder to vscode.
- **Regression**: full `pnpm --filter @cluesmith/codev test` plus `pnpm build` from the worktree.
