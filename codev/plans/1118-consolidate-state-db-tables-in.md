# PIR Plan: Consolidate state.db tables into global.db

## Understanding

`state.db` is named/located as workspace-local (`<workspaceRoot>/.agent-farm/state.db`)
but its scope is effectively user-global: since Bugfix #826 (Migration v11) the `architect`
table is keyed by `(workspace_path, id)`, so one file holds rows from every workspace Tower
touched while parked in that directory. The lie is the **file location**, not the schema.

**Root cause of "missing architect state after restart"** (verified):
`getDb()` (`packages/codev/src/agent-farm/db/index.ts:54`) is a singleton whose path is
`getConfig().stateDir` → `<workspaceRoot>/.agent-farm/state.db`, and `workspaceRoot` is
derived from the process CWD via `findWorkspaceRoot()` (`utils/config.ts:75`). Tower is a
system-wide singleton serving many workspaces, but its `getDb()` is frozen to whichever
workspace it was *started from*. `setArchitect(resolvedPath, …)` (`state.ts:113`) already
writes the correct `workspace_path` column, but always into Tower-CWD's state.db **file**.
So:

- Tower started from A → all architect rows (for A, B, C…) land in `A/.agent-farm/state.db`.
- Reboot, Tower starts from B → `getDb()` now opens `B/.agent-farm/state.db`; A's rows are
  intact on disk but invisible to the running Tower. Hence "some architects missing."

Two direct-open workarounds exist **because** of this singleton-path bug and should collapse
once the DB is genuinely process-wide:
- `state.ts:491` `lookupBuilderSpawningArchitect(builderId, workspacePath?)` opens
  `<workspacePath>/.agent-farm/state.db` read-only (line 496).
- `servers/overview.ts:817` opens `<workspaceRoot>/.agent-farm/state.db` read-only to enrich
  builders by `worktree`.

### Table-by-table: what moves "as-is" vs what gets reshaped

The fix retires the per-workspace `state.db` *file* and moves its four tables into the
already user-global `~/.agent-farm/global.db`. Three tables move **unchanged**; one needs a
structural change:

- **`architect` — as-is.** Already workspace-scoped (composite PK `(workspace_path, id)` from
  v11). `workspace_path` becomes the row-disambiguator *within* the shared file instead of
  selecting a file.
- **`builders` — RESHAPED (the one structural change).** Today keyed by `id` alone. Builder
  ids are `<protocol>-<projectId>` (`buildAgentName`, `spawn.ts:374`), where `projectId` is a
  GitHub issue number — **unique per repo, not across repos**. `bugfix-100` can exist in both
  `codev` and `shannon`. Today they stay distinct only because each workspace's `afx spawn`
  writes to its *own* `state.db` file. `__tests__/spec-755-lookup-builder.test.ts:113-116`
  encodes this as a contract — the same id resolves to a *different* spawning architect per
  workspace — and it is **security-relevant** (the spoofing check at `tower-messages.ts:227`
  authorizes a builder against its architect). Collapsing builders into one shared table keyed
  by `id` alone would collide on the PK: the migration silently drops one row (latest-
  `started_at` wins), runtime upserts clobber, and the spoofing check can mis-authorize.
  **Builders must therefore become workspace-scoped — `workspace_path` column + composite PK
  `(workspace_path, id)` — exactly the treatment #826/v11 gave `architect`.**
- **`utils` — as-is.** UUID ids (globally unique), runtime-ephemeral, and effectively
  vestigial (no production `addUtil` callers). No collision risk.
- **`annotations` — as-is.** UUID ids (`file-<uuid>`), runtime-ephemeral. No collision risk.

The `builders` reshape adds **only** `workspace_path` + composite PK — making builders
structurally consistent with `architect` on the one dimension a shared DB requires
(workspace-scoped identity, since `id` is unique within a workspace but reused across them).
It deliberately does **not** add a `session_id` column: builder conversation resume works by
mtime discovery over each builder's *unique worktree cwd* (`buildResume` →
`findLatestSessionId`), so unlike sibling architects sharing one workspace cwd (Issue #832,
v12), builders have nothing to disambiguate. Persisting builder session ids is the explicit
charter of **#1112** and lands cleanly later as an additive nullable `ALTER` on top of this
reshape — out of scope here.

