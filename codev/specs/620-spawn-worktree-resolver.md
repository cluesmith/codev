---
approved: 2026-03-17
validated: [architect]
---

# Specification: Builder Worktree Protocol Symlinks + Spawn Resolver Fallback

## Metadata
- **ID**: 620
- **Status**: approved
- **GitHub Issue**: https://github.com/cluesmith/codev/issues/620

## Problem Statement

Two bugs prevent builders from working with external artifact backends:

1. **Worktrees missing protocol files**: `createWorktree()` in `spawn-worktree.ts` only symlinks `.env` and `af-config.json`. When `codev/protocols/` is gitignored (common in adopted projects), builders can't find protocol definitions.

2. **Spawn requires GitHub issue with CLI backend**: `spawnSpec()` calls `findSpecFile()` which only checks local `codev/specs/`. When specs are in an external CLI backend, no local file exists. Spawn falls through to a fatal GitHub issue fetch instead of trying the artifact resolver.

## Success Criteria

- [ ] Builder worktrees have `codev/protocols`, `codev/resources`, and `codev/roles` symlinked from main repo
- [ ] Symlinks are skipped if target already exists (git-tracked files)
- [ ] `af spawn N --protocol aspir` works when spec is only in CLI artifact backend (no local file, no GitHub issue)
- [ ] Spawn uses resolver to find spec name for branch/worktree naming when no local file exists
- [ ] All existing tests pass

## Files to Modify

1. `packages/codev/src/agent-farm/commands/spawn-worktree.ts` — extend symlink list with `codev/protocols`, `codev/resources`, `codev/roles`
2. `packages/codev/src/agent-farm/commands/spawn.ts` — in `spawnSpec()`, try `getResolver().findSpecBaseName()` before falling back to GitHub issue
