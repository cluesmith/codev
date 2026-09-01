# Codev Architecture Documentation

## Overview

Codev is a Human-Agent Software Development Operating System. This repository serves a dual purpose: it is both the canonical source of the Codev framework AND a self-hosted instance where Codev uses its own methodology to develop itself.

## Quick Start for Developers

**To understand Codev quickly:**
1. Read `codev/resources/cheatsheet.md` - Core philosophies, concepts, and tool reference
2. Read `CLAUDE.md` (or `AGENTS.md`) - Development workflow and Git safety rules
3. Check GitHub Issues - Current project status and what's being worked on

**To understand a specific subsystem:**
- **Agent Farm**: Start with the Architecture Overview diagram in this document, then `packages/codev/src/agent-farm/`
- **Client SDK**: `packages/sdk/` — TowerClient, workspace encoding, EscapeBuffer, ReconnectPolicy, SSE (environment-agnostic; every client's path to Tower)
- **Server Runtime**: `packages/core/` — local-key issuance, homedir-derived paths (server-side only)
- **VS Code Extension**: `apps/vscode/` — thin client over Tower API
- **Dashboard**: `apps/web/` — React SPA served by Tower
- **Consult Tool**: See `packages/codev/src/commands/consult/` and `codev/roles/consultant.md`
- **Protocols**: Read the relevant protocol in `codev/protocols/{spir,maintain,experiment}/protocol.md`

**To add a new feature to Codev:**
1. Create a GitHub Issue describing the feature
2. Create spec using template from `codev/protocols/spir/templates/spec.md`
3. Follow SPIR protocol: Specify → Plan → Implement → Review

## Quick Tracing Guide

For debugging common issues, start here:

| Issue | Entry Point | What to Check |
|-------|-------------|---------------|
| **"Tower won't start"** | `packages/codev/src/agent-farm/servers/tower-server.ts` | Port 4100 conflict, node-pty availability |
| **"Workspace won't activate"** | `tower-instances.ts` → `launchInstance()` | Workspace state in global.db, architect command parsing |
| **"Terminal not showing output"** | `tower-websocket.ts` → `handleTerminalWebSocket()` | PTY session exists, WebSocket connected, shellper alive |
| **"Terminal not persistent"** | `tower-instances.ts` → `launchInstance()` | Check shellper spawn succeeded, dashboard shows `persistent` flag |
| **"Workspace shows inactive"** | `tower-instances.ts` → `getInstances()` | Check `workspaceTerminals` Map has entry |
| **"Builder spawn fails"** | `packages/codev/src/agent-farm/commands/spawn.ts` → `upsertBuilder()` | Worktree creation, shellper session, role injection |
| **"Gate not notifying architect"** | `commands/porch/notify.ts` → `notifyArchitect()` | porch sends `afx send architect` directly at gate transitions (Spec 0108) |
| **"Consult hangs/fails"** | `packages/codev/src/commands/consult/index.ts` | CLI availability (gemini/codex/claude), role file loading |
| **"State inconsistency"** | `packages/codev/src/agent-farm/state.ts` | SQLite in the user-global `~/.agent-farm/global.db` (Issue #1118); rows scoped by `workspace_path` |
| **"Port conflicts"** | `packages/codev/src/agent-farm/db/schema.ts` | Global registry at `~/.agent-farm/global.db` |
| **"Init/adopt not working"** | `packages/codev/src/commands/{init,adopt}.ts` | Skeleton copy, template processing |

**Common debugging commands:**
```bash
# Check terminal sessions and workspaces
sqlite3 -header -column ~/.agent-farm/global.db "SELECT * FROM terminal_sessions"

# Check if Tower is running
curl -s http://localhost:4100/health | jq

# List all workspaces and their status
curl -s http://localhost:4100/api/workspaces | jq

# Check terminal sessions on Tower
curl -s http://localhost:4100/api/terminals | jq

# Check shellper processes (Spec 0104)
ls ~/.codev/run/shellper-*.sock 2>/dev/null

# Check Tower logs (if started with --log-file)
tail -f ~/.agent-farm/tower.log
```

## Glossary

| Term | Definition |
|------|------------|
| **Spec** | Feature specification document (`codev/specs/XXXX-*.md`) defining WHAT to build |
| **Plan** | Implementation plan (`codev/plans/XXXX-*.md`) defining HOW to build |
| **Review** | Post-implementation lessons learned (`codev/reviews/XXXX-*.md`) |
| **Builder** | An AI agent working in an isolated git worktree on a single spec |
| **Architect** | The human + primary AI orchestrating builders and reviewing work |
| **Consultant** | An external AI model (Gemini, Codex, Claude) providing review/feedback |
| **CMAP** | "Consult Multiple Agents in Parallel" — shorthand for running 3-way parallel consultation (Gemini + Codex + Claude) |
| **Agent Farm** | Infrastructure for parallel AI-assisted development (dashboard, terminals, worktrees) |
| **Protocol** | Defined workflow for a type of work (SPIR, ASPIR, AIR, BUGFIX, MAINTAIN, EXPERIMENT, RELEASE) |
| **SPIR** | Multi-phase protocol: Specify → Plan → Implement → Review |
| **BUGFIX** | Lightweight protocol for isolated bug fixes (< 300 LOC) |
| **MAINTAIN** | Codebase hygiene and documentation synchronization protocol |
| **Workspace** | Tower's term for a registered project directory. Used in API paths and code; synonymous with "project" in user-facing contexts |
| **Worktree** | Git worktree providing isolated environment for a builder |
| **node-pty** | Native PTY session manager, multiplexed over WebSocket |
| **Shellper** | Detached Node.js process owning a PTY for session persistence across Tower restarts (Spec 0104) |
| **SessionManager** | Tower-side orchestrator for shellper process lifecycle (spawn, reconnect, kill, auto-restart) |
| **Skeleton** | Template files (`codev-skeleton/`) copied to projects on init/adopt |

## Invariants & Constraints

**These MUST remain true - violating them will break the system:**

1. **State Consistency**: the user-global `~/.agent-farm/global.db` is the single source of truth for architect/builder/util state (Issue #1118 retired the per-workspace `.agent-farm/state.db`; rows are disambiguated by `workspace_path`). Never modify it manually.

2. **Single Tower Port**: All projects are served through Tower on port 4100. Per-project port blocks were removed in Spec 0098. Terminal sessions and workspace metadata are tracked in `~/.agent-farm/global.db`.

3. **Worktree Integrity**: Worktrees in `.builders/` are managed by Agent Farm. Never delete them manually (use `afx cleanup`).

4. **CLAUDE.md ≡ AGENTS.md**: These files MUST be identical. They are the same content for different tool ecosystems.

5. **Skeleton Independence**: The skeleton (`codev-skeleton/`) is a template for OTHER projects. The `codev/` directory is OUR instance. Don't confuse them.

6. **Git Safety**: Never use `git add -A`, `git add .`, or `git add --all`. Always add files explicitly.

7. **Human Approval Gates**: Only humans can transition `conceived → specified` and `committed → integrated`.

8. **Consultation Requirements**: External AI consultation (Gemini, Codex) is mandatory at SPIR checkpoints unless explicitly disabled.

9. **Tower API Authentication**: Tower's local HTTP + WebSocket API enforces request authentication (advisory GHSA-xvjp-7748-v88v). Every route outside the narrow public-route allowlist (`isPublicRoute` in `agent-farm/utils/server-utils.ts`) requires the shared local key (`~/.agent-farm/local-key`), sent as the `codev-tower-key` HTTP header or a `Sec-WebSocket-Protocol` subprotocol, and fails closed with 401 (the server also accepts the legacy `codev-web-key` header for one release). Any new Tower route must decide public-vs-keyed — a wrong allowlist entry either breaks a pre-auth path (health/version probes, the served HTML shells + static assets, the cloud OAuth callback redirect) or exposes a data route. The key is delivered to browser shells via same-origin serve-time injection; those shell responses omit `Access-Control-Allow-Origin` so the injected key is not cross-origin readable.

## Agent Farm Internals

This section provides comprehensive documentation of how the Agent Farm (`afx`) system works internally. Agent Farm is the most complex component of Codev, enabling parallel AI-assisted development through the architect-builder pattern.

### Architecture Overview

Agent Farm orchestrates multiple AI agents working in parallel on a codebase. Two clients connect to the same Tower server:

```
┌─────────────────────────────┐  ┌─────────────────────────────┐
│  Browser Dashboard          │  │  VS Code Extension          │
│  (React SPA on Tower :4100) │  │  (apps/vscode)              │
│                             │  │                             │
│  xterm.js terminals         │  │  Pseudoterminal ↔ WS        │
│  Work View (React)          │  │  Sidebar TreeViews          │
│  SSE for updates            │  │  SSE for updates            │
└──────────────┬──────────────┘  └──────────────┬──────────────┘
               │ HTTP + WebSocket + SSE          │
               └────────────────┬────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│                    Tower Server (:4100)                            │
│              HTTP routes + WebSocket + SSE push                   │
│                                                                   │
│                  ┌───────────────────┐                             │
│                  │ Terminal Manager  │                             │
│                  │  (node-pty PTY    │                             │
│                  │   sessions)       │                             │
│                  └────────┬──────────┘                             │
└───────────────────────────┼───────────────────────────────────────┘
                            │ WebSocket /ws/terminal/<id>
              ┌─────────────┼─────────────┬─────────────┐
              ▼             ▼             ▼             ▼
   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
   │ Shellper │  │ Shellper │  │ Shellper │  │ Shellper │
   │ (unix    │  │ (unix    │  │ (unix    │  │ (unix    │
   │  socket) │  │  socket) │  │  socket) │  │  socket) │
   │ architect│  │ builder  │  │ builder  │  │  shell   │
   └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────────┘
        │             │             │
        ▼             ▼             ▼
   ┌──────────┐  ┌──────────┐  ┌──────────┐
   │  Main    │  │ Worktree │  │ Worktree │
   │  Repo    │  │ .builders│  │ .builders│
   │          │  │  /0003/  │  │  /0005/  │
   └──────────┘  └──────────┘  └──────────┘
```

**Key Components**:
1. **Tower Server**: Single daemon HTTP server (port 4100) serving React SPA and REST API for all projects
2. **Terminal Manager**: node-pty based PTY session manager with WebSocket multiplexing (Spec 0085)
3. **Shellper Processes**: Detached Node.js processes owning PTYs for session persistence (Spec 0104)
4. **SessionManager**: Tower-side orchestrator for shellper lifecycle (spawn, reconnect, kill, auto-restart)
5. **Git Worktrees**: Isolated working directories for each Builder
6. **SQLite Databases**: State persistence (local and global)

**Data Flow** (both clients use the same Tower API):
1. User opens browser dashboard at `http://localhost:4100` or VS Code auto-connects on workspace open
2. Client subscribes to SSE at `/api/events` for real-time push notifications
3. Client fetches workspace state via `/api/overview` and `/workspace/:encoded/api/state`
4. Terminals connect via WebSocket to `/workspace/:encoded/ws/terminal/<id>` (binary protocol: `0x00` control, `0x01` data)
5. Terminal creation uses `SessionManager.createSession()` for persistent shellper-backed sessions
6. Shellper-backed PtySessions delegate write/resize/kill to the shellper's Unix socket via `IShellperClient`
6. Builders work in isolated git worktrees under `.builders/`

### Port System

As of Spec 0098, the per-project port allocation system has been removed. Tower on port 4100 is the single HTTP server for all projects. All terminal connections are multiplexed over WebSocket using URL path namespaces `/workspace/<base64url>/ws/terminal/<id>`.

#### Global Registry (`~/.agent-farm/global.db`)

The global registry is a SQLite database that tracks workspace metadata and terminal sessions across all projects. See `packages/codev/src/agent-farm/db/schema.ts` for the full schema.

> **Historical note** (Specs 0008, 0098): The global registry originally tracked per-project port block allocations (100 ports per project, starting at 4200). After the Tower Single Daemon architecture (Spec 0090) made per-project ports unnecessary, `port-registry.ts` was deleted and the registry repurposed for terminal session and workspace tracking.

### Shellper Process Architecture (Spec 0104, renamed from Shepherd in Spec 0106)

Shellper processes provide terminal session persistence. Each terminal session is owned by a dedicated detached Node.js process (the "shellper") that holds the PTY master file descriptor. Tower communicates with shellpers over Unix sockets.

**Historical note**: Originally named "Shepherd" (Spec 0104), renamed to "Shellper" (Spec 0106). DB migration v8 renames `shepherd_*` columns to `shellper_*` and renames socket files from `shepherd-{id}.sock` to `shellper-{id}.sock`.

```
Browser (xterm.js, scrollback: 50000)
  |  WebSocket (binary hybrid protocol, unchanged)
Tower (SessionManager -> PtySession -> RingBuffer)
  |  Unix Socket (~/.codev/run/shellper-{sessionId}.sock)
Shellper (PTY owner + replay buffer: 10,000 lines OR 8MB, whichever first)
  |  PTY master fd
Shell / Claude / Builder process
```

#### Shellper Lifecycle

1. **Spawn**: Tower calls `SessionManager.createSession()`, which spawns `shellper-main.js` as a detached child (`child_process.spawn` with `detached: true`). Shellper writes PID + start time to stdout, then Tower calls `child.unref()`.
2. **Connect**: Tower connects to the shellper's Unix socket at `~/.codev/run/shellper-{sessionId}.sock` via `ShellperClient`. Handshake: Tower sends HELLO, shellper responds with WELCOME (pid, cols, rows, startTime).
3. **Data flow**: Shellper forwards PTY output as DATA frames to Tower. Tower pipes DATA frames to all attached WebSocket clients via PtySession.
4. **Tower restart**: Shellpers continue running as orphaned OS processes. On restart, Tower queries SQLite for sessions with `shellper_socket IS NOT NULL`, validates PID + start time, reconnects via Unix socket, and receives REPLAY frame with buffered output.
5. **Kill**: Tower sends SIGTERM via SIGNAL frame, waits 5s, SIGKILL if needed. Cleans up socket file.
6. **Graceful degradation**: If shellper spawn fails, Tower falls back to direct node-pty (non-persistent). SQLite row has `shellper_socket = NULL`. Dashboard shows "Session persistence unavailable" warning.

#### Connection-loss recovery (#1198)

A Tower↔shellper connection that dies **unexpectedly** (post-handshake socket error, protocol/parser error, or remote hangup without an EXIT frame) self-heals instead of zombifying or tearing down:

- **Close-emission contract** (`shellper-client.ts`): `cleanup(intentional)` records `_closePending` when it tears down a live connection that was not asked to die via `disconnect()`; the socket `'close'` event consumes it and emits `'close'` exactly once. The decision is captured at teardown time because error paths run `cleanup()` *before* the close event fires — reading `_connected` inside the close handler is the bug that swallowed the emission (silent zombie terminals). Intentional teardown (`disconnect()`, `killSession`, `detachShellper`, `shutdown()`) never emits `'close'`.
- **In-place reconnect** (`session-manager.ts`): on unexpected close, `recoverSession` retries the connection against the still-alive shellper (3 attempts at 500ms/1s/2s, preflighted by PID-alive + start-time + socket-file checks; capped at 3 consecutive rounds with a 30s stability reset), replacing `session.client` and emitting `'session-reconnected'` on success. Only exhaustion or an unreachable process takes the historical dead path (`removeDeadSession` + `'session-error'`).
- **Deferred teardown** (`pty-session.ts`): PtySession's close handler arms a grace timer (`SHELLPER_CLOSE_GRACE_MS`, 15s — sized above a full recovery round) instead of tearing down immediately; `attachShellper()` cancels it. The tower layer subscribes to `'session-reconnected'` and re-attaches the replacement client (empty replay — the ring buffer already holds history), and logs `'session-error'` at ERROR.
- **Write observability**: `ShellperClient.write()/resize()` and `PtySession.write()/resize()` return delivery booleans; `PtySession.writable` reports live-socket connectivity (a dying session still shows `status: running` until teardown). The send router returns 503 `TERMINAL_NOT_WRITABLE` and logs `Message DROPPED` instead of `Message sent`; the deferred-send buffer holds messages while a session is unwritable and drops loudly only at max age.

**Oversized frames are dropped, not fatal** (#1198 incident): a long-lived full-screen TUI session's replay buffer (newline-free, unbounded partial — see #1047) can exceed `MAX_FRAME_SIZE` (16MB). Old shellper binaries send it anyway, and treating it as a fatal parser error is what zombified the same terminals on every reconnect — and, once recovery retried a *deterministic* failure to exhaustion, escalated to killing live sessions. The `FrameParser` therefore discards an oversized frame incrementally (emitting `'frame-skipped'`) and keeps the stream alive; `ShellperClient` resolves replay waiters with an empty replay (viewers repaint via the post-connect resize nudge); new shellpers cap the replay they send to `REPLAY_PAYLOAD_MAX` (8MB tail). This must stay Tower-side-tolerant: running shellpers are old binaries that survive Tower upgrades.

**Replay is bounded at every layer, and every bound is a lossy tail-cut** (#1205). The shellper's replay buffer was originally capped by line count alone; a full-screen TUI redraws in place via cursor addressing and emits almost no newlines, so the line ceiling never fired and the buffer grew for the life of the session (multi-GB in the field). Two independent defects followed: unbounded retention, and an O(history) `Buffer.concat` in `getReplayData()` that ran on *every* client connect, transiently doubling the process footprint at the moment a user opened the terminal. Current bounds, outermost first: `MAX_FRAME_SIZE` 16MB (wire hard limit) → `REPLAY_PAYLOAD_MAX` 8MB (send cap) → `REPLAY_BUFFER_MAX_BYTES` 8MB (shellper retention, defined `= REPLAY_PAYLOAD_MAX` because nothing above the send cap can ever leave the process) → `RING_SEED_MAX_BYTES` 1MB (Tower ring seed at adoption) → `MAX_PARTIAL_CHARS` 2MB (Tower ring partial, trimmed to half on overflow so the copy amortises instead of running per-call). Byte-driven cuts are ESC-aligned to avoid starting a payload mid-escape-sequence. None of these guarantee a correct screen — they guarantee bounded memory. Since PIR #1354 these caps bound the *fallback and delta paths only*: the happy-path viewer replay is the serialized O(screen) snapshot (next paragraph), which is correct by construction; when the snapshot cannot be produced, the capped raw tail plus the client's post-connect repaint nudge remain the recovery path.

**Clients never see the shellper's REPLAY frame** — a system-shape surprise worth internalising before touching replay. The intuitive model is `shellper → client`, and #1205's own issue body proposed putting a terminal-state emulator "inside the shellper" on that basis. The actual path is `shellper --REPLAY--> Tower (seeds ring + screen mirror) --snapshot/lines--> client`. The shellper's replay is used *only* to seed Tower's per-session state at adoption: the ring buffer gets the `capRingSeed` 1 MiB tail, the `SessionScreen` mirror gets the full (≤8 MB) replay. This is why the O(screen) reconnect emulator (PIR #1354) lives Tower-side — a shellper-side one would deliver nothing to any client. Anything intended to change what a *viewer* sees on reconnect has to change Tower's replay representation, not (only) the shellper's.

**Viewer attach serves the mirror's serialized snapshot, not the raw ring** (PIR #1354). Both the VSCode adapter and the web dashboard attach via `tower-websocket.ts` (and the standalone `TerminalManager` server via the same shared routing, `attach-replay.ts`): a fresh attach — and a resume of a session whose mirror is in the *alternate* buffer, the case a line-delta cannot serve — receives `SessionScreen.serialize()` (screen + both buffers + bounded scrollback, typically KBs regardless of session age), produced under `PtySession.replaySnapshot()`'s flush-until-quiescent `bytesWritten` token loop; the client is attached in the same microtask as the token re-check, so every output byte lands in exactly one of snapshot or live stream. A resume on a *normal*-buffer session keeps the raw `getSince()` line-delta (correct and minimal for scrolling shells). Any snapshot failure falls back to the capped raw-ring replay plus client nudge — never worse than pre-#1354 — and logs `replay-snapshot-fallback session=<id> reason=<no-mirror|flush-timeout|serialize-error|empty-snapshot>` (WARN for desync reasons, INFO for the routine no-mirror case), the field signal for emulation desync.

**Invariants**: (1) never tear down a terminal's registry/DB state (socket unlink, `deleteTerminalSession`) on a raw socket close without first checking whether the shellper process is alive — the close path's cleanup is destructive, and the shellper protocol exists precisely so a lost connection can be re-established; (2) `removeDeadSession` never unlinks the socket of a still-live shellper process — an unlinked socket makes a live shellper unreachable *and* flags it for `killOrphanedShellpers`' kill path, converting a connect failure into a killed conversation; (3) the shellper never emits a frame larger than `MAX_FRAME_SIZE`. Relatedly, `towerStop` polls until the SIGTERMed process exits (SIGKILL after 8s) so `afx tower stop && afx tower start` cannot overlap the old Tower's teardown with the new Tower's adoption pass, and both adoption call sites use `waitForReplay()` rather than reading replay data synchronously (the REPLAY frame usually arrives in a later socket read than WELCOME).

#### Protocol-Behavior Signaling Across Tower Upgrades (#1215)

Shellpers are detached (`session-manager.ts`, `detached: true`) specifically so sessions survive Tower restarts — a Tower upgrade does **not** upgrade already-running shellper processes; they keep executing whatever binary they were spawned from until they exit and get replaced. Tower's client code can therefore be talking to a fleet of shellpers running different wire behaviors simultaneously, for an unbounded period, with no way to force convergence short of killing live sessions.

**When shellper wire *behavior* changes** (not the frame format itself), signal it via a new **optional WELCOME field** that new shellpers set and old ones omit — the pattern established by `lastDataAt` (#1198) and followed by `alwaysSendsReplay` (#1215, `waitForReplay()`'s legacy-timeout short-circuit) — never by bumping `PROTOCOL_VERSION`. `ShellperClient.connect()` treats `shellperVersion < PROTOCOL_VERSION` as a hard handshake rejection (stale shellper); bumping the version for a mere behavior change would reject every still-running old-binary shellper's connection outright, and reconciliation's stale-session sweep then kills it as orphaned — turning a bounded cost (falling back to old behavior for that one peer) into a live-session kill. Reserve `PROTOCOL_VERSION` for genuine wire-incompatible frame-format breaks, where refusing the connection is the correct behavior.

#### Terminal reconnect/replay contract (#1047)

When a WebSocket client attaches, Tower replays the ring buffer as a binary DATA frame **bracketed by `pause`/`resume` control frames** so the client can render the (potentially large) snapshot without counting it against its live-backpressure budget. Clients pass `?resume=<seq>` to request only the bytes after a sequence number (a *delta* reconnect) instead of the full buffer — the dominant cost saver when Tower is hosted remotely and reconnects are frequent. The ring-buffer `partial` (incomplete trailing line) is kept **whole and unbounded** so a full-screen TUI's alt-screen state replays faithfully; per-frame CPU is bounded instead by `pushData` scanning only the new chunk (not re-splitting the accumulated buffer). On the client side, a connecting terminal must **force a redraw** shortly after attach (a size-delta resize → SIGWINCH) — a full-screen TUI only repaints on a size *change*, and the connect-time resize can be a same-size no-op; both the web dashboard (`Terminal.tsx`) and the VSCode adapter (`terminal-adapter.ts`) do this. Under genuine *live* overload, clients **drop** ephemeral output (the app repaints) rather than reconnecting — reconnecting to relieve backpressure re-pulls the same payload and storms.

A client must also **render the replay at the *settled* terminal size, not the connect-time size (#1052)**. VSCode reports a freshly-opened terminal's dimensions in two steps (~120ms apart), so painting the bracketed replay immediately wraps the restored history at a transient width and strands a stale frame in the scrollback (a "ghost" status bar, visible on scroll). The VSCode adapter (`terminal-adapter.ts`) holds all output from `pause` and paints it once via a flush debounced on `setDimensions` (`REPLAY_SETTLE_MS`), so the frame lands at the final width — mirroring the web dashboard's `flushInitialBuffer` (`Terminal.tsx`). Note the lever asymmetry: a PTY-side SIGWINCH (the connect-time redraw above) repaints the app's *current frame* but cannot re-wrap xterm's existing *scrollback*, so wrong-width history must be prevented (render-once-at-settled-size), not patched after the fact.

#### Startup Readiness Barrier (#997)

Tower binds its port and starts serving immediately, but `reconcileTerminalSessions()` (which re-registers persistent sessions in the `workspaceTerminals` map) runs *after* `server.listen()`. To stop the first post-restart read from seeing a half-populated `role → terminalId` map, a monotonic settled-once barrier in `tower-terminals.ts` gates the readers of reconcile's output:

- `getRehydratedTerminalsEntry()` (the shared chokepoint behind `/api/state` and `/api/overview`) and both WS terminal-upgrade routes `await whenStartupReconcileSettled()` before reading the map. The barrier is released in `reconcileTerminalSessions()`'s `finally` (and its early `!_deps` return), with a defensive per-request timeout (`CODEV_STARTUP_READY_TIMEOUT_MS`, default 10s) so a hung reconcile can't wedge serving.
- `isStartupReconcileSettled()` is distinct from `isReconciling()` (which is false both before and after reconcile): it flips false→true once and stays true. `GET /health` exposes it as `ready` — **liveness** (`status: 'healthy'`, port up) stays separate from **readiness** (reconcile complete).

**Invariant for new Tower-startup work**: any endpoint that reads `workspaceTerminals` to build a response should route through `getRehydratedTerminalsEntry` so it inherits the gate, rather than reading the map directly.

#### Boot Readiness Gate (#1261)

The #997 barrier gates one dependency (reconcile's output) for the readers that name it. Every *other* boot dependency was still unguarded, and the largest of them was `initInstances()` — which sets `tower-instances.ts`'s `_deps` and was the last step of the boot sequence. Requests landing before it got whatever a half-wired Tower could produce: `DELETE /api/terminals/:id` returned **404 for a terminal that existed**, because `killTerminalWithShellper()` returns a bare `false` when `_deps` is null and the route reads that as "not found". The window scaled with disk state — the #1227 husk sweep and #1238 log sweep ran inside it — so a log-heavy machine failed deterministically while CI stayed green.

The fix inverts the default from "serve whatever we have" to "serve nothing until wired":

- The port still binds first. It is the single-Tower mutex (a second `afx tower start` needs `EADDRINUSE`) and what every readiness probe connects to.
- `tower-server.ts` holds each request in `http.createServer` until `bootSequence()` calls `markBootComplete()`; held requests get 503 + `Retry-After` if boot exceeds `BOOT_READY_TIMEOUT_MS` (20s), so a hung boot fails loud instead of hanging clients forever.
- `markBootComplete()` fires as soon as the *dependencies* are wired (through `initCron()`). Maintenance and background services — husk sweep, log-retention sweep, `initTunnel()` — deliberately run **after** it. Gating readiness on `initTunnel()` in particular would make an unreachable cloud endpoint look like a broken local Tower.

This also makes `afx tower start`'s readiness signal honest: it polls `/api/status` for a 200, which the pre-fix Tower returned during the window (`getInstances()` returns `[]` when `_deps` is null).

**Invariant for new Tower-startup work**: anything a request handler depends on must be wired *before* `markBootComplete()`; anything else (sweeps, timers, remote connections) goes after it. Do not add work between `server.listen()` and the gate.

**Second line of defence**: `instancesReady()` lets routes distinguish "not wired yet" from "no such thing" — the `_deps`-dependent terminal-delete paths answer 503 rather than 404 or a lying 204. Unreachable while the gate holds, and deliberately so: the failure mode if it is ever bypassed should be honest.

#### Wire Protocol

Binary frame format: `[1-byte type] [4-byte big-endian length] [payload]`

| Type | Code | Direction | Purpose |
|------|------|-----------|---------|
| DATA | 0x01 | Both | PTY output / user input |
| RESIZE | 0x02 | Tower->Shellper | Terminal resize (JSON: cols, rows) |
| SIGNAL | 0x03 | Tower->Shellper | Send signal to child (allowlist: SIGINT, SIGTERM, SIGKILL, SIGHUP, SIGWINCH) |
| EXIT | 0x04 | Shellper->Tower | Child process exited (JSON: code, signal) |
| REPLAY | 0x05 | Shellper->Tower | Replay buffer dump on connect |
| PING/PONG | 0x06/0x07 | Both | Keepalive |
| HELLO | 0x08 | Tower->Shellper | Handshake (JSON: version) |
| WELCOME | 0x09 | Shellper->Tower | Handshake response (JSON: pid, cols, rows, startTime) |
| SPAWN | 0x0A | Tower->Shellper | Restart child process (JSON: command, args, cwd, env) |

Max frame payload: 16MB. Unknown frame types are silently ignored.

#### Auto-Restart (Architect Sessions)

Architect sessions use `restartOnExit: true` in `SessionManager.createSession()`:
- On child exit, SessionManager increments restart counter
- After `restartDelay` (default: 2s), sends SPAWN frame to shellper with original command/args
- `maxRestarts` (default: 50) prevents infinite restart loops
- Counter resets after `restartResetAfter` (default: 5min) of stable operation

#### Architect Role Prompt Injection

All architect sessions (at all 3 creation points) receive a role prompt injected via `buildArchitectArgs()` in `tower-utils.ts`. This function:

1. Loads the architect role from `codev/roles/architect.md` (local) or `skeleton/roles/architect.md` (bundled fallback) via `loadRolePrompt()`
2. Writes the role content to `.architect-role.md` in the project directory
3. Delegates the CLI-specific injection to the configured `HarnessProvider` (`agent-farm/utils/harness.ts`, Spec 591): claude `--append-system-prompt`, codex `-c model_instructions_file=`. (The built-in `gemini` `GEMINI_SYSTEM_MD` provider was retired in #1338; retained-access users wire it back as a custom harness — see Supported Harnesses below.)

**Three architect creation points** where role injection is applied:
- `tower-instances.ts` → `launchInstance()` (new project activation)
- `tower-terminals.ts` → `reconcileTerminalSessions()` (startup reconnection with auto-restart options)
- `tower-terminals.ts` → `getTerminalsForWorkspace()` (on-the-fly shellper reconnection)

#### Builder Prompt: Protocol & Template Delivery (#1011)

Framework files (protocol docs, templates) live in the package skeleton (resolver tier 4) and are not guaranteed on disk in a fresh install, so builder-facing prompts must not fetch them by literal `codev/...` path. They are *delivered* through resolver-aware channels instead:

- **`{{protocol_reference}}`** — `buildPromptFromTemplate` (`agent-farm/commands/spawn-roles.ts`) fills this context variable by reading the protocol's `protocol.md` fresh through the four-tier resolver at spawn and inlining it under the prompt's "Protocol Reference (full text)" heading. Nothing is committed into the prompt, so nothing goes stale.
- **`{{> <codev-path>}}`** — a Handlebars-style include directive resolved by the shared `resolveCodevIncludes()` (`lib/skeleton.ts`): it pulls the referenced framework file fresh through the resolver (recursive, depth-guarded, unresolved includes drop to empty). It runs on two channels: at spawn (inside `protocol.md`, e.g. experiment/spike templates) and in porch's `loadPromptFile` (`commands/porch/prompts.ts`) for phase prompts (e.g. the spir/aspir plan template, which carries the machine-readable phases JSON the plan gate requires).

A `codev doctor` audit (`lib/framework-ref-audit.ts`) flags shell-fetch of framework files in a project's local `codev/` overrides; the shipped skeleton is guarded by a CI unit test.

**Every-template-has-a-consumer invariant (#1279).** A file under `protocols/<p>/templates/` is dead code unless some prompt or `protocol.md` delivers it via a `{{> }}` include — nothing else reads `templates/`. #1011 wired three of the nine shipped templates and the rest rotted unreferenced: builders never saw the spec and review templates, and the hand-rolled inline copies that stood in for them had already drifted from the canonical files. `__tests__/template-delivery.test.ts` now enforces both directions (no orphaned template, no dangling include) across both trees, with mutation checks proving the detector fails on a seeded violation. Consequence for authors: adding a template means adding its include in the same change, and ASPIR deliberately ships **no** `templates/` directory — it includes SPIR's, so there is exactly one copy of each template to keep current.

#### Supported Architect Harnesses & Conversation Resume (#929)

**Supported architect harnesses** (Issue #929): claude and codex are supported as architects, selected via `.codev/config.json` (`shell.architect` / `shell.architectHarness`) — the same config-driven mechanism builders use, and the *recommended* one. **The built-in `gemini` harness is retired (#1338)** — Google ended consumer Gemini CLI access (2026-06-18), so `gemini` is no longer a supported built-in builder *or* architect. It **fails closed** at every spawn / launch / reconnect / clean-exit boundary with a retirement message (never a silent claude fallback), and `codev doctor` flags a persisted `gemini` builder/architect config. Retained-access users (Standard/Enterprise or API-key) can still run it only via an **explicit** custom `gemini` harness selected through `shell.builderHarness` / `shell.architectHarness` — a bare auto-detected `gemini` command stays retired; the custom harness reproduces the old `GEMINI_SYSTEM_MD` env injection. (agy, the gemini successor, is deferred as an architect to #1063 — its only role-injection channel is a visible first user turn.) Harness auto-detection is **override-aware**: `getArchitectHarness` / `getBuilderHarness` resolve the harness from the override-aware command (`getResolvedCommands` → `cliOverrides` / `TOWER_ARCHITECT_CMD` / config), so a `--architect-cmd codex` / `TOWER_ARCHITECT_CMD=codex` / `--builder-cmd opencode` with no matching harness config still resolves the *non-claude* harness, not claude. (Before #929 it auto-detected from the raw config value only — an override launched the non-claude CLI but resolved the claude harness, re-arming the resume crash-loop below.) An explicit `shell.architectHarness` / `shell.builderHarness` still wins over auto-detection. OpenCode remains builder-only (file-based injection needs an ephemeral worktree). Codex reads project context (`AGENTS.md`) natively, so no architect context-file seam is needed; the `getArchitectFiles` seam #1059 added for gemini was removed with gemini's architect support.

> **Caveat — unrecognized override commands still default to the claude harness (tracked in cluesmith/codev#1062).** `#929`'s override-awareness only covers *recognized* harness commands (claude/codex/gemini/opencode, matched by `detectHarnessFromCommand`). An override command the detector does **not** recognize — e.g. `TOWER_ARCHITECT_CMD=bash`, a wrapper script, or any custom launcher — with **no** explicit `shell.architectHarness` / `shell.builderHarness` falls through `resolveHarness` to the **claude** harness (`harness.ts`, the final `return CLAUDE_HARNESS`). With a stale Claude `.jsonl` present, that can still build `<cmd> --resume <uuid>` for the unrecognized command. This is **pre-existing and narrow** (not a #929 regression — #929 strictly *improved* the recognized codex case) and separable. Mitigation today: set an explicit `shell.architectHarness` / `shell.builderHarness` when using an unrecognized launcher command.

**Architect conversation resume is stored-id-only (#832 / #1145).** Every architect launch path (`launchInstance` main spawn, `add-architect` / sibling reconcile, both shellper restart-bake sites) resolves through `resolveArchitectLaunch`: a session id stored on the workspace-scoped architect row (minted at spawn, pinned via the harness's `session.newSessionArgs`) is resumed only after the harness's optional `session.verifyOwnership` confirms the session file still exists for this cwd (Claude: `~/.claude/projects/<encoded-cwd>/<id>.jsonl`, accepted under either the logical or physical form of a symlinked path). Anything else — no row, no stored id, missing file — spawns fresh with role injection and a newly minted, persisted id. `launchInstance`'s mtime-based jsonl-discovery fallback was **removed** by #1145: on a fresh workspace (`codev adopt` / first touch) it resumed whatever Claude conversation the user last held in that directory — hijacking personal sessions, roleless too, since the resume path skips role injection. Do not reintroduce discovery on any architect path; mtime cannot distinguish an architect's session from a newer personal one in the same cwd. Discovery (`HarnessProvider.buildResume`, newest jsonl by mtime) survives for **builder resume only** (`spawn.ts` `discoverResumeSession`), harness-gated to claude — the gating that fixes the latent crash-loop where a non-Claude harness + a stale Claude `.jsonl` built an invalid `<cmd> --resume <claude-uuid>` invocation and shellper restart-looped to death.

**Builder crash restarts resume the pinned conversation (#1233).** Every Claude-harness builder spawn mints a fresh session UUID (never reused across spawns — #1224) and pins it into the generated `.builder-start.sh` via the harness's `session.newSessionScriptFragment` (`--session-id`). On an unnatural exit (nonzero / signal, bash's 128+N — the jetsam-SIGKILL class from #1227) the wrapper's loop (`buildSessionLaunchLoop`, spawn-worktree.ts) runs `--resume "$codev_session_id"` with a short nudge prompt instead of replaying the spawn prompt into a fresh session; the nudge matters because `--resume` restores the transcript but not a turn — without it an unattended builder idles. Three consecutive fast failures (< `CODEV_LAUNCH_FAST_FAIL_SECS`, default 15s — the unresumable-jsonl / held-id class, #1145/#1149) degrade to a prompt-replay relaunch under a re-minted id; a clean exit keeps #1267's Enter-gated fresh relaunch, also under a new pinned id. The wrapper maintains `.builder-session-id` in the worktree as the current-id surface, and **bash is its sole writer** — after a runtime re-mint no Node/DB copy can be accurate (consumption by `--resume`/recover is #1112's scope; recover still uses `buildResume` mtime discovery today). Harnesses without the script-form session seam (codex/gemini/opencode/custom) generate the historical loop byte-for-byte. The state machine lives in generated bash deliberately: builder PTYs survive Tower restarts, so no Node process is guaranteed to exist at crash time.

**Architect role injection is centralized in `buildArchitectArgs`** (`tower-utils.ts`), the shared helper every architect-launch path routes through — `launchInstance` (fresh), `add-architect` (sibling), shellper reconnect (×2), and the no-Tower `afx architect` (refactored in #929 to call `buildArchitectArgs` instead of duplicating injection). So the architect role is injected on **every** launch path, not just first-activation. (No architect context-file seam exists: claude/codex read project context natively; the gemini-only `getArchitectFiles` seam #1059 introduced was removed when gemini's architect support was dropped.)

#### Multi-Architect Support (Spec 755 / Spec 786)

A workspace can host more than one architect terminal. Each architect has a stable name (`main` for the workspace's default; siblings via `afx workspace add-architect`). The primary use case is letting a sibling architect drive a focused workflow without monopolising `main`.

**Identity flow**:
- Every architect terminal Tower spawns has `CODEV_ARCHITECT_NAME` injected into its env (see all three creation points above + Spec 786 Phase 2 which re-injects on shellper auto-restart).
- `afx spawn` reads the variable and tags the new builder row with `spawned_by_architect = <name>`.
- `afx send architect` from a builder uses the recorded name (via `tower-messages.ts:320-342`'s spawning-architect chain) to route back to the correct architect; falls back to `main` when the spawning architect is gone (Spec 786 OQ-A).
- `afx send architect:<name>` is the explicit-target form; works from any sender.

**Lifecycle (Spec 786 Phase 3 / OQ-B)**:
- **Add**: `afx workspace add-architect [--name <name>]`. Validator at `utils/architect-name.ts` enforces `[a-z][a-z0-9-]*` (max 64), rejects `main` as reserved (Spec 786). Auto-numbers via `autoNumberArchitectName` when `--name` is omitted (smallest unused `architect-<N>` integer ≥ 2).
- **Remove**: `afx workspace remove-architect <name>` (also dashboard close-X + VSCode right-click). Server refuses `main`. Removing an architect with in-flight builders proceeds — builders fall back to `main` routing. The registry deletes ARE the removal (Issue #1150): a failed DB delete is surfaced as an error with retry guidance, not swallowed, and a remove of a name with no live terminal purges any stale registration row directly — the recovery path for zombie rows however they arose.
- **Graceful stop**: `afx workspace stop` sets the `intentionallyStopping` flag (`tower-instances.ts`) so the six cascaded exit handlers (4 in `tower-instances.ts`, 2 in `tower-terminals.ts`) skip the `setArchitectByName(workspacePath, name, null)` call. Sibling rows in `state.db.architect` survive the stop, scoped by `workspace_path`.
- **Graceful start**: `launchInstance` creates `main` if absent (gate changed from `entry.architects.size === 0` to `!entry.architects.has('main')`), then iterates persisted siblings via `getArchitects(resolvedPath)` — workspace-scoped (Bugfix #826) — and re-spawns each via `addArchitect`. Critical ordering: main FIRST (otherwise `addArchitect`'s `size > 0` guard rejects the sibling spawn). The workspace scoping prevents architects registered in workspace A from leaking into workspace B at launch — schema-level isolation rather than per-call-site guards. **Sibling respawn is liveness-gated (Issue #1150)**: a persisted row is respawned only with evidence it's real — a matching `terminal_sessions` row, or a resumable session artifact per `siblingRegistrationIsLive` (`tower-utils.ts`, reusing #1145's `session.verifyOwnership`; session-less harnesses like codex are exempt because their respawn is always fresh). Rows with neither are pruned, not resurrected — the fix for removed architects reappearing after recovery events (stale rows from pre-#1118 wrong-file deletes, #1118 consolidation re-inserts of stale snapshots, or WAL loss under the old `synchronous = NORMAL`).
- **Crash recovery**: rows in `terminal_sessions` survive because Tower didn't clean them up; `reconcileTerminalSessions()` reconnects via shellper sockets.
- **Permanent exit** (max-restart exhaustion): exit handlers run WITHOUT the intentional-stop flag set, so `setArchitectByName(workspacePath, name, null)` fires and the row is auto-deleted (Spec 786 OQ-B — `state.db` mirrors reality).
- **Stop-all** (`tower-routes.ts:handleWorkspaceStopAll`): explicit "tear everything down" — full wipe of `terminal_sessions` and per-workspace `state.db.architect` rows. Semantically distinct from `stopInstance` which preserves sibling registration.

**Persistence layers** (the two tables are desired state vs runtime state — an architect identity spans many terminal instances over its life):
- `architect` (global.db) — durable per-architect registration, i.e. **desired state** ("this workspace should have this architect"). Schema: `(workspace_path TEXT NOT NULL, id TEXT NOT NULL, pid, port, cmd, started_at, terminal_id, session_id)` with composite primary key `(workspace_path, id)` (Bugfix #826 migration v11; `session_id` added by #832 for conversation resume). Workspace scoping is part of the schema: the same architect name (e.g. `main`) can exist in multiple workspaces without collision, and queries scoped to one workspace's `workspace_path` cannot return rows from another. `pid`/`port` persist as `0` (Spec 755 limitation); the live values come from Tower's `PtySession` only. Consumers must not treat row existence alone as truth — respawn is liveness-gated (Issue #1150, above).
- `terminal_sessions` — global runtime session registry, i.e. **runtime state** (one row per live terminal instance). Wiped on graceful stop (`stopInstance` and `stop-all`); preserved on crash. Reconciliation reads `role_id` to re-key the in-memory architect map. Not used as a workspace-scoping signal — the architect table carries that directly.

**Migration history**:
- v9 (Spec 755): rebuild architect table as TEXT primary key, rekey to 'main'.
- v11 (Bugfix #826): add `workspace_path` to architect, backfilling from `global.db.terminal_sessions` via ATTACH. Disambiguation uses `architect.terminal_id` as the primary key (matches one unique terminal_session row) with `role_id` as the fallback — for users already hit by the v3.1.1 leak whose `state.db.architect` has names appearing in MULTIPLE workspaces' terminal_session rows, this ensures each architect row is migrated to its LEGITIMATE workspace (the one whose terminal_session has the matching session UUID). Orphans (architects with neither match) are dropped.
- In-memory `WorkspaceTerminals.architects: Map<string,string>` — name → terminal id. Rebuilt on every `launchInstance`/reconciliation.

**Surface enumeration (Spec 786 Phase 5)**:
- Tower `/status` API emits ONE terminal entry per architect (replacing the Spec 755 v1 collapse to a single `'Architect'` entry). Each entry carries: `type='architect'`, `id` (tab id — `'architect'` for main, `'architect:<name>'` for siblings per Spec 761's deep-link convention), `label`, `architectName`, `pid` (live from PtySession), `terminalId` (actual session id).
- `loadState()` populates `DashboardState.architects[]` sorted main-first, with the scalar `state.architect` shim pointing at `architects[0]` for backward compat.
- `afx status` enumerates ALL architects (Tower-up: name + PID + port + terminal id; Tower-down: name + cmd, with `"Tower not running — PID/port not available"` note).

**Dashboard surfaces**:
- Right-pane tabs (builders, shells, file annotations) carry close buttons via the existing `TabBar.tsx` + `closable` flag.
- Left-pane architect tab strip (`ArchitectTabStrip.tsx`) shows one tab per architect. `main`'s tab is non-closable; sibling tabs render a close button that triggers a confirmation modal (informational list of in-flight builders; remove proceeds regardless per OQ-A). Phase 4 of Spec 786.
- Spec 786 / Issue #764: when only one architect is registered (N=1), the tab label is the literal `'Architect'` rather than the internal `'main'` identifier. When N>1, labels use the architect name. The `architectName` property carries identity for deep-link/persistence regardless of label.

**VSCode extension (Spec 786 Phase 6 + Spec 823 Phase 4)**:
- The Workspace sidebar has an expandable "Architects" tree section (replacing the pre-786 singleton "Open Architect" row). One child per architect. Click → opens that architect's terminal.
- `terminal-manager.ts` keys terminal slots by architect name (`architect:${name}`), not the pre-786 singleton `'architect'`. Each architect gets its own VSCode terminal.
- Right-click context menu on a sibling entry → "Remove Architect" (gated on `viewItem == workspace-architect-sibling`; `main` uses `'workspace-architect-main'` and gets no remove option).
- `codev.referenceIssueInArchitect` (Backlog inline button) always targets `main` regardless of how many siblings exist — preserves the pre-786 Backlog UX.
- **Spec 823**: the tree auto-refreshes when an architect is added or removed from outside VSCode (CLI, dashboard close-button, mobile TabBar). Tower emits an `architects-updated` SSE notification from every successful add/remove path; `WorkspaceProvider` subscribes via its existing `connectionManager.onSSEEvent` callback and fires `changeEmitter` on a matching envelope. Same JSON-envelope-on-`data:` shape as `codev-config-updated`, no workspace filter at the SSE-subscriber layer.

#### Tower SSE Event Conventions

Tower fans events to subscribers via an SSE stream. The shape convention (used by `codev-config-updated`, `architects-updated`, and `builder-spawned`):

- Events ride the generic `notification` SSE event type — no per-event-type `event:` name on the SSE wire. The SSE-client-level `type` is always `''`; the real event-type lives inside the JSON envelope at `data.type`.
- Subscribers parse the `data:` JSON in a `try/catch` to swallow malformed payloads, then match `envelope.type === '<known>'` to decide whether to act.
- `NotifyFn` shape (`codev-config-watcher.ts:19-24`): `{ type: string; title: string; body: string; workspace?: string }`. `body` is `JSON.stringify({ workspace })` for events that are workspace-scoped.
- `ctx.broadcastNotification` is available directly on the `RouteContext` for route handlers; standalone modules (like the worktree config watcher) wire their own notifier via a setter (`setWorktreeConfigNotifier`).

#### Builder Gate Notifications (Spec 0100, replaced by Spec 0108)

As of Spec 0108, porch sends direct `afx send architect` notifications via `execFile` when gates transition to pending. The `notifyArchitect()` function in `commands/porch/notify.ts` is fire-and-forget: 10s timeout, errors logged to stderr but never thrown. Called at the two gate-transition points in `next.ts`.

> **Historical note** (Spec 0100): Gate notifications were originally implemented as a polling-based `GateWatcher` class in Tower (`gate-watcher.ts`), which polled porch YAML status files on a 10-second interval. This was replaced by the direct notification approach in Spec 0108. The passive `gate-status.ts` reader is preserved for dashboard API use.

#### Initial Terminal Dimensions

Shellper sessions are spawned with `cols: 80, rows: 24` (standard VT100 defaults) before the browser connects. The browser sends a RESIZE frame on WebSocket connect, and Terminal.tsx also force-sends a resize after replay buffer flush to ensure the shell redraws at the correct size.

#### Security

- **Unix socket permissions**: `~/.codev/run/` is `0700` (owner-only). Socket files are `0600`.
- **No authentication protocol**: Filesystem permissions are the authentication mechanism.
- **Input isolation**: Each shellper manages exactly one session. No cross-session access.
- **PID reuse protection**: Reconnection validates process start time, not just PID.

#### Session Naming Convention

Each session has a unique name based on its purpose:

| Session Type | Name Pattern | Example |
|--------------|--------------|---------|
| Architect | `architect:{name}` (Spec 786) | `architect:main`, `architect:sibling`, `architect:architect-2` |
| Builder | `builder-{protocol}-{id}` | `builder-spir-126` |
| Shell | `shell-{id}` | `shell-U1A2B3C4` |

#### node-pty Terminal Manager (Spec 0085, extended by Spec 0104)

All terminal sessions are managed by the Terminal Manager (`packages/codev/src/terminal/`), which multiplexes PTY sessions over WebSocket. As of Spec 0104, PtySession supports two I/O backends: direct node-pty (non-persistent) and shellper-backed (persistent via `attachShellper()`).

```bash
# REST API for session management
POST /api/terminals              # Create PTY session
GET  /api/terminals              # List sessions
DELETE /api/terminals/:id        # Kill session
POST /api/terminals/:id/resize   # Resize (cols, rows)
PATCH /api/terminals/:id/rename  # Rename shell session (Spec 468)

# WebSocket connection per terminal
ws://localhost:4100/ws/terminal/<session-id>
```

**Hybrid WebSocket Protocol** (binary frames):
- Frame prefix `0x00`: Control message (JSON: resize, ping/pong)
- Frame prefix `0x01`: Data message (raw PTY bytes)

**PTY Environment** (critical for Unicode rendering):
```typescript
const baseEnv = {
  TERM: 'xterm-256color',
  LANG: process.env.LANG ?? 'en_US.UTF-8',  // Required for Unicode rendering
};
```

**Ring Buffer**: Each session maintains a 1000-line ring buffer with monotonic sequence numbers for reconnection replay. On WebSocket connect, the server replays the full buffer. Non-browser clients can send an `X-Session-Resume` header with their last sequence number to receive only missed data (browsers cannot set custom WebSocket headers).

**Disk Logging**: Terminal output is logged to `.agent-farm/logs/<session-id>.log` with 50MB rotation.

### State Management

Agent Farm uses SQLite for ACID-compliant state persistence. Issue #1118 consolidated
everything into **one user-global database** (`~/.agent-farm/global.db`); the per-workspace
`.agent-farm/state.db` file was retired (its cwd-dependent location caused architect state to
"disappear" across Tower restarts). `getDb()` and `getGlobalDb()` both return the single global
connection.

#### Dashboard State tables (in `global.db`)

`architect`, `builders`, `utils`, and `annotations` (formerly in `state.db`) live in `global.db`.
`architect` and `builders` are keyed by a composite `(workspace_path, id)` so the same name/id
can exist in multiple workspaces (a builder id is `<protocol>-<issueNumber>`, unique per repo but
reused across repos); `utils`/`annotations` are UUID-keyed. `state.ts` reads/writes them via
`getDb()`; the one-time on-disk migration of legacy `state.db` files lives in
`db/consolidate.ts` (marker-gated boot one-off + the manual `afx db consolidate <path>`). See
`packages/codev/src/agent-farm/db/schema.ts` (`GLOBAL_SCHEMA`, migration v14) for the full schema.

#### State Operations (from `state.ts`)

All state operations are synchronous for simplicity:

| Function | Purpose |
|----------|---------|
| `loadState()` | Load complete dashboard state |
| `setArchitect(state)` | Set or clear architect state |
| `upsertBuilder(builder)` | Add or update a builder |
| `removeBuilder(id)` | Remove a builder |
| `getBuilder(id)` | Get single builder |
| `getBuilders()` | Get all builders |
| `getBuildersByStatus(status)` | Filter by status |
| `addUtil(util)` | Add utility terminal |
| `removeUtil(id)` | Remove utility terminal |
| `addAnnotation(annotation)` | Add file viewer |
| `removeAnnotation(id)` | Remove file viewer |
| `clearState()` | Clear all state |

#### Builder Lifecycle States

```
spawning → implementing → blocked → implementing → pr → complete
               ↑______________|
```

| Status | Meaning |
|--------|---------|
| `spawning` | Worktree created, builder starting |
| `implementing` | Actively working on spec |
| `blocked` | Needs architect help |
| `pr` | Implementation complete, awaiting review |
| `complete` | Merged, ready for cleanup |

### Worktree Management

Git worktrees provide isolated working directories for each builder, enabling parallel development without conflicts.

#### Worktree Creation

When spawning a builder (`afx spawn 3 --protocol spir`):

1. **Generate IDs**: Create builder ID and branch name
   ```
   builderId: "0003"
   branchName: "builder/0003-feature-name"
   worktreePath: ".builders/0003"
   ```

2. **Create Branch**: `git branch builder/0003-feature-name HEAD`

3. **Create Worktree**: `git worktree add .builders/0003 builder/0003-feature-name`

4. **Setup Files**:
   - `.builder-prompt.txt`: Initial prompt for the builder
   - `.builder-role.md`: Role definition (from `codev/roles/builder.md`)
   - `.builder-start.sh`: Launch script for builder session
   - Root `.env` and shared `.codev/config.json`: symlinked into the worktree,
     along with configured `worktree.symlinks`
   - Personal `.codev/config.local.json`: when present in the main workspace,
     copied atomically into the builder as a regular-file snapshot so builder
     writes cannot mutate the main file; `afx setup` refreshes the snapshot
   - Configured `worktree.postSpawn` hooks: run after symlinks and the personal
     config snapshot are ready

#### Worktree Write-Guard (Issue #1018)

A builder worktree is **nested inside the main checkout** and byte-identical to it at the branch base. The `Write`/`Edit` tools require absolute paths, so the builder model synthesizes one; when it anchors at the inferred canonical repo root instead of its worktree cwd, the `.builders/<id>/` segment is dropped and the write silently lands in the main checkout. This is intrinsic model/CLI path-synthesis behavior that drifts across upgrades, so instructions/memory don't hold — only a deterministic guard does.

The guard is a Claude **PreToolUse hook**, installed per-worktree at spawn time through the existing `HarnessProvider.getWorktreeFiles()` → `writeWorktreeFiles()` path (`CLAUDE_HARNESS` only — `PreToolUse` is Claude-specific). `buildWorktreeGuardFiles()` (`packages/codev/src/agent-farm/utils/worktree-write-guard.ts`, the single source of truth) emits two files:

- `.claude/hooks/worktree-write-guard.cjs` — a self-contained Node hook (no project imports; ships as a TS string constant since `tsc` copies no assets). It denies any `Write`/`Edit` whose `file_path` resolves outside the worktree root, allowlisting temp dirs (`/tmp`, `/private/tmp`, `$TMPDIR`) and `$HOME/.claude` (builder memory/config). Paths are canonicalized via realpath-of-longest-existing-ancestor (handles non-existent new files and macOS `/tmp`→`/private/tmp`). **Fail-open** on any error so it never bricks a session.
- `.claude/settings.local.json` — wires the hook on `Write|Edit|MultiEdit`, baking the worktree root in as `CODEV_WORKTREE_ROOT` (deterministic) with `git rev-parse --show-toplevel` as a runtime fallback.

Scope: write surface only. Reads are untouched, preserving codev's intentional cross-checkout reads (architect reads builder threads, sibling-thread reads). The complementary control for the Bash write surface (`>`, `cp`, `tee`) is relative-path discipline (cwd = worktree), documented in `roles/builder.md`. The architect session is unaffected — it launches via `buildRoleInjection` in the main checkout and never receives the hook (and modifying `main` is its job by design). The consult sub-agent read-surface sibling (#1092) is a separate fix.

#### Directory Structure

```
project-root/
├── .builders/                    # All builder worktrees
│   ├── 0003/                     # Builder for spec 0003
│   │   ├── .builder-prompt.txt   # Initial instructions
│   │   ├── .builder-role.md      # Builder role content
│   │   ├── .builder-start.sh     # Launch script
│   │   └── [full repo copy]      # Complete working directory
│   ├── task-A1B2/                # Task-based builder
│   │   └── ...
│   └── worktree-C3D4/            # Interactive worktree
│       └── ...
└── .agent-farm/                  # State directory
    └── state.db                  # SQLite database
```

#### Builder Modes

Builders can run in two modes:

| Mode | Flag | Behavior |
|------|------|----------|
| **Strict** (default) | `afx spawn XXXX --protocol spir` | Porch orchestrates - runs autonomously to completion |
| **Soft** | `afx spawn XXXX --protocol spir --soft` | AI follows protocol - architect verifies compliance |

**Strict mode** (default for `--project`): Porch orchestrates the builder with automated gates, 3-way consultations, and enforced phase transitions. More likely to complete autonomously.

**Soft mode**: Builder reads and follows the protocol document, but you monitor and verify compliance. Use `--soft` flag or non-project modes (task, shell, worktree).

#### Builder Types

| Type | Flag | Worktree | Branch | Default Mode |
|------|------|----------|--------|--------------|
| `spec` | `--project/-p` | Yes | `builder/{id}-{name}` | Strict (porch) |
| `task` | `--task` | Yes | `builder/task-{id}` | Soft |
| `protocol` | `--protocol` | Yes | `builder/{protocol}-{id}` | Soft |
| `shell` | `--shell` | No | None | Soft |
| `worktree` | `--worktree` | Yes | `builder/worktree-{id}` | Soft |
| `bugfix` | `--issue/-i` | Yes | `builder/bugfix-{id}` | Soft |

#### Cleanup Process

When cleaning up a builder (`afx cleanup -p 0003`):

1. **Check for uncommitted changes**: Refuses if dirty (unless `--force`)
2. **Kill PTY session**: Terminal Manager kills node-pty session
3. **Kill shellper session**: `SessionManager.killSession()` sends SIGTERM, waits 5s, SIGKILL, cleans up socket
4. **Remove worktree**: `git worktree remove .builders/0003`
5. **Delete branch**: `git branch -d builder/0003-feature-name`
6. **Update state**: Remove builder from database
7. **Prune worktrees**: `git worktree prune`

### Tower Single Daemon Architecture (Spec 0090, decomposed in Spec 0105)

As of v2.0.0 (Spec 0090 Phase 4), Agent Farm uses a **Tower Single Daemon** architecture. The Tower server manages all projects directly - there are no separate dashboard-server processes per project. As of Spec 0105, the monolithic `tower-server.ts` was decomposed into focused modules (see "Server Architecture" below for the full module table).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Tower Server (port 4100)                             │
│          HTTP server + WebSocket multiplexer + Terminal Manager              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────┐    ┌─────────────────────┐                         │
│  │   Workspace A       │    │   Workspace B       │                         │
│  │   /workspace/enc(A)/│    │   /workspace/enc(B)/│                         │
│  │                     │    │                     │                         │
│  │  ┌───────────────┐  │    │  ┌───────────────┐  │                         │
│  │  │ Architect     │  │    │  │ Architect     │  │                         │
│  │  │ (shellper)    │  │    │  │ (shellper)    │  │                         │
│  │  └───────────────┘  │    │  └───────────────┘  │                         │
│  │  ┌───────────────┐  │    │  ┌───────────────┐  │                         │
│  │  │ Shells        │  │    │  │ Builders      │  │                         │
│  │  │ (shellper)    │  │    │  │ (shellper)    │  │                         │
│  │  └───────────────┘  │    │  └───────────────┘  │                         │
│  └─────────────────────┘    └─────────────────────┘                         │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    workspaceTerminals Map (in-memory)                  │    │
│  │  Key: workspacePath → { architect?: terminalId,                        │    │
│  │                       builders: Map<builderId, terminalId>,          │    │
│  │                       shells: Map<shellId, terminalId> }             │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    TerminalManager (node-pty sessions)               │    │
│  │  - Spawns PTY sessions via node-pty or attaches to shellper         │    │
│  │  - createSessionRaw() for shellper-backed sessions (no spawn)       │    │
│  │  - Maintains ring buffer (1000 lines) per session                    │    │
│  │  - Handles WebSocket broadcast to connected clients                  │    │
│  │  - shutdown() preserves shellper-backed sessions                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                 SessionManager (shellper orchestration)              │    │
│  │  - Spawns shellper-main.js as detached OS processes                 │    │
│  │  - Connects ShellperClient to each shellper via Unix socket         │    │
│  │  - Reconnects to living shellpers after Tower restart               │    │
│  │  - Auto-restart for architect sessions (SPAWN frame)                │    │
│  │  - Cleans up stale sockets on startup                               │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                    WebSocket /workspace/<enc>/ws/terminal/<id>
                                    │
              ┌─────────────────────┴─────────────────────┐
              │                                           │
              ▼                                           ▼
   ┌──────────────────┐                       ┌──────────────────┐
   │  React Dashboard │                       │  React Dashboard │
   │  (Project A)     │                       │  (Project B)     │
   │  xterm.js tabs   │                       │  xterm.js tabs   │
   └──────────────────┘                       └──────────────────┘
```

#### Key Architectural Invariants

**These MUST remain true - violating them will break the system:**

1. **Single PTY per terminal**: Each architect/builder/shell has exactly one PtySession in TerminalManager (either node-pty direct or shellper-backed)
2. **workspaceTerminals is the runtime source of truth**: The in-memory Map tracks which terminals belong to which workspace
3. **SQLite (global.db) tracks terminal sessions and workspace metadata**: Shellper metadata (`shellper_socket`, `shellper_pid`, `shellper_start_time`), custom labels (Spec 468), and workspace associations persist across restarts
4. **Tower serves React dashboard directly**: No separate dashboard-server processes - Tower serves `/workspace/<encoded>/` routes
5. **WebSocket paths include workspace context**: Format is `/workspace/<base64url>/ws/terminal/<id>`

#### State Split Problem & Reconciliation

**WARNING**: The system has a known state split between:
- **SQLite (global.db)**: Persistent terminal session metadata (including `shellper_socket`, `shellper_pid`, `shellper_start_time`) and workspace associations
- **In-memory (workspaceTerminals)**: Runtime terminal state

On Tower restart, `workspaceTerminals` is empty but SQLite retains terminal session metadata. The reconciliation strategy (`reconcileTerminalSessions()` in `tower-terminals.ts`) uses a **dual-source approach**:

1. **Phase 1 -- Shellper reconnection**: For SQLite rows with `shellper_socket IS NOT NULL`, attempt `SessionManager.reconnectSession()`. Validates PID is alive and start time matches. On success, creates a PtySession via `TerminalManager.createSessionRaw()` and wires it with `attachShellper()`. Receives REPLAY frame for output continuity.
2. **Phase 2 -- SQLite sweep**: Stale rows (no matching shellper) are cleaned up. Orphaned non-shellper processes are killed. Shellper processes are preserved (they may be reconnectable later).

This dual-source strategy (SQLite + live shellper processes) ensures sessions survive Tower restarts when backed by shellper processes.

#### Server Architecture (Spec 0105: Tower Decomposition)

- **Framework**: Native Node.js `http` module (no Express)
- **Port**: 4100 (Tower default)
- **Security**: Localhost binding only (see Security Model section)
- **State**: In-memory `workspaceTerminals` Map + SQLite for terminal sessions and workspace metadata

**Module decomposition** (Spec 0105): The monolithic `tower-server.ts` was decomposed into focused modules with dependency injection. The orchestrator (`tower-server.ts`) creates the HTTP server and initializes all subsystems, delegating work to specialized modules:

| Module | Purpose |
|--------|---------|
| `tower-server.ts` | **Orchestrator** -- creates HTTP/WS servers, initializes subsystems, wires dependency injection, handles graceful shutdown |
| `tower-routes.ts` | All HTTP route handlers (~30 routes). Receives a `RouteContext` from the orchestrator. |
| `tower-instances.ts` | Project lifecycle: `launchInstance()`, `getInstances()`, `stopInstance()`, `killTerminalWithShellper()`, known project registration, directory suggestions |
| `tower-terminals.ts` | Terminal session CRUD, file tab persistence, shell ID allocation, `reconcileTerminalSessions()`, gate watcher, terminal list assembly |
| `tower-websocket.ts` | WebSocket upgrade routing and bidirectional WS-to-PTY frame bridging (`handleTerminalWebSocket()`) |
| `tower-utils.ts` | Shared utilities: rate limiting, path normalization, `isTempDirectory()`, MIME types, static file serving, `buildArchitectArgs()` |
| `tower-types.ts` | TypeScript interfaces: `TowerContext`, `WorkspaceTerminals`, `SSEClient`, `RateLimitEntry`, `TerminalEntry`, `InstanceStatus`, `DbTerminalSession` |
| `tower-tunnel.ts` | Cloud tunnel client lifecycle, config file watching, metadata refresh |
| `statistics.ts` | Statistics aggregation service: GitHub metrics, builder throughput, consultation breakdown. 60s in-memory cache. (Spec 456) |

**Dependency injection pattern**: Each module exports `init*()` and `shutdown*()` lifecycle functions. The orchestrator calls `initTerminals()`, `initInstances()`, and `initTunnel()` at startup (in dependency order), and the corresponding shutdown functions during graceful shutdown. Modules receive only the dependencies they need via typed interfaces (e.g., `TerminalDeps`, `InstanceDeps`, `RouteContext`).

#### Tower API Endpoints (Spec 0090)

**Tower-level APIs (port 4100):**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` | Serve Tower dashboard HTML |
| `GET` | `/health` | Health check (uptime, memory, active projects) |
| `GET` | `/api/workspaces` | List all workspaces with status |
| `GET` | `/api/workspaces/:enc/status` | Get workspace status (terminals, gates) |
| `POST` | `/api/workspaces/:enc/activate` | Activate workspace (creates `main` architect terminal) |
| `POST` | `/api/workspaces/:enc/architects` | Register an additional named architect (Spec 755) |
| `POST` | `/api/workspaces/:enc/deactivate` | Deactivate workspace (kills all architect terminals + builders + shells) |
| `GET` | `/api/status` | Legacy: Get all instances (backward compat) |
| `POST` | `/api/launch` | Legacy: Launch instance (backward compat) |
| `POST` | `/api/stop` | Stop instance by workspacePath |
| `GET` | `/api/browse?path=` | Directory autocomplete for project selection |
| `POST` | `/api/create` | Create new project (codev init + activate) |
| `GET` | `/api/events` | SSE stream for push notifications |
| `POST` | `/api/notify` | Broadcast notification to SSE clients |

**SSE event types** broadcast on `/api/events` (each arrives as a JSON envelope `{ type, title, body, workspace?, id }` on the `data:` field):

| Type | Emitted when | `body` payload |
|------|--------------|----------------|
| `overview-changed` | Overview cache invalidated | Human-readable string |
| `notification` | `POST /api/notify` called | Caller-supplied string |
| `builder-spawned` | Tower registers a new builder terminal (in `handleTerminalCreate`) | JSON-stringified `BuilderSpawnedPayload`: `{ terminalId, roleId, workspacePath }` (see `packages/types/src/sse.ts`) |
| `connected` | SSE client first connects | Client id |
| `heartbeat` | Every 30s keepalive | `:heartbeat` (not JSON) |

Clients may ignore unknown event types — older clients silently drop `builder-spawned`, and newer clients fall back to `overview-changed` when connected to older Tower builds.

**Workspace-scoped APIs (via Tower proxy):**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/workspace/:enc/` | Serve React dashboard for workspace |
| `GET` | `/workspace/:enc/api/state` | Get workspace state (architect, builders, shells) |
| `POST` | `/workspace/:enc/api/tabs/shell` | Create shell terminal for workspace |
| `DELETE` | `/workspace/:enc/api/tabs/:id` | Close a tab |
| `POST` | `/workspace/:enc/api/stop` | Stop all terminals for workspace |
| `GET` | `/workspace/:enc/api/statistics` | Aggregated statistics (GitHub, builders, consultation) (Spec 456) |
| `WS` | `/workspace/:enc/ws/terminal/:id` | WebSocket terminal connection |

**Note**: `:enc` is the workspace path encoded as Base64URL (RFC 4648). Example: `/Users/me/project` → `L1VzZXJzL21lL3Byb2plY3Q`

**Terminal API (global):**

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/terminals` | Create PTY session |
| `GET` | `/api/terminals` | List all PTY sessions |
| `GET` | `/api/terminals/:id` | Get PTY session metadata |
| `DELETE` | `/api/terminals/:id` | Kill PTY session |
| `POST` | `/api/terminals/:id/resize` | Resize PTY session |
| `GET` | `/api/terminals/:id/output` | Get ring buffer output |
| `WS` | `/ws/terminal/:id` | WebSocket terminal connection |

#### Multi-architect routing (Spec 755)

A workspace can host more than one architect terminal. The data model:

- **In-memory**: `WorkspaceTerminals.architects: Map<string, string>` (name → `terminalId`). The first architect is named `main` by default; subsequent architects auto-number to `architect-2`, `architect-3`, ... unless the user supplies a name via `afx workspace add-architect --name <name>`. Validation lives in `packages/codev/src/agent-farm/utils/architect-name.ts`.
- **Local `state.db`**: `architect.id TEXT PRIMARY KEY` (no longer a singleton). `setArchitect(...)` writes the `main`-named row for backward-compat; `setArchitectByName(name, ...)` is the multi-architect setter.
- **Global `~/.agent-farm/global.db`**: `terminal_sessions.role_id` stores the architect's name (previously NULL for architects). Crash recovery / reconnect uses this to re-key `entry.architects` by name.

The routing chain when a builder runs `afx send architect "..."`:

1. **CLI** — `commands/send.ts` populates the request body's `from` field with the builder's ID (detected from the worktree path).
2. **handleSend** (`tower-routes.ts`) — receives the request, forwards `from` to the resolver via `resolveTarget(to, workspace, from)`. The third arg was added in Spec 755; older callers (`tower-cron.ts`, etc.) pass nothing and see unchanged behavior.
3. **resolveTarget** (`tower-messages.ts`) — splits `architect:<name>` from `<agent>` via a special-case intercept (the `parseAddress` grammar can't distinguish `project:agent` cross-workspace addresses from `architect:<name>` per-architect addresses, so the resolver does it). For plain `architect`, calls `resolveAgentInWorkspace`.
4. **resolveAgentInWorkspace** — applies four rules:
   - Single-architect fast path (`size === 1 && has('main')`) returns the `main` terminal without touching `state.db`. Guarantees latency parity for solo-architect users.
   - Builder sender with matching `spawnedByArchitect` → that architect.
   - Builder sender with `spawnedByArchitect` no longer registered → `main` fallback; if `main` is absent, verbatim "architect-gone" error.
   - Builder sender with NULL `spawnedByArchitect` (legacy row) → `main` fallback; if `main` is absent, verbatim "legacy-builder" error.
   - Non-builder sender → `main` (or first registered).
5. **architect:<name>** — same builder-context check; if the sender's `spawnedByArchitect` doesn't match `<name>`, rejected with the spoofing error.

**Builder-context detection** is via SQLite row presence: `lookupBuilderSpawningArchitect(builderId, workspacePath)` returns `string | null | undefined` distinguishing "explicit name" / "legacy row" / "not a builder." Tower side opens the workspace's `state.db` readonly (mirrors the `servers/overview.ts` pattern); CLI side falls back to the singleton `getDb()`.

**Backward compatibility invariants**:
- `/api/state` response shape preserved: `state.architect` remains scalar, populated from `main` (or first registered).
- `state.ts:loadState()` returns the `main`-first architect via the same scalar shim.
- Single-architect workspaces show byte-for-byte identical behavior.

**CI guardrail**: `spec-755-guardrail.test.ts` fails the build if `entry.architect` (singular accessor) reappears in production code.

#### Dashboard UI (React + Vite, Spec 0085)

As of v2.0.0 (Spec 0085), the dashboard is a React + Vite SPA replacing the vanilla JS implementation:

```
packages/codev/dashboard/
├── src/
│   ├── components/
│   │   ├── App.tsx              # Root layout (split pane desktop, single pane mobile)
│   │   ├── Terminal.tsx         # xterm.js wrapper with WebSocket client
│   │   ├── TabBar.tsx           # Tab management (builders, shells, annotations)
│   │   ├── WorkView.tsx         # Work view: builders, PRs, backlog (Spec 0126)
│   │   ├── StatisticsView.tsx  # Statistics tab: GitHub, Builder, Consultation metrics (Spec 456)
│   │   ├── TeamView.tsx         # Team tab: member cards, messages, GitHub activity, review-blocking (Spec 587, 694)
│   │   ├── BuilderCard.tsx      # Builder card with phase/gate indicators (Spec 0126)
│   │   ├── PRList.tsx           # Pending PR list with review status (Spec 0126)
│   │   ├── BacklogList.tsx      # Backlog grouped by readiness (Spec 0126)
│   │   ├── OpenFilesShellsSection.tsx  # Open shells (running/idle) + files (Spec 467)
│   │   ├── FileTree.tsx         # File browser
│   │   └── SplitPane.tsx        # Resizable panes
│   ├── hooks/
│   │   ├── useTabs.ts           # Tab state from /api/state polling
│   │   ├── useBuilderStatus.ts  # Builder status polling
│   │   ├── useOverview.ts       # Overview data polling (Spec 0126)
│   │   ├── useStatistics.ts    # Statistics data fetching with tab activation refresh (Spec 456)
│   │   ├── useTeam.ts           # Team data fetching with fetch-on-activation (Spec 587)
│   │   └── useMediaQuery.ts     # Responsive breakpoints
│   ├── lib/
│   │   ├── api.ts               # REST client + getTerminalWsPath() + overview API
│   │   ├── constants.ts         # Breakpoints, configuration
│   │   └── scrollController.ts  # Terminal scroll state machine (Spec 627)
│   └── main.tsx
├── dist/                         # Built assets (served by tower-server)
├── vite.config.ts
└── package.json
```

**Building**: `pnpm build` in `packages/codev/` builds `apps/web` as part of the graph-derived workspace-dependency closure, then copies `apps/web/dist` into `dashboard-dist` via the `copy-dashboard` step (Issue #1352). Output: ~64KB gzipped.

**Terminal Component** (`Terminal.tsx`):
- xterm.js with `customGlyphs: true` for crisp Unicode block elements
- WebSocket connection to `/ws/terminal/<id>` using hybrid binary protocol
- DA (Device Attribute) response filtering: buffers initial 300ms to catch `ESC[?...c` sequences
- Canvas renderer with dark theme
- **ScrollController** (Spec 627, `dashboard/src/lib/scrollController.ts`): Unified scroll state machine with lifecycle phases (`initial-load` → `buffer-replay` → `interactive`). Replaces the previous three competing mechanisms (safeFit, scroll monitor setInterval, post-flush setTimeout). Event-driven, no polling. Provides `safeFit()`, `beginReplay()`/`endReplay()`, `enterInteractive()`, `reset()` (for reconnection), and `suppressFit()`/`unsuppressFit()`.
- **Persistent prop** (Spec 0104): Accepts `persistent?: boolean`. When `persistent === false`, renders a yellow warning banner: "Session persistence unavailable -- this terminal will not survive a restart". Prop flows from `/api/state` through `useTabs` hook → `Tab` interface → `App.tsx` → `Terminal.tsx`.

**Tab System**:
- Architect tab (always present when running)
- Builder tabs (one per spawned builder)
- Utility tabs (shell terminals, filtered to exclude stale entries with pid=0)
- File tabs (annotation viewers)
- Each tab carries a `persistent?: boolean` field sourced from `/api/state`

**Work View** (Spec 0126):
- Default tab, replaces legacy StatusPanel
- Three sections: Active Builders, Pending PRs, Backlog & Open Bugs
- Data from `/api/overview` endpoint (GitHub + filesystem derived)
- Collapsible file panel at bottom with search bar

**Statistics View** (Spec 456):
- Second static tab (`∿ Stats`), non-closable, always-mounted with CSS display toggling
- Three collapsible sections: GitHub metrics, Builder throughput, Consultation breakdown
- Data from `/api/statistics?range=<7|30|all>` endpoint with 60s server-side cache
- Backend aggregates from GitHub CLI (`gh pr list --state merged`, `gh issue list`), MetricsDB (`~/.codev/metrics.db`), and active builder count from Tower workspace terminals
- No auto-polling; refreshes on tab activation, range change, or manual Refresh button
- `useStatistics(isActive)` hook manages fetch lifecycle with tab activation detection
- `+ Shell` button in header for creating shell terminals

**Team View** (Spec 587):
- Conditional tab — only appears when `codev/team/people/` has 2+ valid member files
- `teamEnabled` boolean in `DashboardState` controls tab visibility (set by `hasTeam()` in `/api/state`)
- Member cards: name, role badge, GitHub handle link, clickable issue/PR title lists, recent activity counts (last 7 days)
- Combined activity feed: unified reverse-chronological timeline of merged PRs and closed issues across all members
- Message log from `codev/team/messages.md` displayed in reverse chronological order
- Data from `/api/team` endpoint — members enriched with batched GraphQL GitHub data
- Fetch-on-activation pattern (like Statistics), manual refresh button, no polling
- `useTeam(isActive)` hook manages fetch lifecycle
- Graceful degradation: shows member cards without GitHub data when API unavailable
- Backend: `team.ts` (parsing), `team-github.ts` (GraphQL), `MessageChannel` interface for extensibility
- CLI: `team list`, `team message`, `team update`, `team add` (standalone `team` CLI; `afx team` is deprecated). Hourly cron via `.af-cron/team-update.yaml`

**Responsive Design**:
- Desktop (>768px): Split-pane layout with file browser sidebar
- Mobile (<768px): Single-pane stacked layout, 40-column terminals

### Error Handling and Recovery

Agent Farm includes several mechanisms for handling failures and recovering from error states.

#### Orphan Session Detection

On startup, `handleOrphanedSessions()` and `reconcileTerminalSessions()` detect and clean up:
- Stale shellper sockets with no live process (via `SessionManager.cleanupStaleSockets()`)
- node-pty sessions without active WebSocket clients
- State entries for dead processes

Shellper processes are treated specially during cleanup: orphaned shellpers are NOT killed during the SQLite sweep because they may be reconnectable later. Only non-shellper orphaned processes receive SIGTERM.

```typescript
// From session-manager.ts — stale socket cleanup
async cleanupStaleSockets(): Promise<number> {
  // Scan ~/.codev/run/shellper-*.sock
  // Skip symlinks (security), skip active sessions
  // Probe socket: connect to check if shellper is alive
  // If connection refused → stale, unlink socket file
}
```

**Husk sweep (Issue #1227).** The "orphaned shellpers are never killed" policy above is deliberately permissive for the reconnectable case, but it also permanently protects a shellper whose PTY child has already exited (a "husk") — a husk's socket still responds, so `killOrphanedShellpers` skips it forever, even though it is not reconnectable. A separate, stricter sweep (`shellper-husk-sweep.ts`) closes that gap: it reaps a shellper only when it is simultaneously **unregistered** (no live PID in `terminal_sessions`), **childless** (no OS child process), and **aged** past a grace period (`SHELLPER_HUSK_GRACE_MS`, default 1h) — three conditions that together are true only for a genuine husk, never a live or reconnectable session. It runs on three triggers: Tower startup, an hourly in-process timer, and on-demand via `afx tower sweep-husks` (dry-run preview by default, `--apply` to reap, mirroring `afx workspace recover`'s UX). Fleet-wide RSS and an unregistered-shellper count are surfaced in `/health` and `afx status` for observability, computed from a shared `process-census.ts` `ps` scan.

**Session log retention (Issue #1238).** PTY session logs live in `~/.agent-farm/logs` as one `<session-id>.log` per terminal Tower has ever opened (plus at most one `.log.1` rotation — `PtySession` caps a single log at 50 MB). That per-file cap was the only bound: nothing ever deleted the log of a session that ended, so the directory accreted forever (an audited machine reached 29,728 files / 19 GB, 97% of it untouched for over a month). `session-log-sweep.ts` adds the missing cross-file policy: a log is unlinked once its **mtime** is older than the retention window (`AGENT_FARM_LOG_RETENTION_DAYS`, default 30; `0` disables). mtime is the retention key because the last byte written to a session log is effectively when that session stopped producing output — the dead session's DB row is long gone, so there is nothing to join against. Live sessions are excluded **by id** regardless of mtime, because their log fd stays open for the session's life and unlinking under a live writer would silently redirect every subsequent write into an unlinked inode. Two triggers: Tower startup (ordered *after* `reconcileTerminalSessions` so surviving sessions are in the terminal manager's map and therefore excluded) and a daily unref'd in-process timer (`AGENT_FARM_LOG_SWEEP_INTERVAL_MS`). `codev doctor` reports the footprint as a health line, warning past 2 GB.

#### Dead Process Cleanup

Tower cleans up stale entries on state load:

```typescript
function cleanupDeadProcesses(): void {
  // Check each util/annotation for running process
  for (const util of getUtils()) {
    if (!isProcessRunning(util.pid)) {
      console.log(`Auto-closing shell tab ${util.name} (process ${util.pid} exited)`);
      // For shellper-backed sessions, SessionManager handles cleanup
      removeUtil(util.id);
    }
  }
}
```

#### Architect Resume Crash-Loop Fallback

An architect's stored conversation id (`architect.session_id` in `global.db`) is a *hint* about state Claude owns, validated at two layers:

- **Bake time** (`resolveArchitectLaunch`, `tower-utils.ts`): the harness's `verifyOwnership` capability confirms the session jsonl exists on disk before the resume branch is taken; otherwise the launch degrades to a fresh session with a newly minted pinned id.
- **Runtime** (`SessionManager.setupAutoRestart`, `session-manager.ts`): existence cannot certify resumability (transcripts can be corrupt, or garbage-collected after the bake). The session manager counts nonzero-code exits; 3 within 30 seconds is a crash loop, and it swaps once to a caller-precomputed `crashLoopFallback` launch. For architects that fallback is the fresh-launch variant (role injection + minted pinned id), precomputed on the resume branch and wired at all four resume-bake sites (two reconcile paths in `tower-terminals.ts`, two cold-spawn paths in `tower-instances.ts`). Its `onApply` callback repairs the architect row via `setArchitectSessionId`, so the unresumable id is never relearned.

The terminal layer stays harness-neutral: it never sees `--resume`, only "plan A fast-fails, apply plan B". Clean exits (code 0) never count toward detection, so a user quitting a healthy session repeatedly cannot lose a resumable conversation. `CODEV_SKIP_RESUME=1` is the manual escape hatch: `resolveArchitectLaunch` ignores stored ids entirely, forcing fresh launches for every architect.

#### Graceful Shutdown

Tower shutdown uses a multi-step process (orchestrated in `tower-server.ts` → `gracefulShutdown()`):

1. **Stop accepting connections**: Close HTTP server
2. **Close WebSocket connections**: Disconnect all terminal WebSocket clients
3. **Preserve shellper sessions**: Do NOT call `shellperManager.shutdown()` -- let the process exit naturally so OS closes sockets. Shellpers detect disconnection and keep running. SQLite rows are preserved for reconnection on next startup.
4. **Stop rate limit cleanup**: Clear interval
5. **Disconnect tunnel**: `shutdownTunnel()` (Spec 0097/0105)
6. **Tear down instances**: `shutdownInstances()` (Spec 0105)
7. **Tear down terminals**: `shutdownTerminals()` -- stops gate watcher, shuts down TerminalManager (Spec 0105)

**TerminalManager.shutdown()**: Iterates all PtySessions. Shellper-backed sessions are **skipped** (they survive Tower restart). Non-shellper sessions receive SIGTERM/SIGKILL.

```typescript
// TerminalManager.shutdown() — preserves shellper sessions
shutdown(): void {
  for (const session of this.sessions.values()) {
    if (session.shellperBacked) continue; // Survive Tower restart
    session.kill();
  }
  this.sessions.clear();
}
```

#### Worktree Pruning

Stale worktree entries are pruned automatically:

```bash
# Run before spawn to prevent "can't find session" errors
git worktree prune
```

This catches orphaned worktrees from crashes, manual kills, or incomplete cleanups.

### Security Model

Agent Farm is designed for local development use only. Understanding the security model is critical for safe operation.

#### Network Binding

All services bind to `localhost` by default:
- Tower server + Dashboard + WebSocket terminals: `127.0.0.1:4100`
- No external network exposure

##### Bridge Mode

Bridge mode enables Tower to bind to non-localhost addresses for container access.
It requires an explicit opt-in via two environment variables:

- `BRIDGE_MODE=1` — Required to enable non-localhost binding. Without this flag, Tower
  only binds to `127.0.0.1` regardless of other settings.
- `BRIDGE_TOWER_HOST` — The bind address used when `BRIDGE_MODE=1` is set. Default:
  `127.0.0.1`. Accepted values: `0.0.0.0` (all interfaces), `127.0.0.1`, `localhost`,
  valid IPv4 literals, and bracketed IPv6 literals (e.g., `[::1]`).

When bridge mode is enabled, Tower logs a warning on startup:
`Bridge mode is ENABLED — Tower is listening on 0.0.0.0 network interfaces.`

**Note:** `BRIDGE_TOWER_HOST` has no effect unless `BRIDGE_MODE=1` is also set.

#### Authentication

**Current approach: None (localhost assumption)**
- Dashboard has no login/password
- Terminal WebSocket endpoints have no authentication
- All processes share the user's permissions

**Justification**: Since all services bind to localhost by default, only processes running as the same user can connect. External network access is blocked at the binding level. If bridge mode is enabled with `BRIDGE_MODE=1`, ensure your firewall restricts access accordingly.

#### Request Validation

The dashboard server implements multiple security checks:

```javascript
// Host header validation (prevents DNS rebinding)
if (host && !host.startsWith('localhost') && !host.startsWith('127.0.0.1')) {
  return false;
}

// Origin header validation (prevents CSRF from external sites)
if (origin && !origin.startsWith('http://localhost') && !origin.startsWith('http://127.0.0.1')) {
  return false;
}
```

#### Path Traversal Prevention

All file operations validate paths are within the project root:

```javascript
function validatePathWithinProject(filePath: string): string | null {
  // Decode URL encoding to catch %2e%2e (encoded ..)
  const decodedPath = decodeURIComponent(filePath);

  // Resolve and normalize to prevent .. traversal
  const normalizedPath = path.normalize(path.resolve(projectRoot, decodedPath));

  // Verify path stays within project
  if (!normalizedPath.startsWith(projectRoot + path.sep)) {
    return null; // Reject
  }

  // Resolve symlinks to prevent symlink-based traversal
  if (fs.existsSync(normalizedPath)) {
    const realPath = fs.realpathSync(normalizedPath);
    if (!realPath.startsWith(projectRoot + path.sep)) {
      return null; // Reject symlink pointing outside
    }
  }

  return normalizedPath;
}
```

#### Worktree Isolation

Each builder operates in a separate git worktree:
- **Filesystem isolation**: Different directory per builder
- **Branch isolation**: Each builder has its own branch
- **No secret sharing**: Worktrees don't share uncommitted files
- **Safe cleanup**: Refuses to delete dirty worktrees without `--force`

#### DoS Protection

Tab creation has built-in limits:
```javascript
const CONFIG = {
  maxTabs: 20, // Maximum concurrent tabs
};
```

#### Security Recommendations

1. **Never expose ports externally**: Don't use port forwarding or tunnels
2. **Trust local processes**: Anyone with local access can use agent-farm
3. **Review worktree contents**: Check `.builder-*` files before committing
4. **Use `--force` carefully**: Understand what uncommitted changes will be lost

---

## Technology Stack

### Core Technologies
- **TypeScript/Node.js**: Primary language for agent-farm orchestration CLI. The compiler version is pinned **once** in the `pnpm-workspace.yaml` `catalog:` (currently `typescript: ^6.0.3`); every workspace member references it as `"typescript": "catalog:"`. Bump the catalog entry — never a single package — to keep the six manifests in lockstep (Issue #1187 unified a prior 5.7/5.9 drift). Note: TS 6 changed the `types` compiler-option default to `[]` (was: auto-include every `@types/*`), so packages using Node globals must declare `"types": ["node"]` explicitly (see `packages/core`, `packages/codev`), and Vite apps need a `vite-env.d.ts` triple-slash reference for the `vite/client` ambient types.
- **Shell/Bash**: Thin wrappers and installation scripting
- **Markdown**: Documentation format for specs, plans, reviews, and agent definitions
- **Git**: Version control with worktree support for isolated builder environments
- **YAML**: Configuration format for protocol manifests
- **JSON**: Configuration format for agent-farm (`.codev/config.json` at project root) and state management

### Agent-Farm CLI (TypeScript)
- **commander.js**: CLI argument parsing and command structure
- **better-sqlite3**: SQLite database for atomic state management (WAL mode, `synchronous = FULL` — commits fsync before acknowledging, so a committed removal can't be rolled back by OS crash; ~26µs/commit on SSD, acceptable at global.db's lifecycle-event write rate — Issue #1150)
- **tree-kill**: Process cleanup and termination
- **Shellper processes**: Detached Node.js processes for terminal session persistence (Spec 0104)
- **node-pty**: Native PTY sessions with WebSocket multiplexing (Spec 0085)
- **React 19 + Vite 6**: Dashboard SPA at `apps/web/` (standalone workspace member)
- **xterm.js**: Terminal emulator in the browser dashboard (with `customGlyphs: true` for Unicode)

### VS Code Extension
- **VS Code Extension API**: TreeViews, Pseudoterminal, StatusBar, Commands, Decorations
- **esbuild**: Bundles extension + codev-sdk into single `dist/extension.js`
- **ws**: WebSocket client for terminal binary protocol

### Testing Framework
- **Vitest**: Unit and integration tests (`packages/codev/src/__tests__/`)
- **Playwright**: E2E browser tests (`packages/codev/tests/e2e/`)

### External Tools (Required)
- **git**: Version control with worktree support for isolated builder environments
- **gh**: GitHub CLI for PR creation and management
- **AI CLIs** (all three required for full functionality):
  - **claude** (Claude Code): Primary builder CLI
  - **gemini** (Gemini CLI): Consultation and review
  - **codex** (Codex CLI): Consultation and review

### Supported Platforms
- macOS (Darwin)
- Linux (GNU/Linux)
- Requires: Node.js 18+, Bash 4.0+, Git 2.5+ (worktree support), standard Unix utilities
- Native addon: node-pty (compiled during npm install, may need `npm rebuild node-pty`)
- Runtime directory: `~/.codev/run/` for shellper Unix sockets (created automatically with `0700` permissions)

## Monorepo Structure

The repository uses pnpm workspaces (`packages/*` + `apps/*`). Shared libraries
live in `packages/`; end-user client surfaces live in `apps/`:

| Package | npm Name | Purpose |
|---------|----------|---------|
| `packages/codev` | `@cluesmith/codev` | CLI + Tower server (published to npm) |
| `packages/core` | `@cluesmith/codev-core` | Server-side runtime: local-key issuance, homedir paths (published to npm) |
| `packages/sdk` | `@cluesmith/codev-sdk` | Client SDK for Tower: TowerClient, workspace encoding, EscapeBuffer, ReconnectPolicy, SSE, pure grouping/naming helpers. Environment-agnostic (browser / Node / React Native): zero runtime deps, injected auth + transport, CI-enforced import boundary. Never imports codev-core (published to npm) |
| `packages/types` | `@cluesmith/codev-types` | Shared TypeScript types: WebSocket protocol, API shapes, SSE events (dev dependency only) |
| `packages/config` | `@cluesmith/codev-config` | Shared tsconfig base (cross-project) |
| `packages/artifact-canvas` | `@cluesmith/codev-artifact-canvas` | Reusable React surface for rendering/reviewing Codev markdown artifacts |
| `apps/web` | `@cluesmith/codev-web` | React dashboard SPA (built into codev package) |
| `apps/vscode` | `codev-vscode` (Marketplace: `cluesmith.codev-vscode`) | VS Code extension |
| `apps/streamdeck` | `@cluesmith/codev-streamdeck` (private; Elgato plugin UUID `com.cluesmith.codev`) | Stream Deck plugin — outside-in controller: overview reads + SSE + command-relay verbs via the sdk's `controller`/`node` subpaths. Imported from codev-integrations under #1347; packs on demand into a `.sdPlugin` Marketplace bundle (not yet Marketplace-distributed — initial Maker Console submission is a tracked follow-up), versioned in workspace lockstep (manifest `Version` = package version + build segment, pinned by a version-sync test) |

**Dependency graph:**
```
codev-types (wire contracts; the ONLY package imported by both sides)
     ↓                                    ↓
codev-core (server: key issuance,   codev-sdk (client: TowerClient, SSE,
  homedir paths)                      EscapeBuffer, pure helpers)
     ↓                                    ↓
codev (CLI + Tower)                vscode (extension)     dashboard (React SPA)
  imports core + sdk                 imports sdk            imports sdk
  imports types (dev)                imports types (dev)    imports types (dev)

streamdeck (Elgato plugin)
  imports sdk only (controller + node subpaths; own import-boundary test)
```

**Isolation invariant (issue #1189):** `codev-core` and `codev-sdk` never import
each other; both import only `codev-types`. Enforced by tests on both sides
(`packages/sdk/src/__tests__/import-boundary.test.ts`, which also bans Node
builtins / `vscode` / direct `fetch` from the sdk's environment-agnostic graph,
and `packages/core/src/__tests__/no-sdk-import.test.ts`). The one sanctioned
duplication: Tower's own reconnect backoff + WS close code live in a private
copy at `packages/codev/src/agent-farm/lib/reconnect-backoff.ts` because the
server must not import the client sdk.

**Build order:** `pnpm build` from root builds artifact-canvas (consumed by the VS Code extension; zero workspace deps, so no ordering hazard) and then `@cluesmith/codev`, whose own build script first builds its graph-derived workspace-dependency closure via `pnpm --filter "@cluesmith/codev^..." build` (types, sdk, core, apps/web in topological order, then the dashboard copy — Issue #1352, replacing the drift-prone hand-list). The closure guarantees `types/dist` exists, which the VS Code extension's esbuild bundle needs: it resolves the package's runtime `exports.default` (`./dist/index.js`), and a missing `types/dist` breaks the extension build even though tsc and vite resolve it from source via `exports.types` (`./src/index.ts`).

**Publishing:** `codev-core` and `codev-sdk` must be published to npm before `codev` (runtime dependencies).

**Published-SDK canary:** with every sdk consumer now on `workspace:*`, nothing in normal CI exercises the *published* npm artifact. `.github/workflows/sdk-canary.yml` rebuilds `apps/streamdeck` against `@cluesmith/codev-sdk@latest` from the registry (types, tests, bundle, validate) — manual-only until the sdk's first npm publish; enable its weekly cron after that release (#1347, mitigation from #1189).

**Per-package build tools:** most packages compile with plain `tsc`; `apps/web` uses Vite; `apps/vscode` uses esbuild; `packages/artifact-canvas` produces its dual-format (CJS + ESM) library via **tsdown** (Rolldown-powered, the maintained successor to tsup — migrated in Issue #1187). tsdown emits per-format filenames (`index.mjs`/`index.d.mts` for ESM, `index.cjs`/`index.d.cts` for CJS), so the package's `exports` map uses nested `import`/`require` conditions each pointing at their matching declaration file.

## VS Code Extension

The VS Code extension (`apps/vscode`) is a thin client over Tower's existing API. It adds VS Code-specific UI on top of `TowerClient` from `@cluesmith/codev-sdk` — no Tower logic is reimplemented.

**Contextual bottom panel (#1049, `src/contextual-panel/`).** The extension's first `WebviewViewProvider` (all other panel/sidebar views are trees). It splits a **pure, `vscode`-free core** — `resolver.ts` (`resolveMode`), `surface-context.ts` (`deriveSurfaceContext`/`surfaceKey`), `pills.ts`, `messages.ts` — from the `vscode`-touching host: `surface-reader.ts` (classifies the active tab, reads live state) and `panel-provider.ts` (subscribes the trigger set, posts a `ModeDescriptor`). The core is source-scan-tested to stay pure. Two VS Code gotchas the panel works around: the multi-file diff (`vscode.changes`) has **no typed tab input** even in 1.105 (classify via `activeTextEditor` gated by the active tab's type); and with `retainContextWhenHidden` the provider re-posts its cached descriptor on `onDidChangeVisibility` because `resolveWebviewView` does not re-fire. The panel is purely contextual — no pinning, no persisted state. **Attention body (#1553):** the fallback view's roll-up (builders at gates, builders waiting on input, held mail, queued feedback, honest empty state) is projected by `deriveAttention(OverviewData)` — a **pure cross-client helper co-located with `isIdleWaiting` in `@cluesmith/codev-sdk/builder-helpers`**, not extension-local, so a future dashboard/Stream Deck attention view shares one definition and can't drift. The projection rides beside the descriptor on the `RenderMessage` (keeping `ModeDescriptor`/the resolver pure), and the provider re-posts it on `overviewCache.onDidChange` only while Attention is showing. Colors reuse the sidebar's exact `ThemeColor` tokens for the same states (`notificationsWarningIcon` blocked, `notificationsInfoIcon` idle).

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    VS Code Extension                          │
│                                                               │
│  ConnectionManager (singleton)                                │
│  ├── TowerClient (from @cluesmith/codev-sdk)                 │
│  ├── AuthWrapper (SecretStorage + readLocalKey)               │
│  ├── WorkspaceDetector (opened folder must contain           │
│  │                      .codev/ or codev/; no ancestor walk) │
│  ├── SSEClient (real-time state updates)                      │
│  └── TowerStarter (auto-start as detached daemon)             │
│                                                               │
│  UI Layer                                                     │
│  ├── Sidebar: 7 TreeView sections (overview + team + status)  │
│  ├── Panel: codevPanel container (#812) for wide-short views  │
│  ├── Terminals: Pseudoterminal ↔ WebSocket binary protocol    │
│  ├── Status Bar: builder count + blocked gates                │
│  ├── Commands: spawn, send, approve, cleanup, tunnel, cron    │
│  └── Review: snippet + Decorations API highlighting           │
│                                                               │
│  esbuild → dist/extension.js (bundles codev-sdk inline)      │
└──────────────┬───────────────────────────────────────────────┘
               │ HTTP + WebSocket + SSE (localhost:4100)
┌──────────────▼───────────────────────────────────────────────┐
│                    Tower Server                               │
│              (unchanged — same API as browser dashboard)      │
└──────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Thin client**: All state stays in Tower/shellper. Extension is a viewport, not a second orchestrator.
- **TowerClient reuse**: Extension imports `TowerClient` from `codev-sdk` — same class the CLI composes. No duplicate REST/auth/encoding logic. The extension injects its own auth (SecretStorage-cached reader over `@cluesmith/codev-sdk/node`).
- **TerminalLocation.Editor**: Terminals open directly in editor area via `ViewColumn.One` (architect) and `ViewColumn.Two` (builders). Uses stable VS Code API, not the undocumented `moveIntoEditor` command.
- **Subpath exports**: `codev-sdk` uses subpath exports (`./tower-client`, `./escape-buffer`, etc.); its environment-agnostic graph is Node-builtin-free by CI-enforced test, so nothing can leak into the dashboard's Vite build or a Metro bundle.
- **Injectable auth**: `TowerClient` accepts a `getAuthKey` callback. CLI uses `ensureLocalKey()` (creates key if missing). Extension uses `readLocalKey()` + `SecretStorage` (never creates keys).
- **Editor-tab webviews (#920)**: Richer-than-TreeView surfaces use `vscode.window.createWebviewPanel` (editor area), not a sidebar `WebviewView`. Pattern: the panel is a thin view that posts debounced criteria to the extension host; **filtering/sorting runs host-side** in vscode-free pure helpers (`views/backlog-filter.ts`, vitest-tested) so logic stays testable and sensitive data (e.g. issue bodies) never crosses into the webview — only display rows do. HTML/CSS/JS live in a sibling `*.template.ts` (no esbuild asset-copy step); theming is **CSS variables only** (`--vscode-*`) so dark/light/high-contrast render natively; CSP is nonce'd. First instance: the "Search Backlog" panel (`webviews/backlog-search-panel.ts`), fed by the dedicated `issue-search` forge concept → `GET /api/issue-search` (kept separate from `issue-list` so `/api/overview` stays body-free).
- **Panel view container (#812)**: The extension contributes view containers to **two** locations — `activitybar.codev` (the 7-section sidebar) and `panel.codevPanel` (bottom panel, wide-short geometry). The panel hosts views whose shape suits a wide layout. It carries `codev.dev` (a `TreeDataProvider`, #921) and the contextual `codev.contextualPanel` (a `WebviewViewProvider`, #1049) — VS Code lets tree and webview views coexist in one container. **#1049 retired the original `codev.panelContainerEmpty` placeholder view + its dead context-key flip** (it could never render, since `codev.dev` seeded the key `false` unconditionally); the follow-ups once tracked as sibling tabs (#813/#814/#815) are rescoped to render into the contextual panel's modes, not their own tabs. VS Code gives no control over panel-tab *position* (it lands last, in the `…` overflow), so the extension does a one-time, globalState-guarded reveal (`workbench.view.extension.codevPanel`) on first activation for discoverability.
- **Codev Dev surface (#921)**: The single `afx dev` PTY gets two complementary surfaces, both driven off the one `TerminalManager.onDidChangeDevTerminals` event (single source of truth, so chip and tab never drift on start/stop/swap): a `codev.dev` panel `TreeDataProvider` (first real `codevPanel` tenant — status header of target / live-ticking uptime / best-effort port, plus title-bar Stop / Restart / Switch-Target / Show-Hide-sidebar actions gated by a `codev.devRunning` key) and an always-visible **status-bar chip** (`StatusBarItem`, left, priority 99) shown only while a dev runs, clicking through to the tab. The native `Codev: <name> (dev)` terminal stays as the output surface (coexist) — the new tab is a status/control surface, not an output mirror, so there is no second PTY/xterm re-plumbing. Uptime needs a start time `listDevTerminals()` doesn't carry, so `TerminalManager` keeps a `builderId → startedAt` map. Pure formatters (`views/dev-format.ts`: uptime, port-from-config) are vitest-tested.
- **Startup CLI preflight (#791)**: On `activate()` the extension verifies the `codev` CLI is installed and at least its own `package.json` version (`codev --version`, resolved like `resolveAfxPath`, cached per session, 400ms-bounded, fire-and-forget so activation never blocks). Missing → `Get started with Codev` walkthrough; outdated → upgrade notification; either dismissed → CLI-dependent commands no-op with one "run setup" toast. Commands register through two helpers — `reg` (unguarded) and `regCli` (guarded) — so the registrar name *is* the guard policy (no separate list). Preflight also sets the `codev.cliReady` context key, which drives the walkthrough's Verify-step completion. Lives in `src/preflight/` (`preflight-core.ts` pure + unit-tested, `preflight.ts` vscode glue).
- **Markdown Preview / artifact-canvas host integration (#859)**: The first integration of the shared `@cluesmith/codev-artifact-canvas` React surface into a host. A read-only `CustomTextEditor` (`codev.markdownPreview`, `priority: "option"` so it never replaces the default `.md` editor; selector scoped to `**/codev/{specs,plans,reviews}/**/*.md`) renders an artifact and lets a reviewer add comments by hovering a block and clicking `+`. It is the extension's **first bundled React webview**: a *second* esbuild entry (`esbuild.js`, browser/IIFE, bundles react/react-dom/the canvas + emits `markdown-preview.css`), type-checked by a dedicated `tsconfig.webview.json` (DOM libs) since the host `tsconfig.json` excludes the browser dir. Host↔webview bridge (`markdown-preview/preview-provider.ts`, HTML in a sibling `preview-template.ts` per #920; the two `postMessage` directions are a named protocol in `markdown-preview/messages.ts`, `HostToWebviewMessage` / `WebviewToHostMessage`, shared by both ends so they can't drift — #1107): the host posts **raw** document text + parsed markers; the webview mounts `<ArtifactCanvas>`; the reviewer's `+`/Enter opens an **inline composer rendered in-flow below the block** (`overlays/CommentComposer.tsx`, portalled into a placeholder there — #1107 replaced the old center-top `showInputBox`); on submit `onAddComment(line, text)` → host `WorkspaceEdit` → the round-trip goes through the file text. (Host-side inbound `postMessage` data is untrusted, so the host still validates payload fields at runtime despite the named type.) **Cross-cutting invariants this established**: (1) the on-disk REVIEW-marker convention (`<!-- REVIEW(@author): text -->`, a marker annotates the nearest non-marker line above it) lives in `@cluesmith/codev-sdk/review-markers` so every host (vscode now, dashboard later) writes/parses identical bytes — the editor Comments-API path (`comments/plan-review.ts`) shares it. (2) The canvas renderer runs markdown-it with **`html: true` + DOMPurify as the sole guard** (#1042 amends spec-945 D7: safe static HTML renders, scripts/handlers/`javascript:` stripped, document JS never executes) and **strips full-line HTML comments before block parsing** with a cleaned→original line map (#1036), so markers never render as text and never split a multi-line block while `data-line` stays accurate.
- **Full-row "+" affordance — row-scoped geometry contract (#1343)**: The canvas's add-comment affordance follows the GitHub-diff pattern: every top-level block is a full-width row carrying its own **block-local leading space** (`--codev-canvas-gutter` padding on `.codev-artifact-canvas-body > [data-line]`; there is no canvas-level gutter), and the "+" renders **inside the hovered row's own DOM** (a single wrapper node moved between rows, React portal into it), positioned only against that row — pointer-line tracked in tall blocks, first-line centered on keyboard focus. This replaced the #863 canvas-anchored overlay and deleted the #1236 grace/pin damping outright (with trigger and target coincident, instant re-anchor and immediate dismiss are correct). **Contract**: affordance geometry must stay row-scoped — no `offsetTop`-against-the-canvas positioning, no canvas-level gutters — because #1380's multi-column mode relies on rows carrying their gutter and affordance through CSS column fragmentation (block padding fragments; absolutely-positioned canvas geometry does not). Known v1 limitation: a horizontally-scrolled wide table carries its "+" with the scroll (`pre` is immune — its scroll container is the inner `code`, so the row box holding the "+" never scrolls).
- **Horizontal reading mode — mode semantics live in the canvas package (#1380)**: `<ArtifactCanvas>` owns the reading mode end-to-end (vocabulary, coercion of untrusted values to `vertical`, the toggle, CSS multicol mechanics via `.codev-canvas-mode-horizontal` on the root scoping `column-width`/`column-fill: auto` onto the body, wheel remap, column paging, fragment-aware "+" placement in flow coordinates, progress readout, minimap suppression). Hosts have exactly two jobs (spec 1380 Constraint 3): a **height context** (a `height: 100%` chain; an unbounded embed self-bounds to `100vh`) and **per-user persistence** via `initialReadingMode`/`onReadingModeChange` (VS Code: `globalState` behind `sanitizeReadingMode`; dev page: `localStorage`). The VS Code webview **bootstraps the persisted mode inside the initial HTML** (`data-reading-mode` on `#root`) because the canvas mounts before the first host message — a later message cannot initialize it; only `WebviewToHostMessage` gained a member (`readingModeChange`). Renderer invariant from the same project (#1396): **fence rows carry `data-line` on the `pre`** (matching `code_block`), with `tabindex` retained on the inner `code` because it is the fence's scroll container — `pre[data-line]` selectors are meaningful again, and fences are two tab stops by design. Fragmentation protection is enforced with descendant selectors plus height caps derived from the JS-published `--codev-canvas-column-height`, because Chromium fragments-and-overflows a protected block taller than the column rather than honoring `break-inside: avoid`. Real-browser regression suite: `packages/artifact-canvas/playwright/` (own `@playwright/test` devDep, vite `examples/` webServer, `canvas-browser` CI job). **Vertical-mode scroll container (#1501)**: in vertical reading mode the **host page** (the document scrolling element) is the vertical scroller, NOT the canvas body — the body only becomes a scroll container in horizontal mode (`overflow-x: auto`). `viewportStartLine` already encodes this (it measures block visibility against the window top, not the body rect), and the `viewport-down`/`viewport-up` command (the Stream Deck Scroll dial on a canvas) pans that document scroller. A host that puts the canvas inside its own `overflow` scroller would break `viewportStartLine` too, so this is a single shared host contract, not a per-command assumption.
- **Review-comment edit + preview-side delete — line+content identity (#1055)**: Extends the #859 review-marker surfaces to a full edit (both surfaces) + preview-delete tool **without any on-disk format change** (a stable-ID "format v2" was explicitly deferred to #1131). The identity a surface uses to locate one marker is its **physical file line** (`markerLine`), surfaced by `parseReviewMarkers` (the parser's own loop index) so a stack of comments on one block — which all share the annotated `line` — is individually addressable. `@cluesmith/codev-sdk/review-markers` owns the shared mechanics: `matchesExpectedMarker(lineText, author, bodyPrefix)` is an **optimistic-concurrency check** (author + whitespace-normalized body-prefix) and `rewriteReviewMarkerBody` re-serializes a marker's body while reading the author *off the existing line* (an edit can never reassign authorship). Every mutating write verifies first: the preview host (`markdown-preview/preview-provider.ts`, message types `editComment`/`deleteComment`) re-reads the line at `markerLine` and, on mismatch (the file changed between click and write), **refuses the write, re-pushes the document, and surfaces an info toast** rather than corrupting a different marker — the preview auto-refreshes anyway, so a race fails loudly. The canvas exposes optional `onEditComment`/`onDeleteComment` props (a read-only host renders plain cards) and per-card edit/delete affordances built as imperative DOM with inline stroke SVGs (host-agnostic — the webview can't assume VS Code's codicon font); a delegated body click routes them by `data-marker-line`. The editor Comments-API path (`comments/plan-review.ts`) gained an edit action (`ReviewComment` class carrying its parent thread; `startEditReviewComment` flips `mode` to `Editing` and **reassigns `thread.comments`** since VS Code only re-renders on reassignment; `saveEditReviewComment` rewrites via the same core helper). Multi-line bodies still collapse to one line at write time (`serializeReviewMarker` normalizes whitespace) — inherent to the single-line marker, deferred to #1131.
- **Builders diff-review: navigation + active-file sync (#1060/#1066)**: The "current builder/file" in a diff review is **derived from the active editor, not stored**. The diff-inject registry (`diff-inject-codelens.ts`) maps each right-side worktree fsPath → `{ builderId, relPath, hunks }`; because a worktree-absolute path is unique per builder, two builders that changed the same relative path stay distinct. Everything keys off `getDiffInjectEntry(activeEditor.fsPath)`: cross-file keyboard nav (`codev.diffNextFile`/`diffPreviousFile`, #1060) and the Builders-tree active-file reveal (#1066). Navigation walks **one builder's** changed-file list (it never crosses builders) in the **visible tree order** — depth-first via `flattenTreeOrder(buildFilePathTree(...))` in tree-view mode, raw git `--name-status` order in flat mode — and **wraps** at both ends (`computeNavTarget` modulo) to match VSCode's built-in hunk navigation, which also wraps. The reveal (#1066, Explorer-style, gated by `codev.buildersAutoReveal`) requires two pieces of TreeView groundwork: file rows carry a stable `<builderId>::<relPath>` id and `BuildersProvider.getParent` reconstructs the full chain (file → compacted folder(s) → builder → group), since `reveal` matches by id and walks parents while the subtree is still collapsed. It fires on **both** the active-editor change AND the diff-inject registry change, because a programmatic diff open registers its entry *after* the editor activates (same dual-trigger the lens context-key sync uses).
- **Agents view + group-by axes (#1104)**: The sidebar's primary work view is **Agents** (view id `codev.agents`, formerly `codev.builders` — only the user-facing id/label changed; internal symbols like `BuildersProvider` and the `codev.buildersGroupBy` setting keep their names). It groups in-flight builders by **exactly one of three axes** (`stage` | `area` | `architect`), each a `BuilderGrouping` strategy in `views/builder-grouping.ts`; `architect` groups by `spawnedByArchitect` (null folds into `main`, matching the affinity router) and a childless architect produces no group, so the work view shows owners-of-work while the *full* roster stays in Workspace > Architects. The axis is a single toolbar button (see the no-`toggled` lesson). The architect roster the Add-Architect flow needs rides on **`/api/overview` as `architects: ArchitectState[]`** (additive wire field), built by a shared `liveArchitects(entry, manager)` helper in `tower-routes.ts` reused by the `/api/state` dashboard-state path so the two payloads can't drift — `liveArchitects` (running-session set, from `terminal_sessions`) is distinct from state.ts's `getArchitects` (persisted `architect` table). `Codev: Add Architect` is conversational: it resolves `main` from that roster and routes a request via `sendMessage('architect:main', …)` rather than creating the architect directly.
- **IDE-mode dual activation + layer model (#1144)**: One extension artifact ships through two channels, the marketplace vsix (guest mode) and the same files baked into the Codev IDE fork as a built-in (IDE mode), with the split made at **runtime** via `vscode.env.appName === CODEV_IDE_APP_NAME` (`src/ide-mode.ts`; the constant is a **cross-repo contract** with the fork's product.json `nameLong` and the only place the string is spelled; a user-installed marketplace copy shadowing the built-in is safe because detection is appName-based, not channel-based). `activationEvents` includes `onStartupFinished`, so `activate()` runs in **every window of every install**; which side effects may fire is decided by a pure activation-tier model: `full` (a codev workspace is open), `ide-empty` (IDE with no codev workspace: Tower-level surfaces + empty-window onboarding), `dormant` (guest with no codev workspace: **provably inert**, meaning no Tower auto-start, no preflight, no status bar, no focus steal, no state writes; commands/providers still register so palette invocations degrade gracefully). `activationPolicy(tier)` is the unit-tested switchboard; the five gated side effects live in `extension.ts`. Three context keys drive the UI: `codev.ideMode`; `codev.hasWorkspace` (**codev-workspace-presence**: the opened folder itself contains `codev/`/`.codev/` or the `codev.workspacePath` override points at one; deliberately NOT bare folder-presence, and detection deliberately does **no ancestor walk**, so a codev-enabled home directory cannot leak into every window under it); and `codev.stateKnown` (set first-thing in `activate()`; unset context keys evaluate *false*, so `viewsWelcome`/`when` clauses gate on it to avoid asserting wrong states during the workbench-restore-to-activation gap, and a `!codev.stateKnown` "Loading Codev…" welcome covers the pre-provider window). Workspace-bound views carry `when: codev.hasWorkspace`; the Agents view is the ungated anchor carrying per-quadrant welcome content. The IDE empty-window onboarding (container focus, one-time globalState-gated first-run toast + the #791 walkthrough) is **runtime code by hard constraint**: extension-contributed `configurationDefaults` register asynchronously and race first render (fork-verified, roughly 1-in-3 leak), so nothing first-launch-visible may ride on them.
- **Builder review-comment queue (#1037)**: The builder diff carries two feedback surfaces that **never merge state**: #789's fire-and-forget forward-to-PTY injection, and a structured per-builder comment queue. Queued comments persist in `.builders/<id>/.codev/pending-comments.json` (worktree-local, so the queue survives reloads, cannot mix across builders, and dies with `afx cleanup`; the file is git-invisible via a managed block the extension appends to the repo's shared `$GIT_COMMON_DIR/info/exclude`, whose `.builder-*` family glob also silences spawn scaffolding files). `ReviewQueueStore` (`review-queue/store.ts`) is the single owner of those files — every surface (inline `codev-builder-review` comment threads, the status-bar `Submit Review (N)` counter, the submit/discard commands) reads through it and reacts to its `onDidChangeQueue` event; cross-window sync rides a debounced FileSystemWatcher with own-write echo suppression. Which surface the diff codelens offers is `codev.diffCodelensMode` (`forward` default preserves #789; the context menu always offers both). `Submit Review` packages the queue into one markdown message and types it into the builder PTY wrapped in bracketed-paste escapes (raw `\n` on the PTY would submit the prompt), deliberately without Enter — the human reviews and sends. The store's read + event API is the seam #1049's contextual panel modes will render from.
- **Running-Tower version probe (#983)**: A second preflight dimension catches the case the CLI check structurally can't — an `npm install -g` upgrade that updated the on-disk binary but left **Tower running stale in-memory code**. Tower exposes read-only `GET /api/version` (`{ version, startedAt }`, wire type `TowerVersionInfo` in `codev-types`, served from `RouteContext` so it reports the *running* process's version, not the disk binary; unauthenticated like `/health`). On each `connected` transition the extension probes it (`TowerClient.getVersion()`, returning the raw `{ status }` so the preflight distinguishes a 404 "Tower too old to report" from an unreachable Tower). Divergence fires **only on `running < installedCLI`** — the case a restart actually fixes; running-vs-extension is left to #791 (a restart can't load code that isn't installed). The toast offers a `Restart Tower` action (`afx tower stop && afx tower start`, local host only — safe to self-invoke because #991 scoped `afx tower stop` to the listening process; remote hosts get informational wording). The two async inputs (installed-CLI version, running-Tower version) are reconciled against the startup race by re-probing once the CLI check resolves. Decision/wording logic is pure + unit-tested in `preflight-core.ts` (`decideTowerStatus`, `towerDivergenceMessage`).

- **Review-comment composer ownership — two surfaces, two owners (#1552)**: The two review-comment composers differ in who owns the *draft*, which decides what a remote (Stream Deck) driver can do to it. The **artifact-canvas** composer (spec/plan, `overlays/CommentComposer.tsx`) is our own React component holding the draft in local state — cancel unmounts it and destroys the draft, so the canvas composer verbs (`composer-open-or-submit` / `composer-cancel`) are **view-scoped** (they act regardless of editor focus). The **builder-diff review box** (`comments/builder-review.ts`) is VS Code's **native Comments widget**: the extension opens it via `workbench.action.addComment` (which focuses the reply input but returns **no thread handle**), and VS Code owns the draft. Consequence for deck "composer parity" (#1552): open and **submit** can mirror (submit via `editor.action.submitComment` — the `editor.*` id; `workbench.action.submitComment` does not exist — which is **focus-gated**, so it no-ops unless the box is the focused editor), but a dial **cancel cannot** — there is no native draft discard (`workbench.action.hideComment` only *collapses* the widget, the draft survives; `workbench.action.closeActiveEditor` closes the **host** editor). The reliable discard is the visible **Cancel button** (`codev.cancelBuilderComment`, disposing the thread VS Code hands us on click). So #1552 dropped dial-cancel (Files-dial is a defined no-op) and the deck vocabulary is `open | submit | noop`; **#1560** tracks the thread-owning rework (`createCommentThread` so the extension holds the handle → dispose on cancel) that would restore a deck cancel by making the box our-owned like the canvas one. **Composer-open state (`isBuilderComposerOpen`) is keyed off THIS controller's own flag, not a "focused comment input" probe** — `plan-review.ts` registers a *second* native comment controller (`codev-review`) that also opens `commentinput-…` editors, so a focus-based probe would let a diff-review dial submit an unrelated plan/spec comment (CMAP-caught in #1552).

## Repository Dual Nature

This repository has a unique dual structure:

### 1. `codev/` - Our Instance (Self-Hosted Development)
This is where the Codev project uses Codev to develop itself:
- **Purpose**: Development of Codev features using Codev methodology
- **Contains**:
  - `specs/` - Feature specifications for Codev itself
  - `plans/` - Implementation plans for Codev features
  - `reviews/` - Lessons learned from Codev development
  - `resources/` - Reference materials (this file, testing-guide.md, lessons-learned.md, etc.)
  - `protocols/` - Working copies of protocols for development
  - `agents/` - Agent definitions (canonical location)
  - `roles/` - Role definitions for architect-builder pattern
  - `templates/` - HTML templates for Agent Farm (`afx`) dashboard and annotation viewer
  - Note: Shell command configuration is in `.codev/config.json` at the project root

**Example**: `codev/specs/0001-test-infrastructure.md` documents the test infrastructure feature we built for Codev.

### 2. `codev-skeleton/` - Template for Other Projects
This is what gets distributed to users when they install Codev:
- **Purpose**: Clean template for new Codev installations
- **Contains**:
  - `protocols/` - Protocol definitions (SPIR, ASPIR, AIR, BUGFIX, MAINTAIN, EXPERIMENT, RELEASE)
  - `specs/` - Empty directory (users create their own)
  - `plans/` - Empty directory (users create their own)
  - `reviews/` - Empty directory (users create their own)
  - `resources/` - Empty directory (users add their own)
  - `agents/` - Agent definitions (copied during installation)
  - `roles/` - Role definitions for architect and builder
  - `templates/` - HTML templates for Agent Farm (`afx`) dashboard UI
  - Note: Shell command configuration is in `.codev/config.json` at the project root

**Key Distinction**: `codev-skeleton/` provides templates for other projects to use when they install Codev. Our own `codev/` directory has nearly identical structure but contains our actual specs, plans, and reviews. The skeleton's empty placeholder directories become populated with real content in each project that adopts Codev.

### 3. `packages/codev/` - The npm Package
This is the `@cluesmith/codev` npm package containing all CLI tools:
- **Purpose**: Published npm package with codev, afx, consult, team, and porch CLIs
- **Contains**:
  - `src/` - TypeScript source code
  - `src/agent-farm/` - Agent Farm orchestration (afx command)
  - `src/commands/` - codev subcommands (init, adopt, doctor, update, eject, tower)
  - `src/commands/consult/` - Multi-agent consultation (consult command)
  - `bin/` - CLI entry points (codev.js, afx.js, af.js (deprecated alias), consult.js, team.js, porch.js)
  - `skeleton/` - Embedded copy of codev-skeleton (built during `npm run build`)
  - `templates/` - HTML templates for Agent Farm (`afx`) dashboard and annotator
  - `dist/` - Compiled JavaScript

**Key Distinction**: packages/codev is the published npm package; codev-skeleton/ is the template embedded within it.

**Note on skeleton/**: During `npm run build`, the codev-skeleton/ directory is copied into packages/codev/skeleton/. This embedded skeleton is what gets installed when users run `codev init`. Local files in a user's codev/ directory take precedence over the embedded skeleton.

## Complete Directory Structure

```
codev/                                  # Project root (pnpm monorepo)
├── packages/sdk/                       # @cluesmith/codev-sdk (client SDK for Tower)
│   └── src/
│       ├── tower-client.ts             # TowerClient class (injected auth + fetch)
│       ├── node/local-key.ts           # Node-only read-only key adapter (/node subpath)
├── packages/core/                      # @cluesmith/codev-core (server-side runtime)
│   └── src/
│       ├── auth.ts                     # readLocalKey() + ensureLocalKey() (issuance)
│       ├── workspace.ts               # encodeWorkspacePath() / decodeWorkspacePath()
│       ├── constants.ts               # DEFAULT_TOWER_PORT, AGENT_FARM_DIR
│       └── escape-buffer.ts           # EscapeBuffer (ANSI sequence buffering)
├── packages/types/                     # @cluesmith/codev-types (shared interfaces)
│   └── src/
│       ├── websocket.ts               # FRAME_CONTROL, FRAME_DATA, ControlMessage
│       ├── sse.ts                     # SSEEventType, SSENotification
│       └── api.ts                     # DashboardState, OverviewData, TeamApiResponse, etc.
├── packages/config/                    # @cluesmith/codev-config (shared tsconfig)
│   └── tsconfig.base.json
├── apps/web/                           # @cluesmith/codev-web (React SPA; end-user surface)
│   └── src/                           # React 19 + Vite 6 + xterm.js + Recharts
├── apps/vscode/                        # VS Code extension (Marketplace: cluesmith.codev-vscode; end-user surface)
│   └── src/
│       ├── extension.ts               # Activation, command/view registration
│       ├── connection-manager.ts      # Singleton wrapping TowerClient
│       ├── auth-wrapper.ts            # SecretStorage + readLocalKey()
│       ├── workspace-detector.ts      # Traverse to .codev/ or codev/
│       ├── sse-client.ts             # SSE with heartbeat filtering
│       ├── tower-starter.ts          # Auto-start Tower as detached process
│       ├── terminal-adapter.ts       # Pseudoterminal ↔ WebSocket binary protocol
│       ├── terminal-manager.ts       # WebSocket pool, editor layout
│       ├── review-decorations.ts     # REVIEW(...) line highlighting
│       ├── commands/                 # spawn, send, approve, cleanup, tunnel, cron, review
│       └── views/                    # TreeView providers (7 sidebar sections)
├── packages/codev/                     # @cluesmith/codev npm package
│   ├── src/                            # TypeScript source code
│   │   ├── cli.ts                      # Main CLI entry point
│   │   ├── commands/                   # codev subcommands
│   │   │   ├── init.ts                 # codev init
│   │   │   ├── adopt.ts                # codev adopt
│   │   │   ├── doctor.ts               # codev doctor
│   │   │   ├── update.ts               # codev update
│   │   │   ├── generate-image.ts       # codev generate-image
│   │   │   └── consult/                # consult command
│   │   │       └── index.ts            # Multi-agent consultation
│   │   ├── agent-farm/                 # afx subcommands
│   │   │   ├── cli.ts                  # afx CLI entry point
│   │   │   ├── index.ts                # Core orchestration
│   │   │   ├── state.ts                # SQLite state management
│   │   │   ├── types.ts                # Type definitions
│   │   │   ├── commands/               # afx CLI commands
│   │   │   │   ├── start.ts            # Start Tower workspace
│   │   │   │   ├── stop.ts             # Stop all processes
│   │   │   │   ├── spawn.ts            # Spawn builder
│   │   │   │   ├── spawn-worktree.ts   # Create git worktree for spawn
│   │   │   │   ├── spawn-roles.ts      # Role prompt injection for spawn
│   │   │   │   ├── status.ts           # Show status
│   │   │   │   ├── cleanup.ts          # Clean up builder
│   │   │   │   ├── open.ts             # File annotation viewer
│   │   │   │   ├── send.ts             # Send message to builder
│   │   │   │   ├── rename.ts           # Rename builder
│   │   │   │   ├── bench.ts            # Consultation benchmarking (afx bench)
│   │   │   │   ├── attach.ts           # Attach directly to shellper session
│   │   │   │   ├── architect.ts        # Architect session management
│   │   │   │   ├── shell.ts            # Shell session management
│   │   │   │   ├── tower.ts            # Tower daemon control (start/stop)
│   │   │   │   ├── tower-cloud.ts      # Cloud tunnel management
│   │   │   │   ├── cron.ts             # Scheduled task management
│   │   │   │   ├── team.ts             # Team operations (deprecated; use `team` CLI)
│   │   │   │   ├── team-update.ts      # Team activity aggregation
│   │   │   │   └── db.ts               # SQLite database commands
│   │   │   ├── servers/                # Web servers (Spec 0105 decomposition)
│   │   │   │   ├── tower-server.ts     # Orchestrator: HTTP/WS server creation, subsystem init, shutdown
│   │   │   │   ├── tower-routes.ts     # HTTP route handlers (~30 routes)
│   │   │   │   ├── tower-instances.ts  # Project lifecycle (launch, getInstances, stop)
│   │   │   │   ├── tower-terminals.ts  # Terminal session CRUD, reconciliation, gate watcher
│   │   │   │   ├── tower-websocket.ts  # WebSocket upgrade routing, WS↔PTY frame bridging
│   │   │   │   ├── tower-utils.ts      # Rate limiting, path utils, MIME types, buildArchitectArgs()
│   │   │   │   ├── tower-types.ts      # Shared TypeScript interfaces
│   │   │   │   ├── tower-tunnel.ts     # Cloud tunnel client lifecycle
│   │   │   │   ├── overview.ts         # Work view data aggregation (Spec 0126)
│   │   │   │   └── statistics.ts       # Statistics aggregation service (Spec 456)
│   │   │   ├── db/                     # SQLite database layer
│   │   │   │   ├── index.ts            # Database operations
│   │   │   │   ├── schema.ts           # Table definitions
│   │   │   │   └── migrate.ts          # JSON → SQLite migration
│   │   │   └── __tests__/              # Vitest unit tests
│   │   └── lib/                        # Shared library code
│   │       ├── tower-client.ts         # CLI composition of @cluesmith/codev-sdk (injects local-key auth)
│   │       └── templates.ts            # Template file handling
│   ├── bin/                            # CLI entry points
│   │   ├── codev.js                    # codev command
│   │   ├── afx.js                      # afx command (af.js deprecated, redirects)
│   │   ├── af.js                       # Deprecated; redirects to afx
│   │   ├── consult.js                  # consult command
│   │   ├── team.js                     # team command
│   │   ├── porch.js                    # porch command
│   │   └── generate-image.js           # generate-image command
│   ├── dashboard-dist/                 # Dashboard build output (copied from apps/web/dist)
│   ├── skeleton/                       # Embedded codev-skeleton (built)
│   ├── templates/                      # HTML templates
│   │   ├── tower.html                  # Multi-project overview
│   │   ├── open.html                   # File viewer with image support
│   │   └── 3d-viewer.html             # STL/3MF 3D model viewer
│   ├── dist/                           # Compiled JavaScript
│   ├── package.json                    # npm package config
│   └── tsconfig.json                   # TypeScript configuration
├── .codev/config.json                      # Shell command configuration (project root)
├── codev/                              # Our self-hosted instance
│   ├── roles/                          # Role definitions
│   │   ├── architect.md                # Architect role and commands
│   │   └── builder.md                  # Builder role and status lifecycle
│   ├── templates/                      # Document templates
│   │   └── pr-overview.md              # PR description template
│   ├── protocols/                      # Working copies for development
│   │   ├── spir/                       # Multi-phase with consultation
│   │   │   ├── protocol.md
│   │   │   ├── protocol.json
│   │   │   ├── builder-prompt.md
│   │   │   ├── templates/
│   │   │   ├── prompts/
│   │   │   └── consult-types/
│   │   ├── aspir/                      # Autonomous SPIR (no human gates)
│   │   ├── air/                        # Autonomous Implement & Review
│   │   ├── bugfix/                     # GitHub Issue-driven fixes
│   │   ├── experiment/                 # Disciplined experimentation
│   │   ├── release/                    # Version release procedure
│   │   ├── spike/                      # Time-boxed research
│   │   ├── maintain/                   # Codebase maintenance
│   │   └── protocol-schema.json        # JSON schema for protocol.json files
│   ├── specs/                          # Our feature specifications
│   ├── plans/                          # Our implementation plans
│   ├── reviews/                        # Our lessons learned
│   ├── resources/                      # Reference materials
│   │   ├── arch.md                     # This file
│   │   └── llms.txt                    # LLM-friendly documentation
│   └── projects/                       # Active project state (managed by porch)
├── codev-skeleton/                     # Template for distribution
│   ├── roles/                          # Role definitions
│   │   ├── architect.md
│   │   └── builder.md
│   ├── templates/                      # Document templates (CLAUDE.md, arch.md, etc.)
│   ├── protocols/                      # Protocol definitions
│   │   ├── spir/
│   │   ├── aspir/
│   │   ├── air/
│   │   ├── bugfix/
│   │   ├── experiment/
│   │   ├── spike/
│   │   └── maintain/
│   ├── specs/                          # Empty (placeholder)
│   ├── plans/                          # Empty (placeholder)
│   ├── reviews/                        # Empty (placeholder)
│   ├── resources/                      # Empty (placeholder)
│   └── agents/                         # Agent templates
├── .agent-farm/                        # Project-scoped state (gitignored)
│   └── state.db                        # SQLite database for architect/builder/util status
├── ~/.agent-farm/                      # Global registry (user home)
│   └── global.db                       # SQLite database for terminal sessions and workspace metadata
├── .claude/                            # Claude Code-specific directory
│   └── agents/                         # Agents for Claude Code
├── tests/                              # Test infrastructure
│   ├── lib/                            # Vendored bats frameworks
│   ├── helpers/                        # Test utilities
│   ├── fixtures/                       # Test data
│   └── *.bats                          # Test files
├── scripts/                            # Utility scripts
│   ├── run-tests.sh                    # Fast tests
│   ├── run-integration-tests.sh        # All tests
│   └── install-hooks.sh                # Install git hooks
├── hooks/                              # Git hook templates
│   └── pre-commit                      # Pre-commit hook
├── examples/                           # Example projects
├── docs/                               # Additional documentation
├── AGENTS.md                           # Universal AI agent instructions
├── CLAUDE.md                           # Claude Code-specific
├── INSTALL.md                          # Installation instructions
├── README.md                           # Project overview
└── LICENSE                             # MIT license
```

## Core Components

### 1. Development Protocols

#### SPIR Protocol (`codev/protocols/spir/`)
**Purpose**: Multi-phase development with multi-agent consultation

**Phases**:
1. **Specify** - Define requirements with multi-agent review
2. **Plan** - Break work into phases with multi-agent review
3. **IDE Loop** (per phase):
   - **Implement** - Build the code
   - **Defend** - Write comprehensive tests
   - **Evaluate** - Verify requirements and get approval
4. **Review** - Document lessons learned with multi-agent consultation

**Key Features**:
- Multi-agent consultation at each major checkpoint
- Default models: Gemini 3 Pro + GPT-5
- Multiple user approval points
- Comprehensive documentation requirements
- Suitable for complex features (>300 lines)

**Files**:
- `protocol.md` - Complete protocol specification
- `templates/spec.md` - Specification template
- `templates/plan.md` - Planning template
- `templates/review.md` - Review template

#### BUGFIX Protocol (`codev/protocols/bugfix/`)
**Purpose**: Lightweight protocol for minor bugfixes using GitHub Issues

**Workflow**:
1. **Identify** - Architect identifies issue #N
2. **Spawn** - `afx spawn N --protocol bugfix` creates worktree and notifies issue
3. **Fix** - Builder investigates, fixes, writes regression test
4. **Review** - Builder runs CMAP, creates PR
5. **Merge** - Architect reviews, builder merges
6. **Cleanup** - `afx cleanup --issue N` removes worktree

**Key Features**:
- No spec/plan documents required
- GitHub Issue is the source of truth
- CMAP review at PR stage only (lighter than SPIR)
- Branch naming: `builder/bugfix-<N>-<slug>`
- Worktree: `.builders/bugfix-<N>/`

**Selection Criteria**:
- Use BUGFIX for: Clear bugs, isolated to single module, < 300 LOC fix
- Escalate to SPIR when: Architectural changes needed, > 300 LOC, multiple stakeholders

**Files**:
- `protocol.md` - Complete protocol specification

### 2. Protocol Import

#### Protocol Import Command

The `codev import` command provides AI-assisted import of protocol improvements from other codev projects, replacing the older agent-based approach.

**Usage**:
```bash
# Import from local directory
codev import /path/to/other-project

# Import from GitHub
codev import github:owner/repo
codev import https://github.com/owner/repo
```

**How it works**:
1. Fetches the source codev/ directory (local path or GitHub clone)
2. Spawns an interactive Claude session with source and target context
3. Claude analyzes differences and recommends imports
4. User interactively approves/rejects each suggested change
5. Claude makes approved edits to local codev/ files

**Focus areas**:
- Protocol improvements (new phases, better documentation)
- Lessons learned from other projects
- Architectural patterns and documentation structure
- New protocols not in your installation

**Requirements**:
- Claude CLI (`npm install -g @anthropic-ai/claude-code`)
- git (for GitHub imports)

### 3. Agent-Farm CLI (Orchestration Engine)

**Location**: `packages/codev/src/agent-farm/`

**Purpose**: TypeScript-based multi-agent orchestration for the architect-builder pattern

**Architecture**:
- **Single canonical implementation** - All bash scripts deleted, TypeScript is the source of truth
- **Thin wrapper invocation** - `afx` command from npm package (installed globally)
- **Project-scoped state** - `.agent-farm/state.db` (SQLite) tracks current session
- **Global registry** — `~/.agent-farm/global.db` (SQLite) tracks workspace registrations and session metadata across projects

#### CLI Commands

```bash
# afx command is installed globally via: npm install -g @cluesmith/codev

# Starting/stopping
afx workspace start            # Start workspace
afx workspace stop             # Stop all agent-farm processes

# Managing builders
afx spawn 3 --protocol spir              # Spawn builder (strict mode, default)
afx spawn 3 --protocol spir --soft       # Soft mode - AI follows protocol, you verify compliance
afx spawn 42 --protocol bugfix           # Spawn builder for GitHub issue (BUGFIX protocol)
afx status                     # Check all agent status
afx cleanup --project 0003     # Clean up builder (checks for uncommitted work)
afx cleanup -p 0003 --force    # Force cleanup (lose uncommitted work)
afx cleanup --issue 42         # Clean up bugfix builder and remote branch

# Utilities
afx util                       # Open a utility shell terminal
afx shell                      # Alias for util
afx open src/file.ts           # Open file annotation viewer

# Communication
afx send 0003 "Check the tests"        # Send message to builder 0003
afx send --all "Stop and report"       # Broadcast to all builders
afx send architect "Need help"         # Builder sends to architect (from worktree)
afx send 0003 "msg" --file diff.txt    # Include file content
afx send 0003 "msg" --interrupt        # Send Ctrl+C first
afx send 0003 "msg" --raw              # Skip structured formatting

# Direct CLI access (v1.5.0+)
afx architect                  # Start/attach to architect session
afx architect "initial prompt" # With initial prompt

# Remote access (v1.5.2+)
afx tunnel                     # Show SSH command for remote access
afx workspace start --remote user@host  # Start on remote machine with tunnel

# Port management (multi-project support)
afx ports list                 # List workspace registrations (historical; port blocks removed in Spec 0098)
afx ports cleanup              # Remove stale allocations

# Database inspection
afx db dump                    # Dump state database
afx db query "SQL"             # Run SQL query
afx db reset                   # Reset state database
afx db stats                   # Show database statistics

# Command overrides
afx workspace start --architect-cmd "claude --model opus"
afx spawn 3 --protocol spir --builder-cmd "claude --model sonnet"
```

#### Configuration (`.codev/config.json`)

```json
{
  "shell": {
    "architect": "claude --model opus",
    "builder": ["claude", "--model", "sonnet"],
    "shell": "bash"
  },
  "templates": {
    "dir": "codev/templates"
  },
  "roles": {
    "dir": "codev/roles"
  }
}
```

**Configuration Hierarchy**: CLI args > .codev/config.json > Defaults

**Features**:
- Commands can be strings OR arrays (arrays avoid shell-escaping issues)
- Environment variables expanded at runtime (`${VAR}` and `$VAR` syntax)
- CLI overrides: `--architect-cmd`, `--builder-cmd`, `--shell-cmd`
- Early validation: on startup, verify commands exist and directories resolve

#### Global Registry (`~/.agent-farm/global.db`)

**Purpose**: Cross-workspace coordination -- tracks workspace metadata and terminal sessions for Tower

See the [Port System](#port-system) section above for details on the global registry schema and how it evolved from per-project port blocks to workspace/session tracking.

#### Role Files

**Location**: `codev/roles/`

**architect.md** - Comprehensive architect role:
- Responsibilities: decompose work, spawn builders, monitor progress, review and integrate
- Execution strategy: Modified SPIR with delegation
- Communication patterns with builders
- Full `afx` command reference

**builder.md** - Builder role with status lifecycle:
- Status definitions: spawning, implementing, blocked, pr, complete
- Working in isolated git worktrees
- When and how to report blocked status
- Deliverables and constraints

#### Global CLI Commands

The `afx`, `consult`, `codev`, `team`, and `porch` commands are installed globally via `npm install -g @cluesmith/codev` and work from any directory. No aliases or local scripts needed.

### 4. Test Infrastructure

**Framework**: Vitest (unit/integration) + Playwright (E2E browser tests)

**Location**:
- Unit tests: `packages/codev/src/__tests__/`
- E2E tests: `packages/codev/tests/e2e/`
- Config: `packages/codev/vitest.config.ts`, `packages/codev/vitest.cli.config.ts`, `packages/codev/vitest.e2e.config.ts`

**Running Tests**:
```bash
cd packages/codev
npm test                     # All Vitest tests
npx playwright test          # E2E browser tests
```

See `codev/resources/testing-guide.md` for Playwright patterns and Tower regression prevention.

### 5. Porch (Protocol Orchestrator)

**Location**: `packages/codev/src/commands/porch/`

**Purpose**: Porch is a stateless planner that drives SPIR, ASPIR, AIR, and BUGFIX protocols via a state machine. It does NOT spawn subprocesses or call LLM APIs — it reads state, decides the next action, and emits JSON task definitions that the Builder executes.

#### The next/done Loop

The canonical builder loop:

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│ porch next   │────→│ Builder runs │────→│ porch done   │
│ (emit tasks) │     │ tasks        │     │ (validate +  │
│              │←────│              │←────│  advance)    │
└─────────────┘     └──────────────┘     └─────────────┘
       ↕ gate_pending → STOP, wait for human approval
       ↕ complete → done
```

- **`porch next`** — Reads `status.yaml` + filesystem, returns a `PorchNextResponse` with status (`tasks`, `gate_pending`, `complete`, `error`) and an array of `PorchTask` objects (subject, description, sequential flag). No side effects except reading state.
- **`porch done`** — Signals task completion, runs checks (npm test/build), records reviews, advances state machine.
- **`porch run`** — Loops `next` → execute → `done` until complete or gate-blocked. Used by strict-mode builders.
- **`porch status`** — Shows current state and prescriptive next steps.
- **`porch approve <id> <gate>`** — Human-only gate approval.

#### State: `status.yaml`

State lives in `codev/projects/<id>-<name>/status.yaml` (atomic writes via tmp + fsync + rename).

Key fields:
- `phase` — Current protocol phase (specify, plan, implement, review)
- `plan_phases` / `current_plan_phase` — For phased protocols, tracks per-plan-phase progress
- `gates` — `Record<gate_name, {status: pending|approved, requested_at?, approved_at?}>`
- `iteration` — Current build-verify iteration (1-based)
- `build_complete` — Has the build finished this iteration?
- `history` — Audit trail of all iterations with review results

Review artifacts live alongside as `<id>-<phase>-iter<N>-<model>.txt`.

#### Gate Mechanics

Gates are human approval checkpoints between phases:

1. Phase build-verify completes with reviewer approvals
2. Gate status transitions: `undefined` → `pending` (with `requested_at`)
3. `porch next` detects pending gate → returns `gate_pending` status → Builder **stops and waits**
4. Human runs `porch approve <id> <gate-name>` → status becomes `approved` (with `approved_at`)
5. Next `porch next` call detects approved gate → advances to next phase

**Pre-approved artifacts**: Specs/plans with YAML frontmatter (`approved: <date>`, `validated: [models]`) auto-approve the corresponding gate, skipping build-verify for that phase.

#### Build-Verify Cycle

For most phases, porch runs an iterative build-verify loop:

1. Emit build task (write spec, implement code, etc.)
2. Run checks (npm test, npm build — defined per-phase in protocol.json)
3. Run 3-way consultation (parallel `consult` commands with `--output` flags)
4. Parse verdicts via `verdict.ts` (scans backward for `VERDICT:` line; defaults to `REQUEST_CHANGES` if not found)
5. If all approve → advance. If not → increment iteration, emit rebuttal/fix task

#### Builder / Enforcer / Worker Layering

Three layers exist because each addresses a concrete failure mode:

| Layer | Component | Why it exists |
|-------|-----------|---------------|
| **Builder** | Claude (in worktree) | Porch was a terrible conversational interface — the Builder provides human-visible progress |
| **Enforcer** | Porch (state machine) | Claude drifts without deterministic constraints — implements everything in one shot, skips reviews |
| **Worker** | `claude --print` / SDK | `--print` mode was crippled (no tools, silent failures) — needed proper tool execution |

#### Key Files

| File | Purpose |
|------|---------|
| `porch/next.ts` | Pure planner — reads state, emits JSON tasks |
| `porch/state.ts` | State management (read/write status.yaml) |
| `porch/protocol.ts` | Protocol loading and phase navigation |
| `porch/verdict.ts` | Review verdict parsing |
| `porch/plan.ts` | Plan phase extraction and advancement |
| `porch/index.ts` | CLI commands (status, init, approve) |
| `porch/types.ts` | Type definitions (ProjectState, PorchTask, etc.) |

### 6. Tower Startup Sequence

The startup ordering is critical — race conditions have caused real bugs when subsystems initialize in the wrong order.

**Canonical boot order** (from `tower-server.ts`):

| Step | Operation | Why this order |
|------|-----------|----------------|
| 1 | HTTP server binds to `localhost:port` | Single-Tower mutex + what readiness probes connect to. **Requests are held, not served, until step 9** (#1261) |
| 2 | SessionManager init + stale socket cleanup | Prepares shellper infrastructure |
| 3 | `initTerminals()` | Terminal management module ready |
| 4 | `startMailboxDrainer()` | Mailbox backstop drainer ready (Spec 1313 — replaced Spec 403's `startSendBuffer()`); shutdown calls `stopMailboxDrainer()` with **no force-flush** |
| 5 | **`reconcileTerminalSessions()`** | **MUST run before step 7** — reconnects shellper sessions from previous run |
| 6 | `killOrphanedShellpers()` | **MUST run after step 5** — avoids killing sessions that were just reconnected |
| 7 | `initInstances()` | Enables workspace API handlers — triggers dashboard polling |
| 8 | `initCron()` | Scheduler starts after instances ready |
| 9 | **`markBootComplete()`** | **Readiness gate opens** — held requests are released and Tower starts serving (#1261) |
| 10 | Husk sweep (#1227) + session-log sweep (#1238) | Maintenance: scales with disk state, so it must not gate the API |
| 11 | `initTunnel()` | Cloud tunnel connects last — a remote endpoint must never gate local readiness |
| 12 | WebSocket upgrade handler installed | Terminal connections accepted (installed at module load; not gated — see #997 barrier) |

**Known ordering bugs**:
- **Bugfix #274**: `initInstances()` before `reconcileTerminalSessions()` allowed dashboard polls to race with reconciliation, corrupting shellper sessions
- **Bugfix #341**: Killing orphaned shellpers before reconciliation killed sessions that were about to be reconnected
- **Bugfix #1261**: `initInstances()` ran last, *after* the two disk-scaling sweeps, so every `_deps`-dependent route was broken for as long as those scans took — `DELETE /api/terminals/:id` 404'd for a terminal that existed. Fixed by moving the sweeps after readiness and holding requests until step 9

**Defense in depth**: During startup, `getTerminalsForWorkspace()` skips on-the-fly shellper reconnection (via `_reconciling` guard) to prevent races through alternate code paths.

### 7. Message Delivery (`afx send`) — Mailbox-First (Spec 1313)

**Location**: `db/mailbox.ts`, `servers/render-gate.ts`, `servers/gate-profiles.ts`, `servers/write-queue.ts`, `servers/mailbox-delivery.ts`, `servers/mailbox-wiring.ts`, `servers/cron-delivery.ts`, `commands/send.ts`, `commands/inbox.ts`, `terminal/pty-session.ts`

Spec 1313 replaced Spec 403's in-memory, timer-based, force-flushing `SendBuffer` (deleted) with a **mailbox-first** pipeline. The governing invariant: a message body is **only ever written to a prompt a headless-terminal render-gate proves is empty**, so it can never fuse with a draft, a menu, a dialog, or a wrapper screen — corruption is eliminated *by construction*, not detect-and-repair. **There is no force path**: no timeout, valve, or fallback ever writes onto a non-clean screen. Any new automated message writer MUST route through this mailbox+gate — never write a PTY directly.

#### How it works

1. **Persist at enqueue.** `handleSend` (`tower-routes.ts`) writes a durable `mailbox` row (`db/mailbox.ts`, agent-addressed) to `global.db` *before* the HTTP response returns. Tower crash/restart/shutdown cannot lose it; shutdown never force-flushes (`stopMailboxDrainer()` just stops the loop).
2. **Gate before every write.** The render-gate (`render-gate.ts`) classifies the session's **persistent bounded headless-screen mirror** (`SessionScreen`, fed the session's output byte-for-byte from birth on the live path — its current viewport IS the live screen) and applies a per-app classifier profile (`gate-profiles.ts`: **claude** & **codex** use a dim-placeholder rule; **agy** uses a color-keyed `placeholderFgPalette` rule — see below). Clean (marker present AND a *positively-bounded* composer region — a rule/status line below the marker, never a scan to the screen bottom — with zero normal-intensity cells) → deliver; else → keep holding. One measured exemption (Spec 1313, 2026-08-06): claude paints a **suggested-command ghost** into an *idle* composer when its own last reply mentioned a runnable command, and the ghost's first char doubles as the software block cursor — SGR-7 **inverse at normal intensity** over a SGR-2-dim tail. The classifier exempts exactly that one cell (inverse + non-dim, at the headless cursor, with a **non-empty** dim tail as positive ghost evidence — `isGhostCursorCell`), so an idle ghost no longer classifies `busy` forever and strands mail to an unattended agent; it is deliberately not a blanket inverse skip (an inverse selection over a real draft keeps every other cell counted), and a real draft never trips it because claude never inverse-renders typed text (the block cursor rests on trailing whitespace) and a lone inverse cell with an empty tail — a 1-char draft with the cursor on its only char — stays `busy` (fail-toward-hold). codex renders its own ghost wholly dim, so the dim rule already covers it. **Why a persistent mirror, not a whole-ring re-render** (Spec 1313 round 2): the gate originally rebuilt the screen each check by replaying the whole output ring through a throwaway terminal. But #1205 caps the ring's newline-free `partial` at 2 MiB (`trimPartial` halves to ~1 MiB), and a claude/codex alt-screen frame is one giant partial — so once a busy long-lived agent's frame crossed the cap the ring handed the gate a **torn** front (dropped composer marker/rule → permanent `busy`), resurrecting the over-ceiling outage for exactly the busiest agents. A bounded terminal mirror needs only the live byte stream, so the cap is irrelevant, the live-ring tear is gone, each classify is O(viewport) not O(ring size), and the whole-render era's unbounded-`partial` OOM risk (#1047) is closed. The mirror is fed at `PtySession`'s single output chokepoint (`onPtyData` + the `attachShellper` replay seed), in lockstep with `RingBuffer.bytesWritten` — the **monotone** gate change-token (cumulative output bytes; the old `currentSeq:partialBytes` pair fell on a trim and could alias a stale verdict). The drainer still memoizes each verdict against the live session + that token so a static held screen skips re-classify; the cost-aware backstop backoff the whole-render era needed is retired (a viewport classify is cheap regardless of history). The throwaway-terminal `classifyScreen(snapshot)` path survives only for the fixture suite. (Caveat: on adopt/reconnect after a Tower restart the mirror is seeded from the FULL shellper replay — ≤8 MB wire cap; only the *ring* seed is `capRingSeed`-trimmed to 1 MiB (PIR #1354) — so a long-lived alt-screen frame is born torn only when its coherent start predates the shellper's whole retention; that residual case classifies not-clean → the gate HOLDS, fail-safe, and self-heals on the next repaint. Startup cost is bounded by draining each >1 MiB seed's parse before adopting the next session, measured ~58 ms/session at 8 MB. Residual tracked as #1361.)
3. **Honest response vocabulary.** `delivered` (gate passed, write completed) or `held` + row id + **why-held reason** ∈ {`busy` (draft/menu/mode), `no-profile` (unknown app), `no-live-pty` (no live terminal)}. Additive over the old shape (`ok`/`terminalId`/`deferred` retained for old binaries; a `held` outcome is still `ok:true`). Surfaced to senders through `packages/core/src/tower-client.ts` and `commands/send.ts` (both single-send and `--all` aggregation).
4. **Delivery moments** (each runs the gate; the gate decides): enqueue-time, **user-submit** trigger, **output-quiescence** trigger (Spec 467 `lastDataAt`), and a **poll backstop** (`DEFAULT_BACKSTOP_INTERVAL_MS = 1500`). Submit/quiescence come from `PtySession`'s single `handleUserInput` chokepoint. A missed trigger only delays to the next backstop — it can't corrupt anything (triggers *schedule*; they never authorize).
5. **Write serialization — two locks, one order (Issue #1365).** `write-queue.ts` chains writes for one *agent* on completion (keyed by `agentKey` — per-agent, not per-PTY; a message's text and its Enter are one unit), so concurrent gated deliveries to one agent can't interleave/blob. The delivery's write edge then takes the per-*terminal* submission lock (`session-submit.ts`) as a **leaf** inside that per-agent serializer, via `submitMessagePaced` — the same lock `escape`/`interrupt`/the delayed `^C` take. **Lock order is always per-agent → per-terminal, never the reverse**, so there is no cycle; re-entrancy is impossible too, since `PtySession.write()` emits no `'submit'` signal (only `handleUserInput` does). The lock wraps the *write* only, never the gate classify — `--interrupt` is the human's escape hatch and must not queue behind a screen classification. Held rows drain **oldest-eligible-first**: a row is eligible when `not_before IS NULL OR not_before <= now`, so a pre-due delayed row (Spec 1313 round 3) is excluded from the scan and never blocks a later row that is already due.

   *Why converged.* Until #1365 the two locks were **disjoint** and the resulting cross-path race was an accepted boundary ("a gated delivery only ever writes onto a render-verified empty prompt; `interrupt` is an explicit human action"). That reasoning covered one ordering and missed two: a `^C` landing inside the *delivery's own* text→Enter window (50–130 ms+) cleared the composer, so the delivery's Enter submitted nothing — yet every byte reached the PTY, the write reported success, and the row was marked **`delivered` for a message the agent never saw**; `--escape` produced the truncated variant, and is the *more* likely trigger for a long body, whose exposed window is longest. The "a human is at this terminal" premise also fails for the **delayed** `^C`, which fires unattended.

   *Asymmetric acquisition.* A delivery **declines** a contended terminal (`trySubmitToSession` → hold `busy`, retry next pass) rather than queueing, because `MailboxDrainer.tick` walks agents sequentially and one blocked delivery would stall every other agent's mail plus that tick's escalation/prune. It costs nothing: a contended terminal means the in-lock precheck would have aborted anyway. Operators **block**, bounded by `OPERATOR_SUBMIT_WAIT_CEILING_MS` (2 s) — a paced write runs `(lines−1)×10+80` ms and a body is capped only by `parseJsonBody`'s 1 MiB, so an unbounded wait could stall `afx interrupt` for minutes. **The ceiling may only bypass a DELIVERY write, never another operator** (`SubmissionKind` + a pending-operator count): operator-vs-operator was always fully serialized before #1365, so a ceiling that could skip a queued or in-flight operator would make that pair strictly *worse* than the old behaviour. With that restriction the "never worse than the old status quo" guarantee is true per pair — op↔op unchanged and unbounded; op↔delivery serialized under the ceiling and degraded to the old disjoint-lock behaviour above it; delivery↔delivery unchanged. Past the ceiling the operator write proceeds **unserialized** with a loud WARN **and** an explicit `degraded: true` in the `/api/send` response (surfaced by `afx send`), because the interrupt path has already claimed its row `delivered` and must not report an unqualified success for a body that may have interleaved. Degraded writes are counted per session, and a delivery that was raced reports `preempted` → **holds its row for redelivery** rather than reporting a delivery that may have been clobbered (trading a possible duplicate for never falsely reporting delivery, the same call the dropped-write branch already makes).

   *What is and isn't guaranteed.* **Serialization is the structural guarantee**: no lock-taking writer can put bytes on a terminal while another's submission is in flight. The delivery additionally re-validates `writable`, the gate's `ringToken`, and the row's own status **inside** the lock — that narrows a window but does not close one, because `ringToken` counts *output*, so un-echoed input from an uncovered writer (the raw `/api/terminals/:id/write` passthrough, or a human's keystrokes — both deliberately uncovered) can still read as unchanged. That echo-lag residual is **#1473**. The in-lock precheck's structural value is that it keeps the acquisition policy a free choice: switching the delivery from declining to waiting (e.g. #1481 ordering an interrupt ahead of its body) stays safe.

   *Delayed `--interrupt` sequencing.* The timer fires **only** the `^C` (inside the lock, re-checking liveness there); the body is an ordinary `not_before` row that delivers through the gate afterwards. So the body can never land mid-turn — but `^C`→body is **not atomic** by design: the gate re-decides, which means the delayed interrupt guarantees "the turn was ended", never "this body is next".
6. **Rows address agents, not PTYs.** A respawned terminal for the same agent drains its predecessor's held mail on the first clean gate pass. Dead-session sends persist as `no-live-pty` and deliver on respawn (no drop-with-WARN).
7. **`--interrupt`** is the sole bypass — an explicit, deliberate sender action (interrupts the agent, writes without a gate check). It is a per-message command, not a timeout/valve, so it does not weaken the no-force-path invariant. `noEnter` sends are gate-checked staging (write text, no Enter) → report `delivered`.

#### Escalation & visibility (never delivery)

A held row past the escalation age (`DEFAULT_ESCALATION_MS`, default 60s; `.codev/config.json` `mailbox.escalationSeconds`) is flagged `escalated` and emits the `mailbox-escalation` SSE event — **visibility only, never a delivery trigger**. Every held-state change (hold/deliver/supersede/dismiss) fires `overview-changed` so the dashboard/VSCode held-count indicators stay live (`setMailboxBroadcaster(broadcastNotification)` wires the boot-time drainer, which has no `RouteContext`, into the SSE fan-out). `afx inbox` lists held rows (workspace-scoped; metadata only, never bodies), `afx inbox show <id>` displays a single row including its body (the one body-surfacing CLI view; works on a row of any status), and `afx inbox dismiss <id>` soft-marks a row dismissed (any workspace operator; CLI-only). Terminal rows (delivered/superseded/dismissed) are pruned after `mailbox.retentionDays` (default 30) by the drainer; **held rows are never pruned**. Cron delivers through the same gate via `deliverCronMessage` (`cron-delivery.ts`) with a per-task supersede key (a newer run replaces the older *held* row) and logs the real outcome.

#### Address Resolution

`afx send` resolves addresses via Tower API with tail-matching: `"0109"` matches `"builder-spir-0109"`. Supports `--all` for broadcast, `--file` for file attachments (48KB max), and `--raw` to skip structured formatting. With no live PTY, resolution falls back to the global.db agent registry so the message holds (`no-live-pty`) instead of 404ing.

#### Sender attribution (message headers)

`formatMessageForTarget` (`tower-routes.ts`, via `utils/message-format.ts`) wraps a delivered body in a header keyed by target + `from`: a message **to a builder** renders as `[ARCHITECT INSTRUCTION]`, a message **to an architect with a builder `from`** as `[BUILDER <id> MESSAGE]`, and (#1494) a message **to an architect with `from === VSCODE_USER_SENDER`** (the `'vscode-user'` wire constant in `@cluesmith/codev-types`) as `[USER via VS Code]`.

**Every wrapper is self-attesting (#1574).** The header also names the RECIPIENT — `[BUILDER <sender> MESSAGE → <to_agent> | <ts>]`, and likewise for the other two variants — where `to_agent` is the canonical identity the mailbox row is keyed on. Without it no pane-reader could verify a frame on its screen was addressed to it: a genuine misdelivery was invisible to its victim (the one party positioned to detect it), and a false claim of one could not be refuted from the screen. `toAgent` is a required formatter argument, so the recipient is threaded from resolution rather than defaulted. Builder-bound frames additionally carry `(reply: afx send architect "…")` **on the closing delimiter line** (`formatArchitectToBuilderMessage`) — the reply channel stated at the point of need, because a builder that types a reply as assistant text in its own terminal reaches nobody and gets no feedback (the real defect behind #1530). The same line, not a fourth one, is deliberate: `message-write.ts` paces messages of `PACED_WRITE_LINE_THRESHOLD` (4) lines or more line-by-line, so a trailing line would move every short architect→builder message off the single-write path and widen the delivery-write exposure window (#1521/#1573) as a side effect of a formatter change. `--raw` sends are unwrapped and gain neither. That third class exists so a human's VS Code action relayed to the architect is distinguishable from a peer-architect instruction. The VS Code Approve-gate button sends its relay with that `from`; the extension itself never runs `porch approve`. Under the builder-runs-it convention the architect passes the relay to the builder, which runs the command in its own worktree.

**The limit (do not build on this header as proof):** `from` is caller-controlled, so within Tower's keyed boundary (post-#1421 every route accepting this message requires the shared local key) the header **differentiates** a VS Code relay for triage, it does **not** prove a human click. A gate-spending or bypass-spending decision still requires the standing provenance bars (the human's word in the executing channel, or evidence independent of the requesting chain), never a `[USER via VS Code]` header alone.

### 8. Identity Resolution (`afx whoami`) (Spec 1134)

**Location**: `commands/whoami.ts` (composes `detectCurrentBuilderId`/`detectWorkspaceRoot` from `commands/send.ts` and `lookupBuilderSpawningArchitect` from `state.ts`)

`afx whoami` reports the current terminal's agent identity (workspace, type, name) from Tower/global.db's perspective. Identity precedence is fixed: **builder-worktree cwd match** (canonical id verified against global.db — same resolution `afx send` uses, including the #1094 rule that an unverifiable worktree identity throws rather than falling through) → **`CODEV_ARCHITECT_NAME`** (the Tower-injected architect env var, read directly — NOT via `currentArchitectName()`, whose `main` default is deliberately not used here) → **unknown** (exit 1, no implicit `main`). Strictly read-only against global.db: `lookupBuilderSpawningArchitect(builderId, workspacePath?, db?)` accepts an optional connection so whoami passes its own readonly handle instead of the read-write `getDb()` singleton. Workspace display name comes from `known_workspaces` with directory-basename fallback (informational field only — fail-loud applies to type/name). `--json` emits `{workspace, type, name, architect?}`; failures emit `{"error": ...}` on stdout plus a human explanation on stderr. Works without Tower running. The shipped `/arch-init` skill builds on whoami for architect identity adoption + state recovery from `codev/state/<name>.md`; it is maintained in both Claude and Codex provider skill trees. Architect state files are per-person (every team member has their own `main`, so a committed one collides across the team) and gitignored via `codev/state/*.md`; builder thread files (`codev/state/<id>_thread.md`) have the opposite lifecycle and are versioned via a `!codev/state/*_thread.md` negation, since they ship with each builder's PR (Issue #1192). `codev init`/`adopt`/`update` all source this rule pair from the single `CODEV_GITIGNORE_ENTRIES` constant (`packages/codev/src/lib/gitignore.ts`); `codev doctor` audits the split via `auditStateFileIgnore()`.

## Installation Architecture

**Entry Point**: `INSTALL.md` - Instructions for AI agents to install Codev

**Installation Flow**:
1. **Prerequisite Check**: Verify consult CLI availability
2. **Directory Creation**: Create `codev/` structure in target project
4. **Skeleton Copy**: Copy protocol definitions, templates, and agents
5. **Conditional Agent Installation**:
   - Detect if Claude Code is available (`command -v claude`)
   - If yes: Install agents to `.claude/agents/`
   - If no: Agents remain in `codev/agents/` (universal location)
6. **AGENTS.md/CLAUDE.md Creation/Update**:
   - Check if files exist
   - Append Codev sections to existing files
   - Create new files if needed (both AGENTS.md and CLAUDE.md)
   - Both files contain identical content
7. **Verification**: Validate installation completeness

**Key Principles**:
- All Codev files go INSIDE `codev/` directory (not project root)
- Agents installed conditionally based on tool detection
- AGENTS.md follows [AGENTS.md standard](https://agents.md/) for cross-tool compatibility
- CLAUDE.md provides native Claude Code support (identical content)
- Uses local skeleton (no network dependency)
- Preserves existing CLAUDE.md content

Provider-native skills are the intentional exception to runtime-only framework
resolution: Claude and Codex discover skills only from root
`.claude/skills/` and `.codex/skills/`, so `codev init` materializes both from
the embedded package skeleton. `codev adopt` and `codev update` backfill
missing skills independently for each provider and treat an existing complete
skill directory as user-owned, never overwriting it. The two shipped provider
trees are physical mirrors guarded by recursive path-and-byte parity tests;
reviewed provider-specific skills must be named in the test's exception
allowlist.

## Key Design Decisions

### 1. Context-First Philosophy
**Decision**: Natural language specifications are first-class artifacts

**Rationale**:
- AI agents understand natural language natively
- Human-AI collaboration requires shared context
- Specifications are more maintainable than code comments
- Enables multi-agent consultation on intent, not just implementation

### 2. Self-Hosted Development
**Decision**: Codev uses Codev to develop itself

**Rationale**:
- Real-world usage validates methodology
- Pain points are experienced by maintainers first
- Continuous improvement from actual use cases
- Documentation reflects reality, not theory

### 3. Tool-Agnostic Agent Installation
**Decision**: Conditional installation - `.claude/agents/` (Claude Code) OR `codev/agents/` (other tools)

**Rationale**:
- **Environment detection** - Automatically adapts to available tooling
- **Native integration** - Claude Code gets `.claude/agents/` for built-in agent execution
- **Universal fallback** - Other tools (Cursor, Copilot) use `codev/agents/` via AGENTS.md
- **Single source** - `codev/agents/` is canonical in this repository (self-hosted)
- **No lock-in** - Works with any AI coding assistant supporting AGENTS.md standard
- **Graceful degradation** - Installation succeeds regardless of environment

**Implementation Details**:
- Detection via `command -v claude &> /dev/null`
- Silent error handling (`2>/dev/null || true`) for missing agents
- Clear user feedback on installation location
- Test infrastructure mirrors production behavior

### 4. AGENTS.md Standard + CLAUDE.md Synchronization
**Decision**: Maintain both AGENTS.md (universal) and CLAUDE.md (Claude Code-specific) with identical content

**Rationale**:
- AGENTS.md follows [AGENTS.md standard](https://agents.md/) for cross-tool compatibility
- CLAUDE.md provides native Claude Code support
- Identical content ensures consistent behavior across tools
- Users of any AI coding assistant get appropriate file format

### 5. Multi-Agent Consultation by Default
**Decision**: SPIR and ASPIR default to consulting GPT-5 and Gemini 3 Pro

**Rationale**:
- Multiple perspectives catch issues single agent misses
- Prevents blind spots and confirmation bias
- Improves code quality and completeness
- User must explicitly disable (opt-out, not opt-in)

#### Consult Architecture

The `consult` command (`packages/codev/src/commands/consult/index.ts`) is a **CLI delegation layer** — it does NOT call LLM APIs directly. Instead, it spawns external CLI tools as subprocesses:

```
consult -m gemini spec 42
  → spawns: agy --print --sandbox --add-dir <workspace> "<role + query>"

consult -m codex spec 42
  → spawns: codex exec -c experimental_instructions_file=<tmpfile> --full-auto "<query>"

consult -m claude spec 42
  → spawns: claude --print -p "<role + query>" --dangerously-skip-permissions
```

**Model configuration** (top of `index.ts`):

| Model | CLI Binary | Role Injection | Key Env Var |
|-------|-----------|----------------|-------------|
| gemini | `agy` (Antigravity CLI; resolved real bin, not the IDE symlink) | Folded into the prompt (role + query) | OAuth / subscription (no API key) |
| codex | `codex` | Temp file via `-c experimental_instructions_file=` flag | `OPENAI_API_KEY` |
| claude | `claude` | Prepended to query string | `ANTHROPIC_API_KEY` |

**Query building**: Five subcommands (`pr`, `spec`, `plan`, `impl`, `general`) each build a prompt that includes the spec/plan/diff content plus a verdict template (`VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]`). PR diffs truncated to 50k chars, impl diffs to 80k chars.

**Role resolution** uses `readCodevFile()` with local-first, embedded-skeleton-fallback:
1. `codev/roles/consultant.md` (local override)
2. `skeleton/roles/consultant.md` (embedded default)

**Porch integration**: Porch's `next.ts` spawns 3 parallel `consult` commands with `--output` flags, collects results, parses verdicts via `verdict.ts` (scans backward for `VERDICT:` line, defaults to `REQUEST_CHANGES` if not found).

**Consultation feedback flow** (Spec 0395): Consultation concerns and builder responses are captured in the **review document** (`codev/reviews/<project>.md`), not in porch project directories. The builder writes a `## Consultation Feedback` section during the review phase, summarizing each reviewer's concerns with one of three responses: **Addressed** (fixed), **Rebutted** (disagreed), or **N/A** (out of scope). This is prompt-driven — the porch review prompt and review templates instruct the builder to read raw consultation output files and summarize them. Raw consultation files remain ephemeral session artifacts; the review file is the durable record. Specs and plans stay clean as forward-looking documents.

**Claude nesting limitation**: The `claude` CLI detects nested sessions via the `CLAUDECODE` environment variable and refuses to run inside another Claude session. This affects builders (which run inside Claude) trying to run `consult -m claude`. Two mitigation options exist:
1. **Unset `CLAUDECODE`**: Builder's shellper session already uses `env -u CLAUDECODE` for terminal sessions, but not for `consult` invocations
2. **Anthropic SDK**: Replace CLI delegation with direct API calls via `@anthropic-ai/sdk`, bypassing the nesting check entirely

### 6. Single Canonical Implementation (TypeScript agent-farm)
**Decision**: Delete all bash architect scripts; TypeScript agent-farm is the single source of truth

**Rationale**:
- **Eliminate brittleness** - Triple implementation (bash + duplicate bash + TypeScript) caused divergent behavior
- **Single maintenance point** - Bug fixes only needed once
- **Type safety** - TypeScript catches errors at compile time
- **Rich features** - Easier to implement complex features (port registry, state locking)
- **Thin wrapper pattern** - Bash wrappers just call `node agent-farm/dist/index.js`

### 7. Global Registry for Multi-Workspace Support
**Decision**: Use `~/.agent-farm/global.db` (SQLite) for cross-workspace coordination

**Rationale**:
- **Cross-workspace coordination** - Multiple repos tracked simultaneously
- **Terminal session persistence** - Session metadata survives Tower restarts
- **File locking** - Prevents race conditions during concurrent operations
- **Stale cleanup** - Automatically removes entries for deleted workspaces

> **Historical note** (Spec 0008, Spec 0098): Originally allocated deterministic 100-port blocks per repository. After the Tower Single Daemon architecture (Spec 0090), per-workspace port blocks became unnecessary and were removed in Spec 0098. The global registry now tracks workspace metadata and terminal sessions instead.

### 8. Request Authentication in Tower: the Shared Local Key
**Decision**: Every non-public Tower route — HTTP and WebSocket upgrades alike — requires the shared local key (`~/.agent-farm/local-key`, generated by Tower at boot, mode 0600), compared in constant time and failing closed (advisory GHSA-xvjp-7748-v88v, PR #1421, merged 2026-08-18).

**How the key travels**:
- **CLI / SDK / VS Code extension** read the file directly (possession proves same-OS-user) and present it as the `codev-tower-key` header, or a `codev-key.<KEY>` WebSocket subprotocol token
- **Browser pages** cannot read files, so Tower injects `window.__CODEV_TOWER_KEY__` into the HTML shells it serves same-origin; those shells strip `Access-Control-Allow-Origin` so a cross-origin fetch can never read the key, and a Host allowlist blocks DNS rebinding
- **Public allowlist is deliberately narrow**, and every entry exists because a *browser navigation* reaches it and cannot attach a header: `/health`, `/api/version`, the dashboard shell and its static assets, the annotator shell + vendor files (iframe / `<script>` / `<link>` loads), and `GET /api/tunnel/connect/callback` — the cloud OAuth redirect, which is nonce-authenticated instead (single-use, 5-min TTL, mintable only by an authenticated `POST /api/tunnel/connect`; #1570). Everything else under `api/` and `ws/` requires the key. `BRIDGE_MODE` refuses to start without a key at all
- **Reviewing a carve-out** means enumerating the header-less entry points, not just walking the API surface: #1421's 3-way consult and architect review both walked the routes and still missed the OAuth redirect, 401ing every fresh cloud registration until #1570

**Complementary controls that predate the key** (still in force): `/api/tunnel/*` rejects tunnel-borne requests outright (PR #1374), and `via=tunnel/local` attribution logs every proxied request. The cloud edge (codevos.ai) still owns *remote user* authentication; the local key authenticates *local* actors to their own Tower.

> **Superseded ruling** (issue #1375, 2026-08-09): Tower briefly had an explicit no-internal-auth-by-design position — localhost binding as the local boundary, the cloud edge as the remote one. Security advisory GHSA-xvjp-7748-v88v reversed it nine days later: localhost binding proves same-*machine*, not same-actor, and any local process could reach every management route. The key model above is the current authority; the trust boundary honesty to preserve is that browser-path key delivery still relaxes "same user" to "same machine reaching loopback."

## Integration Points

### External Services
- **GitHub**: Repository hosting, version control (default forge)
- **AI Model Providers**:
  - Anthropic Claude (Sonnet, Opus)
  - OpenAI GPT-5
  - Google Gemini 3 Pro

### External Tools
- **Claude Code**: Native integration via `.claude/agents/`
- **Cursor**: Via AGENTS.md standard
- **GitHub Copilot**: Via AGENTS.md standard
- **Other AI coding assistants**: Via AGENTS.md standard
- **Consult CLI**: For multi-agent consultation (installed with @cluesmith/codev)

### Forge Concept Commands (Spec 589)

All interactions with the repository hosting platform (GitHub by default) are routed through **forge concept commands** — configurable external processes that produce JSON on stdout. This abstraction enables non-GitHub repository support.

**Rule (demoted from arch-critical, still binding):** when new forge behavior is needed, add a **dedicated concept** — never bolt environment flags onto an existing shared one. (Example: `issue-search` was added as its own concept instead of widening `issue-list`.)

**Core module**: `src/lib/forge.ts`
- `executeForgeCommand(concept, envVars, options)` — async dispatcher
- `executeForgeCommandSync(concept, envVars, options)` — sync variant
- `loadForgeConfig(workspaceRoot)` — loads `.codev/config.json` forge section
- `validateForgeConfig(config)` — validates concept overrides

**Configuration**: `.codev/config.json` `forge` section maps concept names to shell commands. Set to `null` to disable a concept. Omit to use the default (`gh`-based) command.

**15 concepts**: `issue-view`, `pr-list`, `issue-list`, `issue-comment`, `pr-exists`, `recently-closed`, `recently-merged`, `user-identity`, `team-activity`, `on-it-timestamps`, `pr-merge`, `pr-search`, `pr-view`, `pr-diff`, `auth-status`.

**Environment variables**: Each concept receives `CODEV_*` env vars (e.g., `CODEV_ISSUE_NUMBER`, `CODEV_PR_NUMBER`) that the command uses to parameterize its output.

### Two remote-command paths into an editor surface (Spec 1401)

Tower has **two** ways for an external controller to drive an editor, and picking the wrong one
is the mistake this note exists to prevent.

| | `/api/command` (Spec 1189) | `/api/canvas/*` (Spec 1401) |
|---|---|---|
| Shape | Broadcast a canonical **verb** to every SSE subscriber | Resolve **one** registered canvas view and address it |
| Answer | `{ok:true}` unconditionally, even with no provider listening | The resolved target, or `no-canvas` (404) / `invalid-request` (400) |
| State | Stateless relay | In-memory registry of live views, heartbeat lease |
| Use it when | Any provider may act; nobody needs to hear whether one did | The caller must know a target existed, or several could match |

**Rule:** if a new remote feature needs to report that nothing was there to receive it, or to
choose among several candidate surfaces, it belongs on the canvas-style path — the broadcast
relay cannot express either, and bolting a reply onto it would change its contract for every
existing verb.

**Canvas channel specifics.** `packages/codev/src/agent-farm/servers/canvas-relay.ts` owns the
route family; hosts register per **view** (a panel, not a document), heartbeat a lease, and
filter the broadcast SSE by their Tower-minted `viewId`. Liveness and recency are tracked
separately: any heartbeat extends the lease, but only focus or a delivered command advances the
most-recently-active stamp used for targeting. Command delivery deliberately does **not** extend
the lease — delivery is fire-and-forget and proves nothing about the host still being alive.

The command vocabulary lives in `@cluesmith/codev-types` (`canvas-command.ts`) as a closed union;
Tower, the sdk and the canvas package each keep a local `satisfies`-bound copy of any runtime list
because codev-types is type-only for all three.

### Stream Deck ↔ VSCode shared-selection coherence (Spec 1410)

The deck is a remote and VSCode is the screen, bound by **one shared selection**. Two surfaces have
*different* anchors, and keeping them equal is the invariant future deck/vscode work must preserve:

- **Row 1/Row 2 keys** act on the deck's shared cursor (`selectedBuilder()`); the **review dials**
  act on VSCode's *focused* editor / MRU canvas. They stay the same builder because (a) a Row 1 press
  is *select + open* in one gesture, and (b) focusing a builder artifact fires the **`builder-active`
  activity hook** → deep link → the deck's `syncToBuilder`. Spec 1410 extends that back-sync to a
  focused **canvas** (`preview-provider.ts`, resolving the owner by worktree-path prefix), not only a
  diff (`announceActiveBuilderFromEditor`) — so canvas focus moves the deck selection too. The hook is
  personal-config (`~/.codev/config.json`, `activityHooks`), so the VSCode→deck direction is opt-in.
- **Review feedback is mode-neutral at the deck, mode-routed in VSCode.** A diff-dial press relays
  `feedback-file`/`feedback-hunk`/`feedback-selection`; VSCode forwards immediately or enqueues per the
  `codev.diffCodelensMode` workspace setting, and `send-queue` flushes. **All queue mutations go through
  `ReviewQueueStore`** (the single source of truth, Spec 1037) — never a parallel path — so every surface
  reflects deck-driven changes. Tower only *reads* the queue file to project the count.
- **Overview wire (`OverviewData`)** carries `queuedFeedback: Record<builderId, count>` (a per-builder
  **map**, never a scalar — the deck badge and #1049's Attention rollup both index it) and
  `feedbackMode: 'forward' | 'queue'` (per-workspace scalar, read from `.vscode/settings.json`,
  single-folder-workspace only, defaults to `forward`).
- **Open Architect Terminal key (Spec 1463)** — a Row-2 key that opens an architect's terminal via
  `open-architect-terminal` (relay → `codev.openArchitectTerminal`). Two PI modes: `builder` (default,
  the selected builder's `spawnedByArchitect`; inert when none) and `main`. **The deck delegates the
  `main`-else-first resolution policy to VSCode** (which already special-cases the literal `'main'` in
  `openArchitectTerminal`), so it fires a name and never consumes `OverviewData.architects` (the
  live-architect view) — one policy, one home. Two accepted residuals follow from the fire-and-forget
  relay: in `main` mode when `main` is absent VSCode opens the first live architect while the face still
  reads `Main`; and a live registration behind a dead PTY resolves fine. The face renders the resolved
  architect name (the safeguard shown before a press), and because `resolve()` is shared by the
  press path and the render path, that safeguard is **structural** — face and action can't drift,
  there is one resolution. The lesson for the next key: **avoiding** the live-architect dependency
  (fire a name, delegate policy to VSCode) beat handling it — the registry failure modes are simply
  not this key's problem. Don't reach for `OverviewData.architects`. Paired-renamed with the builder key
  (`Open Builder Terminal` / `Open Architect Terminal`); **the Elgato UUID is the stable identity**, so
  renaming `Name`/face never orphans an already-placed key. Prerequisite: #1406 (spawn mis-attribution)
  can make `builder` mode summon the wrong architect until fixed.

### Internal Dependencies
- **Git**: Version control, worktrees for builder isolation
- **Node.js**: Runtime for agent-farm TypeScript CLI
- **Bash**: Thin wrapper scripts and test infrastructure
- **Markdown**: All documentation format
- **YAML**: Protocol configuration
- **JSON**: State management and configuration

### Optional Dependencies (Agent-Farm)
- **node-pty**: Native PTY sessions for dashboard terminals (compiled during install, may need `npm rebuild node-pty`)

## System-Wide Patterns

Cross-cutting concerns that appear throughout the codebase:

### Error Handling

**Pattern**: Fail fast, never silently fallback.

- Errors propagate up to the CLI entry point
- Each command catches and formats errors for user display
- No silent failures - if something can't complete, it throws
- Exit codes: 0 = success, 1 = error

**Example** (`packages/codev/src/commands/*.ts`):
```typescript
try {
  await performAction();
} catch (error) {
  console.error(`[error] ${error.message}`);
  process.exit(1);
}
```

### Logging

**Pattern**: Minimal, prefixed output.

- `[info]` - Normal operation messages
- `[warn]` - Non-fatal issues
- `[error]` - Fatal errors
- No log files - all output to stdout/stderr
- No log levels or verbosity flags (yet)

### Configuration Loading

**Precedence** (highest to lowest):
1. CLI arguments (`--port`, `--architect-cmd`, etc.)
2. Config file (`.codev/config.json`)
3. Embedded defaults in code

**Config file location**: `.codev/config.json` (project root, project-level)

### State Persistence

**Pattern**: SQLite for all structured state.

- `.agent-farm/state.db` - Builder/util state (local, per-project)
- `~/.agent-farm/global.db` - Global workspace/session registry (cross-project)
- `codev/projects/<id>/status.yaml` - Active project state (managed by porch)
- GitHub Issues - Project tracking (source of truth, Spec 0126)

### Template Processing

**Pattern**: Double-brace placeholder replacement.

- `{{PROJECT_NAME}}` - Replaced with project name during init/adopt
- Simple string replacement, no complex templating engine
- Applied to CLAUDE.md, AGENTS.md, and similar files

## Governance Docs (Hot/Cold Tiers)

Spec 987 split the two governance docs into a **hot/cold** two-tier model so durable wisdom is consumed at decision time, not just written:

- **COLD** — `arch.md` and `lessons-learned.md`: full, on-demand reference archives (this file is the cold arch doc). Grepped/read for depth; may hold spec-narrow recipes.
- **HOT** — `arch-critical.md` and `lessons-critical.md`: tiny, hard-capped (≈10 entries + a ≤12-topic "consult when…" map of the cold doc, ≤35 lines). **Always injected** into context two ways:
  - **porch builders** — `buildHotTierContext()` in `packages/codev/src/commands/porch/prompts.ts` resolves the hot files via the runtime four-tier resolver (`resolveCodevFile`) and prepends them to *every* phase prompt.
  - **interactive sessions** — a generated managed block (`packages/codev/src/lib/managed-block.ts`, delimited by `<!-- BEGIN/END CODEV HOT CONTEXT -->`) is written into `CLAUDE.md`/`AGENTS.md` at `codev init`/`update` time (non-clobbering; preserves user content).

Hot files are materialized into projects by `copyHotTierDefaults` (wired into init/adopt/update) and resolve from the skeleton at tier-4 until a project curates its own. The cold files are likewise bootstrapped on init/adopt/update by `copyColdTierDefaults`, which copies minimal placeholder starters from the skeleton's `templates/{arch,lessons-learned}.starter.md` into `codev/resources/{arch,lessons-learned}.md` (issue #1012) — distinct from the rich `templates/{arch,lessons-learned}.md` reference templates, which are a manual-`cp` opt-in and are never auto-copied. Both materializers are skip-existing, so a project's curated copy is never overwritten; the cold files are registered as protected user data in `templates.ts`. Producers **route** new facts/lessons by tier at review time (see the review prompts); MAINTAIN + the `update-arch-docs` skill police the hot caps, displacement (demote to cold when full), and cold-doc map accuracy. The cap is load-bearing: it is what keeps the hot tier cheap enough to inject everywhere.

## Troubleshooting

See the [Quick Tracing Guide](#quick-tracing-guide) for debugging entry points.

Additional issues:
- **Tests hanging**: Install `coreutils` on macOS (`brew install coreutils`)
- **Permission errors**: `chmod -R u+w /tmp/codev-test.*`
- **Agent not found**: Claude Code uses `.claude/agents/`, other tools use `codev/agents/`

## Maintenance

See [MAINTAIN protocol](../protocols/maintain/protocol.md) for codebase hygiene and documentation sync procedures.

---

**Last Updated**: 2026-04-17
**Version**: v3.0.0-rc.9 (Pre-release)
**Changes**: Pre-v3.0.0 MAINTAIN run (0007): directory tree refresh, protocol list update, removed unused http-proxy dependency. See CHANGELOG.md for version history.