> Note: the issue's proposal §4 ("state.ts function signatures stay — they already take
> `workspace_path`") is true only for the *architect* functions. The *builder* functions
> (`upsertBuilder`, `getBuilder`, `getBuilders`, `getBuildersByStatus`, `removeBuilder`,
> `lookupBuilderSpawningArchitect`) are keyed by `id` alone and need workspace scoping. This
> is the same "thread `workspace_path` through every state.ts function" cost the issue
> attributed to the *rejected* per-workspace-file alternative — it applies here too, but
> bounded to the builder callsites only.

## Proposed Change

### A. Schema: move the four tables into global.db (new global migration v14)
- Add `architect`, `utils`, `annotations` **as-is**, plus the **reshaped `builders`**
  (workspace_path column + composite PK `(workspace_path, id)`, keeping the `idx_builders_*`
  indexes and the `builders_updated_at` trigger), and `idx_architect_workspace`, to
  `GLOBAL_SCHEMA` (`db/schema.ts`) so fresh installs create them in global.db at final shape.
- Bump `GLOBAL_CURRENT_VERSION` 13 → 14. Add migration v14 in `ensureGlobalDatabase()`
  (`db/index.ts:625`) that, on existing global.dbs, creates the four tables at their final
  shape (composite-PK architect incl. `session_id`; composite-PK builders incl.
  `spawned_by_architect`, `type` CHECK incl. `'pir'`; etc.). Idempotent via
  `CREATE TABLE IF NOT EXISTS` + the v14 `_migrations` row.
- Drop `LOCAL_SCHEMA` and the entire `ensureLocalDatabase()` local-migration ladder (v1–v12)
  from the live path — they only ever ran against the now-retired file. Their net effect is
  folded into the v14 table definitions. (Keep `LOCAL_SCHEMA` exported only if the one-time
  consolidation reader still needs it for shape reference; otherwise remove.)

### B. `getDb()` returns the global connection + builder callsite audit
- `db/index.ts`: `getDb()` → returns `getGlobalDb()` (single shared `~/.agent-farm/global.db`,
  honoring the existing `NODE_ENV=test`/`AF_TEST_DB` isolation in `getGlobalDbPath()`).
  Remove `_localDb`, `ensureLocalDatabase()`, and the CWD-dependent
  `resolve(config.stateDir, 'state.db')` creation. `getDbPath()` → `getGlobalDbPath()`.
  `closeDb()` → alias to `closeGlobalDb()`; `closeAllDbs()` collapses.
- **Architect functions** (`state.ts`): unchanged — they already take `workspace_path`.
- **Builder functions** (`state.ts`): thread workspace scoping.
  - `upsertBuilder(builder)` — **derive** `workspace_path` internally from `builder.worktree`
    (`<workspace>/.builders/<id>`); no signature change.
  - `lookupBuilderSpawningArchitect(builderId, workspacePath)` — **keep** the `workspacePath`
    param (load-bearing, not vestigial); drop the per-workspace direct file open; query
    `getDb()` with `WHERE workspace_path = ? AND id = ?`.
  - `getBuilder` / `removeBuilder` / `getBuilders` / `getBuildersByStatus` — audit each
    callsite (`lib/builder-lookup.ts`, `commands/cleanup.ts`, dashboard/status readers) and
    scope by `workspace_path` (or filter by `worktree` prefix where a workspace is in scope).
    Document any reader that legitimately wants cross-workspace results.
- Replace the two direct-open workarounds with the now-correct shared connection:
  - `overview.ts:808-836` — open `getGlobalDbPath()` read-only (or `getDb()`); match by
    `worktree` (unique) as today, which naturally scopes to this workspace's builders.

