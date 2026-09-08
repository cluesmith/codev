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

## CMAP (PR review)

All three lanes APPROVE, HIGH confidence, zero blocking issues.

- **gemini** — "Clean extraction of runGlobalMigrations with safe test seams and comprehensive
  full-chain test coverage."
- **codex** — "Clean, behavior-preserving extraction with strong real-runner migration coverage."
- **claude** — verified the extraction is a *mechanical* move (diffed it: only the three declared
  edits, zero SQL changed) and reproduced the full suite independently. Raised three
  non-blocking minors, all now fixed in commit 5a70fbb2:
  1. the `runGlobalMigrations` JSDoc claimed unqualified safety — the marker-less-GLOBAL_SCHEMA
     caveat now sits on the function, since it is publicly re-exported;
  2. `pir-832` / `spec-755` / `bugfix-826` still pointed at "db/index.ts's vN block", which now
     holds no migrations and whose vN is a *different* migration from the state.db vN they test;
  3. the convergence test compared tables only, so `builders_updated_at` was uncovered — it now
     compares triggers too.

  It also noted something I had not: the full-chain marker assertion is a **bidirectional drift
  guard on `GLOBAL_CURRENT_VERSION`** — adding a v18 without bumping the constant fails, and so
  does bumping it without the migration. Spec 1313 actually shipped that mistake once.

## Architect CMAP (integration review, risk tier High)

Unanimous APPROVE across all three lanes, zero blocking. Four non-blocking findings; response
posted as a PR comment.

- **1 — precondition guard: accepted, implemented** (`235b490c`). The runner now rejects a
  marker-less GLOBAL_SCHEMA database at entry (workspace_path-shaped but no v9 marker) with a
  named error, instead of dying at v5 on `no such column: project_path`. Unreachable in
  production; it exists because the extraction is precisely what made the runner callable from
  anywhere. Two tests cover it.
- **3 — pragma fidelity: accepted, implemented** (same commit). The harness now sets production's
  full pragma set rather than WAL alone — it matters for v7–v9's DROP + RENAME rebuilds.
- **4 — stale replica comments: already done** in `5a70fbb2`, pushed before the review landed.
  The arch.md line is architect/MAINTAIN scope.
- **2 — redundant `GLOBAL_CURRENT_VERSION` source guard: left in place, rebutted.** The new
  full-chain marker assertion does cover it better, but deleting an assertion from a Spec 1313
  test changes *that* test's intent rather than this issue's. Offered to drop it either way.

## Status

- Implement phase: complete. Build green; full suite green (4861 passed, 48 skipped, 0 failures).
- PR phase: **PR #1485 open**, CMAP fixes pushed, `porch check` green (pr_exists, e2e_tests),
  PR recorded via `porch done --pr 1485 --branch builder/air-1476`.
- **pr gate approved by the human** (relayed by the architect); `porch approve 1476 pr` run by me,
  then `porch done 1476` → **PROTOCOL COMPLETE**.
- **PR #1485 is deliberately left OPEN and unmerged.** We are not cluesmith/codev maintainers; the
  PR is parked for a maintainer to merge. That is why the post-merge steps a builder would normally
  run — `porch done --merged`, closing the issue, worktree cleanup — are not done here. Whoever
  picks this up after the merge should run them.
