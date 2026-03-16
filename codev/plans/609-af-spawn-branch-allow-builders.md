# Plan: af spawn --branch: Allow Builders to Work on Existing PR Branches

## Metadata
- **ID**: plan-609
- **Status**: draft
- **Specification**: codev/specs/609-af-spawn-branch-allow-builders.md
- **Created**: 2026-03-16

## Executive Summary

Add a `--branch <name>` flag to `af spawn` that creates a worktree on an existing remote branch instead of creating a new one. This enables the "hand-off" workflow where a builder picks up an existing PR.

The implementation is straightforward: add the CLI flag, add a new worktree creation function that fetches an existing branch, wire it into the spawn paths (`spawnSpec` and `spawnBugfix`), and add tests.

## Success Metrics
- [ ] All specification criteria met
- [ ] `--branch` works with spir, aspir, air, bugfix, tick protocols
- [ ] Branch validation prevents shell injection
- [ ] Clear error messages for: branch not on remote, branch already checked out, invalid branch name
- [ ] Unit and E2E tests pass
- [ ] No regression in existing spawn tests

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "cli_and_validation", "title": "Phase 1: CLI Flag, Validation, and Worktree Creation"},
    {"id": "spawn_integration", "title": "Phase 2: Spawn Path Integration and Prompt Context"},
    {"id": "tests", "title": "Phase 3: Tests"}
  ]
}
```

## Phase Breakdown

### Phase 1: CLI Flag, Validation, and Worktree Creation
**Dependencies**: None

#### Objectives
- Add `--branch <name>` flag to the CLI
- Add branch name validation
- Create `createWorktreeFromBranch()` function that fetches and checks out an existing remote branch

#### Deliverables
- [ ] `--branch` option added to CLI in `cli.ts`
- [ ] `branch` field added to `SpawnOptions` in `types.ts`
- [ ] Branch name validation function (safe regex: `/^[a-zA-Z0-9._\/-]+$/`)
- [ ] `createWorktreeFromBranch()` in `spawn-worktree.ts` that:
  1. Validates branch name against safe regex
  2. Runs `git fetch origin <branch>:<branch>` to create local tracking branch
  3. Runs `git worktree add <path> <branch>` with existing branch
  4. Detects "already checked out" errors and surfaces actionable message
  5. Symlinks `.env` and `af-config.json` (same as `createWorktree`)
- [ ] Mutual exclusion check: `--branch` + `--resume` → error

#### Implementation Details
- **`packages/codev/src/agent-farm/cli.ts`**: Add `.option('--branch <name>', 'Use existing remote branch instead of creating a new one')` to the spawn command. Pass `options.branch` through to `spawn()`.
- **`packages/codev/src/agent-farm/types.ts`**: Add `branch?: string` to `SpawnOptions`.
- **`packages/codev/src/agent-farm/commands/spawn-worktree.ts`**: Add `validateBranchName()` and `createWorktreeFromBranch()` functions.
- **`packages/codev/src/agent-farm/commands/spawn.ts`**: Add `--branch` + `--resume` mutual exclusion check in `validateSpawnOptions()`. Add `--branch` + `--shell`/`--worktree`/`--task` mutual exclusion check.

#### Acceptance Criteria
- [ ] `af spawn --help` shows `--branch` option
- [ ] `af spawn 603 --protocol bugfix --branch "foo;rm -rf /"` rejects with validation error
- [ ] `af spawn 603 --protocol bugfix --branch nonexistent-branch` fails with "not found on remote" error
- [ ] `af spawn 603 --protocol bugfix --branch --resume` fails with mutual exclusion error
- [ ] `createWorktreeFromBranch()` fetches remote branch and creates worktree correctly

#### Test Plan
- **Unit Tests**: Branch name validation (valid names, invalid names with metacharacters)
- **Unit Tests**: `createWorktreeFromBranch()` with mocked git commands

---

### Phase 2: Spawn Path Integration and Prompt Context
**Dependencies**: Phase 1

#### Objectives
- Wire `--branch` into `spawnSpec()` and `spawnBugfix()` so they use `createWorktreeFromBranch()` when `--branch` is provided
- Inject branch context into the builder prompt
- Handle worktree directory naming (slugify the branch name)

#### Deliverables
- [ ] `spawnSpec()` uses `createWorktreeFromBranch()` when `options.branch` is set
- [ ] `spawnBugfix()` uses `createWorktreeFromBranch()` when `options.branch` is set
- [ ] Worktree directory name derived from slugified branch name (e.g., `builder/bugfix-603-slug` → `builder-bugfix-603-slug`)
- [ ] Builder prompt includes: "You are continuing work on existing branch `<branch>`. This branch may have commits from another contributor."
- [ ] The branch name (not the auto-generated one) is used for git operations and stored in builder state

#### Implementation Details
- **`packages/codev/src/agent-farm/commands/spawn.ts`**:
  - In `spawnSpec()`: When `options.branch` is set, derive `worktreeName` by slugifying the branch name. Use `createWorktreeFromBranch()` instead of `createWorktree()`. Set `branchName = options.branch` (the actual branch, not auto-generated).
  - In `spawnBugfix()`: Same pattern as `spawnSpec()`.
  - Add a helper `slugifyBranchName()` that converts branch names with slashes to directory-safe names (replace `/` with `-`, then apply existing `slugify` logic).
- **`packages/codev/src/agent-farm/commands/spawn-roles.ts`**: Add `existingBranch` to `TemplateContext` so the prompt template can include branch continuation context.

#### Acceptance Criteria
- [ ] `af spawn 603 --protocol bugfix --branch builder/bugfix-603-slug` creates worktree at `.builders/builder-bugfix-603-slug`
- [ ] The builder's prompt mentions continuing work on the branch
- [ ] The builder state records the correct (user-specified) branch name
- [ ] Pushing from the worktree goes to the correct remote branch

#### Test Plan
- **Unit Tests**: Worktree naming from branch name slugification
- **Integration Tests**: End-to-end spawn with `--branch` flag (mocked git/tower)

---

### Phase 3: Tests
**Dependencies**: Phase 2

#### Objectives
- Comprehensive unit tests for all new functions
- E2E test for the full `--branch` spawn flow

#### Deliverables
- [ ] Unit tests for `validateBranchName()` — valid names, invalid names, edge cases
- [ ] Unit tests for `createWorktreeFromBranch()` — happy path, branch not found, already checked out
- [ ] Unit tests for `validateSpawnOptions()` — `--branch` mutual exclusion with `--resume`, `--shell`, `--task`, `--worktree`
- [ ] Unit tests for worktree directory naming from branch names
- [ ] E2E test: spawn with `--branch` flag end-to-end

#### Implementation Details
- **`packages/codev/tests/unit/spawn-worktree.test.ts`**: Add tests for `validateBranchName()` and `createWorktreeFromBranch()`
- **`packages/codev/tests/unit/spawn.test.ts`**: Add tests for `--branch` validation in `validateSpawnOptions()`
- **`packages/codev/tests/e2e/`**: Add E2E test for branch spawn flow

#### Acceptance Criteria
- [ ] All new unit tests pass
- [ ] All existing tests still pass
- [ ] E2E test validates the complete flow
- [ ] No reduction in test coverage

#### Test Plan
- Run full test suite: `npm test` from `packages/codev/`
- Run E2E tests: `npx playwright test` from `packages/codev/`

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Shell injection via branch name | Low | High | Validate against safe regex before any shell command |
| Branch already checked out | Medium | Low | Detect git error and surface actionable message |
| Git fetch fails (network/auth) | Low | Medium | Let git's error propagate — it's already clear |

## Validation Checkpoints
1. **After Phase 1**: `createWorktreeFromBranch()` works standalone with a real git repo
2. **After Phase 2**: Full `af spawn --branch` flow works end-to-end manually
3. **After Phase 3**: All tests pass, no regressions