### C. One-off migration of the active state.db (lifetime-once, then state.db is dead)
A **single** migration that runs **once in the lifetime of the install**, at the first
post-upgrade Tower boot. It is guarded by one persistent marker in global.db; once set,
`state.db` has no further role and is **never read or checked again**. This is not a per-boot
sweep — it is a one-off cutover.

**Reusable engine — `db/consolidate.ts`** (the single source of truth; knows nothing about the
marker or about Tower boot):
- `activeStateDbPath(): string` — the pre-fix `getDb()` path
  (`<workspace-root>/.agent-farm/state.db`), used by the boot caller.
- `planMigration(globalDb, file): MigrationPlan` — pure read; per-table counts + which rows are
  newer/older than existing global rows. Reads defensively (`PRAGMA table_info`): a pre-v11
  `architect` row with no `workspace_path` gets it synthesized from the file's directory; a
  `builders` row gets `workspace_path` derived from its `worktree` column (fallback: the file's
  directory).
- `applyMigration(globalDb, file)` — **upsert-if-newer, always**:
  `INSERT … ON CONFLICT(<pk>) DO UPDATE SET … WHERE excluded.started_at > started_at`. On an
  empty target (the boot one-off) every row is "newer than nonexistent" → all insert; on a
  non-empty target (a satellite import after the one-off already ran) a stale overlapping row
  (e.g. an old `codev/main`) is correctly skipped. One transaction; on success, rename the source
  `state.db` (+ `-wal`/`-shm` sidecars) to `state.db.pre-merge-<timestamp>` (preserved, never
  deleted). This unifies the boot and manual paths on one code path with correct conflict
  resolution for free.

**Caller 1 — automatic boot one-off** (`tower-server.ts main()`, before `initInstances()`):
gated by the persistent `_consolidation` marker. If unset: `applyMigration(activeStateDbPath())`,
then write the marker **in the same transaction as the row copy**. The marker is written **on the
first boot unconditionally** (strict policy — even if the active `state.db` was absent/empty), so
once set, every subsequent boot reads the marker and short-circuits — `state.db` is never opened
again. The marker guards *the automatic boot cutover only*; if a stateless first-boot misses a
richer satellite file, the user recovers it via Caller 2.
- Preview: `afx tower start --dry-run-migration` prints what the active file would contribute and
  **exits without spawning the server**, opening global.db read-only so the preview never
  applies. `--apply-migration` (or plain `afx tower start`) commits.

**Caller 2 — manual command `afx db consolidate <path-to-state.db>`** (fits the existing `db`
group alongside dump/query/reset): dry-run by default, `--apply` to commit. Calls
`applyMigration(<path>)` directly — **not marker-gated** (a deliberate, targeted user action),
idempotent via the source rename, and **safe with Tower running** (global.db is WAL +
`busy_timeout`; Tower never touches satellite `state.db` files post-fix, so no stop/start). This
is the escape hatch for the accepted-loss case below: a user can pull in any *satellite*
`state.db` whose rows weren't captured by the boot one-off. (Optional `--all` could reuse
`known_workspaces` to sweep every remaining satellite — nice-to-have, not core.)

**Accepted scope of the *automatic* one-off**: only the file active at the first post-upgrade
boot is migrated automatically. Rows that live *only* in another workspace's `state.db` aren't
auto-recovered — but they remain on disk and can be pulled in deliberately via
`afx db consolidate <path>` (Caller 2). Auto-completeness depends on which workspace Tower is
first started from after the upgrade; first-starting from the dominant start-cwd (the audit's
40-row codev file) captures the bulk, and the manual command mops up the rest.

### D. Leave in place (per issue "what doesn't change")
- `~/.agent-farm/global.db` location; `known_workspaces`, `terminal_sessions`,
  `port_allocations`, `file_tabs`, `cron_tasks`.
- `architect.workspace_path` column (still the disambiguator).
- The per-workspace `.agent-farm/` directory (forward-compat; not deleted by migration).
- Migration v12's `session_id` work.

