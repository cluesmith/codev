# Specification: Tower Async Subprocess Calls

## Metadata
- **ID**: 0127
- **Status**: draft
- **Created**: 2026-02-16

## Problem Statement

Tower's HTTP request handlers use `execSync` to spawn subprocesses, blocking the Node.js event loop for seconds at a time. This freezes terminal WebSocket traffic and dashboard responsiveness while the subprocess runs.

Both Codex and Gemini independently flagged this during codebase review.

## Scope

Convert all `execSync` calls in Tower request handlers to async equivalents. `fs.*Sync` calls are out of scope — they complete in microseconds on local disk and don't cause real-world blocking.

### Target calls

1. **`execSync('git status --porcelain')`** — `tower-routes.ts`
   - Handler: `handleWorkspaceGitStatus()` (workspace-scoped `GET /api/git/status`)
   - Timeout: 5s
   - Impact: Blocks event loop during git command. Dashboard polls and terminal WebSocket frames queue up.

2. **`execSync('codev init --yes ...')`** — `tower-routes.ts`
   - Handler: `POST /api/create`
   - Timeout: 60s
   - Impact: Blocks event loop during workspace creation. Cold path but extremely long block.

3. **`execSync('npx codev adopt --yes')`** — `tower-instances.ts`
   - Handler: `POST /api/launch` (auto-adopt)
   - Timeout: 30s
   - Impact: Blocks event loop during npm process chain. Cold path but extremely long block.

## Desired State

All three `execSync` calls replaced with `child_process.exec` (promisified) or `child_process.spawn` with async await. Same behavior, same timeouts, same error handling — just non-blocking.

## Success Criteria

- [ ] Zero `execSync` calls in Tower request handler code paths
- [ ] `git status` requests don't block terminal WebSocket traffic
- [ ] Workspace creation doesn't freeze the dashboard for 60s
- [ ] Auto-adopt doesn't freeze the dashboard for 30s
- [ ] No behavioral changes — same API responses, same error handling
- [ ] Existing tests pass

## Implementation Notes

- `handleWorkspaceGitStatus()` is currently sync (`void` return) — must become `async`. The caller already supports async returns.
- `handleCreateWorkspace()` and `launchInstance()` are already `async`.
- All three commands are static strings or use pre-validated input (`workspaceName` is validated against `/^[a-zA-Z0-9_-]+$/`). No command injection risk.

## Constraints

- `fs.*Sync` calls are explicitly out of scope
- Cold path sync operations outside of request handlers (server startup) are out of scope
- Must not change any API contracts
- Same timeouts must be preserved

## Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Error handling differences between sync/async exec | Low | Low | `exec` promisified throws on non-zero exit, same as `execSync` |
| Concurrent requests to same git repo | Low | Low | git handles concurrent reads fine |
