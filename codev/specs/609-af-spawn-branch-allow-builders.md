# Specification: afx spawn --branch: Allow Builders to Work on Existing PR Branches

## Metadata
- **ID**: spec-609
- **Status**: draft
- **Created**: 2026-03-16

## Clarifying Questions Asked

1. **Q**: What happens to the original PR author attribution when a builder pushes to their branch?
   **A**: Not a concern — the git history preserves original commits. New commits from the builder are additive.

2. **Q**: Should the builder be able to create the branch if it doesn't exist remotely?
   **A**: No. The branch must exist on the remote. This feature is specifically for picking up existing work.

3. **Q**: Does the worktree naming need to match the branch name?
   **A**: The worktree directory name should follow existing conventions but the git branch inside it will be the specified one instead of a freshly created one.

4. **Q**: Should this work with `--resume`?
   **A**: No. `--resume` reconnects to an existing worktree. `--branch` creates a new worktree on an existing remote branch. They are mutually exclusive.

## Problem Statement

When a team member opens a PR and the architect identifies issues, there's currently no way to spawn a builder to fix those issues on the same branch. `afx spawn` always creates a new branch from HEAD, which means:

- The original PR must be closed to avoid conflicts
- Review history and context from the original PR is lost
- The new PR has no continuity with the original work

This is a real workflow gap. The use case that prompted this: Nat opened PR #604 on branch `builder/bugfix-603-propagate-opaque-string-`. The architect reviewed it and found issues. Rather than waiting for Nat, we wanted a builder to fix the remaining issues on the same branch/PR — but there was no way to do it.

## Current State

`afx spawn` always creates a new branch from HEAD via `createWorktree()` in `spawn-worktree.ts`:

```
git branch ${branchName}        # creates new branch from HEAD
git worktree add "${worktreePath}" ${branchName}
```

The branch name is deterministically generated from the protocol, issue number, and slug. There is no option to use an existing branch.

**Current workaround**: Close the original PR, spawn a fresh builder, re-do the work. This loses all review context.

## Desired State

A new `--branch <name>` flag on `afx spawn` that:

1. Fetches the specified branch from the remote
2. Creates a worktree checked out to that branch (instead of creating a new branch)
3. Lets the builder work normally — commits and pushes go to the same branch, updating the existing PR
4. Injects context into the builder prompt so it knows it's continuing someone else's work

Example usage:
```bash
afx spawn 603 --protocol bugfix --branch builder/bugfix-603-propagate-opaque-string-
```

## Stakeholders
- **Primary Users**: Architects using `afx spawn` to delegate work on existing PRs
- **Secondary Users**: Builders that need context about the branch they're continuing
- **Technical Team**: Codev maintainers

## Success Criteria
- [ ] `afx spawn <id> --protocol <proto> --branch <name>` creates a worktree on the specified existing remote branch
- [ ] The branch must exist on the remote; if not, the command fails with a clear error
- [ ] If the branch is already checked out in another worktree, the command fails with a clear, actionable error
- [ ] `--branch` is mutually exclusive with `--resume` (error if both provided)
- [ ] `--branch` works with all protocol types: spir, aspir, air, bugfix, tick (not with `--task` or `--shell` which have no issue context)
- [ ] The builder prompt includes the branch name and a note that the builder is continuing existing work on that branch
- [ ] Branch names are validated against a safe regex before any shell commands run
- [ ] Pushing from the builder updates the existing PR (no new PR created)
- [ ] Unit tests cover the new flag parsing, validation, and worktree creation path
- [ ] E2E test validates the end-to-end spawn-with-branch flow

## Constraints

### Technical Constraints
- Must use `git worktree add` with an existing branch (not create a new one)
- The branch must be fetched from remote and a local tracking branch created before worktree creation (e.g., `git fetch origin <branch>:<branch>` to create the local branch from the remote)
- Worktree directory naming: use `<protocol>-<issueNumber>-branch-<slugified-branch>` pattern to preserve compatibility with existing detection utilities (e.g., `bugfix-603-branch-builder-bugfix-603-slug`)
- Must not break existing spawn flows — all current tests must continue to pass
- If the branch is already checked out in another worktree or the main working directory, fail with a clear, actionable error (e.g., "Branch 'X' is already checked out at '/path'. Switch that checkout to a different branch first.")
- Branch names from user input must be validated against a safe regex (e.g., matching valid git branch name characters only) before being passed to shell commands — do not rely on existing auto-generated-only patterns

### Business Constraints
- None — this is an internal tooling improvement

## Assumptions
- The remote branch exists and is accessible via `git fetch`
- The user has push access to the remote branch
- The specified branch has a corresponding open PR (not enforced, but expected)

## Solution Approaches

