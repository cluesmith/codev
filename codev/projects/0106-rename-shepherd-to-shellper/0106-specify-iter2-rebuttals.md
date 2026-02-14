# Spec 0106 — Iteration 2 Rebuttals

## Disputed: Fresh install migration conflict (Gemini)

**Claim**: Updated GLOBAL_SCHEMA with `shellper_*` columns + old v6 migration adding `shepherd_*` columns creates a conflict on fresh installs.

**False positive.** The migration system marks ALL migration versions as done on fresh installs WITHOUT executing them. Fresh installs get the current GLOBAL_SCHEMA (which will have `shellper_*` columns), then `INSERT OR IGNORE INTO _migrations (version) VALUES (N)` is called for all N — no migration code actually runs. This is the existing pattern for v1-v7.

**Evidence**: `db/index.ts` lines ~360-430 — fresh installs call `db.exec(GLOBAL_SCHEMA)` then mark all migrations as done. Migration v6's `ALTER TABLE ADD COLUMN` and v7's table rebuild never execute on fresh installs.

## Disputed: Migration idempotency / retry handling (Gemini)

**Claim**: Socket file rename after DB commit creates non-transactional split-brain if migration retries.

**False positive.** The migration system checks `SELECT version FROM _migrations WHERE version = N` before each migration. Once v8 is marked as done, it never re-runs. The file rename is best-effort (skip if file missing) which handles any edge case. This is a development tool, not a distributed database — "retry migration" isn't a supported operation.

## Disputed: "Stale session" needs formal definition (Codex)

**Claim**: The spec must define what "stale" means in persisted state, how UI reflects it, when cleanup occurs.

**Overcomplication.** SessionManager already handles unreachable sessions — if a socket doesn't exist or connection fails, the session is treated as dead. There is no new "stale" state to define. The spec's intent was simply: if a socket file can't be renamed, the session can't reconnect because the new code looks for `shellper-*.sock`. This is handled by existing error paths.

**Updated**: The spec now says "silently skips any socket files that cannot be renamed" and "sessions connected to old sockets will naturally disconnect on upgrade" — removing the ambiguous "mark as stale" language.

## Disputed: Explicit migration tests needed (Codex)

**Claim**: The spec should require explicit tests for v7→v8 migration, socket rename success/failure paths.

**Overcomplication.** This is a column rename in a development tool. The existing test suite validates behavioral correctness. The migration follows the exact same table-rebuild pattern as v7. Adding migration-specific tests for a mechanical rename would be scope creep inconsistent with the project's testing approach (v6 and v7 migrations have no dedicated migration tests either).

## Disputed: Migration execution point ambiguous (Codex)

**Claim**: "During migration or at startup" is ambiguous.

**Legitimate concern, addressed.** The updated spec now clearly specifies: all three steps (table rebuild, value UPDATE, socket file rename) happen in the same migration function. No ambiguity about execution point.
