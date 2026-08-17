# air-1476 — Tower: extract runGlobalMigrations(db)

Protocol: AIR (strict). Issue #1476.

## What the issue asks

The global.db migration tests drove hand-maintained *replicas* of the migration blocks that
live inside the private `ensureGlobalDatabase()` path in `db/index.ts`, kept honest by source
guards. Extract the block into `runGlobalMigrations(db)` so production init and tests call the
same runner.

## Implementation

- New `packages/codev/src/agent-farm/db/migrations.ts`: `GLOBAL_CURRENT_VERSION` (17) and
  `runGlobalMigrations(db, options?)`. The v2→v17 sequence moved over verbatim; only two
  seams were added, both defaulted to today's production behavior:
  - `options.log` (default `console.log`) — tests collect the per-migration lines instead of
    spamming stdout, and can assert which steps ran.
  - `options.runDir` (default `~/.codev/run`) — migration v8 renames `shepherd-*.sock` files
    on disk. Without this seam, a test driving the real chain would rename a developer's live
    sockets. This is the one genuine filesystem side effect in the chain.
- `db/index.ts` now calls `runGlobalMigrations(db)` on the existing-database path and imports
  `GLOBAL_CURRENT_VERSION` for the fresh-install marker stamping. Both are re-exported from
  `db/index.ts` so no callsite has to learn a new module.

Note: the runner is only safe on a database that reached its recorded version through
migrations. A fresh GLOBAL_SCHEMA database with no markers would fail at v5 (which selects
`terminal_sessions.project_path`) — which is exactly why `ensureGlobalDatabase` stamps every
marker on the fresh path instead of running the chain. Behavior unchanged; now documented.

## Tests

`spec-1313-migration.test.ts` rewritten to drive the real runner (no replicas). Same v15 / v16
/ v17 coverage as before, plus what only a callable runner makes possible:

- full v1 → v17 chain on a legacy database, stamping every marker;
- convergence of the migrated database with a fresh `GLOBAL_SCHEMA` install across **all**
  tables, columns and indexes (previously only the one table under test);
- v9's `project_path → workspace_path` data carry-over plus v13's architect `role_id` backfill,
  asserted on real rows through the table rebuilds no replica reproduced;
- v8's socket rename against an injected run directory, and a missing run directory.

Because the runner applies every outstanding step, a pre-v15 fixture now walks v15→v16→v17 in
one call — the same thing a real upgrading install does — so the v15 mailbox assertions include
`not_before`.

Source guards in `send-architect-identity.test.ts` and `bugfix-506-annotator-worktree-cwd.test.ts`
retargeted from `db/index.ts` to `db/migrations.ts` (same intent, new home).

Out of scope, left alone: `pir-832`, `bugfix-826`, `spec-755` migration tests. Those replicate
migrations of the **retired per-workspace state.db**, which has no production runner to call.

## Status

- Implement phase: code + tests written; targeted tests pass (32/32).
- Build and full suite: run before signalling `porch done`.
- Architect instruction on record: we are not cluesmith/codev maintainers — open the PR, address
  review, do NOT merge; park it for the maintainer.
