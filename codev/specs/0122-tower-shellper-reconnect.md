---
approved: 2026-02-16
validated: [architect]
---

# Specification: Tower Shellper Reconnect on Startup

## Metadata
- **ID**: 0122
- **Status**: approved
- **Created**: 2026-02-16

## Problem Statement

When Tower restarts (via `afx tower stop && afx tower start`), it starts fresh with no knowledge of existing shellper sessions. The shellper processes survive the restart (they're independent processes), the PTYs survive, and the builder AI processes inside those PTYs survive. But Tower doesn't reconnect to them, so the dashboard shows no builders and `afx spawn --resume` creates new terminal sessions instead of reattaching to existing ones.

With tmux, sessions were fully independent and discoverable after Tower restart. Shellper was designed for the same persistence, but Tower's startup path never implemented reconnection.

## Current State

1. `afx tower stop` sends SIGTERM to Tower
2. Tower's `gracefulShutdown()` calls `sessionManager.shutdown()` which disconnects from shellpers (but does not kill them)
3. Shellper processes keep running, PTYs keep running, builder AI keeps running
4. `afx tower start` starts a fresh Tower
5. Tower reads SQLite `terminal_sessions` table but does NOT reconnect to existing shellper sockets
6. Dashboard shows no builders. Builders are alive but invisible/unreachable.

## Desired State

On startup, Tower should:

1. Query `terminal_sessions` for rows with non-null `shellper_socket`
2. For each, attempt to connect to the shellper socket (HELLO with `clientType: 'tower'`, wait for WELCOME)
3. If WELCOME received: register the session in SessionManager as a live session (existing shellper, existing PTY)
4. If connection fails (socket gone, no WELCOME): mark the row as stale and clean up
5. After reconnection, dashboard shows all surviving builders immediately

## Success Criteria

- [ ] After `afx tower stop && afx tower start`, all surviving builders appear in the dashboard
- [ ] Tower reconnects to shellper sockets and receives PTY output
- [ ] Dead sessions (shellper process exited) are cleaned up from SQLite
- [ ] `afx spawn --resume` works correctly with reconnected sessions
- [ ] No duplicate sessions created for already-reconnected shellpers
- [ ] Reconnection happens during Tower startup, before accepting HTTP connections

## Constraints

- Must use existing `ShellperClient` for reconnection (sends `clientType: 'tower'`)
- Must not block Tower startup for more than a few seconds even if many sessions exist
- Must handle partial failures (some shellpers alive, some dead)
- Must not interfere with normal session creation flow

## Implementation

### Tower startup path (`tower-server.ts`)

After SQLite is initialized but before the HTTP server starts listening:

1. Call `sessionManager.reconnectExisting()` (new method)
2. This queries `terminal_sessions` for all rows with `shellper_socket IS NOT NULL`
3. For each row, attempt `ShellperClient.connect()` with a short timeout (2-3 seconds)
4. On success: add to SessionManager's sessions map, set up event handlers (same as normal session creation)
5. On failure: delete the row from SQLite, unlink the socket file if it exists

### SessionManager changes

New method: `reconnectExisting()` that takes the DB handle and attempts to restore sessions from SQLite state.

## Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Slow startup with many dead sockets | Medium | Low | Short timeout (2-3s), parallel probes |
| Race with new session creation | Low | Medium | Reconnect before HTTP server starts |
| Stale SQLite rows from crashed shellpers | Medium | Low | Failed probes clean up rows |

## Dependencies

- 0118 (shellper multi-client) — merged. Tower connects as `clientType: 'tower'`.
