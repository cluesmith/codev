# PIR #1118 — Consolidate state.db tables into global.db

## Phase: plan

### Investigation notes (plan phase)
- **Root of fragmentation**: `getDb()` (`db/index.ts:54`) is a singleton bound to Tower's
  startup CWD via `getConfig().stateDir` → `<workspaceRoot>/.agent-farm/state.db`.
  `setArchitect(resolvedPath, …)` already tags rows with `workspace_path` (Bugfix #826),
  but the *file* is still CWD-bound, so workspace B's architect row lands in workspace A's
  state.db. After a Tower restart from B, those rows are stranded.
- **Two direct-open workarounds** that exist *because* of the singleton-path bug and should
  collapse to `getDb()`/global.db after the fix:
  - `state.ts:496` `lookupBuilderSpawningArchitect` — opens `<ws>/.agent-farm/state.db` RO.
  - `overview.ts:817` — opens `<ws>/.agent-farm/state.db` RO, reads all builders by worktree.
- **Schema**: only `architect` has a `workspace_path` column (v11). `builders` (keyed by id,
  has `worktree` path), `utils`, `annotations` have NO workspace linkage. This is the main
  wrinkle for `prune-state` (acceptance criteria name all four). builders/utils/annotations
  are runtime-ephemeral (wiped by `clearRuntime`/`clearState`); the audited stale rows are
  all `architect` rows.
- global.db migrations live in `ensureGlobalDatabase` (`db/index.ts:625`),
  `GLOBAL_CURRENT_VERSION = 13`. Local migrations (1–12) in `ensureLocalDatabase`.
- CLI is commander-based (`cli.ts`); `workspace` is a command group. `afx prune-state`
  → top-level command; `afx workspace forget <path>` → workspaceCmd subcommand.
- Tower boot: `tower-server.ts` `main()` — good hook for the one-time data consolidation.
- Tests mock `getDb`/`getGlobalDb` separately (`__tests__/state.test.ts:16`); the 4 tables
  come from `LOCAL_SCHEMA`. After merge they must come from `GLOBAL_SCHEMA`; test mocks +
  fixtures need updating.

Plan written; flagging the prune-state per-table strategy + consolidation-as-boot-step
vs migration as the key plan-gate design decisions.

### Plan revision (architect feedback at plan-approval gate)
Architect pushed back on 4 points; plan revised:
1+2. **Cut `afx prune-state` + `afx workspace forget`.** Stale rows are harmless under
   workspace_path read-scoping; pruning was cosmetic + dragged in the per-table mess. Deviates
   from issue acceptance criteria — flagged for confirmation.
3. **Migration on Tower boot** — locked in (removed the fold-into-v14 alternative).
4. **`lookupBuilderSpawningArchitect` workspacePath param is LOAD-BEARING, not vestigial.**
   Investigating it surfaced the big finding: **builder ids collide across workspaces**
   (`<protocol>-<issueNumber>`; issue numbers repeat across repos). Per-workspace state.db FILES
   keep them distinct today; `spec-755-lookup-builder.test.ts:113-116` encodes this as a
   security-relevant contract (spoofing check). So **`builders` needs workspace_path + composite
   PK `(workspace_path, id)`** — the one structural reshape; mirrors #826/v11 for architect.

### Table verdict (architect asked: move as-is or reshape?)
- architect → as-is (already composite PK since v11)
- builders → RESHAPED (add workspace_path + composite PK) — the only structural change
- utils, annotations → as-is (UUID ids, no production addUtil/addAnnotation callers, vestigial)

Builder-read callsite audit (getBuilder/getBuilders/removeBuilder/getBuildersByStatus) is the
bounded extra cost. upsertBuilder can derive workspace_path from builder.worktree (no sig change).
### Migration scope decision (architect, plan-approval gate)
Architect chose **strict one-off migration of the ACTIVE state.db only** (not multi-file scan,
not per-boot). Key points:
- Runs ONCE in the install's lifetime, at first post-upgrade Tower boot. Persistent marker in
  global.db (written in the SAME txn as the row copy) → every later boot short-circuits;
  state.db is dead, never read again.
- Straight copy (single source, empty target) → NO conflict resolution needed.
- Satellite files (other workspaces' state.db) abandoned — accepted loss. Completeness depends
  on which workspace Tower is first started from after upgrade. Dry-run lets user confirm.
- Open marker set-policy question: strict (mark on first boot unconditionally) vs
  mark-on-first-real-migration (when active state.db absent/empty on first boot). Flagged in
  plan Open Q #3.

### All open questions resolved (architect, plan-approval gate)
1. **Cut** `afx prune-state` + `afx workspace forget` — confirmed dropped.
2. **Accept** builders reshape (workspace_path + composite PK, mirror #826) + callsite audit.
3. **Strict** one-off marker — `_consolidation` row written on first boot unconditionally;
   state.db never read again. Satellite recovery via manual `afx db consolidate <path>`.
Also added (architect idea): reusable `db/consolidate.ts` engine (upsert-if-newer) with two
callers — auto boot one-off (marker-gated) + manual `afx db consolidate <path>` (not gated,
Tower-up-safe). Plan fully specified. Awaiting plan-approval gate approval.

## Phase: implement (plan-approval APPROVED, rebased on main)

### Builder-read callsite audit (done before coding)
- `loadState(ws)` → scope builders by `workspace_path` (consistent w/ architect; status/stop/
  send/attach/cleanup all pass a ws).
- `lib/builder-lookup.ts` findBuilderByIssue/ById → pass `getConfig().workspaceRoot` to
  getBuilders/getBuilder (matches its loadTowerBuilderRows scoping).
- `tower-routes.ts:1895` getBuilders() → getBuilders(workspacePath) (handleWorkspaceState has it).
- `cleanup.ts:381` removeBuilder(id) → removeBuilder(id, config.workspaceRoot).
- `getBuildersByStatus` → no production callers.
- Signatures: builder reads get optional `workspacePath?` (scope if provided, else cross-ws);
  upsertBuilder DERIVES workspace_path from builder.worktree (no sig change).

### Schema/migration decisions
- LOCAL_SCHEMA kept UNCHANGED as legacy-state.db reference (used by consolidate fixtures + ~7
  existing tests; old builders shape = id-only PK = correct legacy representation).
- GLOBAL_SCHEMA gains architect/utils/annotations as-is + builders RESHAPED (workspace_path +
  composite PK) + indexes + builders trigger + idx_architect_workspace.
- getDb()→getGlobalDb(); remove ensureLocalDatabase + local v1-v12 ladder + migrateLocalFromJson
  from production path; getDbPath()→getGlobalDbPath(); add global migration v14 (create 4 tables
  on existing global.db); GLOBAL_CURRENT_VERSION 13→14.
- Expect test fallout (migrate.test, bugfix-826/pir-832 local-ladder tests, state.test mock);
  fix iteratively after build.

### Implementation complete (pre dev-approval)
Commits on builder/pir-1118:
- data layer: schema.ts (GLOBAL_SCHEMA + 4 tables, builders reshaped), index.ts (getDb→global,
  v14, removed ensureLocalDatabase + ladder), types.ts, state.ts (builder workspace-scoping),
  callsites (builder-lookup/cleanup/tower-routes/overview), deleted db/migrate.ts
- engine: db/consolidate.ts (planMigration/applyMigration upsert-if-newer, _consolidation
  marker, runBootConsolidation strict one-off), tower-server boot hook, afx db consolidate,
  afx tower start --dry-run-migration
- tests: rewrote state.test mock (unified GLOBAL_SCHEMA), spec-755-lookup-builder (single-db),
  overview.test (global db enrichment), new consolidate.test (8 cases), deleted migrate.test

**Bug caught by tests**: deriveWorkspaceFromWorktree used indexOf('/.builders/') → wrong when
the worktree path itself sits under another .builders/ (our test runs inside pir-1118's
worktree!). Fixed to lastIndexOf in BOTH state.ts and consolidate.ts.

**Test status**: full agent-farm suite GREEN (2014 passed, 34 skipped, 0 fail). The 8 failing
files outside agent-farm (adopt/update/cold-tier/hot-tier/consult/hot-tier-injection/
session-manager) are PRE-EXISTING — verified they fail with my changes stashed (scaffold tests
need built skeleton; session-manager needs live shellper). Running pnpm build to confirm.
Next: dev-approval gate.

## Phase: review (dev-approval APPROVED)
- Manual testing done at dev-gate: dry-run + isolated apply against real 40-row codev state.db
  copy (40 rows / 38 ws), v13→v14 migration on real global.db snapshot — all verified.
- Post-approval refactors: ternary→if/else cleanup, dedupe normalizeWorkspacePath into
  utils/workspace-path.ts (behavior-identical, suite green).
- Review file written: codev/reviews/1118-*.md. Arch docs updated: arch-critical.md HOT fact
  (state.db→global.db), arch.md invariants + state section, lessons-learned.md [From #1118]
  Architecture entry. CLAUDE.md/AGENTS.md always-on block left to codev update (auto-generated).
- PR #1127 opened (review as body), recorded with porch. Checks green.
- verify block: 2-way consult. claude APPROVE. codex REQUEST_CHANGES — caught 2 REAL issues:
  (1) clearRuntime() unscoped DELETE wiped ALL workspaces' builders on `afx workspace stop`
  (real regression I missed) → fixed: clearRuntime(workspacePath) scopes by workspace_path,
  threaded through stop.ts; utils/annotations left untouched. (2) `afx db consolidate` repeat-run
  not idempotent (fatal on renamed source / re-rename archives) → friendly no-op guards.
  Both fixed + regression-tested (commit d9828577). Rebuttal written. Suite green (2017 passed).
- codex consult was blocked by macOS 26 XProtect flagging the un-notarized @openai/codex vendor
  binary as malware (SIGKILL→ENOENT auto-delete); fixed by restoring binary + ad-hoc codesign.
  Upstream/packaging issue — flagged as separate follow-up.
- PR #1127 body synced with consult outcome. Rebuttal done, porch checks green.
- **pr gate PENDING**. Architect notified (led with codex findings). Waiting for human GitHub
  review + `porch approve 1118 pr`. After approval: gh pr merge --merge, porch done --merged 1127.

### Cross-workspace audit (architect asked "other bugs like clearRuntime?") + cmap iter2
The shared-DB conversion turns "per-file implicit scoping" into latent bugs anywhere code
relied on the file boundary. Systematic audit + iter2 (claude APPROVE, gemini APPROVE, codex
dry-run finding) found 2 MORE, both FIXED (commit 7f6ce330, +tests):
- **HIGH (audit-found, missed by ALL 3 models)**: send.ts detectCurrentBuilderId opened the
  RETIRED per-workspace state.db for `afx send` #1094 anti-spoofing → breaks afx send from a
  worktree post-migration. LAST direct state.db open (siblings lookupBuilderSpawningArchitect +
  overview.ts were already fixed). Now reads global.db scoped by workspace_path.
- **MED (codex iter2)**: `afx db consolidate` dry-run called getGlobalDb() (eagerly migrates
  global.db) → now opens read-only; only --apply uses RW connection.
- **LOW (noted, not fixed)**: loadState returns utils/annotations unscoped — vestigial (no
  producers), future cleanup.
Audit complete: 3 direct-opens total (all fixed), all builder-fn callers scoped, clearState no
callers. iter2 rebuttal written. Full suite 2018 passed. Architect re-notified.
