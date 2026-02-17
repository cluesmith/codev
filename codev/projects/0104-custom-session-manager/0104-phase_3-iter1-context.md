# Phase 3 Implementation Summary (for consultation)

## Overview
Phase 3 integrates the shepherd system (Phases 1+2) into tower-server.ts, replacing tmux as the primary terminal persistence mechanism.

## Changes Made

### 1. PtySession (pty-session.ts)
- Added `attachShepherd(client, replayData, pid)` method — wires PtySession to use ShepherdClient instead of node-pty
- Data flow: shepherd → ring buffer → WebSocket clients
- Modified `write()`, `resize()`, `kill()` to delegate to shepherd when `_shepherdBacked` is true
- Modified `detach()` to skip disconnect timer for shepherd sessions (shepherd keeps process alive)
- Added `persistent` field to `PtySessionInfo`
- `cleanupShepherd()` does NOT clear ring buffer (shepherd manages replay)

### 2. TerminalManager (pty-manager.ts)
- Added `createSessionRaw()` — creates PtySession without spawning a process (for shepherd)
- Fixed `shutdown()` to skip `session.kill()` for shepherd-backed sessions (shepherds survive Tower restart)

### 3. ShepherdClient Interface (shepherd-client.ts)
- Added `getReplayData(): Buffer | null` to `IShepherdClient` interface

### 4. tower-server.ts (largest changes, ~970 lines diff)
Key changes:
- **SessionManager initialization**: At startup, creates `SessionManager` with `socketDir: ~/.codev/run/`, runs `cleanupStaleSockets()`
- **Graceful shutdown**: Added `shepherdManager.shutdown()` (closes socket connections only, doesn't kill processes)
- **Architect session creation**: Try shepherd first (`restartOnExit: true, restartDelay: 2000, maxRestarts: 50`), fall back to tmux
- **Shell creation (POST /api/tabs/shell)**: Try shepherd first (`restartOnExit: false`), fall back to tmux
- **Terminal creation (POST /api/terminals)**: Try shepherd first, fall back to tmux
- **reconcileTerminalSessions()**: Rewritten as 3-phase:
  1. Shepherd reconnection via `shepherdManager.reconnectSession()`
  2. tmux reconnection (legacy dual-mode)
  3. Sweep stale SQLite rows (don't kill shepherd processes)
- **getTerminalsForProject()**: On-the-fly shepherd reconnection before tmux fallback
- **/api/state**: Returns `persistent: session.shepherdBacked` for architect, builders, shells

### 5. Dashboard (Terminal.tsx, App.tsx, api.ts, useTabs.ts)
- Added `persistent?: boolean` prop to Terminal component
- Warning banner when `persistent === false`
- Wired `persistent` through `/api/state` → API types → Tab interface → Terminal component

### 6. Integration Tests (tower-shepherd-integration.test.ts)
16 tests covering:
- attachShepherd behavior (flag, PID, replay data, data forwarding, persistent info)
- write/resize/kill delegation to shepherd
- Exit handling (normal, unexpected disconnect, no double-emit)
- Detach behavior (no disconnect timer for shepherd)
- createSessionRaw lifecycle
- shutdown() preserves shepherd sessions

## Test Results
All 1036 tests pass across 63 test files. TypeScript build clean.

## Key Design Decisions
- **Dual-mode**: Shepherd is primary, tmux is fallback (Phase 4 removes tmux)
- **Shepherd survival**: Tower shutdown disconnects sockets but doesn't kill shepherd processes
- **PtySession as adapter**: Existing WebSocket → PtySession → client path unchanged; only I/O backend swaps
