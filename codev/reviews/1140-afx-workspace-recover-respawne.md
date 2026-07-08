# PIR Review: Preserve spawnedByArchitect across `afx workspace recover`

Fixes #1140

## Summary

`afx workspace recover --apply` respawned builders by shelling out to `afx spawn` with an inherited environment, so every recovered builder's `spawned_by_architect` was regenerated from the recovery shell's `CODEV_ARCHITECT_NAME` (typically `main`) instead of being read from its `global.db` row. This PR makes recovery read each builder's recorded architect via the existing `lookupBuilderSpawningArchitect` helper (the same one the anti-spoofing check uses) and force it into the child process env, so sibling-architect workspaces keep per-builder attribution across recovery. Legacy rows with no recorded architect fall back to the caller's env, reproducing the pre-fix behavior for those rows only.

## Files Changed

- `packages/codev/src/agent-farm/commands/workspace-recover.ts` (+113 / −30)
- `packages/codev/src/agent-farm/__tests__/workspace-recover.test.ts` (+108 / −1)
- `codev/plans/1140-afx-workspace-recover-respawne.md` (+93 / −0)
- `codev/reviews/1140-afx-workspace-recover-respawne.md` (this file)
- `codev/resources/lessons-learned.md` (+1 line, cold tier)
- `codev/state/pir-1140_thread.md` (builder thread log)
- `codev/projects/1140-afx-workspace-recover-respawne/status.yaml` (porch-managed)

## Commits

- `031bca87` [PIR #1140] Plan draft
- `8077b7b0` [PIR #1140] Preserve spawnedByArchitect when workspace recover respawns builders
- `75ee3383` [PIR #1140] Thread: implement phase notes
- `chore(porch)` commits are porch-managed state transitions.

## Test Results

- `pnpm --filter @cluesmith/codev build`: ✓ pass
- `pnpm test` (full package suite): ✓ 3443 passed, 48 pre-existing skips, 0 failures
- `workspace-recover.test.ts`: 57/57 pass (11 new: 6 for `deriveBuilderInfoWithArchitect`, 5 for `respawnEnv`)
- Manual verification: human reviewed the worktree at the `dev-approval` gate (approved 2026-07-08); the multi-architect respawn path is additionally pinned by the "preserves distinct attribution across builders in the same workspace" unit test.

## Architecture Updates

No arch changes needed. The fix does not move any module boundary or introduce new state; it aligns `workspace-recover.ts` with the already-documented design (attribution lives solely in `global.db`, per the Issue #1118 hot-tier fact) by reusing the existing `lookupBuilderSpawningArchitect` read path instead of adding a second source of truth.

## Lessons Learned Updates

One COLD-tier lesson added to `codev/resources/lessons-learned.md` (Architecture section): when a process derives identity from an inherited environment variable, every programmatic respawn/recovery path must explicitly set that variable from recorded state rather than inheriting it, otherwise the respawned process's identity silently becomes a function of who ran the recovery. Not HOT-tier: it is a recipe for a specific bug class, not a behavior-changing cross-cutting rule, and the hot file is at cap.

## Things to Look At During PR Review

- **The null-fallback policy in `respawnEnv`**: legacy rows (no recorded architect) return the base env untouched rather than hardcoding `'main'`. This keeps `spawn.ts`'s `DEFAULT_ARCHITECT_NAME` as the single owner of the default. Confirm you agree that legacy-row recoveries attaching to the recovery shell's architect (today's behavior) is the right degradation.
- **The `try`/`finally` restructure in `workspaceRecover`**: the `allRows` construction moved inside the existing DB block so the per-builder architect lookups complete before `closeGlobalDb()`. Behavior is otherwise unchanged, but it is the largest visual diff hunk; verify the connection still closes before any child `afx spawn` launches (it does: the confirm prompt and respawn loop remain outside the block).
- **The three-valued lookup collapse**: `lookupBuilderSpawningArchitect` distinguishes `null` (legacy row) from `undefined` (no row); recovery collapses both to `null` since they demand the same fallback. The distinction remains load-bearing in the message-routing spoofing check and is untouched.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1140 → **View Diff**
- **What to verify** (mapped to the plan's Test Plan):
  1. In a workspace with a sibling architect, confirm a builder row with a non-`main` architect: `sqlite3 ~/.agent-farm/global.db "SELECT id, spawned_by_architect FROM builders WHERE workspace_path = '<ws>'"`
  2. Kill that builder's shellper (or reboot), run `afx workspace recover --apply` from main's terminal
  3. Re-run the query: the respawned builder retains its original `spawned_by_architect`
  4. From the respawned builder, `afx send architect "ping"` routes to the original architect; the VS Code Agents view shows the correct owner
