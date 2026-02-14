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

4. **Process lifecycle management**: Start, resize, kill processes. Detect exit. Support disconnect timeouts before cleanup. Shepherd must forward resize (SIGWINCH) and signals (SIGINT, SIGTERM, SIGKILL) from Tower to the child process.

5. **Reconnection with replay**: When a client reconnects, replay recent output from a server-side buffer so the terminal isn't blank. The shepherd maintains its own replay buffer (10,000 lines, matching xterm.js scrollback) so that after Tower restarts, recent output is available immediately without waiting for new shell output.

6. **Auto-restart for architect sessions**: Architect sessions must auto-restart on any exit (clean or crash). The `restartOnExit` option triggers on all exit codes, matching the current unconditional `while true` loop behavior. A `maxRestarts` counter (default: 50) prevents infinite restart loops. Counter resets after 5 minutes of stable operation.

7. **Zero global state mutation**: No mechanism should allow one session's configuration to affect another session.

### Should Have

8. **Disk logging**: Log terminal output to disk for debugging (current: 50MB max per session in `.agent-farm/logs/`).

9. **Session metadata in SQLite**: Continue using `terminal_sessions` table as source of truth, with project path, session type, role ID. Schema migration: add `shepherd_socket TEXT` and `shepherd_pid INTEGER` and `shepherd_start_time INTEGER` columns alongside the existing `tmux_session` column. During Phase 3 (tmux removal), drop the `tmux_session` column. This two-step migration allows rollback during the transition period.

10. **Graceful degradation**: If the shepherd process fails to spawn, Tower falls back to a direct node-pty session without persistence. The session works normally for the duration of the Tower process but won't survive a restart. SQLite row is marked with `shepherd_socket = NULL` to indicate non-persistent mode. User sees a warning in the dashboard terminal header: "Session persistence unavailable."

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
  ↓ Unix Socket
Shepherd (PTY owner + replay buffer)
  ↓ PTY master fd
Shell / Claude / Builder process (no tmux wrapper)
```

### Decision: Node.js Shepherd

The shepherd will be implemented as a **Node.js script** (`codev-shepherd.mjs`). Rationale:

- Keeps the stack uniform (all TypeScript/Node.js) — easier to maintain and debug
- Runtime overhead (~30MB RSS per session) is acceptable: we typically run 2-5 sessions, so 60-150MB total, well within dev machine RAM
- Can be optimized to a compiled binary later if needed, with the same wire protocol
- Node.js provides native Unix socket support (`net.createServer`) and child process management

### Session Persistence Strategy

**Approach B: Lightweight Shepherd Process** (selected — see alternatives in Appendix).

Each terminal session is managed by a dedicated shepherd process:

1. Tower spawns `codev-shepherd.mjs` as a detached child process (`child_process.spawn` with `detached: true, stdio: ['ignore', 'pipe', 'ignore']`). Tower reads the shepherd's PID and start time from stdout, then calls `child.unref()` to allow Tower to exit independently.
2. Shepherd creates the PTY (via `node-pty`) and owns the master fd
3. Shepherd listens on a Unix socket for Tower connections
4. Tower connects to the shepherd's socket and forwards I/O to/from WebSocket clients
5. When Tower restarts, it discovers running shepherds via SQLite (socket path + PID) and reconnects

```
Browser → WebSocket → Tower → Unix Socket → Shepherd → PTY → Shell
```

### Shepherd Wire Protocol

The shepherd communicates with Tower over a Unix socket using a simple binary frame protocol:

```
Frame format: [1-byte type] [4-byte big-endian length] [payload]