### Cut from the original issue scope (deliberate deviation — confirm at gate)
`afx prune-state` and `afx workspace forget` are **dropped**. Rationale: with a single shared
DB, `workspace_path` scoping on every read means stale rows (workspaces deleted from disk) are
**harmless** — a live workspace never sees a dead one's rows. They are not the fragmentation
bug; SQLite handles them trivially (indexed, scoped reads). The only benefit was a tidier
`afx db dump` (cosmetic), and `prune-state` dragged in a messy per-table rule (only `architect`
has `workspace_path`). The old "free cleanup on `rm`" was a side effect of the per-file model,
not a requested feature. If stale-row accumulation ever proves to matter, it is a clean
standalone follow-up. (Architect to confirm cutting these two acceptance criteria.)

## Files to Change

- `packages/codev/src/agent-farm/db/schema.ts` — add `architect`/`utils`/`annotations` as-is +
  reshaped `builders` (workspace_path + composite PK) to `GLOBAL_SCHEMA`; retire `LOCAL_SCHEMA`.
- `packages/codev/src/agent-farm/db/index.ts` — `getDb()`→`getGlobalDb()`; remove
  `ensureLocalDatabase` + local migration ladder; bump `GLOBAL_CURRENT_VERSION` to 14 + add
  global migration v14; `getDbPath()`→`getGlobalDbPath()`; collapse `closeDb`.
- `packages/codev/src/agent-farm/db/consolidate.ts` — **new**: reusable engine
  (`activeStateDbPath` / `planMigration` / `applyMigration`, upsert-if-newer). Marker-agnostic.
- `packages/codev/src/agent-farm/state.ts` — builder functions thread `workspace_path`
  (derive in `upsertBuilder`; filter in `getBuilder`/`getBuilders`/`removeBuilder`/
  `getBuildersByStatus`/`lookupBuilderSpawningArchitect`); drop the per-workspace direct open.
- `packages/codev/src/agent-farm/lib/builder-lookup.ts`, `commands/cleanup.ts` — builder-read
  callsite audit (scope by workspace where in scope).
- `packages/codev/src/agent-farm/servers/overview.ts:808-836` — open `getGlobalDbPath()` /
  `getDb()` instead of `<ws>/.agent-farm/state.db`.
- `packages/codev/src/agent-farm/servers/tower-server.ts` — boot one-off caller: marker check →
  `applyMigration(activeStateDbPath())` → write `_consolidation` marker (same txn).
- `packages/codev/src/agent-farm/commands/tower.ts` — `--dry-run-migration` /
  `--apply-migration` handling in `towerStart` (preview-and-exit path).
- `packages/codev/src/agent-farm/commands/db.ts` — new `afx db consolidate <path>` subcommand
  (dry-run default, `--apply`), calling the engine directly (not marker-gated). `--global`/local
  now alias the same file; simplify or keep both for compat.
- `packages/codev/src/agent-farm/cli.ts` — register the new tower-start flags + `db consolidate`.
- Tests: update `__tests__/state.test.ts` mock (the four tables now come from `GLOBAL_SCHEMA`
  via `getGlobalDb`; `getDb` returns it); update `spec-755-lookup-builder.test.ts` to the
  single-file + `workspace_path`-scoped model; add `__tests__/consolidate.test.ts`. Audit other
  DB-touching tests (`bugfix-826-migration`, `migrate`, `tower-instances`, `overview`,
  `concurrency`, `spec-755-*`, `bugfix-1094-tower-guard`) for the `getDb`≡`getGlobalDb` and
  builder-workspace-scoping changes.
- Docs: `codev/resources/arch.md` + `arch-critical.md` ("state lives in state.db + global.db"
  → "single user-global global.db"). Mirror to `AGENTS.md`/`CLAUDE.md` if the hot fact text
  changes. Done in the review phase per tier routing.

## Risks & Alternatives Considered

- **Risk — builder PK collision missed at a callsite.** The reshape is the subtle part: any
  builder read not scoped by `workspace_path` could return the wrong workspace's row. Mitigation:
  explicit callsite audit (above) + the `spec-755-lookup-builder` cross-workspace test reframed
  onto the single-file model + a new test asserting two same-id builders in different workspaces
  stay distinct.
