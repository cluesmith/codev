# Plan Iteration 1 Rebuttals

## Disputed: Missing acceptance-test coverage for socket behavior and migration correctness

Codex requests explicit upgrade-path verification (seed old DB + old socket path/file, run migration, assert renamed columns/data/filesystem effects).

**Rebuttal**: The spec explicitly states under "Session Continuity":

> **Clean break is acceptable.** This is a development tool where sessions are ephemeral. [...] No dual-path fallback logic or backward-compatibility shims are needed. Sessions connected to old sockets will naturally disconnect on upgrade; users restart them.

The migration follows the v7 table-rebuild pattern which is already proven. Writing a dedicated migration integration test would be over-engineering for what the spec scopes as a best-effort clean break. The existing test suite (`npm test`) already covers:

1. Socket path patterns in `session-manager.test.ts` — after rename, these validate `shellper-*` prefix
2. Schema correctness via `terminal-sessions.test.ts` — validates column names match code expectations
3. Build verification via `npm run build` — confirms all types and imports are consistent

Codex's suggestion of seeding an old DB and running migration is valuable in general but is out of scope for this spec. The spec's AC #4 ("Socket files are created with `shellper-*` prefix") is satisfied by the existing session-manager tests that create socket paths, and AC #5 ("SQLite migration handles column rename cleanly") is satisfied by the migration existing and following the proven v7 pattern.

## Disputed: Risk section understates migration/file-rename failure modes

Codex requests explicit handling of partial filesystem rename, idempotency/re-run behavior, and recovery expectations.

**Rebuttal**: The spec explicitly addresses this under "Session Continuity" and the migration section:

> Silently skips any socket files that cannot be renamed

The migration is designed to be a one-shot operation with graceful degradation (skip files that can't be renamed). The table-rebuild pattern is atomic within SQLite (wrapped in a transaction). Partial filesystem rename is handled by the skip-on-error design. Idempotency is not a concern because migrations run exactly once (tracked by version number).

Adding risk mitigation for "partial filesystem rename" and "recovery expectations" would contradict the spec's explicit design of "clean break is acceptable."
