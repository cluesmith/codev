### Iteration 1 Reviews
- gemini: APPROVE — Comprehensive plan that correctly handles atomic renaming of source, schema, and migration logic.
- codex: REQUEST_CHANGES — Plan is solid structurally, but it needs explicit migration/socket validation steps and stronger migration risk handling to satisfy spec AC #4/#5.
- claude: APPROVE — Comprehensive, well-structured rename plan with complete spec coverage, verified file references, and sound migration approach.

### Builder Response to Iteration 1
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


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
