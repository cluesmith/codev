---
approved: 2026-02-14
validated: [gemini, codex, claude]
---

# Spec 0104: Custom Terminal Session Manager

## Summary

Replace tmux with a purpose-built terminal session manager that provides session persistence, multi-client shared access, and auto-restart — without the alternate-screen conflicts, global state mutation, and scrollback fragility that tmux introduces into the xterm.js + node-pty pipeline.

## Problem

tmux sits between node-pty and the user's shell, adding a process layer that was designed for human terminal multiplexing, not for programmatic WebSocket-to-PTY bridging. This mismatch has caused recurring bugs:

### Scrollback Conflicts (10+ hours of debugging)

tmux uses its own internal scrollback buffer and alternate-screen handling. When xterm.js also maintains a scrollback buffer, the two fight:

- **Alternate screen ON** (tmux default): xterm.js receives no scrollback data — all history is trapped in tmux's internal buffer, invisible to the browser.
- **Alternate screen OFF** (current workaround): Scroll works but applications that use alternate screen (vim, less, Claude Code TUI) send raw escape sequences that corrupt xterm.js state.
- **Mouse ON**: tmux intercepts mouse events, breaks text selection and clipboard in the browser.
- **Mouse OFF**: Scroll wheel does nothing in tmux's buffer (only in xterm.js buffer).

There is no configuration of tmux that satisfies all four requirements: native scroll, text selection, clipboard, and application compatibility.

### Global State Mutation

tmux's `-g` flag sets options globally across ALL sessions on the machine. A single `tmux set -g mouse on` in one session (architect.ts line 106, now fixed) broke scroll in every other session. This class of bug is impossible to prevent with tmux because:

- Any spawned process inside tmux can run `tmux set -g`
- Claude Code and other AI tools sometimes execute tmux commands
- There is no way to sandbox tmux option scope

### Configuration Fragility

Every new and reconnected session requires re-applying settings (`mouse off`, `alternate-screen off`, `status off`). Missing any one causes regressions. The settings must also match between `createTmuxSession()` and `reconcileTerminalSessions()` — a sync requirement that has already caused bugs.

### Unnecessary Complexity

tmux provides features we don't use (windows, panes, copy-mode, status bar, key bindings, scripting) while the features we DO use (persistence, shared sessions) can be implemented more simply.

## Current Architecture

```
Browser (xterm.js, scrollback: 10000)
  ↓ WebSocket (binary hybrid protocol)
Tower (node-pty → PtySession → RingBuffer: 1000 lines)
  ↓ node-pty spawns process
tmux new-session (alternate-screen off, mouse off, status off)
  ↓ tmux runs command inside session
Shell / Claude / Builder process
```

### What tmux Currently Provides

| Capability | How tmux provides it | Our usage |
|------------|---------------------|-----------|
| **Session persistence** | tmux server survives Tower restart; `tmux attach` reconnects | Used for architect and builder resilience |
| **Multi-client access** | Multiple `tmux attach` to same session | Used when dashboard reconnects or multiple tabs view same terminal |
| **Auto-restart** | `while true; do ...; sleep 2; done` inside tmux | Architect sessions only |
| **Process outliving parent** | tmux server is a daemon | Tower restart doesn't kill shells |

### Key Files

- `packages/codev/src/agent-farm/servers/tower-server.ts` — tmux session create/kill/list/reconnect (lines 503-870)
- `packages/codev/src/terminal/pty-manager.ts` — TerminalManager class
- `packages/codev/src/terminal/pty-session.ts` — PtySession with RingBuffer
- `packages/codev/src/terminal/ring-buffer.ts` — Scrollback storage
- `packages/codev/src/terminal/ws-protocol.ts` — Binary WebSocket protocol
- `packages/codev/src/agent-farm/utils/session.ts` — Session name parsing
- `packages/codev/dashboard/src/components/Terminal.tsx` — xterm.js setup
- `codev/resources/terminal-tmux.md` — Documented tmux challenges

## Requirements

### Must Have

