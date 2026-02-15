---
approved: 2026-02-15
validated: [architect]
---

# Specification: Consolidate Shellper Session Creation

## Metadata
- **ID**: 0117
- **Status**: approved
- **Created**: 2026-02-15

## Problem Statement

Shellper session creation logic is duplicated across 6 call sites in 4 files. Each site independently assembles the same options object (`cols`, `rows`, `cwd`, `env`, `restartOnExit`, etc.) before calling `shellperManager.createSession()`. This duplication led to the 200x50 bug — when the default dimensions needed changing, 6 files had to be updated independently, and one was missed.

### Current Call Sites

| # | File | Function/Context | Notes |
|---|------|-----------------|-------|
| 1 | `tower-routes.ts:351-360` | `handleTerminalCreate` | Terminal creation API |
| 2 | `tower-routes.ts:1242-1251` | `handleWorkspaceShellCreate` | Workspace shell API |
| 3 | `tower-instances.ts:373-384` | `launchInstance` | Architect session on workspace activate |
| 4 | `spawn-worktree.ts:264` | `createPtySession` | Builder terminal via Tower REST API |
| 5 | `pty-manager.ts:75-80` | `createSession` | Direct PTY creation |
| 6 | `pty-manager.ts:121-126` | `createSessionRaw` | Shellper-backed session stub |
| 7 | `session-manager.ts:322-333` | `reconnectToExisting` | Reconnect after Tower restart |

Note: `spawn-worktree.ts` sends cols/rows over HTTP to Tower, which then hits one of the tower-routes paths. So it's not a direct `createSession` call, but it still assembles the same defaults independently.

## Desired State

A single factory function (e.g., `createDefaultSessionOptions()`) in the terminal module that:
1. Returns the standard options object with `DEFAULT_COLS`, `DEFAULT_ROWS`, and common env setup
2. Accepts overrides for call-site-specific values (custom cols from API request, restartOnExit, etc.)
3. Is imported by all call sites instead of each assembling options independently

### Example

```typescript
// terminal/index.ts or terminal/session-defaults.ts
export function defaultSessionOptions(overrides?: Partial<SessionOptions>): SessionOptions {
  return {
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    restartOnExit: false,
    ...overrides,
  };
}
```

## Detached Shellper Process

Shellper is currently spawned as a child process of Tower. When Tower stops, shellper dies and all PTY sessions are killed. This is a regression from tmux, which ran as an independent daemon and sessions survived restarts.

### Root Cause

On 2026-02-15, Tower became unstable due to PTY exhaustion (`posix_openpt()` failing at `kern.tty.ptmx_max = 511`). Restarting Tower killed all builder sessions. The `while true` loop in `.builder-start.sh` respawned Claude processes, but session state was lost.

### Required Change

Spawn shellper as a detached process so it survives Tower restarts:

1. **Spawn detached**: Use `child_process.spawn()` with `detached: true` + `unref()`. Shellper already communicates over a Unix socket, so no IPC channel is needed.
2. **Reconnect on startup**: Tower startup checks if a shellper socket already exists. If so, reconnect to the existing process instead of spawning a new one.
3. **PID file**: Write shellper's PID to a known location (e.g., `~/.agent-farm/shellper.pid`) for lifecycle management.
4. **Graceful handoff**: When Tower stops, it disconnects from shellper but does NOT kill it. Sessions continue running.

### Startup Sequence

```
Tower.start():
  1. Check if shellper socket exists at expected path
  2. If exists → try connecting
     a. Connection succeeds → reuse existing shellper
     b. Connection fails → stale socket, clean up and spawn new
  3. If not exists → spawn new detached shellper
```

### Interaction with 0118 (Multi-Client)

Spec 0118 adds multi-client support to shellper. That's a natural prerequisite — Tower reconnecting after restart is just "another client connecting." These two specs together restore the session persistence that tmux provided natively.

## Success Criteria

- [ ] All shellper session creation flows through one shared function for default options
- [ ] No raw `cols: DEFAULT_COLS, rows: DEFAULT_ROWS` literals outside the factory function
- [ ] Existing tests pass without modification (behavior unchanged)
- [ ] `spawn-worktree.ts` uses the same constants for its HTTP body
- [ ] Shellper spawned as detached process (survives Tower restart)
- [ ] Tower reconnects to existing shellper on startup
- [ ] PID file written for shellper lifecycle management
- [ ] Tower stop does NOT kill shellper

## Constraints

- Session creation consolidation is a pure refactor — zero behavior change
- Detached shellper changes process lifecycle but not session behavior
- The factory function should live in the terminal module (not scattered into server code)
- Depends on 0118 (multi-client) for full Tower reconnection support

## Scope

- Session consolidation: ~100 LOC changed
- Detached shellper: ~150 LOC new/changed in `shellper-process.ts` and `tower-server.ts`
- New test needed for reconnect-on-startup path
