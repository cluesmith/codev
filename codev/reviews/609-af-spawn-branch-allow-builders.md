# Review: afx spawn --branch — Allow Builders to Work on Existing PR Branches

## Summary

Added a `--branch <name>` flag to `afx spawn` that creates a worktree on an existing remote branch instead of creating a new one. This enables the "hand-off" workflow where a builder picks up an existing PR to complete another contributor's work.

**Files modified**: 5 source files, 2 test files
- `packages/codev/src/agent-farm/types.ts` — Added `branch` to `SpawnOptions`
- `packages/codev/src/agent-farm/cli.ts` — Added `--branch` CLI option
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts` — Added `validateBranchName()`, `createWorktreeFromBranch()`, extracted `symlinkConfigFiles()`
- `packages/codev/src/agent-farm/commands/spawn.ts` — Wired `--branch` into `spawnSpec()` and `spawnBugfix()`, added mutual exclusion checks, skip uncommitted changes check
- `packages/codev/src/agent-farm/commands/spawn-roles.ts` — Added `existing_branch` to `TemplateContext`
- `packages/codev/src/agent-farm/__tests__/spawn-worktree.test.ts` — Tests for validation, worktree creation, symlink helper
- `packages/codev/src/agent-farm/__tests__/spawn.test.ts` — Tests for mutual exclusion validation
- `packages/codev/src/__tests__/cli/af.e2e.test.ts` — E2E tests for CLI flag

## Spec Compliance

- [x] `afx spawn <id> --protocol <proto> --branch <name>` creates a worktree on the specified existing remote branch
- [x] The branch must exist on the remote; if not, command fails with clear error
- [x] If the branch is already checked out in another worktree, command fails with actionable error
- [x] `--branch` is mutually exclusive with `--resume` (error if both provided)
- [x] `--branch` works with all protocol types: spir, aspir, air, bugfix, tick
- [x] Builder prompt includes the branch name and continuation notice
- [x] Branch names validated against safe regex before any shell commands
- [x] Pushing from the builder updates the existing PR (no new PR created)
- [x] Unit tests cover new flag parsing, validation, and worktree creation
- [x] E2E tests validate CLI flag visibility and error paths

## Deviations from Plan

- **Worktree naming**: Plan specified `<protocol>-<id>-branch-<slug>`. Implemented as specified. No deviation.
- **Git strategy**: Plan specified `git fetch origin` + `git worktree add -b`. Implemented with fallback to `git worktree add <branch>` when local branch already exists. This was specified in the plan.
- **E2E test scope**: Plan listed "E2E test: spawn with --branch flag end-to-end." Full end-to-end spawn requires Tower, so E2E tests cover CLI validation paths (help output, error cases) through the built binary instead.

## Lessons Learned

### What Went Well
- The 3-way consultation caught real issues early (worktree naming compatibility, git fetch brittleness, missing edge cases)
- Extracting `symlinkConfigFiles()` as a shared helper improved code quality beyond the spec's requirements
- Pre-checking via `git worktree list --porcelain` gives deterministic error messages

### Challenges Encountered
- **Worktree naming compatibility**: Initial plan used branch-name-based directory names that would break `inferProtocolFromWorktree()` and porch project detection. Consultation caught this; resolved with the `<protocol>-<id>-branch-<slug>` pattern.
- **Try/catch swallowing fatal()**: The "already checked out" detection initially put `fatal()` inside a try/catch meant to catch git errors, which swallowed the fatal. Fixed by extracting the check result before calling fatal.

### What Would Be Done Differently
- Would have checked detection utility patterns earlier before proposing worktree naming
- Would have added `validateSpawnOptions` tests from the start in Phase 1 rather than being caught by consultation

## Technical Debt
- None introduced. The implementation follows existing patterns.

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini
- **Concern**: Git fetch limitation — `git fetch origin <branch>` doesn't create local tracking branch
  - **Addressed**: Changed to `git fetch origin` + `git worktree add -b` with fallback
- **Concern**: Contradictory worktree naming between Constraints and Approach sections
  - **Addressed**: Resolved to use branch-name-slugified naming consistently
- **Concern**: Shell injection risk from user-supplied branch names
  - **Addressed**: Added `validateBranchName()` with safe regex
- **Concern**: Branch already checked out edge case missing
  - **Addressed**: Added pre-check via `git worktree list`

#### Codex
- **Concern**: Same naming contradiction and remote tracking behavior
  - **Addressed**: Same fixes as Gemini
- **Concern**: Builder prompt requirements underspecified
  - **Addressed**: Specified exact prompt text in spec

#### Claude
- **Concern**: Same naming contradiction, minor git command inaccuracy, missing edge case
  - **Addressed**: Same fixes

### Plan Phase (Round 1)

#### Gemini
- **Concern**: Worktree naming breaks core detection logic
  - **Addressed**: Changed to `<protocol>-<id>-branch-<slug>` pattern
- **Concern**: `git fetch origin <branch>:<branch>` is brittle
  - **Addressed**: Changed to `git fetch origin` + DWIM-style worktree add
- **Concern**: Missing mutual exclusion for protocol-only mode
  - **Addressed**: Added `--branch` without issue number check

#### Codex
- **Concern**: Air/tick protocol coverage unclear
  - **Rebutted**: All non-bugfix protocols route through `spawnSpec()`, which is documented in the plan
- **Concern**: Preflight check for existing local branch
  - **Addressed**: Fallback logic handles existing local branches

#### Claude
- **Concern**: `--branch` should skip uncommitted changes check
  - **Addressed**: Added to skip condition
- **Concern**: Test phasing ambiguity
  - **Addressed**: Consolidated to 2 phases with tests in each
- **Concern**: Symlink setup should be shared
  - **Addressed**: Extracted `symlinkConfigFiles()` helper

### Phase 1 Implementation (Round 1)

All three reviewers: Missing `validateSpawnOptions()` unit tests in `spawn.test.ts`
- **Addressed**: Added 7 test cases covering all mutual exclusion rules

### Phase 2 Implementation (Round 1)

All three reviewers: Missing E2E test
- **Addressed**: Added 3 E2E tests to `af.e2e.test.ts` (CLI validation paths)

## Architecture Updates

No architecture updates needed. This feature adds a new CLI flag and an alternative worktree creation path, but does not introduce new subsystems, data flows, or architectural patterns. The existing spawn architecture (CLI → spawn.ts → spawn-worktree.ts) is unchanged.

## Lessons Learned Updates

No lessons learned updates needed. The main insight (consultation catching detection-utility compatibility issues) reinforces existing lessons about testing against upstream patterns. No novel anti-patterns or debugging techniques emerged.

## Flaky Tests

No flaky tests encountered.

## Follow-up Items
- Future enhancement: `--pr <number>` convenience flag that auto-resolves the branch name from a PR number via `gh pr view`
