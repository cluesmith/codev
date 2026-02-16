# Review: Tower Async Subprocess Calls

## Summary

Converted three `execSync` calls in Tower HTTP request handlers to async `exec` (promisified), preventing the Node.js event loop from blocking during subprocess execution. This was a mechanical refactor — same behavior, same timeouts, same error handling.

## Spec Compliance

- [x] Zero `execSync` calls in Tower request handler code paths
- [x] `git status` requests don't block terminal WebSocket traffic
- [x] Workspace creation doesn't freeze the dashboard for 60s
- [x] Auto-adopt doesn't freeze the dashboard for 30s
- [x] No behavioral changes — same API responses, same error handling
- [x] Existing tests pass

## Changes

| File | Change |
|------|--------|
| `tower-routes.ts` | `handleWorkspaceGitStatus()`: sync → async, `execSync` → `execAsync` |
| `tower-routes.ts` | `handleCreateWorkspace()`: `execSync` → `execAsync` |
| `tower-instances.ts` | `launchInstance()`: `execSync` → `execAsync` |
| Both files | `execSync` import removed, replaced with `exec` + `promisify` |

Net diff: +15 lines, -11 lines across 2 files.

## Deviations from Plan

None. Implementation followed the plan exactly.

## Lessons Learned

### What Went Well
- Spec was tight and well-scoped — 3 specific call sites, clear success criteria
- Mechanical refactor meant zero ambiguity in implementation
- All 3 reviewers approved both phases without blocking issues
- Existing tests passed unchanged because they mock at module boundaries, not at child_process level

### Challenges Encountered
- **Codex false positive on import ordering**: Codex claimed `const execAsync` between import statements would "fail typecheck/build" — this was incorrect (TypeScript hoists imports). Fixed the style anyway since it was a fair cosmetic concern.
- **Build environment**: `tsc` wasn't available globally in the worktree; needed `npm install` first. Minor setup friction.

### What Would Be Done Differently
- Nothing significant. For a 2-file, 3-call-site mechanical refactor, the process was appropriately lightweight.

### Methodology Improvements
- For mechanical refactors (sync → async, rename, move), a single-phase plan would be sufficient. The 2-phase split was driven by porch's minimum requirement, not by natural work boundaries.

## Technical Debt
- None introduced. Pre-existing: the `execSync` calls in tests are not directly exercised (mocked at higher levels). This is acceptable for the current test strategy but could be improved if test coverage is expanded later.

## Follow-up Items
- None. The spec is fully implemented.