- **Risk — re-running the one-off (duplicate rows).** Mitigation: the row copy **and** the
  marker insert happen in the **same transaction** — either both commit or neither. Every boot
  checks the marker first and short-circuits. A crash mid-copy rolls back (global tables stay
  empty, marker unset) and the next boot cleanly retries; a crash *after* commit but before the
  file rename leaves the marker set (so no re-migrate) and only an un-renamed `state.db` lingering
  (cosmetic, never read again).
- **Risk — first post-upgrade boot is from a workspace with an absent/empty `state.db`.** Strict
  policy marks done regardless, so a richer satellite file in another workspace is skipped by the
  *automatic* path. Mitigation: fully recoverable via `afx db consolidate <path>` (Caller 2);
  plus the dry-run preview + guidance to first-start from the dominant start-cwd.
- **Risk — a stray `getGlobalDb()` from a read-only CLI command triggers the migration before the
  user runs Tower.** Mitigation: schema (v14) is separated from the data migration; the migration
  is gated to Tower boot / explicit `--apply-migration`, not to mere DB open. Dry-run opens
  defensively (read-only).
- **Risk — source-version heterogeneity** (a pre-v11 active file). Mitigation: `PRAGMA
  table_info` + synthesized `workspace_path`; validated live via the dry-run at the dev-approval
  gate.
- **Risk — test fallout** from `getDb`≡`getGlobalDb`. Mitigation: update the central mock; the
  change generally *simplifies* test isolation (one file). Run the full agent-farm suite.
