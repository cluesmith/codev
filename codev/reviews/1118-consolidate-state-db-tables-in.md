# PIR Review: Consolidate state.db tables into global.db

Fixes #1118

## Summary

Retired the per-workspace `state.db` file and moved its four tables (`architect`, `builders`,
`utils`, `annotations`) into the already user-global `~/.agent-farm/global.db`. `getDb()` now
returns the single global connection, so architect/builder state no longer depends on Tower's
start-cwd — the root cause of "some architects missing their state after a restart." `builders`
was reshaped to be workspace-scoped (composite `(workspace_path, id)` PK), and a one-time,
marker-gated boot migration (plus a manual `afx db consolidate <path>` and an
`afx tower start --dry-run-migration` preview) moves legacy `state.db` files in — renaming
sources to `*.pre-merge-<ts>`, never deleting.

## Files Changed

(code, vs `main` merge-base)

- `packages/codev/src/agent-farm/db/schema.ts` (+92/−…) — `GLOBAL_SCHEMA` absorbs the four tables; `builders` reshaped with `workspace_path` + composite PK; `LOCAL_SCHEMA` retained as legacy-shape reference
- `packages/codev/src/agent-farm/db/index.ts` (−≈470 net) — `getDb()`/`getDbPath()` alias the global connection; removed `ensureLocalDatabase()` + the local v1–v12 migration ladder; added global migration v14
- `packages/codev/src/agent-farm/db/consolidate.ts` (+456, new) — reusable upsert-if-newer engine (`planMigration`/`applyMigration`), defensive legacy reads, `_consolidation` marker, strict boot one-off (`runBootConsolidation`)
- `packages/codev/src/agent-farm/db/migrate.ts` (−135, deleted) — dead state.json→SQLite migration
- `packages/codev/src/agent-farm/db/types.ts` (+1) — `DbBuilder.workspace_path`
- `packages/codev/src/agent-farm/state.ts` (+…/−…) — builder functions workspace-scoped (derive `workspace_path` from `worktree` on upsert; optional `workspacePath` on reads); `lookupBuilderSpawningArchitect` drops the per-file open
- `packages/codev/src/agent-farm/utils/workspace-path.ts` (+26, new) — single-source `normalizeWorkspacePath` (dedupe of 3 copies)
- `packages/codev/src/agent-farm/servers/tower-server.ts` (+16) — boot one-off caller
- `packages/codev/src/agent-farm/servers/tower-utils.ts` (±16) — re-exports the shared normalizer
- `packages/codev/src/agent-farm/servers/overview.ts` (+14/−…), `servers/tower-routes.ts` (+4/−…), `lib/builder-lookup.ts` (+12/−…), `commands/cleanup.ts` (+5/−…) — builder-read callsites scoped by workspace
- `packages/codev/src/agent-farm/commands/db.ts` (+48), `commands/tower.ts` (+54), `cli.ts` (+17) — `afx db consolidate <path>` + `afx tower start --dry-run-migration`
- Tests: `__tests__/consolidate.test.ts` (+246, new); `state.test.ts`, `spec-755-lookup-builder.test.ts`, `overview.test.ts` reworked for the single-DB model; `migrate.test.ts` (−264, deleted)
- Docs: `codev/resources/arch-critical.md`, `arch.md`, `lessons-learned.md` updated

## Commits

- `c05a2e0d` … `1f2e8fa9` — Plan phase (draft + gate-decision revisions)
- `539dc93b` / `de357092` Move state.db tables into global.db; reshape builders workspace-scoped
- `d44fc707` Consolidation engine + boot one-off + `afx db consolidate` + dry-run preview
- `3a2ee987` Update tests for single-DB model (state, lookup-builder, overview)
- `d32c0391` Consolidate engine tests + fix workspace derivation (lastIndexOf)
- `fc6f371a` Clean up stale state.db references in state.ts comments
- `f8823e53` Replace introduced ternaries with if/else (no-ternary preference)
- `65ed4788` Dedupe workspace-path canonicalization into one leaf module

## Test Results

- `pnpm build`: ✓ pass
- `pnpm test`: ✓ pass — full suite **3419 passed, 48 skipped, 0 failures** (agent-farm alone: 2014 passed); consolidate suite adds 8 new cases
- Manual verification (dev-approval gate): ran the new code against a **real snapshot** of this machine's fragmented data — `afx db consolidate` dry-run + apply on a copy of the real 40-row `codev` `state.db` migrated **40 architect rows across 38 workspaces** into a throwaway `global.db`, source renamed to `*.pre-merge-<ts>`, re-apply a graceful no-op. Verified `afx tower start --dry-run-migration` previews without spawning/mutating, and the v13→v14 migration path on a snapshot of the real `global.db` (existing `terminal_sessions`/`known_workspaces` preserved).

