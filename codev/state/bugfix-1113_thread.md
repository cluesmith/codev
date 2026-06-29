# bugfix-1113 thread

## Issue
`consult --type integration pr <N>` produces 10k+ line diffs in repos with a long-lived
integration branch (`ci`) ahead of `main`. No way to anchor the diff on the integration branch.

## Investigation (complete)
Root cause confirmed by reading `packages/codev/src/commands/consult/index.ts`:
- `--type integration` (builder ctx line ~1569, architect ctx line ~1740) → `buildPRQuery(prId)`
  → `fetchPRDiff` → `pr-diff` forge concept → `gh pr diff <N>`.
- `gh pr diff` is anchored on the PR's **host-recorded base** (merge-base of base↔head).
  When head was branched off `ci` but PR targets `main`, the diff swallows the whole
  `ci`-over-`main` delta.
- The `impl` path was already hardened (#777/#784): it computes the diff locally as
  `git diff origin/<base>...origin/<head>` (three-dot), verifying both refs up front and
  failing loudly. The `integration` path never got this.

## Fix plan (BUGFIX scope, design prescribed in issue)
1. `--base <ref>` flag + `consult.integrationBranch` config (`.codev/config.json`).
2. New `computeLocalPRDiff(workspaceRoot, base, head)` — mirrors impl path: fetch both,
   verify both `origin/<ref>` resolve (fail loudly w/ `git fetch` hint), then
   `git diff origin/<base>...origin/<head>` (three-dot) + name-only for changed files.
   execFileSync argv arrays (ref injection-safe, same as impl path).
3. `buildPRQuery(prId, localDiff?)` — when override present, use local diff + changed files
   instead of `gh pr diff`; still fetch PR info+comments. Keep on-disk diff handoff.
4. Wire both integration cases (builder: head = current branch; architect: head = pr.headRefName).
5. Default (no flag/config) → unchanged `gh pr diff`.
6. Guard: `--base` only valid with `--type integration` (fail-fast).

## Implementation (done)
Files changed:
- `packages/codev/src/lib/config.ts` — added `consult.integrationBranch` to CodevConfig.
- `packages/codev/src/commands/consult/index.ts` — `base?` option; `resolveIntegrationBase()`,
  `computeLocalPRDiff()`; `buildPRQuery(prId, localDiff?)`; wired both integration cases
  (builder head=current branch, architect head=pr.headRefName); fail-fast guard `--base`
  only valid with `--type integration`; exported helpers for tests.
- `packages/codev/src/cli.ts` — `--base <ref>` flag, passed through.
- `codev/resources/commands/consult.md` — documented `--base` + config.
- `packages/codev/src/__tests__/bugfix-1113-integration-base.test.ts` — regression tests
  (8 tests: three-dot override excludes ci-over-main delta; bug demo; fail-loud on bad
  base/head; resolveIntegrationBase precedence; --base guard).

Net diff ~150 LOC + 144 LOC test. Well within BUGFIX scope.

## Test status
- New test: 8/8 pass, stable across 3 runs (no flakiness).
- consult.test.ts + pr-query.test.ts: 58/58 pass.
- Worktree env was incomplete on spawn (no node_modules, no skeleton/, core subpaths
  unlinked). Ran `pnpm install` + `pnpm copy-skeleton` + `tsc`. Full-suite failures are
  all environmental (terminal/shellper need built dist + PTY; core package subpath exports
  unresolved) — none touch consult/config/cli. Verifying with full log.

## Verification (final)
- New regression test: 8/8 pass, stable across 3 consecutive runs.
- Full unit suite (after `pnpm install` + building `@cluesmith/codev-core` + `tsc` dist +
  `copy-skeleton`): **170 files passed, 3393 tests passed, 0 failed** (48 skipped).
- Full `pnpm build`: green (types→core→artifact-canvas→codev + dashboard + skeleton).
- The 39 transient failures seen mid-investigation were ALL environmental (worktree was
  spawned without node_modules / built core / dist / skeleton). Building core+dist cleared
  them; verified a sample (github, agent-names, pr-ready-872, tower-messages = 138 tests) green.
  None touched consult/config/cli.

## PR
- PR #1114 opened against cluesmith/codev main (Fixes #1113).

## CMAP (round 1)
- claude: APPROVE (HIGH) — clean focused fix mirroring impl-path machinery; strong tests.
- gemini: APPROVE (HIGH) — correct base override; solid regression suite.
- codex: REQUEST_CHANGES (HIGH) — blanket try/catch in resolveIntegrationBase swallowed
  loadConfig errors (malformed config / legacy af-config.json) → broken consult.integrationBranch
  would silently revert to gh pr diff (the overflow this fix prevents). VALID finding.

## CMAP resolution (2 codex findings, both valid, both addressed)
1. Config errors swallowed: removed the try/catch in resolveIntegrationBase so loadConfig
   errors propagate (fail-fast; matches every other caller). --base short-circuits before
   the read → still works with a broken config. +2 tests. Commit 43507a4b.
2. Skeleton doc not mirrored: mirrored the consult.md --base/integrationBranch section into
   codev-skeleton/resources/commands/consult.md (two-tree rule). packages/codev/skeleton/ is a
   gitignored build artifact. Commit 542b9048.

## Final CMAP: claude=APPROVE, gemini=APPROVE, codex=APPROVE (all HIGH, codex round 3 clean)
- PR #1114, CMAP summary comment posted.
- Final full suite: 170 files passed / 3395 tests / 0 failed. pnpm build green.

## Architect feedback (round 1 on PR) — addressed
Architect approved the core fix; asked for 2 things before the human pr gate:
1. A test driving the actual `--type integration` command path (not just helpers).
   → Added bugfix-1113-integration-dispatch.test.ts: drives resolveArchitectQuery →
   resolveIntegrationBase → computeLocalPRDiff → buildPRQuery with --base ci (forge
   stubbed, git real); asserts the query consumed the local three-dot diff (feature.txt
   only; temp file holds real change, not the stubbed gh pr diff). Exported
   resolveArchitectQuery. Stable across 3 runs, has teeth. Commit 00f6ecde.
2. Document proven-vs-deferred in the PR. → PR body now has a "Proven locally vs.
   deferred" section: diff math + wiring + fail-loud proven; the true end-to-end
   "overflowing PR now fits + verdicts" requires an adopter repo with real
   ci-ahead-of-main topology and was NOT run locally (close vs real repro PR after merge).
- Full suite after change: 171 files / 3396 tests / 0 failed.

## Status
- Phase: PR. Re-requesting `pr` gate. WAITING for human gate approval.
- Do NOT self-merge: merge is gated by porch `pr` state, approved only by a human.
