# Plan: afx spawn --branch: Allow Builders to Work on Existing PR Branches

## Metadata
- **ID**: plan-609
- **Status**: draft
- **Specification**: codev/specs/609-af-spawn-branch-allow-builders.md
- **Created**: 2026-03-16

## Executive Summary

Add a `--branch <name>` flag to `afx spawn` that creates a worktree on an existing remote branch instead of creating a new one. This enables the "hand-off" workflow where a builder picks up an existing PR.

The implementation is straightforward: add the CLI flag, add a new worktree creation function that fetches an existing branch, wire it into the spawn paths (`spawnSpec` and `spawnBugfix`), and add tests.

**Routing note**: `getSpawnMode()` routes all issue-based non-bugfix spawns (spir, aspir, air, tick) through `spawnSpec()`, while bugfix goes through `spawnBugfix()`. So wiring `--branch` into these two functions covers all five protocol types.

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
    {"id": "cli_and_worktree", "title": "Phase 1: CLI Flag, Validation, Worktree Creation, and Unit Tests"},
    {"id": "spawn_integration_and_tests", "title": "Phase 2: Spawn Path Integration, Prompt Context, and E2E Tests"}
  ]
}
```

## Phase Breakdown

### Phase 1: CLI Flag, Validation, Worktree Creation, and Unit Tests
**Dependencies**: None

#### Objectives
- Add `--branch <name>` flag to the CLI
- Add branch name validation
- Create `createWorktreeFromBranch()` function that fetches and checks out an existing remote branch
- Extract shared symlink setup from `createWorktree()`
- Write unit tests for all new functions

#### Deliverables
- [ ] `--branch` option added to CLI in `cli.ts`
- [ ] `branch` field added to `SpawnOptions` in `types.ts`
- [ ] `validateBranchName()` function (safe regex: `/^[a-zA-Z0-9._\/-]+$/`)
- [ ] `createWorktreeFromBranch()` in `spawn-worktree.ts` that:
  1. Validates branch name against safe regex
  2. Runs `git fetch origin` to update remote refs
  3. Checks `git worktree list` for "already checked out" before attempting `git worktree add`
  4. Runs `git worktree add <path> -b <branch> origin/<branch>` (creates local tracking branch from remote; if local branch already exists, falls back to `git worktree add <path> <branch>`)
  5. Calls shared symlink setup helper
- [ ] Extract symlink setup from `createWorktree()` into a shared `symlinkConfigFiles()` helper (used by both `createWorktree` and `createWorktreeFromBranch`)
- [ ] Mutual exclusion checks in `validateSpawnOptions()`:
  - `--branch` + `--resume` → error
  - `--branch` + `--shell`/`--worktree`/`--task` → error
  - `--branch` without issue number → error (protocol-only mode rejected)
- [ ] Skip uncommitted changes check when `--branch` is set (line ~720 of spawn.ts) — `--branch` fetches from remote, not HEAD, so dirty worktree is irrelevant
- [ ] Unit tests for `validateBranchName()` — valid names, invalid names with metacharacters
- [ ] Unit tests for `createWorktreeFromBranch()` — happy path, branch not found, already checked out
- [ ] Unit tests for `validateSpawnOptions()` — `--branch` mutual exclusion cases

#### Implementation Details
- **`packages/codev/src/agent-farm/cli.ts`**: Add `.option('--branch <name>', 'Use existing remote branch instead of creating a new one')` to the spawn command. Pass `options.branch` through to `spawn()`.
- **`packages/codev/src/agent-farm/types.ts`**: Add `branch?: string` to `SpawnOptions`.
- **`packages/codev/src/agent-farm/commands/spawn-worktree.ts`**:
  - Add `validateBranchName(name: string): void` — throws on invalid names.
  - Add `symlinkConfigFiles(config: Config, worktreePath: string): void` — extracted from `createWorktree()`.
  - Refactor `createWorktree()` to call `symlinkConfigFiles()`.
  - Add `createWorktreeFromBranch(config: Config, branch: string, worktreePath: string): Promise<void>`.
- **`packages/codev/src/agent-farm/commands/spawn.ts`**: Update `validateSpawnOptions()` with mutual exclusion checks. Add `options.branch` to the uncommitted changes skip condition.

#### Git strategy for `createWorktreeFromBranch()`:
```
git fetch origin                          # update all remote refs
git worktree list                         # check if branch is already checked out
git worktree add <path> -b <local> origin/<branch>   # create worktree with new local tracking branch
# If local branch already exists:
git worktree add <path> <branch>          # use existing local branch
```

This avoids the `git fetch origin <branch>:<branch>` pitfall (fails on non-fast-forward if local branch exists and has diverged).

#### Acceptance Criteria
- [ ] `afx spawn --help` shows `--branch` option
- [ ] `afx spawn 603 --protocol bugfix --branch "foo;rm -rf /"` rejects with validation error
- [ ] `afx spawn 603 --protocol bugfix --branch nonexistent-branch` fails with "not found on remote" error
- [ ] `afx spawn 603 --protocol bugfix --branch some-branch --resume` fails with mutual exclusion error
- [ ] `afx spawn --protocol maintain --branch some-branch` fails (no issue number)
- [ ] `createWorktreeFromBranch()` fetches remote branch and creates worktree correctly
- [ ] All unit tests pass

---

### Phase 2: Spawn Path Integration, Prompt Context, and E2E Tests
**Dependencies**: Phase 1

#### Objectives
- Wire `--branch` into `spawnSpec()` and `spawnBugfix()` so they use `createWorktreeFromBranch()` when `--branch` is provided
- Inject branch context into the builder prompt
- Handle worktree directory naming (must be compatible with existing detection patterns)
- Write E2E tests

#### Deliverables
- [ ] `spawnSpec()` uses `createWorktreeFromBranch()` when `options.branch` is set
- [ ] `spawnBugfix()` uses `createWorktreeFromBranch()` when `options.branch` is set
- [ ] Worktree directory uses `<protocol>-<issueNumber>-branch-<slug>` pattern to maintain compatibility with `inferProtocolFromWorktree()`, `findExistingBugfixWorktree()`, and porch's `detectProjectIdFromCwd()`
- [ ] Builder prompt includes: "You are continuing work on existing branch `<branch>`. This branch may have commits from another contributor."
- [ ] The user-specified branch name (not the auto-generated one) is used for git operations and stored in builder state
- [ ] E2E test: spawn with `--branch` flag end-to-end

#### Implementation Details
- **`packages/codev/src/agent-farm/commands/spawn.ts`**:
  - In `spawnSpec()`: When `options.branch` is set:
    - Set `branchName = options.branch` (the actual branch, not auto-generated)
    - Derive `worktreeName = `${protocol}-${strippedId}-branch-${slugify(options.branch)}`` — the `branch-` infix distinguishes from auto-generated names while preserving the `<protocol>-<id>-` prefix that detection utilities scan for
    - Use `createWorktreeFromBranch()` instead of `createWorktree()`
    - Add `existingBranch: options.branch` to template context
  - In `spawnBugfix()`: Same pattern as `spawnSpec()`
- **`packages/codev/src/agent-farm/commands/spawn-roles.ts`**: Add `existingBranch?: string` to `TemplateContext`. When present, inject continuation context into the builder prompt (inline in `buildPromptFromTemplate` or as part of the template data).
- **`packages/codev/tests/e2e/`**: Add E2E test for branch spawn flow

#### Worktree naming examples:
```
afx spawn 603 --protocol bugfix --branch builder/bugfix-603-propagate-opaque-string-
→ worktree: .builders/bugfix-603-branch-builder-bugfix-603-propagate
→ branch: builder/bugfix-603-propagate-opaque-string- (the actual remote branch)

