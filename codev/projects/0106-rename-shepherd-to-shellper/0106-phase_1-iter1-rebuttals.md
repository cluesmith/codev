# Phase 1 Iteration 1 Rebuttals

## Disputed: Codex — "Phase-1 implementation evidence is missing in submitted scope"

**False positive.** Codex's review tool only examined the `git diff --name-only main` output which showed spec/plan/rebuttal files as the committed diff. The actual implementation (file renames, content updates, schema changes, migration v8) exists as unstaged changes in the worktree — standard for SPIR builders that don't commit until porch advances them. Codex's own `rg` command confirmed the implementation was present: all 5 shellper source files exist, and shepherd references are limited to old migration code in `db/index.ts`.

## Addressed: Claude — "buildArchitectArgs removed from tower-utils.ts"

**Legitimate finding, but not caused by this rename.** The `buildArchitectArgs` removal was a merge artifact from the 0105 decomposition merge (`1c52cd0 Merge branch 'main' into builder/0106-rename-shepherd-to-shellper`). The previous session's merge resolution incorrectly dropped this function. Fixed by restoring `tower-utils.ts`, `tower-terminals.ts`, and `tower-instances.ts` from main and re-applying only the shepherd→shellper renames.

## Addressed: Claude — "Terminal.tsx IME deduplication rewrite + VirtualKeyboard reorder"

**Legitimate finding, but not caused by this rename.** Same merge artifact as above — the previous session's merge resolution picked up an in-progress Terminal.tsx refactor. Fixed by restoring `Terminal.tsx` from main and re-applying only the shepherd→shellper comment renames.
