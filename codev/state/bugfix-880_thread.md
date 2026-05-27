# bugfix-880 thread

## Investigate (2026-05-27)

**Issue**: `.architect-role.md` is missing from `CODEV_GITIGNORE_ENTRIES` in `packages/codev/src/lib/scaffold.ts:12`. Result: every fresh `codev init`/`codev adopt` produces a dirty git status the first time the architect spawns (Tower writes `.architect-role.md` at workspace root via `tower-utils.ts:184`).

**Root cause confirmed** by reading:
- `packages/codev/src/lib/scaffold.ts:12` — `CODEV_GITIGNORE_ENTRIES` lists `.agent-farm/`, `.consult/`, `codev/.update-hashes.json`, `.builders/` but not `.architect-role.md`.
- `packages/codev/src/commands/update.ts` — confirmed zero gitignore handling; existing projects can't self-heal.
- `packages/codev/src/agent-farm/servers/tower-utils.ts:184` — confirms architect spawn writes `.architect-role.md` to workspace root.

**Scope**: 2-part fix per issue spec.
1. Part 1: add `.architect-role.md` to `CODEV_GITIGNORE_ENTRIES`.
2. Part 2: add `backfillGitignore(targetDir, entries)` helper + wire into `codev update`.

**Fixable in BUGFIX scope**: yes, well under 300 LOC.

## Fix (2026-05-27)

Implemented per the issue spec:

**Part 1** — `packages/codev/src/lib/scaffold.ts`: added `.architect-role.md` to `CODEV_GITIGNORE_ENTRIES`. Covers fresh `codev init` (via `FULL_GITIGNORE_CONTENT`) and `codev adopt` (direct append).

**Part 2** — added `backfillGitignore(targetDir, block, options)` in `scaffold.ts`:
- Parses the managed block to extract pattern lines (ignoring comments and blanks).
- Compares with the existing `.gitignore` on a trimmed line-equality basis (avoids false-positive substring matches like `.agent-farm/x` matching `.agent-farm/`).
- Idempotent: no-op when all entries already present.
- Append-only: never deletes, reorders, or duplicates existing lines.
- Returns `{ added, alreadyPresent, skipped }`. `skipped: true` when no `.gitignore` exists at all (creation belongs to init/adopt).
- Supports `dryRun` and an injectable `today` (for deterministic header in tests).
- Appended block carries header: `# Codev (added by codev update YYYY-MM-DD)`.

Wired into `packages/codev/src/commands/update.ts`:
- Called at the end of the framework-refresh section.
- Result surfaced via `UpdateResult.gitignoreAdded` / `gitignoreSkipped`.
- Summary line: `gitignore: added <N> entries` or `gitignore: up to date` or `.gitignore: not present, skipped`.
- Honors `dryRun`.

## Tests (2026-05-27)

- `scaffold.test.ts`: new `backfillGitignore` describe block (6 cases) — appends under dated header, idempotent, preserves custom user entries, skips silently when no gitignore, respects dry-run, no duplicates on repeated invocation. Plus regression tests on `createGitignore`, `CODEV_GITIGNORE_ENTRIES`.
- `init.test.ts`, `adopt.test.ts`: extended existing assertions to verify `.architect-role.md` lands in fresh project gitignore.
- `update.test.ts`: new `gitignore backfill (issue #880)` describe (4 cases) — backfills stale gitignore, respects dry-run, skips absent gitignore, idempotent across two updates.

Full suite (`vitest run --exclude '**/e2e/**'`): **3185 passed | 13 skipped (3198)**. `tsc` clean. `porch check` passes both build and tests.

## PR + CMAP (2026-05-27)

PR #881 opened against `main`.

CMAP verdicts:
- gemini: **APPROVE**
- codex: **REQUEST_CHANGES** — legitimate gap: `updateGitignore()` short-circuited on `.agent-farm/` as a sentinel, so `codev adopt` on a project that already had a partial Codev block (e.g. `.agent-farm/` ignored but not yet `.architect-role.md`) would skip without backfilling. Bug not fully closed via the adopt path alone — required user to know they needed to also run `codev update`.
- claude: **APPROVE**

## Iteration: address codex feedback (2026-05-27)

Replaced the `.agent-farm/` sentinel short-circuit in `updateGitignore()` with a delegation to `backfillGitignore()`. Result: adopt now does line-level backfill against existing `.gitignore` files — partial Codev blocks self-heal, no duplicates, existing user entries untouched. The `alreadyPresent: true` return value now means *all* managed entries are present, not just `.agent-farm/`.

Updated the existing `scaffold.test.ts` "should not duplicate entries if already present" — it was encoding the buggy short-circuit (only `.agent-farm/` present, expected `alreadyPresent: true`). Replaced with a test that loads the *full* `CODEV_GITIGNORE_ENTRIES` block and expects `alreadyPresent: true`. Added new regression tests in both `scaffold.test.ts` and `adopt.test.ts` for the partial-block scenario.

Full suite still green: **3179 passed | 21 skipped (3200)** (two new tests; skip count fluctuates with conditional-skip tests). `tsc` clean.