### Approach 1: Flag-based branch override in createWorktree

Add a `--branch` CLI flag that passes through to `createWorktree()`. When provided:
1. Validate the branch name against a safe regex (alphanumeric, hyphens, underscores, slashes, dots)
2. `git fetch origin <branch>:<branch>` to fetch and create the local tracking branch
3. Skip `git branch <branchName>` (branch already exists)
4. Use `git worktree add <path> <branch>` with the existing local branch
5. If `git worktree add` fails because the branch is already checked out, surface a clear error
6. Proceed with normal porch initialization and prompt generation

The worktree directory name is derived from the branch name (slugified) — e.g., `builder/bugfix-603-slug` becomes directory `builder-bugfix-603-slug` under `.builders/`.

**Pros**:
- Minimal change — modifies only the worktree creation path
- Fits naturally into the existing spawn flow
- Easy to understand and test

**Cons**:
- None significant

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: Auto-detect branch from PR number

Instead of specifying the branch name, accept a `--pr <number>` flag and use `gh pr view <number> --json headRefName` to auto-resolve the branch.

**Pros**:
- More user-friendly — PR numbers are easier to remember than branch names
- Can also extract PR context (title, body, review comments) for the builder

**Cons**:
- Requires `gh` CLI to be available
- More complex — introduces a GitHub API dependency
- Can be added as a future enhancement on top of `--branch`

**Estimated Complexity**: Medium
**Risk Level**: Low

### Recommended Approach

**Approach 1** — it's simpler, has no external dependencies, and Approach 2 can be layered on top later as a convenience wrapper.

## Open Questions

### Critical (Blocks Progress)
- [x] How should the worktree directory be named when using `--branch`? → Use `<protocol>-<id>-branch-<slug>` pattern to maintain compatibility with detection utilities

### Important (Affects Design)
- [x] Should we add PR context (review comments, etc.) to the builder prompt? → Out of scope for this spec. The builder prompt should note it's continuing work on an existing branch, but pulling full PR context is a future enhancement.
- [x] Should `--branch` work with `--task` and `--shell` modes? → No. These modes have no issue context. `--branch` requires an issue number and protocol.
- [x] Which remote is used? → Always `origin`. No `--remote` flag for now; can be added later if needed.

### Nice-to-Know (Optimization)
- [ ] Should we support `--pr <number>` as a convenience alias? → Deferred to a future spec.

## Performance Requirements
- No performance-sensitive paths — this is a CLI spawn operation
- `git fetch` may take a few seconds depending on the remote

## Security Considerations
- Branch names from `--branch` are user-supplied input and must be validated before use in shell commands. Validate against a regex like `/^[a-zA-Z0-9._\/-]+$/` — reject anything else with a clear error. This is a new requirement since existing branch names are auto-generated and never contain arbitrary user input.
- No new authentication or authorization concerns — uses existing git credentials

## Test Scenarios

### Functional Tests
1. **Happy path**: `afx spawn 603 --protocol bugfix --branch builder/bugfix-603-slug` creates worktree on the specified branch
2. **Branch doesn't exist on remote**: Command fails with error "Branch 'foo' does not exist on the remote"
3. **Branch already checked out**: Command fails with a clear, actionable error when the branch is already checked out in another worktree or the main directory
4. **Mutual exclusion**: `--branch` + `--resume` produces an error
5. **All protocols**: `--branch` works with spir, aspir, air, bugfix, tick
6. **Builder prompt**: The generated prompt includes the branch name and a note that this is continuing existing work on that branch
7. **Invalid branch name**: Branch names with shell metacharacters (`;`, `$`, backticks, etc.) are rejected before any git command runs

### Non-Functional Tests
1. **Existing tests pass**: No regression in current spawn tests
2. **Branch name validation**: Only valid git branch name characters are accepted

## Dependencies
- **External Services**: None new (git remote already required)
- **Internal Systems**: `spawn-worktree.ts`, `spawn.ts`, `cli.ts`, `types.ts`
- **Libraries/Frameworks**: None new

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Branch has diverged significantly from main | Medium | Low | Builder works on the branch as-is; divergence is the architect's judgment call |
| Existing PR has merge conflicts | Low | Low | Not our problem — standard git workflow handles this |
| Branch name collision with auto-generated names | Low | Low | Worktree naming uses the actual branch name, avoiding collision with auto-generated patterns |
| Branch already checked out elsewhere | Medium | Low | Detect and surface a clear error telling the user to switch the other checkout to a different branch |
| Shell injection via malicious branch name | Low | High | Validate branch names against a safe regex before any shell command |

## Notes
- This feature enables the "hand-off" workflow where one person starts a PR and another finishes it
- Future enhancement: `--pr <number>` flag that auto-resolves the branch from a PR number
