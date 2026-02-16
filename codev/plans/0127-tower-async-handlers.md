# Plan: Tower Async Subprocess Calls

## Metadata
- **ID**: 0127
- **Status**: draft
- **Specification**: codev/specs/0127-tower-async-handlers.md
- **Created**: 2026-02-16

## Executive Summary

Replace three `execSync` calls in Tower HTTP request handlers with `util.promisify(child_process.exec)`. This is a mechanical refactor — same behavior, same timeouts, same error handling, just non-blocking. Split into two phases: hot path (git status polled by dashboard) and cold paths (workspace creation/adoption).

## Success Metrics
- [ ] Zero `execSync` calls in Tower request handler code paths
- [ ] All existing tests pass
- [ ] No API contract changes

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Async git status handler"},
    {"id": "phase_2", "title": "Async workspace lifecycle"}
  ]
}
```

## Phase Breakdown

### Phase 1: Async git status handler
**Dependencies**: None

#### Objectives
- Convert the most frequently called `execSync` (git status) to async
- This is the hot path — dashboard polls it regularly, so it has the most impact on WebSocket responsiveness

#### Deliverables
- [ ] `handleWorkspaceGitStatus()` converted from sync to async
- [ ] Import changed from `execSync` to `exec` + `promisify`
- [ ] Tests pass

#### Implementation Details

**File**: `packages/codev/src/agent-farm/servers/tower-routes.ts`

1. Add import: `import { exec } from 'node:child_process'` and `import { promisify } from 'node:util'`
2. Create: `const execAsync = promisify(exec)`
3. Change function signature from `function handleWorkspaceGitStatus(...): void` to `async function handleWorkspaceGitStatus(...): Promise<void>`
4. Replace:
   ```typescript
   const result = execSync('git status --porcelain', {
     cwd: workspacePath,
     encoding: 'utf-8',
     timeout: 5000,
   });
   ```
   With:
   ```typescript
   const { stdout: result } = await execAsync('git status --porcelain', {
     cwd: workspacePath,
     encoding: 'utf-8',
     timeout: 5000,
   });
   ```
5. Error handling: No changes needed. `execAsync` rejects with an error that has `.message` — same as `execSync` throws. The catch block uses `(err as Error).message`, which works identically.
6. Caller at line ~1032 (`return handleWorkspaceGitStatus(...)`) inside `handleWorkspaceRoutes` (already async) — returning a Promise is fine, no changes needed.

#### Acceptance Criteria
- [ ] `handleWorkspaceGitStatus` is async
- [ ] `git status --porcelain` runs via `execAsync` with 5s timeout
- [ ] Same JSON response shape: `{ modified, staged, untracked }` on success
- [ ] Same graceful degradation: `{ modified: [], staged: [], untracked: [], error }` on failure
- [ ] Existing tests pass

#### Test Plan
- **Unit Tests**: Existing `tower-routes.test.ts` tests pass (they don't exercise git status directly — it's not mocked at the child_process level)
- **Manual Testing**: Hit `GET /workspace/:encoded/api/git/status` and verify JSON response

#### Rollback Strategy
Revert the commit.

---

### Phase 2: Async workspace lifecycle
**Dependencies**: Phase 1 (shares the `execAsync` utility)

#### Objectives
- Convert the two remaining cold-path `execSync` calls to async
- These block for up to 60s (codev init) and 30s (codev adopt)

#### Deliverables
- [ ] `handleCreateWorkspace()` — `execSync('codev init ...')` → `execAsync`
- [ ] `launchInstance()` — `execSync('npx codev adopt ...')` → `execAsync`
- [ ] `execSync` import removed from both files
- [ ] Tests pass

#### Implementation Details

**File 1**: `packages/codev/src/agent-farm/servers/tower-routes.ts`

Replace in `handleCreateWorkspace()` (already async):
```typescript
execSync(`codev init --yes "${workspaceName}"`, {
  cwd: expandedParent,
  stdio: 'pipe',
  timeout: 60000,
});
```
With:
```typescript
await execAsync(`codev init --yes "${workspaceName}"`, {
  cwd: expandedParent,
  timeout: 60000,
});
```
Note: `stdio: 'pipe'` is the default for `exec`, so it can be omitted.

Error handling: The catch block uses `(err as Error).message` — works identically with async rejection.

After this change, remove the `execSync` import from `tower-routes.ts` (no longer needed).

**File 2**: `packages/codev/src/agent-farm/servers/tower-instances.ts`

1. Add import: `import { exec } from 'node:child_process'` and `import { promisify } from 'node:util'`
2. Create: `const execAsync = promisify(exec)`
3. Replace in `launchInstance()` (already async):
   ```typescript
   execSync('npx codev adopt --yes', {
     cwd: workspacePath,
     stdio: 'pipe',
     timeout: 30000,
   });
   ```
   With:
   ```typescript
   await execAsync('npx codev adopt --yes', {
     cwd: workspacePath,
     timeout: 30000,
   });
   ```
4. Remove the `execSync` import from `tower-instances.ts`.

Error handling: The catch block uses `(err as Error).message` — works identically.

#### Acceptance Criteria
- [ ] `handleCreateWorkspace` uses `execAsync` with 60s timeout
- [ ] `launchInstance` uses `execAsync` with 30s timeout
- [ ] Zero `execSync` imports in tower-routes.ts and tower-instances.ts
- [ ] Same API responses and error messages
- [ ] Existing tests pass

#### Test Plan
- **Unit Tests**: Existing `tower-instances.test.ts` tests pass (the adopt path is not exercised in current tests — the test fixture has a codev/ directory)
- **Manual Testing**: Create workspace via dashboard, verify it works

#### Rollback Strategy
Revert the commit.

## Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Error message format differs slightly | Low | Low | `exec` promisified rejects with same error shape as `execSync` throws |
| `maxBuffer` exceeded on large repos | Very Low | Low | Default 1MB buffer; git status porcelain output won't approach this |