1. **Session persistence across Tower restarts**: When Tower stops and restarts, running shells/processes must survive and be reconnectable. This is the primary reason tmux exists in our stack.

2. **Multi-client shared access**: Multiple WebSocket connections (dashboard tabs, reconnections) must be able to attach to the same terminal session and see the same output.

3. **Native xterm.js scrollback**: The browser's xterm.js scrollback buffer (currently 10,000 lines) must work natively — no alternate screen conflicts, no mouse interception, no modal copy-mode.

4. **Process lifecycle management**: Start, resize, kill processes. Detect exit. Support disconnect timeouts before cleanup.

5. **Reconnection with replay**: When a client reconnects, replay recent output from a server-side buffer so the terminal isn't blank. Current RingBuffer (1000 lines) serves this purpose.

6. **Auto-restart for architect sessions**: Architect sessions must auto-restart on exit (currently `while true; do ...; sleep 2; done` loop in tmux).

7. **Zero global state mutation**: No mechanism should allow one session's configuration to affect another session.

### Should Have

8. **Disk logging**: Log terminal output to disk for debugging (current: 50MB max per session in `.agent-farm/logs/`).

9. **Session metadata in SQLite**: Continue using `terminal_sessions` table as source of truth, with project path, session type, role ID.

10. **Graceful degradation**: If the persistence mechanism fails, terminals should still work (just without persistence).

### Won't Have

11. Terminal multiplexing (windows/panes within a session) — we use separate sessions.
12. Key binding or scripting — handled by xterm.js and the shell.
13. Copy-mode — handled by browser text selection.
14. Status bar — handled by dashboard UI.

## Proposed Architecture

### Design: Daemonized Shell Processes

Instead of tmux, we use **direct node-pty processes that are managed to survive Tower restarts**. The key insight is that node-pty spawns real OS processes — if we can track their PIDs and PTY file descriptors, we can reconnect to them without tmux.

```
Browser (xterm.js, scrollback: 10000)
  ↓ WebSocket (binary hybrid protocol, unchanged)
Tower (SessionManager → ManagedSession → RingBuffer)
  ↓ node-pty spawns process directly
Shell / Claude / Builder process (no tmux wrapper)
```

### Session Persistence Strategy

Three approaches to evaluate (in order of preference):

#### Approach A: PID + PTY FD Recovery

When Tower starts, read saved PIDs from SQLite. For each:
1. Check if process is still alive (`kill(pid, 0)`)
2. If alive, open the PTY master fd (`/dev/ptmx` or platform equivalent)
3. Create a new node-pty instance wrapping the existing fd
4. Resume output streaming

**Pros**: No external daemon, minimal complexity
**Cons**: Reopening PTY fds is platform-specific and may not be possible with node-pty's API. node-pty creates the PTY pair internally and doesn't support adopting an existing fd.

#### Approach B: Lightweight Shepherd Process