- **Alternative — per-workspace state.db with an LRU pool** (issue alt #1): rejected upstream as
  more complex than warranted.
- **Alternative — just relocate state.db to `~/.agent-farm/state.db`** (issue alt #2): keeps the
  arbitrary two-DB split. Rejected as a half-measure.
- **Alternative — keep builders keyed by `id` alone** (treat ids as globally unique): rejected —
  ids are `<protocol>-<issueNumber>`, provably non-unique across repos, and the contract is
  security-relevant.

## Resolved Decisions (plan-approval gate)

1. **Cut `afx prune-state` + `afx workspace forget`** — confirmed. Both dropped from this PIR
   (deliberate deviation from the issue's acceptance criteria). Stale rows are harmless under
   workspace-scoped reads; cleanup is not part of the consolidation. See "Cut from scope."
2. **`builders` reshape accepted** — `builders` gains `workspace_path` + composite PK
   `(workspace_path, id)`, mirroring #826/v11 for `architect`, plus the builder-read callsite
   audit. Not optional for correctness (builder ids are non-unique across repos and the spoofing
   check is security-relevant).
3. **Strict one-off marker** — the dedicated persistent `_consolidation` table is written on the
   first post-upgrade boot **unconditionally** (even if the active `state.db` is absent/empty),
   inside the migration transaction; every later boot short-circuits and `state.db` is never read
   again. A stateless first-boot that misses a richer satellite file is fully recoverable via
   `afx db consolidate <path>` (Caller 2) — the manual command is the accepted recovery path, so
   strict simplicity wins.

## Test Plan

**Unit**
- Cross-workspace architect isolation: rows for A and B in one global.db; reads scoped by
  `workspace_path` return only the requested workspace's rows.
- **Cross-workspace builder isolation (new)**: two builders with the *same id* in workspaces A
  and B; `getBuilder`/`lookupBuilderSpawningArchitect` scoped by `workspace_path` return the
  correct, distinct rows; `upsertBuilder` derives `workspace_path` from `worktree` and does not
  clobber the other workspace's row.
- One-off migration: an active `state.db` (incl. a pre-v11 architect shape + a builder with no
  `workspace_path`) copies cleanly into empty global tables; `workspace_path` synthesized
  correctly for builders/pre-v11 architect rows; source renamed to `*.pre-merge-<ts>`.
- Marker idempotency: with the marker set, a second boot is a no-op — `state.db` is not opened,
  not re-read, not re-renamed; global rows unchanged (no duplicates).
- Crash-safety: simulate a crash after the migration commit but before rename — next boot
  short-circuits on the marker (no re-migrate), leaving the un-renamed file untouched.
- Satellite upsert-if-newer (engine reuse): after a one-off, run `applyMigration` on a second
  (satellite) file whose rows overlap an already-migrated workspace; assert the fresher existing
  global row survives, the stale satellite copy is skipped, genuinely-new rows are added, and the
  satellite is renamed. Not marker-gated — runs even though the boot marker is set.
- `afx db consolidate <path>`: dry-run lists per-table counts + would-skip rows, no writes;
  `--apply` commits + renames; second invocation on the now-renamed path is a friendly no-op.

**Manual (dev-approval gate, against the local fragmented machine)**
- `afx tower start --dry-run-migration` against the real active state.db: preview lists the
  per-table counts it would migrate; no files changed.
- Reboot scenario: `afx tower stop` (from workspace A), `afx tower start` (from workspace B),
  confirm A's architects are now readable from Tower at B (`afx status` shows them).
- Confirm the active `state.db` is renamed to `*.pre-merge-<ts>` after the real start, the marker
  is set, and a second start does **not** re-migrate (and never opens `state.db` again).
- Spawn a builder + add a sibling architect post-merge; confirm `afx status`, dashboard, and the
  VS Code sidebar read correct state regardless of Tower's start CWD, and that messaging /
  spoofing-check authorization still resolves to the right architect.

### Testing the migration — recipe & caveats (manual)

**This change is Tower-*boot* behaviour, not a dev-server feature.** The one-off runs in
`tower-server.ts main()`, so `afx dev <builder>` does **not** exercise it (that runs the
worktree's `devCommand`). To run the new code you install the worktree build
(`pnpm -w run local-install` from the worktree — builds, installs globally, restarts Tower);
the boot one-off then runs on that Tower restart against whatever workspace the restart's cwd
resolves to.

**Which `state.db` gets read:** `activeStateDbPath()` = `<workspace-root-of-Tower's-cwd>/
.agent-farm/state.db`. Started from the worktree → the worktree's *empty* file (nothing to
migrate, and it would burn the strict marker). Started from the main checkout → main's real
aggregate. **Do not copy `state.db` into the worktree** — it's the wrong vector and still writes
to the real shared `~/.agent-farm/global.db`.

**Safe preview (zero mutation)** — `--dry-run-migration` opens `global.db` read-only, writes
nothing, renames nothing, never spawns the server. Point it at a chosen file via a scratch dir:

```bash
mkdir -p /tmp/cons/ws/.agent-farm && cd /tmp/cons/ws && git init -q && mkdir -p codev
cp ~/repos/cluesmith/codev/.agent-farm/state.db /tmp/cons/ws/.agent-farm/state.db
afx tower start --dry-run-migration          # per-table counts for the copy; exits, no writes
afx db consolidate ~/repos/cluesmith/shannon/.agent-farm/state.db   # satellite preview (dry-run)
```

**Isolated apply test** — `AGENT_FARM_DIR` is `homedir()`-based, so a scratch `HOME` gives a
throwaway `global.db`, keeping the live one untouched:

```bash
export HOME=/tmp/cons/home && mkdir -p $HOME/.agent-farm
afx db consolidate /tmp/cons/ws/.agent-farm/state.db --apply        # writes throwaway global.db
afx db query --global "SELECT workspace_path, id FROM architect"    # verify rows landed, scoped
```

**Live reboot test (real mutation, recoverable)** — the genuine end-to-end check: `afx tower
stop` (from workspace A), `afx tower start` (from workspace B), confirm A's architects are
visible from Tower at B. This writes the real `~/.agent-farm/global.db` and renames real
`state.db` files to `*.pre-merge-<ts>` (idempotent; sources preserved for recovery). Do the
apply-path validation under the scratch `HOME` first if you'd rather not mutate live state until
the confidence check.
