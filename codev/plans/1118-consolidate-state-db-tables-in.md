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

### C. One-time on-disk consolidation (migrate legacy state.db files) — at Tower boot
New module `db/consolidate.ts`:
- `discoverLegacyStateDbFiles(globalDb): string[]` — union of every
  `<workspace_path>/.agent-farm/state.db` from `known_workspaces`, plus `~/.agent-farm/state.db`
  (the `$HOME`-fallback file, which may not be registered), filtered to existing files.
  `known_workspaces` lives in the already-global `~/.agent-farm/global.db`, so it is a reliable
  index of where the source files are.
- `planConsolidation(globalDb, files): ConsolidationPlan` — pure read. For each table, collect
  rows from all sources and report per-table merge counts + **conflicts** (same primary key in
  ≥2 source files with differing content). No writes. Reads each source defensively
  (`PRAGMA table_info`): a pre-v11 `architect` row with no `workspace_path` gets it synthesized
  from the file's own directory; a `builders` row gets `workspace_path` derived from its
  `worktree` column (or the file's directory as fallback).
- `applyConsolidation(globalDb, files, plan)` — per table, gather all source rows, sort
  ascending by `started_at`, `INSERT OR REPLACE` in that order so **latest-started_at wins** on
  PK collisions (architect/builders PK = `(workspace_path, id)`; utils/annotations PK = `id`).
  Row merge is one transaction; after commit, rename each source `state.db` (and its
  `-wal`/`-shm` sidecars) to `state.db.pre-merge-<timestamp>` — preserved, never deleted.
- Idempotency marker: a dedicated `_consolidation` marker in global.db (clearer than reusing
  the integer `_migrations` ladder). Re-run-safe regardless: renamed sources are no longer
  discovered, and re-merging is idempotent under latest-wins.

**Where it runs**:
- Normal start: invoked at Tower boot in `tower-server.ts main()` (apply mode), before
  `initInstances()`. (Schema v14 is already applied by the first `getGlobalDb()`.)
- Preview: `afx tower start --dry-run-migration` computes + prints the plan (sources, per-table
  counts, conflicts) and **exits without spawning the server**. It opens global.db read-only/
  defensively so the preview never applies the consolidation as a side effect. `--apply-migration`
  (or plain `afx tower start`) commits.

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
- `packages/codev/src/agent-farm/db/consolidate.ts` — **new**: discover/plan/apply + marker.
- `packages/codev/src/agent-farm/state.ts` — builder functions thread `workspace_path`
  (derive in `upsertBuilder`; filter in `getBuilder`/`getBuilders`/`removeBuilder`/
  `getBuildersByStatus`/`lookupBuilderSpawningArchitect`); drop the per-workspace direct open.
- `packages/codev/src/agent-farm/lib/builder-lookup.ts`, `commands/cleanup.ts` — builder-read
  callsite audit (scope by workspace where in scope).
- `packages/codev/src/agent-farm/servers/overview.ts:808-836` — open `getGlobalDbPath()` /
  `getDb()` instead of `<ws>/.agent-farm/state.db`.
- `packages/codev/src/agent-farm/servers/tower-server.ts` — invoke `applyConsolidation` at
  boot (apply mode, marker-guarded).
- `packages/codev/src/agent-farm/commands/tower.ts` — `--dry-run-migration` /
  `--apply-migration` handling in `towerStart` (preview-and-exit path).
- `packages/codev/src/agent-farm/cli.ts` — register the new tower-start flags.
- `packages/codev/src/agent-farm/commands/db.ts` — `--global`/local now alias the same file;
  simplify or keep both for compat.
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
- **Risk — data loss on a botched merge.** Mitigation: sources renamed, never deleted
  (`*.pre-merge-<ts>`); merge is transactional; dry-run preview surfaces conflicts before any
  write; idempotent marker prevents re-merge.
- **Risk — a stray `getGlobalDb()` from a read-only CLI command triggers the file rename/merge
  before the user runs Tower.** Mitigation: schema (v14) is separated from the data
  consolidation; consolidation is gated to Tower boot / explicit `--apply-migration`, not to
  mere DB open. Dry-run opens defensively (read-only).
- **Risk — source-version heterogeneity** (the audited pre-v11 file). Mitigation: per-source
  `PRAGMA table_info` + synthesized `workspace_path`; validated live via the dry-run against the
  real 8 files at the dev-approval gate.
- **Risk — test fallout** from `getDb`≡`getGlobalDb`. Mitigation: update the central mock; the
  change generally *simplifies* test isolation (one file). Run the full agent-farm suite.
- **Alternative — per-workspace state.db with an LRU pool** (issue alt #1): rejected upstream as
  more complex than warranted.
- **Alternative — just relocate state.db to `~/.agent-farm/state.db`** (issue alt #2): keeps the
  arbitrary two-DB split. Rejected as a half-measure.
- **Alternative — keep builders keyed by `id` alone** (treat ids as globally unique): rejected —
  ids are `<protocol>-<issueNumber>`, provably non-unique across repos, and the contract is
  security-relevant.

## Open Questions (for the plan gate)

1. **Cutting `afx prune-state` + `afx workspace forget`** — recommended (see "Cut from scope").
   Confirm this deviation from the issue's acceptance criteria, or specify why a cleanup command
   is still wanted.
2. **`builders` reshape buy-in** — adding `workspace_path` + composite PK to `builders` (and the
   builder-callsite audit) is the one structural change and expands blast radius slightly beyond
   the issue's "move as-is" framing. Confirm the approach (mirror #826) vs any alternative.
3. **Consolidation marker** — dedicated `_consolidation` marker (recommended) vs a reserved
   `_migrations` sentinel. Confirm.

## Test Plan

**Unit**
- Cross-workspace architect isolation: rows for A and B in one global.db; reads scoped by
  `workspace_path` return only the requested workspace's rows.
- **Cross-workspace builder isolation (new)**: two builders with the *same id* in workspaces A
  and B; `getBuilder`/`lookupBuilderSpawningArchitect` scoped by `workspace_path` return the
  correct, distinct rows; `upsertBuilder` derives `workspace_path` from `worktree` and does not
  clobber the other workspace's row.
- Consolidation row-routing: synthesize 2–3 legacy `state.db` files (incl. a pre-v11 shape and
  an overlapping same-id builder) with differing `started_at`; assert latest-started_at wins,
  all distinct rows present, conflicts reported, sources renamed (not deleted).
- Idempotency: second consolidation run is a no-op (marker set; no further renames/merges).

**Manual (dev-approval gate, against the local fragmented machine)**
- `afx tower start --dry-run-migration` against the real 8 fragmented state.db files: preview
  lists every source + per-table counts + flags conflicts; no files changed.
- Reboot scenario: `afx tower stop` (from workspace A), `afx tower start` (from workspace B),
  confirm A's architects are now readable from Tower at B (`afx status` shows them).
- Confirm source `state.db` files are renamed to `*.pre-merge-<ts>` after the real start, and a
  second start does not re-migrate.
- Spawn a builder + add a sibling architect post-merge; confirm `afx status`, dashboard, and the
  VS Code sidebar read correct state regardless of Tower's start CWD, and that messaging /
  spoofing-check authorization still resolves to the right architect.
