# Spec 0102: Porch CWD / Worktree Awareness

## Summary

Porch should auto-detect the project or bug ID from the current working directory when running inside a builder worktree, making the numeric ID argument optional in the common case.

## Problem

Builders run inside `.builders/<id>/` worktrees. Every porch command requires an explicit numeric ID:

```bash
porch status 228
porch done 228
porch next 0073
```

This is awkward because:

1. **The ID is redundant** — when running from `.builders/bugfix-228/`, porch should know it's working on 228.
2. **Bug vs project confusion** — porch treats all IDs as project IDs and searches `codev/projects/NNNN-*`. A bugfix worktree at `.builders/bugfix-228/` has a `codev/projects/` directory containing `0228-*` (porch init creates it), but the user thinks of it as "bug 228", not "project 0228".
3. **Auto-detection only works for single-project repos** — the current `detectProjectId()` scans `codev/projects/` and returns a result only if exactly one project directory exists. In a worktree that has exactly one project, this already works, but it requires scanning the filesystem when the answer is right there in the CWD path.

## Current State

### Porch ID Resolution (`packages/codev/src/commands/porch/state.ts`)

- `detectProjectId(projectRoot)` scans `codev/projects/` for directories matching `NNNN-*`. Returns the ID if exactly one match; `null` otherwise.
- `findStatusPath(projectRoot, projectId)` finds the `status.yaml` for a given 4-digit ID.
- `getProjectId()` in `index.ts` (line 614-622): uses explicit arg if provided, falls back to `detectProjectId()`, throws if neither available.

### Worktree Naming (`packages/codev/src/agent-farm/commands/spawn.ts`)

| Spawn Type | Worktree Path | Branch Name |
|-----------|---------------|-------------|
| Spec (`-p 0073`) | `.builders/0073` | `builder/{specName}` |
| Bugfix (`--issue 228`) | `.builders/bugfix-228` | `builder/bugfix-228-{slug}` |
| Task | `.builders/task-{4charId}` | `builder/task-{4charId}` |
| Protocol | `.builders/{proto}-{4charId}` | `builder/{proto}-{4charId}` |

### What's Missing

- No function checks if CWD is inside `.builders/*/`
- No function extracts the builder ID from the worktree path
- No mapping from worktree path back to project ID

## Desired State

### CWD-Based Auto-Detection

When porch is invoked without an explicit ID, it should:

1. **Check if CWD is inside a `.builders/` worktree** by walking up from `process.cwd()` looking for a parent path segment matching `.builders/<something>`.
2. **Extract the project ID from the worktree directory name**:
   - `.builders/0073` -> project ID `0073`
   - `.builders/bugfix-228` -> project ID `0228` (zero-padded to 4 digits)
   - `.builders/task-aB2C` -> no project ID (task mode doesn't map to a project)
   - `.builders/maintain-xY9z` -> no project ID
3. **Fall back to the existing `detectProjectId()`** if CWD is not in a worktree (e.g., running from the main repo root).

### Resolution Priority

```
1. Explicit CLI argument (porch status 0073)
2. CWD worktree detection (running from .builders/0073/)
3. detectProjectId() scan of codev/projects/
4. Error: "Cannot determine project ID"
```

### Implementation

Add a new function `detectProjectIdFromCwd()` in `state.ts`:

```typescript
/**
 * Detect project ID from the current working directory if inside a builder worktree.
 * Returns 4-digit zero-padded project ID, or null if not in a worktree.
 */
export function detectProjectIdFromCwd(cwd: string): string | null {
  // Walk up looking for .builders/<id> in the path
  const match = cwd.match(/\.builders\/(bugfix-(\d+)|(\d{4}))\b/);
  if (!match) return null;

  // bugfix-228 -> "0228", 0073 -> "0073"
  const rawId = match[2] || match[3];
  return rawId.padStart(4, '0');
}
```

Update `getProjectId()` in `index.ts` to use the new resolution chain:

```typescript
function getProjectId(args: string[], projectRoot: string): string {
  // 1. Explicit argument
  if (args[0]) return args[0].padStart(4, '0');

  // 2. CWD worktree detection
  const fromCwd = detectProjectIdFromCwd(process.cwd());
  if (fromCwd) return fromCwd;

  // 3. Filesystem scan
  const detected = detectProjectId(projectRoot);
  if (detected) return detected;

  throw new Error('Cannot determine project ID. Provide it explicitly or run from a builder worktree.');
}
```

### What This Enables

```bash
# Inside .builders/bugfix-228/:
porch status        # automatically resolves to project 0228
porch done          # automatically resolves to project 0228
porch next          # automatically resolves to project 0228

# Inside .builders/0073/:
porch status        # automatically resolves to project 0073

# From main repo root (existing behavior):
porch status 0073   # explicit ID required if multiple projects exist
```

## Acceptance Criteria

1. `porch status` (no arg) works correctly when CWD is inside `.builders/0073/`
2. `porch status` (no arg) works correctly when CWD is inside `.builders/bugfix-228/`
3. Explicit ID argument still takes precedence over CWD detection
4. `detectProjectId()` fallback still works from main repo root
5. Task/protocol worktrees (no project mapping) produce a clear error message
6. Unit tests cover all worktree naming patterns

## Out of Scope

- Adding `-p` / `-b` flags for explicit disambiguation — CWD detection is sufficient
- Changing worktree naming conventions
- Modifying how `porch init` creates project directories