Spawn a minimal daemon (`codev-shepherd`) that:
1. Owns the PTY master fd and keeps it open
2. Accepts Unix socket connections from Tower
3. Forwards PTY I/O to/from Tower over the socket
4. Survives Tower restarts (it's a separate process)
5. Has no configuration, no options, no global state — just fd forwarding

```
Browser → WebSocket → Tower → Unix Socket → Shepherd → PTY → Shell
```

The shepherd is ~100 lines of code. It has exactly one job: keep the PTY fd alive and forward bytes. It has no concept of mouse mode, alternate screen, scrollback, or any other terminal feature.

**Pros**: Clean separation, guaranteed persistence, no platform hacks
**Cons**: Additional process per session (lightweight), new code to maintain

#### Approach C: Screen as tmux Alternative

Use GNU `screen` instead of tmux. Screen has simpler defaults and less aggressive terminal feature interception.

**Pros**: Drop-in replacement, battle-tested
**Cons**: Same fundamental problem (external multiplexer intercepting the byte stream), just with different defaults. Doesn't solve the architectural mismatch.

### Recommended Approach

**Approach B (Shepherd process)** is recommended because:

1. It cleanly separates persistence (keeping fds alive) from terminal management (buffering, multiplexing, WebSocket)
2. The shepherd has zero configuration — no settings to apply, sync, or accidentally mutate globally
3. It's a tiny, auditable program with one responsibility
4. It works identically on macOS and Linux (Unix sockets + PTY are POSIX)
5. It eliminates the entire class of tmux bugs (alternate screen, mouse, copy-mode, global options)

### Multi-Client Shared Access

Without tmux, multi-client access is handled in Tower's `PtySession`:

1. PtySession already supports multiple WebSocket listeners (broadcast to all attached clients)
2. Each client gets replay from RingBuffer on connect
3. Input from any client goes to the same PTY fd
4. This is already implemented — tmux's multi-attach is redundant with our WebSocket multiplexing

### Auto-Restart

Replace tmux's `while true` loop with a `restartOnExit` option in SessionManager:

```typescript
interface SessionOptions {
  restartOnExit?: boolean;    // Auto-restart on clean exit
  restartDelay?: number;      // Delay before restart (default: 2000ms)
  maxRestarts?: number;       // Prevent infinite restart loops
}
```

When the process exits and `restartOnExit` is true, SessionManager spawns a new process in the same PTY (or creates a new PTY and updates the shepherd). Connected clients see the restart seamlessly.

## Migration Path

### Phase 1: Shepherd Implementation

Build the shepherd process and SessionManager wrapper. Test alongside tmux (both running).

### Phase 2: New Sessions Use Shepherd

New terminal sessions are created via shepherd instead of tmux. Existing tmux sessions continue working.

### Phase 3: Reconciliation Update

Update `reconcileTerminalSessions()` to reconnect via shepherd (Unix socket) instead of `tmux attach`.

### Phase 4: Remove tmux Code

Remove all tmux-related code from tower-server.ts. Remove `checkTmuxAvailable()`, `createTmuxSession()`, `killTmuxSession()`, `listCodevTmuxSessions()`.

### Phase 5: tmux as Optional User Tool

tmux remains available for users who want it inside their shells — it's just no longer part of Codev's infrastructure.

## Acceptance Criteria

1. Terminal sessions survive Tower restart (stop Tower, start Tower, terminals resume)
2. Multiple dashboard tabs viewing the same terminal see identical output
3. Scrollback works natively in xterm.js — no alternate-screen artifacts, no mouse interception
4. Architect sessions auto-restart on exit
5. `af spawn` creates builder sessions that work identically to current behavior
6. No tmux dependency in Codev's codebase (tmux may still be installed but is not required)
7. RingBuffer replay works on reconnection (terminal is not blank after page refresh)
8. All existing Playwright E2E tests pass
9. SQLite `terminal_sessions` table continues to be source of truth

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| node-pty can't adopt existing PTY fds | Approach A fails | Use Approach B (shepherd) |
| Shepherd process crashes | Sessions lose persistence | Shepherd is ~100 LOC with no deps; add PID monitoring |
| Unix socket performance | Latency in terminal I/O | Unix sockets add <0.1ms; negligible for terminal use |
| Platform differences (macOS vs Linux) | Shepherd behavior varies | Use POSIX-only APIs; test both in CI |
| Orphaned shepherd processes | Resource leak | Tower tracks shepherd PIDs in SQLite; cleanup on reconciliation |
| Applications that expect tmux | Break if they detect tmux env vars | Don't set TMUX env var (which we shouldn't have been doing anyway) |

## Open Questions

1. **Should the shepherd be a compiled binary or a Node.js script?** A compiled Go/Rust binary is smaller and starts faster, but a Node.js script keeps the stack uniform and is easier to maintain. Recommendation: Start with Node.js, optimize later if needed.

2. **Should we support session "snapshots"?** Save the full terminal state (screen buffer + cursor position) to disk for offline inspection. Not required for MVP but could be valuable for debugging.

3. **Can we use `nohup` or `setsid` instead of a shepherd?** These prevent process termination when Tower exits, but don't solve the PTY fd recovery problem. The PTY master fd closes when Tower exits, which sends SIGHUP to the shell. A shepherd keeps the master fd open.
