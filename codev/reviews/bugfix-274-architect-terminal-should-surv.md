# Bugfix #274: Architect Terminal Should Survive Tower Restarts

## Summary

Fixed a race condition in Tower's startup sequence that caused architect terminal sessions to be permanently lost during `af tower stop && af tower start`.

## Root Cause

Tower's startup in `tower-server.ts` called `initInstances()` BEFORE `reconcileTerminalSessions()`. This enabled dashboard polls (via `getInstances` → `getTerminalsForProject`) to arrive during reconciliation. Both `getTerminalsForProject()`'s on-the-fly reconnection and `reconcileTerminalSessions()` would attempt to connect to the same shellper socket. The shellper's single-connection model (new connection replaces old) caused the first client to be disconnected, triggering `removeDeadSession()` which corrupted the session and deleted the architect terminal's socket file.

Builder terminals were unaffected because `getInstances()` skips `/.builders/` paths, so their `getTerminalsForProject()` was never called during the race window.

## Fix (Two Layers)

1. **Startup reorder** (`tower-server.ts`): `reconcileTerminalSessions()` now runs BEFORE `initInstances()`. Since `getInstances()` returns `[]` when `_deps` is null, no dashboard poll can trigger `getTerminalsForProject()` during reconciliation.

2. **Reconciling guard** (`tower-terminals.ts`): Added `_reconciling` flag that blocks on-the-fly shellper reconnection in `getTerminalsForProject()` while `reconcileTerminalSessions()` is running. This closes a secondary race path through `/project/<path>/api/state` which bypasses `getInstances()` entirely (identified by Codex CMAP review).

## Files Changed

| File | Change |
|------|--------|
| `packages/codev/src/agent-farm/servers/tower-server.ts` | Reordered startup: reconcile before initInstances |
| `packages/codev/src/agent-farm/servers/tower-terminals.ts` | Added `_reconciling` flag + `isReconciling()` export |
| `packages/codev/src/agent-farm/__tests__/bugfix-274-architect-persistence.test.ts` | 6 regression tests |

## Test Results

- 1295 tests passed, 13 skipped (tunnel E2E)
- 6 new regression tests for startup guards and reconciling flag
- TypeScript type check passes

## CMAP Results

| Reviewer | Verdict | Notes |
|----------|---------|-------|
| Gemini | APPROVE | Noted edge case with direct `/project/.../api/state` — addressed by _reconciling guard |
| Codex | REQUEST_CHANGES | Identified secondary race path and test duplication — both addressed in follow-up commit |
| Claude | APPROVE | Thorough review, confirmed dependency chain is clean |

## Lessons Learned

1. **Startup ordering matters**: When multiple subsystems share resources (shellper sockets), initialization order creates implicit synchronization. Document ordering constraints in comments.
2. **Defense in depth for race conditions**: The startup reorder closes the primary race path, but the `_reconciling` guard provides a safety net for paths that bypass `getInstances()`.
3. **CMAP value**: Codex caught a real secondary race path that the initial fix missed. Multi-agent review found a gap that single-reviewer analysis didn't.