Types:
  0x01 DATA      — PTY output (shepherd→Tower) or user input (Tower→shepherd)
  0x02 RESIZE    — Terminal resize: payload = JSON {"cols": N, "rows": N}
  0x03 SIGNAL    — Send signal to child: payload = JSON {"signal": N} (allowed signals: SIGINT, SIGTERM, SIGKILL, SIGHUP, SIGWINCH only)
  0x04 EXIT      — Child process exited: payload = JSON {"code": N, "signal": S}
  0x05 REPLAY    — Replay buffer dump (shepherd→Tower on connect): payload = raw bytes
  0x06 PING      — Keepalive (bidirectional)
  0x07 PONG      — Keepalive response
  0x08 HELLO     — Handshake (Tower→shepherd on connect): payload = JSON {"version": 1}
  0x09 WELCOME   — Handshake response (shepherd→Tower): payload = JSON {"pid": N, "cols": N, "rows": N, "startTime": N}
  0x0A SPAWN     — Restart child process (Tower→shepherd): payload = JSON {"command": S, "args": [...], "cwd": S, "env": {...}}

Constraints:
  - Maximum frame payload size: 16MB. Frames exceeding this are dropped with an error log.
  - Unknown frame types are silently ignored (forward compatibility).
  - Version mismatch in HELLO/WELCOME: If shepherd version > Tower version, Tower logs a warning but continues. If shepherd version < Tower version, Tower disconnects and marks session as stale.
  - Malformed frames (incomplete header, invalid JSON in control frames): connection is closed and logged.
  - Backpressure: If Tower is disconnected or slow, shepherd continues buffering PTY output in its replay buffer (overwriting oldest entries). No flow control — terminal I/O is low-throughput enough that backpressure is not a concern.
```

The protocol is intentionally minimal — no authentication (Unix socket permissions handle access control), no multiplexing (one session per shepherd), no configuration.

### Shepherd Lifecycle

**Spawning**: Tower spawns one shepherd process per session. The shepherd is a standalone Node.js script that:
1. Creates a PTY with the requested command, args, cwd, and environment
2. Creates a Unix socket at a predictable path: `~/.codev/run/shepherd-{sessionId}.sock`
3. Maintains a 10,000-line replay buffer of recent PTY output
4. Writes its PID to stdout before detaching (Tower captures this)

**Socket directory**: `~/.codev/run/` is created with permissions `0700` (owner-only). Socket files are created with permissions `0600`.

**Discovery after Tower restart**:
1. Tower queries SQLite for all sessions with non-null `shepherd_socket` paths
2. For each, checks if the shepherd PID is still alive (`kill(pid, 0)`) AND validates process identity by checking the process start time matches the recorded start time (prevents PID reuse attacks)
3. If alive and validated, connects to the Unix socket and sends HELLO handshake
4. Shepherd responds with WELCOME containing current PTY state (pid, cols, rows)
5. Shepherd sends REPLAY frame with buffered output, then streams live DATA frames
6. If PID is dead or identity check fails, mark SQLite row as stale and clean up socket file

**Stale socket cleanup**: On startup, Tower also scans `~/.codev/run/shepherd-*.sock` for socket files with no corresponding live process. Stale socket files are unlinked after verifying the socket path is a regular socket file (not a symlink), preventing symlink-based attacks. This handles the case where a shepherd crashed without cleanup.

**Shutdown**:
- When Tower intentionally stops: Tower closes its socket connections to shepherds. Shepherds continue running (this is the whole point — persistence).
- When Tower kills a session: Tower sends SIGNAL frame with SIGTERM, waits 5s, then SIGKILL if still alive. Then closes socket. Shepherd exits when child dies and no connections remain.
- When a shepherd crashes: The PTY master fd closes, sending SIGHUP to the shell process, which terminates it. This is the same behavior as a tmux server crash — acceptable because the shepherd is a minimal process with few crash vectors.

**Machine reboot**: All shepherds die (same as tmux). This is a clean-slate event — Tower starts fresh with empty session state.

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
  restartOnExit?: boolean;    // Auto-restart on any exit (default: false)
  restartDelay?: number;      // Delay before restart (default: 2000ms)
  maxRestarts?: number;       // Prevent infinite restart loops (default: 50)
  restartResetAfter?: number; // Reset restart counter after stable operation (default: 300000ms / 5min)
}
```

