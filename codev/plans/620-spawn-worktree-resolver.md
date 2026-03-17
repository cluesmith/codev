---
approved: 2026-03-17
validated: [architect]
---

# Plan: Builder Worktree Protocol Symlinks + Spawn Resolver Fallback

## Metadata
- **ID**: 620
- **Specification**: codev/specs/620-spawn-worktree-resolver.md

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Worktree protocol symlinks"},
    {"id": "phase_2", "title": "Spawn resolver fallback"}
  ]
}
```

## Phase 1: Worktree Protocol Symlinks

**File**: `packages/codev/src/agent-farm/commands/spawn-worktree.ts`

In `createWorktree()`, find the symlinks section (lines ~56-69). Extend it to symlink directories:

```typescript
// Existing file symlinks
const fileSymlinks = ['.env', 'af-config.json'];

// Directory symlinks — protocols and resources from main repo
const dirSymlinks = ['codev/protocols', 'codev/resources', 'codev/roles'];
```

For directory symlinks, create parent directories if needed (`codev/` may not exist in worktree). Use the same `existsSync` guard to skip if target already exists (handles git-tracked directories).

## Phase 2: Spawn Resolver Fallback

**File**: `packages/codev/src/agent-farm/commands/spawn.ts`

In `spawnSpec()`, after `findSpecFile()` returns null and before the fatal GitHub issue fetch:

1. Import `getResolver` from `../../commands/porch/artifacts.js`
2. Try `resolver.findSpecBaseName(projectId, '')` to get the spec name
3. If found, use it for branch/worktree naming (same as local spec file path would provide)
4. If not found, fall through to existing GitHub issue logic

The resolver import is acceptable — `artifacts.ts` is a standalone module with no circular dependencies.

## Validation

1. `npm run build` — compiles
2. `npx vitest run src/commands/porch/` — tests pass
3. Manual: `af spawn N --protocol aspir` with spec only in CLI backend