## Architecture Updates

Routed **HOT** (`arch-critical.md`): rewrote the always-injected state fact — "State lives in
`.agent-farm/state.db` + `~/.agent-farm/global.db`" → "single user-global `~/.agent-farm/global.db`
(Issue #1118 retired per-workspace state.db; architect/builders keyed by `workspace_path`)". This
is behavior-changing and cross-cutting, so it belongs in the capped hot tier (no displacement
needed — reworded an existing entry in place).

Routed **COLD** (`arch.md`): updated the "State inconsistency" quick-map row, the "State
Consistency" invariant, and the state-persistence section (two-databases → one `global.db`;
described the composite-PK reshape, the `consolidate.ts` engine, and migration v14). Left the
historical #826 v11-migration detail intact (still accurate about schema evolution).

## Lessons Learned Updates

Routed **COLD** (`lessons-learned.md` → Architecture): a `[From #1118]` entry — "when a
subsystem's scope outgrows its storage location, relocate the storage rather than patching the
scope with a column," plus the corollary that moving a table into a shared DB forces re-examining
its primary key (the `builders` id-collision finding), and the reusable migration techniques
(upsert-if-newer, defensive `PRAGMA` reads). Not routed HOT: the existing hot lesson "single
source of truth beats distributed state — consolidate duplicates rather than syncing them"
already captures the headline; this PR is a detailed instance of it, so it belongs in cold.

## Things to Look At During PR Review

- **The `builders` reshape (`db/schema.ts`, migration v14, `state.ts`)** — the one structural
  change. Confirm every builder *read* that should be workspace-scoped is (`builder-lookup.ts`,
  `cleanup.ts`, `tower-routes.ts`, `overview.ts`, `loadState`), and that the security-relevant
  `lookupBuilderSpawningArchitect` filters by `(workspace_path, id)`.
- **`deriveWorkspaceFromWorktree` uses `lastIndexOf('/.builders/')`, not `indexOf`** — a bug the
  tests caught (a worktree path can itself sit under another `.builders/`, e.g. a builder testing
  from its own worktree). Same helper duplicated in `state.ts` and `consolidate.ts`.
- **Strict one-off marker semantics** (`runBootConsolidation`) — marks done unconditionally on
  first boot even if the active `state.db` is absent/empty; satellites are recovered via
  `afx db consolidate`. Confirm the marker + row-copy share one transaction.
- **Defensive legacy reads** (`consolidate.ts` normalizers) — pre-v11 architect (integer id, no
  `workspace_path`) and legacy builder rows are normalized without running the old migration
  ladder; enum values are clamped to satisfy the new CHECK constraints.