When the process exits and `restartOnExit` is true:
1. Shepherd detects child exit and sends EXIT frame to Tower (with exit code and signal)
2. Tower increments restart counter. If counter exceeds `maxRestarts`, Tower sends no SPAWN and notifies clients "Session stopped after too many restarts."
3. After `restartDelay` ms, Tower sends a SPAWN frame to the shepherd with the original command/args/cwd/env
4. Shepherd creates a new PTY with the specified parameters and begins forwarding output
5. Connected clients see the restart seamlessly — Tower sends a brief "Session restarting..." control message via the WebSocket
6. If the session stays alive for `restartResetAfter` ms, the restart counter resets to 0
7. If Tower is not connected when the child exits, the shepherd waits indefinitely (it cannot restart on its own — restart policy is Tower's responsibility)

### Security

- **Unix socket permissions**: Socket directory `~/.codev/run/` is `0700` (owner-only access). Socket files are `0600`. Only the user who started Tower can connect to shepherd sockets.
- **No authentication protocol**: Unix socket filesystem permissions are the authentication mechanism. This is standard practice for local-only IPC (e.g., Docker socket, X11 socket).
- **Input isolation**: Each shepherd manages exactly one session. There is no command channel that could be used to access other sessions. The only operations are: data forwarding, resize, signal, and lifecycle events.
- **No `TMUX` environment variable**: The shepherd does not set `TMUX` or any other environment variable that would cause child processes to believe they're in a multiplexer.

## Migration Path

### Phase 1: Shepherd Implementation

Build the shepherd process (`codev-shepherd.mjs`) and the Tower-side `SessionManager` wrapper. Implement the wire protocol, socket lifecycle, and replay buffer. Include comprehensive unit and integration tests.

### Phase 2: Integration and Session Creation

Wire the shepherd into Tower's session creation flow. New terminal sessions are created via shepherd instead of tmux. Existing tmux sessions continue working during the transition. Reconciliation handles both session types simultaneously: tmux sessions are reconnected via `tmux attach`, shepherd sessions via Unix socket. Session type is determined by checking whether `shepherd_socket` or `tmux_session` is populated in SQLite.

### Phase 3: Reconciliation and tmux Removal

Update `reconcileTerminalSessions()` to reconnect via shepherd (Unix socket) instead of `tmux attach`. Remove all tmux-related code: `checkTmuxAvailable()`, `createTmuxSession()`, `killTmuxSession()`, `listCodevTmuxSessions()`, tmux option application, and tmux-related comments. Clean up SQLite schema (migrate `tmux_session` → `shepherd_socket`).

### Phase 4: Cleanup and Polish

Remove `terminal-tmux.md` documentation (replaced by this spec's architecture). Update any remaining references to tmux in comments, error messages, or documentation. tmux remains available for users who want it inside their shells — it's just no longer part of Codev's infrastructure.

## Acceptance Criteria

1. Terminal sessions survive Tower restart (stop Tower, start Tower, terminals resume with recent output visible)
2. Multiple dashboard tabs viewing the same terminal see identical output
3. Scrollback works natively in xterm.js — no alternate-screen artifacts, no mouse interception
4. Architect sessions auto-restart on exit (including non-zero exit codes)
5. `af spawn` creates builder sessions that: start a shell in the correct worktree, connect to the dashboard, accept input, display output, and survive Tower restart
6. No tmux dependency in Codev's codebase (tmux may still be installed but is not required)
7. After Tower restart, reconnected terminals display recent output from shepherd's replay buffer (not blank)
8. All existing Playwright E2E tests pass
9. SQLite `terminal_sessions` table continues to be source of truth, with updated schema (`shepherd_socket`, `shepherd_pid`, `shepherd_start_time` columns)

## Testing Requirements

### Unit Tests

- **Shepherd wire protocol**: Frame encoding/decoding round-trips for all message types (DATA, RESIZE, SIGNAL, EXIT, REPLAY, PING/PONG, HELLO/WELCOME)
- **Shepherd replay buffer**: Circular buffer behavior, capacity limits, replay on connect
- **SessionManager**: Session creation, listing, killing, resize forwarding
- **Auto-restart logic**: Restart counter, maxRestarts limit, restartResetAfter timer, restart delay

### Integration Tests

- **Session lifecycle**: Create session → write input → read output → kill session → verify cleanup
- **Tower restart survival**: Create session → stop Tower → verify shepherd alive → start Tower → reconnect → verify output continuity
- **Shepherd crash recovery**: Create session → kill shepherd process → verify session cleanup in SQLite and socket file removal
- **Multi-client concurrent input**: Two clients connected to same session, both sending input, both receiving output
- **Auto-restart cycle**: Session with restartOnExit → kill process → verify restart → kill again → verify maxRestarts limit
- **Stale socket cleanup**: Create stale socket file → start Tower → verify cleanup
- **Graceful degradation**: Prevent shepherd from spawning → verify session works without persistence → verify dashboard warning

### Protocol Robustness Tests

- **Malformed frames**: Send incomplete header, invalid JSON control payload, oversized frame (>16MB) → verify connection closed gracefully
- **Unknown frame types**: Send frame with type 0xFF → verify silently ignored
- **Version mismatch**: Send HELLO with version 99 → verify appropriate handling
- **Signal allowlist**: Send SIGNAL with disallowed signal number → verify rejected
- **Rapid restart cycles**: Kill process 10 times in quick succession → verify maxRestarts honored and no race conditions

### E2E Tests (Playwright)

- All existing terminal E2E tests must pass (regression gate)
- New test: Stop and restart Tower while terminal is active → verify terminal resumes
- New test: Open same terminal in two tabs → verify both see same output

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| node-pty can't adopt existing PTY fds | Approach A fails | Use Approach B (shepherd) — shepherd owns the PTY directly |
| Shepherd process crashes | PTY master fd closes → SIGHUP kills shell → session lost | Shepherd is ~300-500 LOC with minimal dependencies; few crash vectors. Acceptable tradeoff (same as tmux crash). |
| Unix socket performance | Latency in terminal I/O | Unix sockets add <0.1ms; negligible for terminal use |
| Platform differences (macOS vs Linux) | Shepherd behavior varies | Use POSIX-only APIs; test on macOS (primary dev platform) |
| Orphaned shepherd processes | Resource leak | Tower scans `~/.codev/run/` on startup; kills shepherds with no matching SQLite row |
| PID reuse after restart | Reconnect to wrong process | Validate process identity using start time comparison, not just PID |
| Stale Unix socket files | Connection failures | Tower unlinks stale socket files during startup scan |
| Rapid Tower restart race condition | Old/new Tower connections overlap on shepherd | Shepherd accepts only one Tower connection at a time; new connection closes old one |
| Node.js runtime overhead | ~30MB RSS per shepherd process | Acceptable for 2-5 concurrent sessions; optimize to compiled binary later if needed |

## Appendix: Rejected Approaches

### Approach A: PID + PTY FD Recovery

Rejected because node-pty doesn't support adopting an existing PTY fd. The PTY master fd closes when Tower exits, sending SIGHUP to the shell.

### Approach C: Screen as tmux Alternative

Rejected because it has the same fundamental problem — an external multiplexer intercepting the byte stream with its own terminal emulation layer.

## Open Questions

1. **Should we support session "snapshots"?** Save the full terminal state (screen buffer + cursor position) to disk for offline inspection. Not required for MVP but could be valuable for debugging. Deferred to future spec.

2. **Should the shepherd replay buffer be configurable?** Default 10,000 lines matches the xterm.js scrollback. Power users might want more. Deferred — can be added as a config option later without protocol changes.
