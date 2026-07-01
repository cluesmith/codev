# Rebuttal — PIR #1118 review iteration 1

**claude**: APPROVE — no action needed.

**codex**: REQUEST_CHANGES — two findings, **both accepted and fixed** (commit `d9828577`).
No disagreement; codex was correct on both.

---

## Finding 1 — `clearRuntime()` wiped every workspace's builders (real regression)

> `state.ts:431-440` — `clearRuntime()` now deletes **all** `builders` rows from the shared
> `global.db`, not just the current workspace's. After #1118, stopping one workspace would wipe
> builder state for other workspaces too.

**Accepted — this was a real bug I missed.** Pre-#1118, `getDb()` returned the per-workspace
`state.db`, so an unscoped `DELETE FROM builders` only affected that workspace's file. After the
consolidation `getDb()` returns the shared `global.db`, so `afx workspace stop` (which calls
`clearRuntime()`) deleted **every** workspace's builders.

**Fix:**
- `clearRuntime(workspacePath: string)` now scopes the delete: `DELETE FROM builders WHERE
  workspace_path = ?`. Signature changed to require the workspace.
- `commands/stop.ts` passes `workspacePath` (in scope from `config.workspaceRoot`) at both call
  sites.
- `utils`/`annotations` (global, UUID-keyed, no `workspace_path`, and vestigial — no producers)
  are intentionally **no longer** deleted by `clearRuntime`, to avoid the same cross-workspace
  wipe. The full-nuke `clearState()` (no production callers) still clears them.

**Regression test** (`state.test.ts`): builders in workspaces A and B coexist in the shared DB;
`clearRuntime('/workspace/aaa')` removes only A's builder, B's survives.

## Finding 2 — `afx db consolidate` repeat-run not idempotent

> `db.ts:176-180` / `consolidate.ts:394-397` — re-running on the original path hard-fails once the
> source has been renamed, and re-running on an already archived file would rename it again
> instead of being a friendly no-op.

**Accepted.** The underlying engine (`applyMigration`) already no-ops on a missing source
(`migrated:false`, covered by a test), but the **CLI command** `dbConsolidate` called
`fatal(...)` on a missing path and had no guard against re-processing a `*.pre-merge-*` archive —
so the documented "friendly no-op on re-run" was true for the engine but not the command.

**Fix** (`commands/db.ts`):
- Missing source → friendly `logger.info("Nothing to consolidate … (already migrated?)")` and
  `return` (exit 0), instead of `fatal`.
- Source path matching `*.pre-merge-*` → skip with a message (don't re-migrate + double-rename).
- Both guards return **before** opening `global.db`.

**Regression tests** (`db.test.ts`): `dbConsolidate` on a missing path and on an already-archived
`*.pre-merge-*` file each complete without throwing / hard-failing.

---

**Verification after fixes**: `pnpm build` ✓, full agent-farm suite ✓ (2017 passed, +3 new tests),
typecheck clean.

**Note**: PIR's verify is a single advisory pass (`max_iterations: 1`) — these fixes are not
re-consulted; they're surfaced to the human at the `pr` gate (and recorded in the PR body /
review file). Both findings are non-security correctness/UX fixes with regression coverage.
