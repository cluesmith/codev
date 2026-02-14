# Plan 0106 — Iteration 1 Rebuttals

## Addressed: Phase 1/2 must be merged (Gemini)

**Legitimate concern, addressed.** Gemini correctly identified that code references DB column names directly, so source rename and schema/migration must change atomically. The updated plan merges Phase 1 and Phase 2 into a single phase.

## Addressed: Dashboard outside grep AC scope (Claude)

**Legitimate concern, addressed.** Added explicit dashboard deliverables and a separate grep AC for `packages/codev/dashboard/src/`.

## Addressed: db/index.ts exclusion clarity (Claude)

**Legitimate concern, addressed.** Added explicit note that `db/index.ts` is intentionally NOT updated in the source rename step — its shepherd references are in old migration code.

## Disputed: Fixture-based migration integration test (Codex)

**Overcomplication.** The existing migration system (v1-v7) has zero dedicated migration tests. Adding fixture-based migration tests for a column rename would be inconsistent with the project's testing approach and constitute scope creep. The table-rebuild pattern is proven in v7. The existing terminal-sessions test suite validates the schema works correctly.

## Disputed: Explicit socket prefix runtime test (Codex)

**Overcomplication.** The socket path pattern (`shellper-*.sock`) is generated in `session-manager.ts` and used throughout. The existing test suite for session-manager covers this code path. Adding a dedicated assertion for the string prefix of a socket filename is testing implementation details, not behavior.

## Disputed: Migration edge-case/idempotency mitigations (Codex)

**Already handled by existing pattern.** The migration checks `SELECT version FROM _migrations WHERE version = 8` before running — it never re-runs. The try-catch wrapper (consistent with v6/v7) handles any edge cases. Socket file rename is best-effort (skip if missing). There are no "partial rename states" to handle — SQLite operations within a migration are transactional.

## Disputed: Fresh install logic correction (Gemini)

**Mixed.** Gemini claims fresh installs run all migrations rather than marking them as done. Looking at the actual code, fresh installs DO run `db.exec(GLOBAL_SCHEMA)` which creates the table with current columns, then each migration's `SELECT version FROM _migrations WHERE version = N` check determines if it runs. For v8 specifically, the try-catch wrapper handles both fresh (table already has shellper_* columns) and upgrade (table needs rebuild) paths correctly. The implementation approach is sound regardless of the exact fresh-install mechanism.