afx spawn 315 --protocol spir --branch builder/spir-315-some-feature
→ worktree: .builders/spir-315-branch-builder-spir-315-some-featur
→ branch: builder/spir-315-some-feature (the actual remote branch)
```

This pattern ensures:
- `inferProtocolFromWorktree()` matches on `parts[1]` (the issue number)
- `findExistingBugfixWorktree()` matches on `bugfix-{N}-` prefix
- Porch detects project ID from the `<id>-` segment in the path

#### Acceptance Criteria
- [ ] `afx spawn 603 --protocol bugfix --branch builder/bugfix-603-slug` creates worktree at `.builders/bugfix-603-branch-builder-bugfix-603-slug`
- [ ] The builder's prompt mentions continuing work on the branch
- [ ] The builder state records the correct (user-specified) branch name
- [ ] `inferProtocolFromWorktree()` still works for `--branch`-created worktrees
- [ ] All unit tests pass, all existing tests pass
- [ ] E2E test validates the complete flow

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Shell injection via branch name | Low | High | Validate against safe regex before any shell command |
| Branch already checked out | Medium | Low | Pre-check via `git worktree list` before attempting add |
| Git fetch fails (network/auth) | Low | Medium | Let git's error propagate — it's already clear |
| Local branch exists and diverged | Low | Medium | Try `-b` first, fall back to using existing local branch |
| Fetched branch is stale (behind main) | Medium | Low | Architect's judgment call — not our problem to solve |

## Validation Checkpoints
1. **After Phase 1**: `createWorktreeFromBranch()` works standalone with a real git repo; unit tests pass
2. **After Phase 2**: Full `afx spawn --branch` flow works end-to-end; E2E test passes; no regressions