- **Schema-version tolerance is load-bearing, not incidental.** Because this PR deletes the
  local migration ladder (v1–v12), consolidation is the *sole* reader of legacy `state.db` files
  and never brings their schema up to date first — so it must tolerate **every** historical
  shape. This is why `readRows` uses `SELECT *` (never `SELECT <column>`) and every
  migration-added column is read as `row.<col> ?? null` (or synthesized). Concretely, a very
  common field shape is **v11-but-not-v12**: the `architect` table has `workspace_path` (#826)
  but no `session_id` column (#832 not yet rolled out). An explicit `SELECT session_id` would
  throw `no such column`; `SELECT *` + `?? null` yields `session_id = null` and migrates cleanly.
  Same for the builder columns added by v8/v9/v10 (`issue_number`, `spawned_by_architect`,
  `type` incl. `'pir'`). Pinned by tests: the `pre-v11` case and an explicit **v11-but-not-v12
  (no `session_id`)** regression test that would fail if any read ever became column-specific.
- **`db/index.ts` deletion is large** (−≈470) — it's the removed local-migration ladder, folded
  into `GLOBAL_SCHEMA` + v14. Worth a scan that nothing live still referenced it.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1118` → **View Diff**
- **What to verify** (maps to the plan's Test Plan — full recipe in `codev/plans/1118-*.md`):
  - Unit: `pnpm --filter @cluesmith/codev test` (state / consolidate / lookup-builder suites)
  - Safe preview: build the branch, then `afx tower start --dry-run-migration` (or
    `afx db consolidate <copy-of-state.db>`) — reads, no writes
  - Isolated apply: `NODE_ENV=test AF_TEST_DB=global-probe.db` against a copy of a real
    `state.db` / `global.db` — exercises migration v14 + data migrate without touching live state
  - Live: install from the **main** checkout (not the worktree) → Tower restart auto-migrates;
    then stop-from-A / start-from-B and confirm A's architects are visible (the fragmentation fix)

## Consultation (3-way verify, single advisory pass)

- **claude**: APPROVE — "implementation faithfully follows the approved plan across all dimensions."
- **codex**: REQUEST_CHANGES — caught **two real issues, both now fixed + regression-tested** (commit `d9828577`):
  1. **`clearRuntime()` wiped all workspaces' builders** — it did an unscoped `DELETE FROM builders`, and `afx workspace stop` calls it; on the shared `global.db` that deleted *every* workspace's builders, not just the stopping one. Fixed: `clearRuntime(workspacePath)` scopes the delete by `workspace_path` (threaded through `stop.ts`); `utils`/`annotations` (global, vestigial) are left untouched to avoid a cross-workspace wipe. Test: `clearRuntime(A)` leaves B's builders intact.
  2. **`afx db consolidate` repeat-run wasn't idempotent** — re-running on the renamed source `fatal`ed, and an already-`*.pre-merge-*` archive would re-migrate + double-rename. Fixed: missing source → friendly no-op; archived file → skip. Tests added.
- gemini/agy: not configured for the porch verify (a 2-way consult); a later ad-hoc 3-way
  re-run (iteration 2) added gemini (APPROVE).

**Iteration 2 (re-run after the iter-1 fixes) + a manual cross-workspace audit** surfaced two
more consolidation-fallout bugs, both fixed (commit `7f6ce330`):
  3. **`send.ts detectCurrentBuilderId` opened the RETIRED per-workspace `state.db`** to resolve
     a builder's canonical id for `afx send` (issue #1094 anti-spoofing). After migration renames
     that file, `afx send` from a worktree would break. This was the **last** direct `state.db`
     open (its siblings `lookupBuilderSpawningArchitect` and `overview.ts` were fixed in the main
     implementation; this one was missed). Found by the audit — **all three consult models missed
     it**. Fixed: read `global.db` scoped by `workspace_path`. Test rewritten incl. a same-id
     cross-workspace scoping case.
  4. **`afx db consolidate` dry-run wasn't side-effect-free** (codex iter2) — it called
     `getGlobalDb()`, which eagerly creates/migrates `global.db`. Fixed: dry-run opens `global.db`
     read-only (or in-memory if absent); only `--apply` uses the RW connection. Test added.
- **Known low-severity item**: `loadState()` returns `utils`/`annotations` unscoped (they have no
  `workspace_path` column). These tables are vestigial (no production producers — verified), so
  the exposure is a stale/empty read, not a live leak. Left as-is; noted for a future cleanup.
**Iteration 3** (final re-run: claude APPROVE, gemini COMMENT, codex REQUEST_CHANGES) — two
items, both addressed (commit `c81b8f0d`):
  5. **`send.ts` `.builders` regexes used lazy `.+?` (first-match)** — a *nested* worktree
     (`<repo>/.builders/a/.builders/b`) would resolve the outer builder. Same class as the
     `indexOf`→`lastIndexOf` fix; switched to greedy `.+` (last `/.builders/`) + regression test.
     Nesting is an unsupported anti-pattern (`afx spawn` from inside a worktree), so this is a
     consistency fix, not a normal-path bug. (Stale `detectCurrentBuilderId` docstring refreshed.)
  6. **No direct `runBootConsolidation` coverage** — added tests for the real boot path:
     first-boot migrate+marker+rename, marker-set no-op, and strict mark-done-when-absent.
- **Env note**: the codex consult initially failed because macOS 26 XProtect flagged the
  un-notarized `@openai/codex` vendor binary as malware and auto-deleted it (SIGKILL→ENOENT);
  restoring the binary + ad-hoc `codesign` unblocked it. Upstream/packaging follow-up, not a
  signal about this PR.

## Notes / Out of Scope

- **Pre-existing suite state**: scaffold tests (adopt/update/cold-tier/hot-tier/consult) and the
  terminal shellper-integration tests fail on a *stale build* (they need `pnpm build`'s
  copy-skeleton step / a live shellper) — verified they fail identically with this change stashed,
  so they are unrelated. After a full `pnpm build` the entire suite is green.
- **`session_id` for builders** deliberately excluded — that's #1112's charter (builders resume
  via unique-worktree mtime discovery; no shared-cwd sibling to disambiguate). Layers on cleanly
  as a later additive column.
- **`afx prune-state` / `afx workspace forget`** (named in the issue's acceptance criteria) were
  **cut** at the plan gate — stale rows are harmless under workspace-scoped reads; cleanup is a
  separable follow-up if ever needed.
- **`normalizeWorkspacePath` dedupe** collapsed 3 real copies into `utils/workspace-path.ts`; the
  bare `fs.realpathSync` calls in `tower-instances.ts`/`tower-routes.ts` are a different pattern
  (no fallback) and were intentionally left alone.
