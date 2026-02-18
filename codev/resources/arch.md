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
- **Consult Tool**: See `packages/codev/src/commands/consult/` and `codev/roles/consultant.md`
- **Protocols**: Read the relevant protocol in `codev/protocols/{spir,tick,maintain,experiment}/protocol.md`

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
| **"Builder spawn fails"** | `packages/codev/src/agent-farm/commands/spawn.ts` → `createBuilder()` | Worktree creation, shellper session, role injection |
| **"Gate not notifying architect"** | `commands/porch/notify.ts` → `notifyArchitect()` | porch sends `af send architect` directly at gate transitions (Spec 0108) |
| **"Consult hangs/fails"** | `packages/codev/src/commands/consult/index.ts` | CLI availability (gemini/codex/claude), role file loading |
| **"State inconsistency"** | `packages/codev/src/agent-farm/state.ts` | SQLite at `.agent-farm/state.db` |
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
| **Agent Farm** | Infrastructure for parallel AI-assisted development (dashboard, terminals, worktrees) |
| **Protocol** | Defined workflow for a type of work (SPIR, TICK, MAINTAIN, EXPERIMENT) |
| **SPIR** | Multi-phase protocol: Specify → Plan → Implement → Review |
| **TICK** | Amendment protocol for extending existing SPIR specs |
| **MAINTAIN** | Codebase hygiene and documentation synchronization protocol |
| **Worktree** | Git worktree providing isolated environment for a builder |
| **node-pty** | Native PTY session manager, multiplexed over WebSocket |
| **Shellper** | Detached Node.js process owning a PTY for session persistence across Tower restarts (Spec 0104) |
| **SessionManager** | Tower-side orchestrator for shellper process lifecycle (spawn, reconnect, kill, auto-restart) |
| **Skeleton** | Template files (`codev-skeleton/`) copied to projects on init/adopt |

## Invariants & Constraints

**These MUST remain true - violating them will break the system:**

1. **State Consistency**: `.agent-farm/state.db` is the single source of truth for builder/util state. Never modify it manually.

2. **Single Tower Port**: All projects are served through Tower on port 4100. Per-project port blocks were removed in Spec 0098. Terminal sessions and workspace metadata are tracked in `~/.agent-farm/global.db`.

3. **Worktree Integrity**: Worktrees in `.builders/` are managed by Agent Farm. Never delete them manually (use `af cleanup`).

4. **CLAUDE.md ≡ AGENTS.md**: These files MUST be identical. They are the same content for different tool ecosystems.

5. **Skeleton Independence**: The skeleton (`codev-skeleton/`) is a template for OTHER projects. The `codev/` directory is OUR instance. Don't confuse them.

6. **Git Safety**: Never use `git add -A`, `git add .`, or `git add --all`. Always add files explicitly.

7. **Human Approval Gates**: Only humans can transition `conceived → specified` and `committed → integrated`.

8. **Consultation Requirements**: External AI consultation (Gemini, Codex) is mandatory at SPIR checkpoints unless explicitly disabled.

## Agent Farm Internals

This section provides comprehensive documentation of how the Agent Farm (`af`) system works internally. Agent Farm is the most complex component of Codev, enabling parallel AI-assisted development through the architect-builder pattern.

### Architecture Overview

Agent Farm orchestrates multiple AI agents working in parallel on a codebase. The architecture consists of:

```
┌─────────────────────────────────────────────────────────────────────┐
│                   Dashboard (React + Vite on :4200)                  │
│              HTTP server + WebSocket multiplexer                     │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │Architect │  │ Builder  │  │ Builder  │  │  Utils   │            │
│  │  Tab     │  │  Tab 1   │  │  Tab 2   │  │  Tabs    │            │
│  │(xterm.js)│  │(xterm.js)│  │(xterm.js)│  │(xterm.js)│            │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘            │
│       │             │             │             │                   │
│       └─────────────┴──────┬──────┴─────────────┘                   │
│                            ▼                                        │
│                  ┌───────────────────┐                               │
│                  │ Terminal Manager  │                               │
│                  │  (node-pty PTY    │                               │
│                  │   sessions)       │                               │
│                  └────────┬──────────┘                               │
└───────────────────────────┼─────────────────────────────────────────┘
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

**Data Flow**:
1. User opens dashboard at `http://localhost:4200`
2. React dashboard polls `/api/state` for current state (1-second interval). Response includes `persistent` boolean per terminal.
3. Each tab renders an xterm.js terminal connected via WebSocket to `/ws/terminal/<id>`
4. Terminal creation uses `SessionManager.createSession()` for persistent shellper-backed sessions, or direct node-pty for non-persistent sessions
5. Shellper-backed PtySessions delegate write/resize/kill to the shellper's Unix socket via `IShellperClient`
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
Shellper (PTY owner + 10,000-line replay buffer)
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
3. Appends `--append-system-prompt <content>` to the architect command args

**Three architect creation points** where role injection is applied:
- `tower-instances.ts` → `launchInstance()` (new project activation)
- `tower-terminals.ts` → `reconcileTerminalSessions()` (startup reconnection with auto-restart options)
- `tower-terminals.ts` → `getTerminalsForWorkspace()` (on-the-fly shellper reconnection)

#### Builder Gate Notifications (Spec 0100, replaced by Spec 0108)

As of Spec 0108, porch sends direct `af send architect` notifications via `execFile` when gates transition to pending. The `notifyArchitect()` function in `commands/porch/notify.ts` is fire-and-forget: 10s timeout, errors logged to stderr but never thrown. Called at the two gate-transition points in `next.ts`.

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
| Architect | `af-architect-{port}` | `af-architect-4201` |
| Builder | `builder-{project}-{id}` | `builder-codev-0003` |
| Shell | `shell-{id}` | `shell-U1A2B3C4` |
| Utility | `af-shell-{id}` | `af-shell-U5D6E7F8` |

#### node-pty Terminal Manager (Spec 0085, extended by Spec 0104)

All terminal sessions are managed by the Terminal Manager (`packages/codev/src/terminal/`), which multiplexes PTY sessions over WebSocket. As of Spec 0104, PtySession supports two I/O backends: direct node-pty (non-persistent) and shellper-backed (persistent via `attachShellper()`).

```bash
# REST API for session management
POST /api/terminals              # Create PTY session
GET  /api/terminals              # List sessions
DELETE /api/terminals/:id        # Kill session
POST /api/terminals/:id/resize   # Resize (cols, rows)

# WebSocket connection per terminal
ws://localhost:4200/ws/terminal/<session-id>
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

Agent Farm uses SQLite for ACID-compliant state persistence with two databases:

#### Local State (`.agent-farm/state.db`)

Stores the current session's state with tables for `architect`, `builders`, `utils`, and `annotations`. See `packages/codev/src/agent-farm/db/schema.ts` for the full schema.

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

When spawning a builder (`af spawn 3 --protocol spir`):

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
| **Strict** (default) | `af spawn XXXX --protocol spir` | Porch orchestrates - runs autonomously to completion |
| **Soft** | `af spawn XXXX --protocol spir --soft` | AI follows protocol - architect verifies compliance |

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

When cleaning up a builder (`af cleanup -p 0003`):

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
3. **SQLite (global.db) tracks terminal sessions and workspace metadata**: Shellper metadata (`shellper_socket`, `shellper_pid`, `shellper_start_time`) and workspace associations persist across restarts
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

**Dependency injection pattern**: Each module exports `init*()` and `shutdown*()` lifecycle functions. The orchestrator calls `initTerminals()`, `initInstances()`, and `initTunnel()` at startup (in dependency order), and the corresponding shutdown functions during graceful shutdown. Modules receive only the dependencies they need via typed interfaces (e.g., `TerminalDeps`, `InstanceDeps`, `RouteContext`).

#### Tower API Endpoints (Spec 0090)

**Tower-level APIs (port 4100):**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` | Serve Tower dashboard HTML |
| `GET` | `/health` | Health check (uptime, memory, active projects) |
| `GET` | `/api/workspaces` | List all workspaces with status |
| `GET` | `/api/workspaces/:enc/status` | Get workspace status (terminals, gates) |
| `POST` | `/api/workspaces/:enc/activate` | Activate workspace (creates architect terminal) |
| `POST` | `/api/workspaces/:enc/deactivate` | Deactivate workspace (kills all terminals) |
| `GET` | `/api/status` | Legacy: Get all instances (backward compat) |
| `POST` | `/api/launch` | Legacy: Launch instance (backward compat) |
| `POST` | `/api/stop` | Stop instance by workspacePath |
| `GET` | `/api/browse?path=` | Directory autocomplete for project selection |
| `POST` | `/api/create` | Create new project (codev init + activate) |
| `GET` | `/api/events` | SSE stream for push notifications |
| `POST` | `/api/notify` | Broadcast notification to SSE clients |

**Project-scoped APIs (via Tower proxy):**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/workspace/:enc/` | Serve React dashboard for project |
| `GET` | `/workspace/:enc/api/state` | Get project state (architect, builders, shells) |
| `POST` | `/workspace/:enc/api/tabs/shell` | Create shell terminal for project |
| `DELETE` | `/workspace/:enc/api/tabs/:id` | Close a tab |
| `POST` | `/workspace/:enc/api/stop` | Stop all terminals for project |
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
│   │   ├── BuilderCard.tsx      # Builder card with phase/gate indicators (Spec 0126)
│   │   ├── PRList.tsx           # Pending PR list with review status (Spec 0126)
│   │   ├── BacklogList.tsx      # Backlog grouped by readiness (Spec 0126)
│   │   ├── FileTree.tsx         # File browser
│   │   └── SplitPane.tsx        # Resizable panes
│   ├── hooks/
│   │   ├── useTabs.ts           # Tab state from /api/state polling
│   │   ├── useBuilderStatus.ts  # Builder status polling
│   │   ├── useOverview.ts       # Overview data polling (Spec 0126)
│   │   └── useMediaQuery.ts     # Responsive breakpoints
│   ├── lib/
│   │   ├── api.ts               # REST client + getTerminalWsPath() + overview API
│   │   └── constants.ts         # Breakpoints, configuration
│   └── main.tsx
├── dist/                         # Built assets (served by tower-server)
├── vite.config.ts
└── package.json
```

**Building**: `npm run build` in `packages/codev/` includes `build:dashboard`. Output: ~64KB gzipped.

**Terminal Component** (`Terminal.tsx`):
- xterm.js with `customGlyphs: true` for crisp Unicode block elements
- WebSocket connection to `/ws/terminal/<id>` using hybrid binary protocol
- DA (Device Attribute) response filtering: buffers initial 300ms to catch `ESC[?...c` sequences
- Canvas renderer with dark theme
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
- `+ Shell` button in header for creating shell terminals

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

All services bind to `localhost` only:
- Dashboard server + WebSocket terminals: `127.0.0.1:4200`
- No external network exposure

#### Authentication

**Current approach: None (localhost assumption)**
- Dashboard has no login/password
- Terminal WebSocket endpoints have no authentication
- All processes share the user's permissions

**Justification**: Since all services bind to localhost, only processes running as the same user can connect. External network access is blocked at the binding level.

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

### Key Files Reference

#### CLI Layer

| File | Purpose |
|------|---------|
| `src/agent-farm/cli.ts` | CLI command definitions using commander.js |
| `src/agent-farm/index.ts` | Re-exports for programmatic use |
| `src/agent-farm/types.ts` | TypeScript type definitions |

#### Commands

| File | Purpose |
|------|---------|
| `commands/start.ts` | Start architect dashboard |
| `commands/stop.ts` | Stop all processes |
| `commands/spawn.ts` | Spawn builder (5 modes) |
| `commands/cleanup.ts` | Clean up builder worktree |
| `commands/status.ts` | Show agent status |
| `commands/util.ts` | Spawn utility shell |
| `commands/open.ts` | Open file annotation viewer |
| `commands/send.ts` | Send message to builder |
| `commands/rename.ts` | Rename builder/utility |
| `commands/tower.ts` | Multi-project overview |
| `commands/tunnel.ts` | Secure remote access setup (v1.5.2+) |
| `commands/architect.ts` | Direct CLI access to architect session (v1.5.0+) |
| `commands/db.ts` | Database inspection/management (dump, query, reset, stats) |

#### Database Layer

| File | Purpose |
|------|---------|
| `db/index.ts` | Database initialization and connection management |
| `db/schema.ts` | SQLite schema definitions (local and global) |
| `db/migrate.ts` | JSON to SQLite migration |
| `db/types.ts` | Database row types and converters |
| `db/errors.ts` | Error handling utilities |

#### State Management

| File | Purpose |
|------|---------|
| `state.ts` | High-level state operations |

#### Servers (Spec 0105: Tower Decomposition)

| File | Purpose |
|------|---------|
| `servers/tower-server.ts` | **Orchestrator** -- creates HTTP/WS servers, initializes subsystem modules via DI, handles graceful shutdown (Spec 0090 + 0105) |
| `servers/tower-routes.ts` | All HTTP route handlers (~30 routes), receives `RouteContext` from orchestrator (Spec 0105 Phase 6) |
| `servers/tower-instances.ts` | Project lifecycle: `launchInstance()`, `getInstances()`, `stopInstance()`, known project registration, directory autocomplete (Spec 0105 Phase 3) |
| `servers/tower-terminals.ts` | Terminal session CRUD, file tab persistence, `reconcileTerminalSessions()`, gate watcher, terminal list assembly (Spec 0105 Phase 4) |
| `servers/tower-websocket.ts` | WebSocket upgrade routing and WS-to-PTY frame bridging (Spec 0105 Phase 5) |
| `servers/tower-utils.ts` | Rate limiting, path normalization, MIME types, static file serving, `buildArchitectArgs()` (Spec 0105 Phase 1) |
| `servers/tower-types.ts` | Shared TypeScript interfaces: `TowerContext`, `WorkspaceTerminals`, `SSEClient`, `InstanceStatus`, `DbTerminalSession` (Spec 0105) |
| `servers/tower-tunnel.ts` | Cloud tunnel client lifecycle, config file watching, metadata refresh (Spec 0097 / 0105 Phase 2) |
| `servers/open-server.ts` | File annotation viewer server |

**Note**: As of Spec 0090 Phase 4, `dashboard-server.ts` has been removed. Tower manages everything directly. As of Spec 0105, the monolithic tower-server.ts was decomposed into the focused modules listed above.

#### Utilities

| File | Purpose |
|------|---------|
| `utils/config.ts` | Configuration loading and port initialization |
| `utils/port-registry.ts` | Global port allocation (deleted in Spec 0098) |
| `utils/shell.ts` | Shell command execution, session management |
| `utils/logger.ts` | Formatted console output |
| `utils/deps.ts` | Dependency checking (git, node-pty) |
| `utils/orphan-handler.ts` | Stale session cleanup (removed in Spec 0099) |
| `utils/gate-status.ts` | Reads gate status from porch project status YAML files |
| `utils/file-tabs.ts` | File tab persistence in SQLite (save, delete, load by project) |
| `utils/roles.ts` | Role prompt loading with local-first, bundled-fallback resolution |
| `utils/server-utils.ts` | HTTP utilities: JSON body parsing, request validation (Host/Origin checks) |

#### Terminal Management (Spec 0085, extended by Spec 0104)

| File | Purpose |
|------|---------|
| `terminal/pty-manager.ts` | Terminal session lifecycle (spawn, kill, resize, list) + REST/WS routing. `createSessionRaw()` creates PtySession without spawning (for shellper). `shutdown()` skips shellper-backed sessions. |
| `terminal/pty-session.ts` | Individual PTY wrapper with ring buffer, disk logging, WebSocket broadcast. `attachShellper()` wires IShellperClient as I/O backend. `shellperBacked` flag changes write/resize/kill/detach behavior. |
| `terminal/ring-buffer.ts` | Fixed-size circular buffer (1000 lines) with monotonic sequence numbers |
| `terminal/ws-protocol.ts` | WebSocket frame encoding/decoding (hybrid binary protocol) |
| `terminal/session-manager.ts` | Orchestrates shellper lifecycle: spawn, reconnect, kill, auto-restart, stale socket cleanup (Spec 0104) |
| `terminal/shellper-client.ts` | Tower-side client connecting to a single shellper process via Unix socket (Spec 0104) |
| `terminal/shellper-protocol.ts` | Binary wire protocol encoder/decoder shared by shellper and Tower (Spec 0104) |
| `terminal/shellper-process.ts` | Shellper core logic: PTY management, replay buffer, socket handling (Spec 0104) |
| `terminal/shellper-main.ts` | Standalone shellper entry point spawned by Tower as detached process (Spec 0104) |
| `terminal/shellper-replay-buffer.ts` | Shellper-side 10,000-line replay buffer (standalone, no ring-buffer.ts dependency) (Spec 0104) |

#### Dashboard (React + Vite, Spec 0085)

| File | Purpose |
|------|---------|
| `dashboard/src/components/App.tsx` | Root layout with split pane |
| `dashboard/src/components/Terminal.tsx` | xterm.js + WebSocket client with DA filtering. Accepts `persistent` prop; shows warning banner when `false` (Spec 0104). |
| `dashboard/src/components/TabBar.tsx` | Tab bar with close buttons |
| `dashboard/src/components/WorkView.tsx` | Work view: builders, PRs, backlog (Spec 0126) |
| `dashboard/src/components/BuilderCard.tsx` | Builder card with phase/gate indicators (Spec 0126) |
| `dashboard/src/components/PRList.tsx` | Pending PR list with review status (Spec 0126) |
| `dashboard/src/components/BacklogList.tsx` | Backlog grouped by readiness (Spec 0126) |
| `dashboard/src/hooks/useTabs.ts` | Tab state management from /api/state. Tab interface includes `persistent?: boolean` (Spec 0104). |
| `dashboard/src/hooks/useOverview.ts` | Overview data polling from /api/overview (Spec 0126) |
| `dashboard/src/lib/api.ts` | REST client + getTerminalWsPath() + overview API (Spec 0126). |

#### Templates

| File | Purpose |
|------|---------|
| `templates/annotate.html` | File annotation viewer |
| `templates/open.html` | File viewer with image support (v1.5.0+) |
| `templates/3d-viewer.html` | STL/3MF 3D model viewer (v1.5.0+) |
| `templates/tower.html` | Multi-project overview |

---

## Technology Stack

### Core Technologies
- **TypeScript/Node.js**: Primary language for agent-farm orchestration CLI
- **Shell/Bash**: Thin wrappers and installation scripting
- **Markdown**: Documentation format for specs, plans, reviews, and agent definitions
- **Git**: Version control with worktree support for isolated builder environments
- **YAML**: Configuration format for protocol manifests
- **JSON**: Configuration format for agent-farm (`af-config.json` at project root) and state management

### Agent-Farm CLI (TypeScript)
- **commander.js**: CLI argument parsing and command structure
- **better-sqlite3**: SQLite database for atomic state management (WAL mode)
- **tree-kill**: Process cleanup and termination
- **Shellper processes**: Detached Node.js processes for terminal session persistence (Spec 0104)
- **node-pty**: Native PTY sessions with WebSocket multiplexing (Spec 0085)
- **React 19 + Vite 6**: Dashboard SPA (replaced vanilla JS in Spec 0085)
- **xterm.js**: Terminal emulator in the browser (with `customGlyphs: true` for Unicode)

### Testing Framework
- **bats-core**: Bash Automated Testing System (vendored in `tests/lib/`)
- **bats-support**: Helper functions for bats tests
- **bats-assert**: Assertion helpers for test validation
- **bats-file**: File system assertion helpers
- **Vitest**: TypeScript unit testing for packages/codev

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

## Repository Dual Nature

This repository has a unique dual structure:

### 1. `codev/` - Our Instance (Self-Hosted Development)
This is where the Codev project uses Codev to develop itself:
- **Purpose**: Development of Codev features using Codev methodology
- **Contains**:
  - `specs/` - Feature specifications for Codev itself
  - `plans/` - Implementation plans for Codev features
  - `reviews/` - Lessons learned from Codev development
  - `resources/` - Reference materials (this file, llms.txt, etc.)
  - `protocols/` - Working copies of protocols for development
  - `agents/` - Agent definitions (canonical location)
  - `roles/` - Role definitions for architect-builder pattern
  - `templates/` - HTML templates for Agent Farm (`af`) dashboard and annotation viewer
  - Note: Shell command configuration is in `af-config.json` at the project root

**Example**: `codev/specs/0001-test-infrastructure.md` documents the test infrastructure feature we built for Codev.

### 2. `codev-skeleton/` - Template for Other Projects
This is what gets distributed to users when they install Codev:
- **Purpose**: Clean template for new Codev installations
- **Contains**:
  - `protocols/` - Protocol definitions (SPIR, TICK, EXPERIMENT, MAINTAIN)
  - `specs/` - Empty directory (users create their own)
  - `plans/` - Empty directory (users create their own)
  - `reviews/` - Empty directory (users create their own)
  - `resources/` - Empty directory (users add their own)
  - `agents/` - Agent definitions (copied during installation)
  - `roles/` - Role definitions for architect and builder
  - `templates/` - HTML templates for Agent Farm (`af`) dashboard UI
  - Note: Shell command configuration is in `af-config.json` at the project root

**Key Distinction**: `codev-skeleton/` provides templates for other projects to use when they install Codev. Our own `codev/` directory has nearly identical structure but contains our actual specs, plans, and reviews. The skeleton's empty placeholder directories become populated with real content in each project that adopts Codev.

### 3. `packages/codev/` - The npm Package
This is the `@cluesmith/codev` npm package containing all CLI tools:
- **Purpose**: Published npm package with codev, af, and consult CLIs
- **Contains**:
  - `src/` - TypeScript source code
  - `src/agent-farm/` - Agent Farm orchestration (af command)
  - `src/commands/` - codev subcommands (init, adopt, doctor, update, eject, tower)
  - `src/commands/consult/` - Multi-agent consultation (consult command)
  - `bin/` - CLI entry points (codev.js, af.js, consult.js)
  - `skeleton/` - Embedded copy of codev-skeleton (built during `npm run build`)
  - `templates/` - HTML templates for Agent Farm (`af`) dashboard and annotator
  - `dist/` - Compiled JavaScript

**Key Distinction**: packages/codev is the published npm package; codev-skeleton/ is the template embedded within it.

**Note on skeleton/**: During `npm run build`, the codev-skeleton/ directory is copied into packages/codev/skeleton/. This embedded skeleton is what gets installed when users run `codev init`. Local files in a user's codev/ directory take precedence over the embedded skeleton.

## Complete Directory Structure

```
codev/                                  # Project root (git repository)
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
│   │   ├── agent-farm/                 # af subcommands
│   │   │   ├── cli.ts                  # af CLI entry point
│   │   │   ├── index.ts                # Core orchestration
│   │   │   ├── state.ts                # SQLite state management
│   │   │   ├── types.ts                # Type definitions
│   │   │   ├── commands/               # af CLI commands
│   │   │   │   ├── start.ts            # Start architect dashboard
│   │   │   │   ├── stop.ts             # Stop all processes
│   │   │   │   ├── spawn.ts            # Spawn builder
│   │   │   │   ├── status.ts           # Show status
│   │   │   │   ├── cleanup.ts          # Clean up builder
│   │   │   │   ├── util.ts             # Utility shell
│   │   │   │   ├── open.ts             # File annotation viewer
│   │   │   │   ├── send.ts             # Send message to builder
│   │   │   │   └── rename.ts           # Rename builder/util
│   │   │   ├── servers/                # Web servers (Spec 0105 decomposition)
│   │   │   │   ├── tower-server.ts     # Orchestrator: HTTP/WS server creation, subsystem init, shutdown
│   │   │   │   ├── tower-routes.ts     # HTTP route handlers (~30 routes)
│   │   │   │   ├── tower-instances.ts  # Project lifecycle (launch, getInstances, stop)
│   │   │   │   ├── tower-terminals.ts  # Terminal session CRUD, reconciliation, gate watcher
│   │   │   │   ├── tower-websocket.ts  # WebSocket upgrade routing, WS↔PTY frame bridging
│   │   │   │   ├── tower-utils.ts      # Rate limiting, path utils, MIME types, buildArchitectArgs()
│   │   │   │   ├── tower-types.ts      # Shared TypeScript interfaces
│   │   │   │   ├── tower-tunnel.ts     # Cloud tunnel client lifecycle
│   │   │   │   └── open-server.ts      # File annotation viewer
│   │   │   ├── db/                     # SQLite database layer
│   │   │   │   ├── index.ts            # Database operations
│   │   │   │   ├── schema.ts           # Table definitions
│   │   │   │   └── migrate.ts          # JSON → SQLite migration
│   │   │   └── __tests__/              # Vitest unit tests
│   │   └── lib/                        # Shared library code
│   │       └── templates.ts            # Template file handling
│   ├── bin/                            # CLI entry points
│   │   ├── codev.js                    # codev command
│   │   ├── af.js                       # af command
│   │   └── consult.js                  # consult command
│   ├── skeleton/                       # Embedded codev-skeleton (built)
│   ├── templates/                      # HTML templates
│   │   ├── dashboard.html              # Split-pane dashboard
│   │   └── annotate.html               # File annotation viewer
│   ├── dist/                           # Compiled JavaScript
│   ├── package.json                    # npm package config
│   └── tsconfig.json                   # TypeScript configuration
├── af-config.json                      # Shell command configuration (project root)
├── codev/                              # Our self-hosted instance
│   ├── roles/                          # Role definitions
│   │   ├── architect.md                # Architect role and commands
│   │   └── builder.md                  # Builder role and status lifecycle
│   ├── templates/                      # Document templates
│   │   └── pr-overview.md              # PR description template
│   ├── protocols/                      # Working copies for development
│   │   ├── spir/                       # Multi-phase with consultation
│   │   │   ├── protocol.md
│   │   │   ├── templates/
│   │   │   └── manifest.yaml
│   │   ├── tick/                       # Fast autonomous protocol
│   │   ├── experiment/                 # Disciplined experimentation
│   │   └── maintain/                   # Codebase maintenance
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
│   │   ├── tick/
│   │   ├── experiment/
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

#### TICK Protocol (`codev/protocols/tick/`)
**Purpose**: **T**ask **I**dentification, **C**oding, **K**ickout - Fast autonomous implementation

**Workflow**:
1. **Specification** (autonomous) - Define task
2. **Planning** (autonomous) - Create single-phase plan
3. **Implementation** (autonomous) - Execute plan
4. **Review** (with multi-agent consultation) - Document and validate

**Key Features**:
- Single autonomous execution from spec to implementation
- Multi-agent consultation ONLY at review phase
- Two user checkpoints: start and end
- Suitable for simple tasks (<300 lines)
- Architecture documentation updated automatically at review

**Selection Criteria**:
- Use TICK for: Simple features, utilities, configuration, amendments to existing specs
- Use SPIR for: Complex features, architecture changes, unclear requirements
- Use BUGFIX for: Minor bugs reported as GitHub Issues (< 300 LOC)

#### BUGFIX Protocol (`codev/protocols/bugfix/`)
**Purpose**: Lightweight protocol for minor bugfixes using GitHub Issues

**Workflow**:
1. **Identify** - Architect identifies issue #N
2. **Spawn** - `af spawn N --protocol bugfix` creates worktree and notifies issue
3. **Fix** - Builder investigates, fixes, writes regression test
4. **Review** - Builder runs CMAP, creates PR
5. **Merge** - Architect reviews, builder merges
6. **Cleanup** - `af cleanup --issue N` removes worktree

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

**Location**: `agent-farm/`

**Purpose**: TypeScript-based multi-agent orchestration for the architect-builder pattern

**Architecture**:
- **Single canonical implementation** - All bash scripts deleted, TypeScript is the source of truth
- **Thin wrapper invocation** - `af` command from npm package (installed globally)
- **Project-scoped state** - `.agent-farm/state.db` (SQLite) tracks current session
- **Global port registry** - `~/.agent-farm/global.db` (SQLite) prevents cross-project port conflicts

#### CLI Commands

```bash
# af command is installed globally via: npm install -g @cluesmith/codev

# Starting/stopping
af dash start                 # Start architect dashboard
af dash stop                  # Stop all agent-farm processes

# Managing builders
af spawn 3 --protocol spir              # Spawn builder (strict mode, default)
af spawn 3 --protocol spir --soft       # Soft mode - AI follows protocol, you verify compliance
af spawn 42 --protocol bugfix           # Spawn builder for GitHub issue (BUGFIX protocol)
af spawn 42 --protocol tick --amends 30 # TICK amendment to spec 30
af status                     # Check all agent status
af cleanup --project 0003     # Clean up builder (checks for uncommitted work)
af cleanup -p 0003 --force    # Force cleanup (lose uncommitted work)
af cleanup --issue 42         # Clean up bugfix builder and remote branch

# Utilities
af util                       # Open a utility shell terminal
af shell                      # Alias for util
af open src/file.ts           # Open file annotation viewer

# Communication
af send 0003 "Check the tests"        # Send message to builder 0003
af send --all "Stop and report"       # Broadcast to all builders
af send architect "Need help"         # Builder sends to architect (from worktree)
af send 0003 "msg" --file diff.txt    # Include file content
af send 0003 "msg" --interrupt        # Send Ctrl+C first
af send 0003 "msg" --raw              # Skip structured formatting

# Direct CLI access (v1.5.0+)
af architect                  # Start/attach to architect session
af architect "initial prompt" # With initial prompt

# Remote access (v1.5.2+)
af tunnel                     # Show SSH command for remote access
af dash start --remote user@host  # Start on remote machine with tunnel

# Port management (multi-project support)
af ports list                 # List workspace registrations (historical; port blocks removed in Spec 0098)
af ports cleanup              # Remove stale allocations

# Database inspection
af db dump                    # Dump state database
af db query "SQL"             # Run SQL query
af db reset                   # Reset state database
af db stats                   # Show database statistics

# Command overrides
af dash start --architect-cmd "claude --model opus"
af spawn 3 --protocol spir --builder-cmd "claude --model sonnet"
```

#### Configuration (`af-config.json`)

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

**Configuration Hierarchy**: CLI args > af-config.json > Defaults

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
- Full `af` command reference

**builder.md** - Builder role with status lifecycle:
- Status definitions: spawning, implementing, blocked, pr, complete
- Working in isolated git worktrees
- When and how to report blocked status
- Deliverables and constraints

#### Global CLI Commands

The `af`, `consult`, and `codev` commands are installed globally via `npm install -g @cluesmith/codev` and work from any directory. No aliases or local scripts needed.

### 4. Test Infrastructure

**Location**: `tests/`

**Framework**: bats-core (Bash Automated Testing System)

**Architecture**:
- **Zero external dependencies** - All frameworks vendored locally
- **Platform portable** - Works on macOS and Linux without changes
- **XDG sandboxing** - Tests never touch real user directories
- **Graceful degradation** - Skips tests when dependencies unavailable

#### Test Organization

**Framework Tests (00-09)**:
- Core framework validation
- Runner behavior verification
- Helper function tests

**Protocol Tests (10-19)**:
- SPIR protocol installation
- CLAUDE.md preservation and updates
- Directory structure validation
- Protocol content verification

**Integration Tests (20+)**:
- Claude CLI execution with isolation flags
- Real agent invocation tests
- Codev updater validation

**Total Coverage**: 64 tests, ~2000 lines of test code

#### Test Helpers (`tests/helpers/`)

##### common.bash
**Purpose**: Shared test utilities and assertions

**Key Functions**:
- `setup_test_project()` - Creates isolated temporary test directory
- `teardown_test_project()` - Cleans up test artifacts (guaranteed via trap)
- `install_from_local()` - Installs Codev from local skeleton
- `create_claude_md()` - Creates CLAUDE.md with specified content
- `assert_codev_structure()` - Validates directory structure
- `assert_spir_protocol()` - Validates SPIR protocol files
- `file_contains()` - Checks file for literal string match

**Agent Installation Logic**:
```bash
# Mimics INSTALL.md conditional agent installation
# This test helper replicates production behavior
if command -v claude &> /dev/null; then
    # Claude Code present - install agents to .claude/agents/
    mkdir -p "$target_dir/.claude/agents"
    cp "$source_dir/agents/"*.md "$target_dir/.claude/agents/" 2>/dev/null || true
fi
# Note: For non-Claude Code environments, agents remain in codev/agents/
# from the skeleton copy (universal location for AGENTS.md-compatible tools)
```

**Implementation Details**:
- Detects Claude Code via `command -v claude` check
- Installs agents conditionally based on detection result
- Handles both Claude Code and non-Claude Code environments gracefully
- Never overwrites existing agent files (2>/dev/null || true pattern)

##### mock_mcp.bash
**Purpose**: Test isolation utilities for PATH manipulation

**Key Functions**:
- `mock_mcp_present()` - Simulates MCP command availability
- `mock_mcp_absent()` - Simulates MCP command unavailability
- `remove_mcp_from_path()` - Removes MCP from PATH
- `restore_path()` - Restores original PATH

**Strategy**: Uses failing shims instead of PATH removal for realistic testing

#### Test Execution

**Fast Tests** (excludes integration):
```bash
./scripts/run-tests.sh
```
- Runs in <30 seconds
- No Claude CLI required
- Core functionality validation

**All Tests** (includes integration):
```bash
./scripts/run-all-tests.sh
```
- Includes Claude CLI tests
- Requires `claude` command
- Full end-to-end validation

#### Test Isolation Strategy

**XDG Sandboxing** (prevents touching real user config):
```bash
export XDG_CONFIG_HOME="$TEST_PROJECT/.xdg"
export XDG_DATA_HOME="$TEST_PROJECT/.local/share"
export XDG_CACHE_HOME="$TEST_PROJECT/.cache"
```

**Claude CLI Isolation**:
```bash
claude --strict-mcp-config --mcp-config '[]' --settings '{}'
```
- `--strict-mcp-config` - Enforces strict MCP configuration
- `--mcp-config '[]'` - No MCP servers
- `--settings '{}'` - No user preferences

**Temporary Directories**:
- Each test gets isolated `mktemp -d` directory
- Cleanup guaranteed via `teardown()` trap
- No persistence between tests

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

## Data Flow

### Specification → Plan → Implementation → Review

**Document Flow**:
1. **Specification** (`codev/specs/####-feature.md`)
   - Defines WHAT to build
   - Created by developer or AI agent
   - Multi-agent reviewed (SPIR with consultation)
   - Committed before planning

2. **Plan** (`codev/plans/####-feature.md`)
   - Defines HOW to build
   - Breaks specification into phases (SPIR) or single phase (TICK)
   - Lists files to create/modify
   - Multi-agent reviewed (SPIR with consultation)
   - Committed before implementation

3. **Implementation** (actual code in project)
   - Follows plan phases
   - Each phase: Implement → Defend (tests) → Evaluate
   - Committed per phase (SPIR) or single commit (TICK)
   - Multi-agent consultation at checkpoints (SPIR) or review only (TICK)

4. **Review** (`codev/reviews/####-feature.md`)
   - Documents lessons learned
   - Identifies systematic issues
   - Updates protocol if needed
   - Multi-agent reviewed (both SPIR and TICK)
   - Triggers architecture documentation update (TICK)
   - Final commit in feature workflow

**File Naming Convention**:
```
codev/specs/####-descriptive-name.md
codev/plans/####-descriptive-name.md
codev/reviews/####-descriptive-name.md
```
- Sequential numbering shared across all protocols
- Same identifier for spec, plan, review

## Git Commit Strategy

See [CLAUDE.md](../../CLAUDE.md#git-workflow) for commit message formats and Git safety rules.

## Development Infrastructure

### Pre-Commit Hooks

**Location**: `hooks/pre-commit`

**Purpose**: Automated quality assurance through test execution before commits

**Installation**:
```bash
./scripts/install-hooks.sh
```

**Behavior**:
- Runs fast test suite (via `./scripts/run-tests.sh`) before allowing commits
- Exits with error if any tests fail
- Provides clear feedback on test status
- Can be bypassed with `git commit --no-verify` (not recommended)

**Design Rationale**:
1. **Catch regressions early** - Find issues before they reach the repository
2. **Maintain quality** - Ensure all commits pass the test suite
3. **Fast feedback** - Uses fast tests (not integration tests) for quick iteration
4. **Optional but recommended** - Manual installation respects developer choice

**Installation Script** (`scripts/install-hooks.sh`):
- Copies `hooks/pre-commit` to `.git/hooks/pre-commit`
- Makes hook executable
- Provides clear feedback on installation success
- Safe to run multiple times (idempotent)

### Test-Driven Development

Codev itself follows test-driven development practices:
- **64 comprehensive tests** covering all functionality
- **Fast test suite** (<30 seconds) for rapid iteration
- **Integration tests** for end-to-end validation
- **Platform compatibility** testing (macOS and Linux)
- **Pre-commit hooks** for continuous quality assurance

**Test Organization Philosophy**:
- Framework tests (00-09) validate core infrastructure
- Protocol tests (10-19) verify installation and configuration
- Integration tests (20+) validate real-world usage
- All tests hermetic and isolated (XDG sandboxing)

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

### 3. Dual Repository Structure
**Decision**: Separate `codev/` (our work) from `codev-skeleton/` (template)

**Rationale**:
- Clear separation of concerns
- Users get clean template without our development artifacts
- We can evolve protocols while using them
- No risk of user specs polluting template

### 4. Vendored Test Dependencies
**Decision**: Include bats-core and helpers directly in repository

**Rationale**:
- Zero installation dependencies for contributors
- Consistent test environment across systems
- No dependency on external package managers
- Version control ensures stability

### 5. XDG Sandboxing for Tests
**Decision**: All tests use XDG environment variables to isolate configuration

**Rationale**:
- Prevents accidental modification of user directories
- Tests are hermetic and reproducible
- No side effects on host system
- Safety-first testing approach

### 6. Shell-Based Testing
**Decision**: Use bash/bats instead of Python/pytest

**Rationale**:
- Tests the actual shell commands from INSTALL.md
- No language dependencies beyond bash
- Directly validates installation instructions
- Simple for shell-savvy developers to understand

### 7. Tool-Agnostic Agent Installation
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

### 8. AGENTS.md Standard + CLAUDE.md Synchronization
**Decision**: Maintain both AGENTS.md (universal) and CLAUDE.md (Claude Code-specific) with identical content

**Rationale**:
- AGENTS.md follows [AGENTS.md standard](https://agents.md/) for cross-tool compatibility
- CLAUDE.md provides native Claude Code support
- Identical content ensures consistent behavior across tools
- Users of any AI coding assistant get appropriate file format

### 9. Multi-Agent Consultation by Default
**Decision**: SPIR and TICK default to consulting GPT-5 and Gemini 3 Pro

**Rationale**:
- Multiple perspectives catch issues single agent misses
- Prevents blind spots and confirmation bias
- Improves code quality and completeness
- User must explicitly disable (opt-out, not opt-in)

#### Consult Architecture

The `consult` command (`packages/codev/src/commands/consult/index.ts`, ~750 lines) is a **CLI delegation layer** — it does NOT call LLM APIs directly. Instead, it spawns external CLI tools as subprocesses:

```
consult -m gemini spec 42
  → spawns: gemini --yolo "<role + query>"

consult -m codex spec 42
  → spawns: codex exec -c experimental_instructions_file=<tmpfile> --full-auto "<query>"

consult -m claude spec 42
  → spawns: claude --print -p "<role + query>" --dangerously-skip-permissions
```

**Model configuration** (top of `index.ts`):

| Model | CLI Binary | Role Injection | Key Env Var |
|-------|-----------|----------------|-------------|
| gemini | `gemini` | Temp file via `GEMINI_SYSTEM_MD` env var | `GOOGLE_API_KEY` |
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

### 10. TICK Protocol for Fast Iteration
**Decision**: Create lightweight protocol for simple tasks

**Rationale**:
- SPIR is excellent but heavy for simple tasks
- Fast iteration needed for bug fixes and utilities
- Single autonomous execution reduces overhead
- Multi-agent review at end maintains quality
- Fills gap between informal changes and full SPIR

### 11. Pre-Commit Hooks for Quality Assurance
**Decision**: Provide optional pre-commit hooks that run test suite

**Rationale**:
- **Early detection** - Catch regressions before they reach repository
- **Continuous quality** - Ensure all commits pass tests
- **Fast feedback** - Use fast tests (not integration) for quick iteration
- **Developer choice** - Manual installation respects autonomy
- **Escape hatch** - Can bypass with --no-verify when needed
- **Self-hosting validation** - Codev validates itself before commits

**Implementation**:
- Hooks stored in `hooks/` directory (not `.git/hooks/` - not tracked)
- Installation script (`scripts/install-hooks.sh`) copies to `.git/hooks/`
- Runs `./scripts/run-tests.sh` (fast tests, ~30 seconds)
- Clear feedback on pass/fail
- Instructions for bypassing when necessary

### 12. Single Canonical Implementation (TypeScript agent-farm)
**Decision**: Delete all bash architect scripts; TypeScript agent-farm is the single source of truth

**Rationale**:
- **Eliminate brittleness** - Triple implementation (bash + duplicate bash + TypeScript) caused divergent behavior
- **Single maintenance point** - Bug fixes only needed once
- **Type safety** - TypeScript catches errors at compile time
- **Rich features** - Easier to implement complex features (port registry, state locking)
- **Thin wrapper pattern** - Bash wrappers just call `node agent-farm/dist/index.js`

**What was deleted**:
- `codev/bin/architect` (713-line bash script)
- `codev-skeleton/bin/architect` (duplicate)
- `agent-farm/templates/` (now uses codev/templates/)
- `codev/builders.md` (legacy state file)

### 13. Global Registry for Multi-Workspace Support
**Decision**: Use `~/.agent-farm/global.db` (SQLite) for cross-workspace coordination

**Rationale**:
- **Cross-workspace coordination** - Multiple repos tracked simultaneously
- **Terminal session persistence** - Session metadata survives Tower restarts
- **File locking** - Prevents race conditions during concurrent operations
- **Stale cleanup** - Automatically removes entries for deleted workspaces

> **Historical note** (Spec 0008, Spec 0098): Originally allocated deterministic 100-port blocks per repository. After the Tower Single Daemon architecture (Spec 0090), per-workspace port blocks became unnecessary and were removed in Spec 0098. The global registry now tracks workspace metadata and terminal sessions instead.

### 14. af-config.json for Shell Command Customization
**Decision**: Replace bash wrapper customization with JSON configuration file at project root

**Rationale**:
- **Declarative configuration** - Easy to understand and modify
- **Array-form commands** - Avoids shell escaping issues
- **Environment variable expansion** - `${VAR}` syntax for secrets
- **Configuration hierarchy** - CLI args > af-config.json > defaults
- **Early validation** - Fail fast if commands or directories invalid

### 15. Clean Slate with Safety Checks
**Decision**: When consolidating, nuke old state but protect uncommitted work

**Rationale**:
- **No migration complexity** - Delete old artifacts rather than migrating
- **Dirty worktree protection** - Refuse to delete worktrees with uncommitted changes
- **Force flag requirement** - `--force` required to override safety checks
- **Orphaned session handling** - Detect and handle stale shellper sockets on startup

## Integration Points

### External Services
- **GitHub**: Repository hosting, version control
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
2. Config file (`af-config.json`)
3. Embedded defaults in code

**Config file location**: `af-config.json` (project root, project-level)

### State Persistence

**Pattern**: SQLite for all structured state.

- `.agent-farm/state.db` - Builder/util state (local, per-project)
- `~/.agent-farm/global.db` - Global port registry (cross-project)
- `codev/projects/<id>/status.yaml` - Active project state (managed by porch)
- GitHub Issues - Project tracking (source of truth, Spec 0126)

### Template Processing

**Pattern**: Double-brace placeholder replacement.

- `{{PROJECT_NAME}}` - Replaced with project name during init/adopt
- Simple string replacement, no complex templating engine
- Applied to CLAUDE.md, AGENTS.md, and similar files

## Development Patterns

### 1. Protocol-Driven Development
Every feature follows a protocol (SPIR, TICK, EXPERIMENT, or MAINTAIN):
- Start with specification (WHAT)
- Create plan (HOW)
- Implement in phases or single execution
- Document lessons learned

### 2. Multi-Agent Consultation
Default consultation pattern:
```
1. Agent performs work
2. STOP - consult GPT-5 and Gemini Pro
3. Apply feedback
4. Get FINAL approval from experts
5. THEN present to user
```

### 3. Fail-Fast & Git Safety
See [CLAUDE.md](../../CLAUDE.md) for fail-fast principle and explicit file staging rules.

### 4. Document Naming Convention
```
####-descriptive-name.md
```
- Four-digit sequential number
- Kebab-case descriptive name
- Shared across spec, plan, review
- Numbers never reused

## File Naming Conventions

See [CLAUDE.md](../../CLAUDE.md#file-naming-convention) for naming patterns. Key paths:
- Specs: `codev/specs/####-feature-name.md`
- Plans: `codev/plans/####-feature-name.md`
- Reviews: `codev/reviews/####-feature-name.md`

## Utility Functions & Helpers

### Test Helpers (`tests/helpers/common.bash`)

#### setup_test_project()
**Purpose**: Create isolated temporary test directory

**Returns**: Path to test directory

**Usage**:
```bash
TEST_PROJECT=$(setup_test_project)
```

#### teardown_test_project(directory)
**Purpose**: Clean up test artifacts

**Parameters**:
- `directory` - Path to test directory

**Usage**:
```bash
teardown_test_project "$TEST_PROJECT"
```

#### install_from_local(target_dir)
**Purpose**: Install Codev from local skeleton with conditional agent installation

**Parameters**:
- `target_dir` - Installation target directory

**Returns**: 0 on success, 1 on failure

**Behavior**:
- Copies `codev-skeleton/` to `target_dir/codev/`
- Conditionally installs agents based on Claude Code detection
- Verifies installation success

**Usage**:
```bash
install_from_local "$TEST_PROJECT"
```

#### create_claude_md(directory, content)
**Purpose**: Create CLAUDE.md with specified content

**Parameters**:
- `directory` - Target directory
- `content` - CLAUDE.md content

**Usage**:
```bash
create_claude_md "$TEST_PROJECT" "# My Project\n\nInstructions..."
```

#### assert_codev_structure(directory)
**Purpose**: Validate Codev directory structure exists

**Parameters**:
- `directory` - Directory to check

**Usage**:
```bash
assert_codev_structure "$TEST_PROJECT"
```

#### file_contains(file, text)
**Purpose**: Check if file contains literal string

**Parameters**:
- `file` - File path
- `text` - Text to search for (literal match)

**Returns**: 0 if found, 1 if not found

**Usage**:
```bash
file_contains "$TEST_PROJECT/CLAUDE.md" "Codev Methodology"
```

### Test Helpers (`tests/helpers/mock_mcp.bash`)

#### mock_mcp_present()
**Purpose**: Simulate MCP command availability (for test isolation)

**Usage**:
```bash
mock_mcp_present
```

#### mock_mcp_absent()
**Purpose**: Simulate MCP command unavailability (for test isolation)

**Usage**:
```bash
mock_mcp_absent
```

## Cross-Tool Compatibility

### AGENTS.md Standard
Codev supports the [AGENTS.md standard](https://agents.md/) for universal AI coding assistant compatibility:

**Supported Tools**:
- Claude Code (via CLAUDE.md)
- Cursor (via AGENTS.md)
- GitHub Copilot (via AGENTS.md)
- Continue.dev (via AGENTS.md)
- Other AGENTS.md-compatible tools

**File Synchronization**:
- Both `AGENTS.md` and `CLAUDE.md` maintained
- Identical content in both files
- AGENTS.md is canonical for non-Claude Code tools
- CLAUDE.md provides native Claude Code support

### Agent Location Strategy
**Detection and Installation**:
```bash
if command -v claude &> /dev/null; then
    # Claude Code: Install to .claude/agents/
    AGENT_DIR=".claude/agents"
else
    # Other tools: Use codev/agents/
    AGENT_DIR="codev/agents"
fi
```

**Benefits**:
- Tool-agnostic architecture
- Native integration where available
- Fallback to universal location
- No tool lock-in

## Platform Compatibility

### macOS Specific
- Uses BSD `stat` command: `stat -f "%Lp"`
- gtimeout from coreutils for timeout support
- Default mktemp behavior compatible

### Linux Specific
- Uses GNU `stat` command: `stat -c "%a"`
- Native `timeout` command available
- Standard mktemp available

### Portable Patterns
```bash
# Platform-agnostic permission checking
if [[ "$OSTYPE" == "darwin"* ]]; then
  perms=$(stat -f "%Lp" "$file")
else
  perms=$(stat -c "%a" "$file")
fi

# Timeout command detection
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
fi
```

## Security Considerations

### Test Isolation
- XDG sandboxing prevents touching real user directories
- Temporary directories isolated per test
- No persistent state between tests
- Cleanup guaranteed via teardown traps

### Git Commit Safety
- Explicit file staging required (no `git add -A` or `git add .`)
- Prevents accidental commit of sensitive files
- Clear file-by-file staging

### Claude CLI Isolation
- `--strict-mcp-config` prevents MCP server loading
- `--mcp-config '[]'` ensures no external servers
- `--settings '{}'` prevents user settings leakage
- API keys explicitly unset during testing

### Codev Updater Safety
- Always creates backups before updating
- Never modifies user specs, plans, or reviews
- Provides rollback instructions
- Verifies successful update before completing

## Performance Characteristics

### Test Suite
- **Fast Tests**: <30 seconds (no Claude CLI)
- **All Tests**: ~2-5 minutes (with Claude CLI integration)
- **Total Tests**: 64 tests, ~2000 lines
- **Coverage**: Framework validation, protocol installation, agent testing, updater validation
- **Parallelization**: Tests are independent and can run in parallel
- **Execution Speed**: Average ~0.5 seconds per test (fast suite)

### Protocol Execution Times
- **TICK**: ~4 minutes for simple tasks
- **SPIR** (without consultation): ~15-30 minutes depending on complexity
- **SPIR** (with consultation): ~30-60 minutes depending on complexity

### Installation
- **Network**: Not required (uses local skeleton)
- **Time**: <1 minute for basic installation
- **Space**: ~500KB for protocols and templates

## Troubleshooting

See the [Quick Tracing Guide](#quick-tracing-guide) for debugging entry points.

Additional issues:
- **Tests hanging**: Install `coreutils` on macOS (`brew install coreutils`)
- **Permission errors**: `chmod -R u+w /tmp/codev-test.*`
- **Agent not found**: Claude Code uses `.claude/agents/`, other tools use `codev/agents/`

## Maintenance

See [MAINTAIN protocol](../protocols/maintain/protocol.md) for codebase hygiene and documentation sync procedures.

## Contributing

See [README.md](../../README.md) for contribution guidelines.

## Success Metrics

A well-maintained Codev architecture should enable:
- **Quick Understanding**: New developers understand structure in <15 minutes
- **Fast Location**: Find relevant files in <2 minutes
- **Easy Extension**: Add new protocols or agents in <1 hour
- **Reliable Testing**: Tests pass consistently on all platforms
- **Safe Updates**: Framework updates never break user work

## Historical Architecture Evolution

This section captures architectural decisions and patterns from the full history of Codev development, organized chronologically by spec range. Content is extracted from review documents with `(Spec XXXX)` attribution.

### Early Foundations (Specs 0001-0012)

#### Architect-Builder Pattern Origins (Spec 0002)

> **Note**: Core architecture, worktree isolation, and builder modes are documented in the [Agent Farm Internals](#agent-farm-internals) and [Worktree Management](#worktree-management) sections above. This entry captures historical context not covered there.

- **Web terminals via ttyd** (Spec 0002): Initially, ttyd served web-based terminals for each builder on dynamically assigned ports. Each builder terminal was embedded as an iframe in the dashboard. This was later replaced by a tmux-based approach for session persistence, and ultimately by node-pty + Shellper (Spec 0085, Spec 0104).

- **Inline REVIEW comments** (Spec 0002): Code review uses inline comments with a `REVIEW:` prefix in the appropriate comment syntax for each file type (e.g., `// REVIEW: comment` for JS/TS, `# REVIEW: comment` for Python, `<!-- REVIEW: comment -->` for Markdown). Comments are attributed with `@username` and cleaned up before merging.

- **Protocol-agnostic spawn system** (Spec 0002, TICK-002): The `af spawn` command separates three orthogonal concerns: input type (spec, issue, task, protocol), mode (strict/porch vs. soft/AI-follows-protocol.md), and protocol (SPIR, BUGFIX, TICK, MAINTAIN). Each protocol defines its requirements in `protocol.json` with input specifications, pre-spawn hooks (collision checks, issue comments), and mode defaults. Protocol-specific prompt templates live in `protocols/{name}/builder-prompt.md`.

#### Architecture Consolidation (Spec 0005, Spec 0008)

> **Note**: The current TypeScript CLI, configuration system, and port registry are documented in [Agent Farm Internals](#agent-farm-internals) and [Key Design Decisions](#key-design-decisions) above. This entry captures migration history.

- **TypeScript migration** (Spec 0005): The CLI was migrated from a 650+ line bash script to TypeScript using Commander.js. State was initially persisted as JSON at `.agent-farm/state.json` (later migrated to SQLite in Spec 0031).

- **Elimination of triple implementation** (Spec 0008): The project originally had the same functionality in three places: a 713-line bash script (`codev/bin/architect`), a duplicate in `codev-skeleton/bin/architect`, and the TypeScript `agent-farm/`. The consolidation deleted both bash scripts and duplicate templates.

- **Template resolution** (Spec 0008): Agent Farm resolves templates at runtime from `codev/templates/` (configurable via `af-config.json`). The dual-directory structure is preserved: `codev/` for this project's instance, `codev-skeleton/` for the distribution template.

#### Terminal File Click (Spec 0009)

- **File path clicking in terminals** (Spec 0009): Initial approach using custom xterm.js with `registerLinkProvider` failed due to xterm.js v5 ES module system incompatibility with script tags. The working solution uses ttyd's built-in HTTP link handling: tools output `http://localhost:<port>/open-file?path=<file>` URLs which ttyd makes clickable natively. The dashboard's `/open-file` route spawns a BroadcastChannel message to open an annotation tab.

- **Annotation server readiness** (Spec 0009): A `waitForPortReady()` function in `dashboard-server.ts` waits up to 5 seconds for the annotation server to be accepting connections before returning from the `/api/tabs/file` endpoint, preventing the "refresh needed" issue where iframes loaded before servers were ready.

#### Annotation Editor (Spec 0010)

- **Edit/Annotate toggle** (Spec 0010): The annotation viewer supports a mode toggle between read-only annotate mode (syntax highlighted with Prism.js) and edit mode (full-file textarea). Switching back to annotate mode auto-saves via the existing `/save` endpoint. Cmd/Ctrl+S saves while in edit mode.

#### Multi-Instance Support (Spec 0011)

- **Project-aware dashboard titles** (Spec 0011): Dashboard titles include the project directory name (`Agent Farm - <projectName>`) in both browser tab and page header, derived from `path.basename(projectRoot)` with HTML escaping.

#### tmux Session Configuration (Spec 0012)

- **tmux status bar hidden** (Spec 0012): All agent-farm tmux sessions have `status off` set immediately after creation via `tmux set-option -t "<sessionName>" status off`. This is per-session (not global), so user's other tmux sessions are unaffected. The dashboard provides equivalent navigation, making the tmux status bar redundant.

### Infrastructure Maturation (Specs 0013-0031)

#### OS Dependencies & Environment Verification (Spec 0013)

The `codev doctor` command (Spec 0013) provides full environment verification as a standalone shell script that works even without Node.js installed. It checks:
- **Core dependencies**: Node.js (>=18), tmux (>=3.0), git (>=2.5), Python (>=3.10)
- **AI CLI dependencies** (at least one required): Claude Code, Gemini CLI, Codex CLI
- Outputs a summary table with status indicators and exit code reflecting overall health

The `af start` command performs a subset of these checks at startup (core deps only), while `codev doctor` covers the full environment including AI CLIs and Python packages. (Spec 0013)

#### Flexible Builder Spawning (Spec 0014)

> **Note**: Current builder types and modes are documented in [Builder Types](#builder-types) above. This entry captures design rationale.

Key design choices (Spec 0014):
- **Explicit flags only** -- no positional arguments for mode selection. `--files` requires `--task`.
- **4-char alphanumeric IDs** for collision-safe, filesystem-safe Builder identification.
- **Unified `BuilderConfig` internally** -- CLI uses mode-based parsing for clear UX, but normalizes to a single internal model to avoid duplicating git/tmux logic across modes.
- **Protocol role precedence**: Protocol mode loads `codev/protocols/{name}/role.md` if it exists, falling back to `codev/roles/builder.md`.

#### CLEANUP Protocol -- Precursor to MAINTAIN (Spec 0015)

The CLEANUP protocol (Spec 0015, later superseded by the MAINTAIN protocol in Spec 0035) introduced a four-phase codebase maintenance workflow:

1. **AUDIT** -- Identify dead code, unused deps, stale docs, orphaned tests
2. **PRUNE** -- Remove identified cruft using soft-delete (move to `.trash/`) with auto-generated `restore.sh`
3. **VALIDATE** -- Run full test suite, verify nothing broke
4. **SYNC** -- Update architecture docs, sync CLAUDE.md/AGENTS.md

Key design patterns that carried forward into MAINTAIN:
- **Soft-delete with restore scripts**: Files moved to `codev/maintain/.trash/{timestamp}/` with directory structure preserved and `restore.sh` generated for rollback
- **30-day retention policy** for `.trash/` directories
- **Dry-run mode** for the prune phase
- **Entry/exit criteria** per phase with human approval required for all deletions
- **Cleanup categories**: dead-code, dependencies, docs, tests, temp, metadata (Spec 0015)

#### Platform Portability / Transpilation Vision (Spec 0017)

Spec 0017 envisioned a transpilation approach for multi-platform support where a single `.codev/` source of truth would generate platform-specific instruction files (`CLAUDE.md`, `GEMINI.md`, `AGENTS.md`). While this spec was low-priority and not implemented, it articulated the architectural direction:
- One-way transpilation: `.codev/` source -> platform targets
- Handlebars-style templates with platform conditionals
- Risk assessment: over-abstraction and "lowest common denominator" limitation

Expert consultation flagged this as potentially premature -- the simpler approach of manually maintaining CLAUDE.md/AGENTS.md in sync was adopted instead (see Invariant #4 in arch.md). (Spec 0017)

#### Architect-to-Builder Communication -- af send (Spec 0020)

The `af send` command (Spec 0020) enables bidirectional communication in the architect-builder workflow using **tmux buffer paste** rather than `send-keys`:

**Message flow**: CLI -> load state -> find builder tmux session -> write to temp file -> `tmux load-buffer` -> `tmux paste-buffer` -> `tmux send-keys Enter` -> cleanup temp file

**Why buffer paste over send-keys**: `send-keys` has severe shell escaping issues with special characters (`$`, backticks, quotes). Buffer paste treats content as a paste operation, preserving formatting and avoiding escaping entirely. Both GPT-5 and Gemini independently recommended this approach.

**Structured message format** (default, disable with `--raw`):
```
### [ARCHITECT INSTRUCTION | <timestamp>] ###
<message content>
###############################
```

**Key flags**: `--all` (broadcast), `--file` (attach file content, 48KB limit), `--interrupt` (send Ctrl+C first), `--raw` (skip formatting), `--no-enter` (don't submit). (Spec 0020)

#### Multi-CLI Builder Support -- CLI Adapter Pattern (Spec 0021)

Spec 0021 designed the CLI Adapter pattern for supporting multiple AI CLI tools as builders:

```typescript
interface CLIAdapter {
  name: string;
  command: string;
  isAvailable(): Promise<boolean>;
  isAuthenticated(): Promise<boolean>;
  validateCapabilities(): Promise<{ valid: boolean; missing: string[] }>;
  buildSpawnCommand(options): { cmd: string; args: string[] };
  getEnv(options): Record<string, string>;
  capabilities: { systemPrompt, modelSelection, fileEditing, shellExecution, toolLoop };
}
```

**Critical constraint**: Only agentic CLIs (with tool loop, file I/O, and shell execution) can function as builders. Non-agentic CLIs (basic API wrappers) must be rejected with clear error messages. (Spec 0021)

#### Consult Tool Origins (Spec 0022)

The consult tool (Spec 0022) replaced the zen MCP server with a direct CLI wrapper, eliminating ~3.7k tokens of MCP context overhead per conversation. Key architectural decisions:

- **Python with Typer** chosen over TypeScript or Bash -- no build step, proper arg handling, `subprocess.run([...])` bypasses shell for injection safety
- **Stateless by design** -- each invocation is a fresh process
- **Consultant role** (`codev/roles/consultant.md`) -- collaborative partner, not adversarial reviewer
- **Autonomous mode flags**: `--yolo` (gemini), `--full-auto` (codex) to minimize permission prompts
- **History logging**: `.consult/history.log` for observability

**TICK-001 Amendment (architect-mediated PR reviews)**: Changed PR review workflow from each consultant independently exploring the filesystem (slow: 200-250s with 10-15 shell commands) to architect-prepared overviews passed via `--context` flag or stdin. Consultants analyze provided context without filesystem access. Review time dropped to <60s per consultant.

**Sandbox modes for mediated reviews**:
| Model | Exploration Mode | Mediated Mode |
|-------|------------------|---------------|
| Gemini | `--yolo` | `--sandbox` |
| Codex | `exec --full-auto` | `exec` (no full-auto) |
| Claude | `--print --dangerously-skip-permissions` | `--print` |

(Spec 0022)

#### Librarian Role -- Abandoned (Spec 0028)

Spec 0028 proposed a Librarian role for documentation stewardship but was abandoned after consultation. The decision was to absorb documentation maintenance into the MAINTAIN protocol (Spec 0035) rather than adding a fourth role. This preserved the clean three-role model: **Architect, Builder, Consultant**. The insight: documentation maintenance is an episodic protocol activity, not an ongoing role. (Spec 0028)

#### Overview Dashboard -- Meta-Dashboard (Spec 0029)

Spec 0029 designed a standalone overview dashboard on port 4100 showing all running Agent Farm instances across projects:
- Reads from global port registry (`~/.agent-farm/ports.json`, later `global.db`)
- Port status detection via TCP socket connect with 1s timeout
- Launch capability via directory picker + detached `af start`
- Requires validation that target directory is a valid codev project

Review feedback (from 3-way consultation) flagged: web browsers don't provide native directory pickers that return server-accessible paths -- text input for absolute paths is more reliable. Spawned instances should be detached to survive meta-dashboard restarts. (Spec 0029)

#### Markdown Syntax Highlighting in Annotator (Spec 0030)

Spec 0030 addressed markdown files rendering as plaintext in the annotation viewer. Two approaches failed:
- Removing the Prism markdown exception caused line breaks around `**` tokens (Prism inserts actual newline characters)
- CSS override (`display: inline !important`) didn't help because Prism outputs newlines in the string, not block elements

**Working approach (Hybrid "Styled Source")**: Custom regex-based highlighting that keeps syntax characters visible but muted:
- `#` headers: syntax muted gray, text large/purple
- `**bold**`: asterisks muted gray, content bold/yellow
- Backtick code: backticks muted, code red with background
- Links: brackets muted, text blue underlined
- Code block state tracked across lines for fenced blocks

This preserves 1:1 line mapping (all characters present, no position drift) and monospace alignment for tables. (Spec 0030)

#### SQLite Runtime State Details (Spec 0031)

Spec 0031 replaced JSON file-based state with SQLite databases. Additional architectural details beyond the main State Management section:

**Migration strategy**: Copy-first, delete-only-after-verification. JSON files backed up as `.bak` permanently for rollback capability. Migration wrapped in transactions for atomicity.

**Schema versioning**: `_migrations` table tracks applied schema versions rather than filesystem sentinels.

**Error handling layers**:
1. `busy_timeout = 5000` pragma for lock contention
2. `withRetry()` wrapper for `SQLITE_BUSY` with max 3 retries
3. WAL mode verification with fallback warning if filesystem doesn't support it (e.g., NFS)

**Debugging CLI**:
- `af db dump` -- export all tables to JSON
- `af db query <sql>` -- ad-hoc SELECT queries only (writes rejected for safety)
- `af db reset` -- destructive reset with confirmation prompt

**Key pragmas**: `journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`, `foreign_keys = ON` (Spec 0031)

### Package & Protocol Evolution (Specs 0032-0044)

#### Package Architecture (Spec 0039)

> **Note**: Current package structure is documented in [packages/codev/ - The npm Package](#3-packagescodev---the-npm-package) above.

- **Consolidation** (Spec 0039): Three separate packages (agent-farm, consult, codev) merged into single `@cluesmith/codev`. Consult tool ported from Python to TypeScript, eliminating polyglot dependency (Spec 0039 TICK-001).

#### Template and Skeleton Architecture (Specs 0032, 0039)

- **Template consolidation** (Spec 0032): All HTML templates (tower, dashboard-split, dashboard, annotate) live in `packages/codev/src/agent-farm/templates/`. Server code uses dynamic path resolution (`findTemplatePath()`) checking relative-to-compiled then relative-to-source paths.
- **Skeleton lifecycle** (Spec 0039 TICK-002 through TICK-004): `codev-skeleton/` is the single source of truth for protocol/role/template files. During `npm run build`, skeleton is copied to `packages/codev/skeleton/`. At init/adopt time, files are copied to the project's `codev/` directory with managed headers (`<!-- MANAGED BY CODEV -->`). Framework version tracked in `codev/.framework-version`. `codev update` uses hash comparison for safe merges (unchanged files overwritten silently, user-modified files get `.codev-new` sibling).
- **`codev import` command** (Spec 0039 TICK-005): AI-assisted protocol import from other codev projects. Spawns an interactive Claude session with source/target context for intelligent merging. Replaces the deleted `codev-updater` and `spider-protocol-updater` agents.

#### MAINTAIN Protocol (Spec 0035)

> **Note**: See [MAINTAIN Protocol](#core-components) in the Core Components section above for current protocol details.

- Renamed from CLEANUP (Spec 0015) to MAINTAIN (Spec 0035). Key difference from SPIR/TICK: MAINTAIN is a **task list** protocol where tasks can run in parallel rather than sequential phases. Absorbs the former `architecture-documenter` agent role (Spec 0028 decision).
- `lessons-learned.md` (at `codev/resources/lessons-learned.md`) is a MAINTAIN-generated artifact: consolidated wisdom from review documents, organized by topic with `[From XXXX]` attribution.

#### TICK Protocol Redesign (Spec 0040)

- TICK redefined as an **amendment mechanism for existing SPIR specs**, not a standalone parallel protocol. Modifies spec and plan in-place with an "Amendments" section at the bottom. Review files use naming convention `reviews/XXXX-name-tick-NNN.md`. Commit format: `[TICK XXXX-NNN] Phase: description`.
- Decision framework: TICK = refine existing feature (< 300 LOC, amends integrated spec); SPIR = create new feature from scratch.

#### Consult Tool Enhancements (Specs 0038, 0043, 0044)

- **PR review mode** (Spec 0038): `consult pr N` pre-fetches PR data (6 commands: pr info, comments, diff, files, spec, plan) into `.consult/pr-NNNN/` directory. Supports `--all` for parallel 3-way review, `--model` for single model. Verdict extraction parses `VERDICT:` marker from output, falls back to last 50 lines. Auto-cleanup keeps last 10 PR directories.
- **Codex CLI configuration** (Spec 0043): Uses official `experimental_instructions_file` config flag (writes role to temp file, passes via `-c experimental_instructions_file=<path>`) instead of undocumented `CODEX_SYSTEM_MESSAGE` env var. Uses `-c model_reasoning_effort=low` for faster responses (27% time reduction, 25% token reduction).
- **Review type prompts** (Spec 0044): `--type` parameter loads stage-specific prompts from `codev/roles/review-types/`. Five types: `spec-review`, `plan-review`, `impl-review`, `pr-ready`, `integration-review`. Type prompt is appended to base consultant role.

#### 7-Stage Architect-Builder Workflow (Spec 0044)

- Documented in `codev/resources/workflow-reference.md`. Stages: conceived -> specified -> planned -> implementing -> implemented -> committed -> integrated.
- Human approval gates: conceived->specified, specified->planned, planned->implementing, committed->integrated.
- SPIR-SOLO protocol deleted (redundant; use SPIR with "without consultation" instead).
- Communication: `af send XXXX "message"` for short notifications, PR comments for detailed feedback.

#### Markdown Annotator Table Alignment (Spec 0034)

- **Table alignment** (Spec 0034): Two-pass rendering in `annotate.html`. First pass identifies code block ranges and tables (using header+separator detection pattern to avoid false positives), computes column widths. Second pass renders with padded cells. Uses `buildTableMap()` for O(1) line-to-table lookup. Preserves alignment markers (`:---:`, `:---`, `---:`).

#### Dashboard Tab Bar UX (Specs 0036, 0037)

- **Tab bar UX** (Spec 0037): Active tab uses bottom border accent (`border-bottom: 2px solid var(--accent)`). Close button always visible at `opacity: 0.4`. Overflow indicator (`... +N`) with dropdown menu listing all tabs when tabs exceed viewport width. Overflow detection via `scrollWidth > clientWidth` comparison.
- **Tab actions** (Spec 0036): Open-in-new-tab button (arrow symbol) on each tab. Context menu with "Open in New Tab". Tooltips showing tab metadata (port, status, worktree for builders; path for files). Reload button in annotation viewer header (not tab bar).

#### E2E Test Suite (Spec 0041)

- BATS-based E2E tests in `tests/e2e/`. Tests the actual npm tarball after `npm pack`, not source. 70 tests across install, init, adopt, doctor, af, and consult. XDG sandboxing (isolated HOME, XDG dirs, npm prefix/cache) per test. CI workflows: `.github/workflows/e2e.yml` (PR, macOS+Linux matrix) and `.github/workflows/post-release-e2e.yml` (post-release with 120s npm propagation wait).

### Dashboard & Tooling Expansion (Specs 0045-0055)

#### Dashboard UI Components (Specs 0045, 0050, 0055)

- **Projects Tab** (Spec 0045): Uncloseable first tab in the dashboard providing a Kanban-style view of all projects across 7 lifecycle stages (conceived, specified, planned, implementing, implemented, committed, integrated). Data source is `codev/projectlist.md`, parsed client-side with a custom YAML-like line-by-line parser. Includes welcome screen for onboarding, status summary, project detail expansion, real-time polling (5-second interval with hash-based change detection and 500ms debounce), terminal state handling (abandoned/on-hold in collapsible section), and TICK badge indicators. Key file: `packages/codev/src/lib/projectlist-parser.ts` (standalone parser module, 232 lines, 31 unit tests).

- **Files Tab** (Spec 0055): Second permanent/uncloseable tab providing a VSCode-like file browser. Backend `/api/files` endpoint returns directory tree as JSON with recursive traversal. Excludes heavyweight directories (node_modules, .git, dist, .builders, __pycache__) but shows dotfiles like .github and .gitignore. Frontend renders collapsible folder tree with expand/collapse controls. Clicking a file opens it in the annotation viewer via a new tab.

- **Dashboard Polish** (Spec 0050): Three UX refinements: (1) project row click behavior restricted to title-only with underline-on-hover styling, (2) TICK amendment badges (green `TICK-NNN` badges) shown in expanded project view, (3) starter page polling for `projectlist.md` creation every 15 seconds via `/api/projectlist-exists` endpoint with auto-reload on detection.

#### File Viewer Enhancements (Specs 0048, 0053)

- **Markdown Preview** (Spec 0048): Toggle button in `af open` viewer switches between annotated line-number view (`#viewMode`) and rendered markdown preview (`#preview-container`). Uses marked.js (CDN) for parsing, DOMPurify (CDN) for XSS sanitization, and Prism.js (already loaded) for code block syntax highlighting. Three-container architecture: viewMode (annotated), editor (textarea), preview-container (rendered). Libraries loaded conditionally only for `.md` files. Keyboard shortcut: Cmd/Ctrl+Shift+P. Approximate scroll position preserved via percentage-based mapping. GitHub-flavored markdown styling with dark theme colors matching the existing UI. Key files: `open-server.ts` (passes `isMarkdown` flag), `open.html` (main implementation, +202 lines).

- **Image Viewer** (Spec 0053): Extends `af open` to display images (PNG, JPG, GIF, WebP, SVG). Dedicated `/api/image` endpoint serves raw binary with correct MIME types. Image viewer UI includes zoom controls (Fit, 100%, +/-) with CSS class-based zoom modes. Image dimensions and file size displayed in header. Code editor/preview UI hidden for image files. Cache-busting via `?t=<timestamp>` query parameter. Key files: `open-server.ts` (+50 lines), `open.html` (+230 lines).

#### generate-image Command (Spec 0054)

- **AI-powered image generation** (Spec 0054): CLI using Google's Nano Banana Pro model (gemini-3-pro-image-preview) via `@google/genai` SDK. Integrated as both `codev generate-image` subcommand and standalone `generate-image` binary. Options: prompt (text or .txt file), output path, resolution (1K/2K/4K), aspect ratio, reference image for image-to-image generation. GEMINI_API_KEY from environment with GOOGLE_API_KEY fallback. Key file: `packages/codev/src/commands/generate-image.ts` (~180 lines, 12 tests).

#### Documentation Architecture (Specs 0046, 0051, 0052)

- **CLI Command Reference** (Spec 0046): Established standard documentation location at `codev/docs/commands/` (later moved to `codev/resources/commands/`). Four files: `overview.md`, `codev.md`, `agent-farm.md`, `consult.md`. Documented all CLI subcommands with synopsis, description, options, and examples. Integrated into both main repository and `codev-skeleton/` for distribution to all projects. Referenced from CLAUDE.md and AGENTS.md for AI agent discoverability.

- **Codev Cheatsheet** (Spec 0051): Created `codev/resources/cheatsheet.md` as comprehensive onboarding and quick reference document. Covers three core philosophies (Natural Language as Programming Language, Multiple Models Outperform a Single Model, Human-Agent Work Requires Thoughtful Structure), all four protocols (SPIR, TICK, MAINTAIN, EXPERIMENT), three roles (Architect, Builder, Consultant), information hierarchy diagram, and complete tool reference tables for codev, af, and consult commands. Linked from CLAUDE.md, AGENTS.md, and README.md.

- **Agent Farm Internals documentation** (Spec 0052): The [Agent Farm Internals](#agent-farm-internals) section of this document was established, covering architecture diagrams, port system, state management, worktree lifecycle, API endpoints, error handling, and security model.

#### Dashboard Server API Endpoints (Specs 0045, 0050, 0053, 0055)

- `/file?path=<relative-path>` (Spec 0045): Serves file content with path traversal protection via `validatePathWithinProject()`. Used by Projects tab to load `projectlist.md`.
- `/api/projectlist-exists` (Spec 0050): Returns `{ exists: boolean }` for starter page polling.
- `/api/files` (Spec 0055): Returns project directory tree as JSON with exclusion filtering.
- `/api/image` (Spec 0053): Serves raw image binary data with correct MIME Content-Type headers.

#### Security Patterns (Specs 0045, 0048, 0055)

> **Note**: Network binding, authentication, and path traversal are documented in the [Security Model](#security-model) section above. These entries cover additional dashboard-specific security patterns.

- **XSS Prevention** (Spec 0045, Spec 0048): All user-generated content escaped via `escapeHtml()` (createElement + textContent + innerHTML pattern). Markdown preview uses DOMPurify to sanitize marked.js HTML output. No eval() or Function() in custom parsers.
- **Link Security** (Spec 0048): All preview links rendered with `target="_blank" rel="noopener noreferrer"` via custom marked.js renderer.
- **JS Context Escaping** (Spec 0055): `escapeJsString()` function for inline JS handlers, separate from `escapeHtml()` which only handles HTML context.

### Architecture Modernization (Specs 0056-0082)

#### Consult Types System (Spec 0056)

Consultation types moved from `roles/review-types/` to `consult-types/` with a backward-compatibility fallback chain. The `consult` CLI resolves review type prompts by checking `consult-types/<type>.md` first, then falling back to `roles/review-types/<type>.md` with a deprecation warning. The `codev doctor` command validates that `consult-types/` directory exists and is populated. (Spec 0056)

#### Pre-React Dashboard Architecture (Specs 0057, 0058, 0059, 0060, 0064)

The dashboard evolved through multiple specs before the React rewrite:

- **Tab Overhaul (Spec 0057)**: Dashboard uses a two-column layout (tabs list + content area) with builder status indicators (working/idle) derived from builder state proxy data. Quick-action buttons enable spawning new shells and creating worktrees. The "Projects" tab was renamed to "Dashboard". Worktree creation handles both new and existing branches.

- **File Search Autocomplete (Spec 0058)**: Cmd+P file finder with substring matching and relevance scoring. Uses a flat file list cache built from the tree data structure. Search highlighting uses XSS-safe rendering via `escapeHtml()` plus mark tags for matches. Debounced input prevents excessive DOM updates.

- **Daily Activity Summary (Spec 0059)**: Clock button triggers an AI-generated standup summary. Backend collects git log, GitHub PR data, and builder activity. Time tracking uses interval merging with a 2-hour gap detection threshold. The `/api/activity-summary` endpoint aggregates data and passes it to Claude for summarization.

- **Dashboard Modularization (Spec 0060)**: The monolithic 4700-line `dashboard.html` was split into 9 CSS files + 8 JS files served from `dashboard/css/` and `dashboard/js/` directories. Hot reloading via SSE: CSS changes trigger hot-swap (replace link href), JS changes trigger soft-refresh (page reload with `sessionStorage` state preservation). Static file serving includes path traversal protection on the `dashboard/` route. No build step -- plain CSS and JS files served directly.

- **Tab State Preservation (Spec 0064)**: Iframes use hide/show pattern instead of destroy/recreate to preserve terminal state. An iframe cache (`Map<string, HTMLIFrameElement>`) stores active iframes keyed by tab ID. Port change invalidation ensures stale iframes are replaced when the backing port changes.

#### 3D Viewer (Spec 0061)

Three.js loaded via ES Modules using an `importmap` in the HTML template. Supports STL and 3MF file formats. 3MF uses `ThreeMFLoader` which handles multi-color and multi-object models. `TrackballControls` replaces `OrbitControls` for quaternion-based rotation without gimbal lock. Z-up to Y-up coordinate conversion is applied on load. A unified `3d-viewer.html` template handles both formats. File paths are escaped with `escapeHtml()` to prevent XSS from malicious filenames. (Spec 0061)

#### Secure Remote Access and Tower Origins (Specs 0062, 0081)

- **SSH Tunnel Architecture (Spec 0062)**: `af start --remote` enables remote access via SSH tunnel. A reverse proxy using the `http-proxy` npm package handles both HTTP and WebSocket proxying. Dashboard iframe URLs changed from direct port references to `/terminal/:id` proxied paths. The reverse proxy multiplexes WebSocket connections through a single exposed port.

- **Web Tower (Spec 0081)**: Tower server (`tower-server.ts`) provides multi-project web access through a single port (4100). Project paths encoded using Base64URL (RFC 4648) for URL safety. Routes: `/workspace/<base64url-path>/*` (originally `/project/`, renamed in Spec 0112) proxies to the workspace's Agent Farm instance.

  Authentication uses timing-safe comparison (`crypto.timingSafeEqual`) with the `CODEV_WEB_KEY` environment variable. No localhost bypass when key is set -- this is critical because tunnel daemons (cloudflared, ngrok) run locally and proxy remote traffic, so checking `remoteAddress` would be insufficient. WebSocket authentication uses the `Sec-WebSocket-Protocol` subprotocol header (`auth-<key>`), which is stripped before forwarding to the backend to avoid confusing upstream servers.

  Push notifications use ntfy.sh (external service) for mobile alerts. Real-time updates use SSE (Server-Sent Events) via `/api/events` endpoint. The EventSource API lacks custom header support, so authenticated SSE uses `fetch()` with `ReadableStream` instead.

  Mobile responsiveness uses `env(safe-area-inset-*)` CSS for notched devices, 44px minimum touch targets, and a 600px responsive breakpoint.

  TICK-001 amendment simplified proxy routing: all terminal types now route to a single basePort (node-pty WebSocket multiplexing), removing the old per-terminal port routing (`basePort+1`, `basePort+2+n`). The `getInstances()` function no longer probes an architect port, and `stopInstance()` only kills the basePort.

#### BUGFIX Protocol Architecture (Spec 0065)

A lightweight protocol for GitHub Issue-driven bug fixes. Key architectural elements: `af spawn --issue <number>` fetches issue details via GitHub API; collision detection checks for existing worktrees, "On it" issue comments, and open PRs before spawning; 300 LOC net diff threshold with escalation to SPIR if exceeded; PR-only CMAP reviews (no spec/plan consultation). State stored in `codev/executions/bugfix_<issue>/status.yaml`. (Spec 0065)

#### VSCode Companion -- Abandoned (Spec 0066)

Investigated a thin VSCode companion extension using `tmux attach` for terminal persistence. Critical discovery: **VSCode Terminal API cannot capture stdout** -- this fundamental limitation makes a terminal-based companion impractical. The approach was abandoned in favor of CODEV_HQ (Spec 0068). (Spec 0066)

#### Agent Farm Architecture Rewrite Vision (Specs 0067, 0068)

- **Architecture Rewrite (Spec 0067, SUBSUMED into 0068)**: Proposed replacing ttyd + tmux with node-pty + xterm.js. Single-port WebSocket multiplexing replaces port-per-terminal. React + Vite dashboard replaces vanilla JS. This spec was subsumed into Codev 2.0.

- **Codev 2.0 Vision (Spec 0068)**: Three-pillar architecture:
  1. **Terminal + UI Rewrite**: node-pty, xterm.js, WebSocket mux, React + Vite, single port, stdout capture
  2. **CODEV_HQ + Mobile**: "Tethered Satellite" hybrid -- cloud control plane (auth, coordination, dashboards) + local runners (execution, code stays on user's machine). Mobile as "Director's Chair" (approve gates, view logs, send commands -- no full terminal).
  3. **Deterministic Core**: Protocol compliance via state machine, not AI memory. YAML status files tracked in git provide audit trail.

  HQ Network Protocol uses WebSocket (wss://) with JSON message envelope (`type`, `id`, `ts`, `payload`). Key message types: `register`, `status_update`, `builder_update`, `terminal_output`, `gate_completed` (local to HQ); `command`, `approval`, `terminal_input` (HQ to local). State ownership: status files owned by local (git), human approvals owned by HQ, both sync bidirectionally. Reconnection uses exponential backoff with 5-minute message buffering.

  Migration path: v1.6.x-v1.9.x feature flags, v2.0.0-alpha HQ opt-in, v2.0.0 full release. Local-only mode remains viable indefinitely. (Spec 0068)

#### Protocol Enforcement Evolution (Specs 0069, 0071, 0072, 0073, 0075)

- **Checklister Spike (Spec 0069)**: Early exploration of SPIR compliance enforcement via `.spir-state.json` checklist state and Claude Code skills (`/checklister status`, `/checklister complete`, `/checklister gate`). Precursor to porch.

- **Declarative Protocol Checks / pcheck (Spec 0071)**: Proposed declarative YAML check definitions with three check types: `file_exists`, `llm_check` (semantic evaluation via Haiku), and `command` (shell execution). Gates compose multiple checks. LLM checks use content hash caching (`.codev/pcheck-cache.json`) to avoid redundant API calls. `codev pcheck --next` provides actionable guidance.

- **Ralph-SPIR Integration Spike (Spec 0072)**: Validated that builders can own the full SPIR lifecycle (S-P-I-D-E-R) with human approval gates as backpressure points. Key tenets: fresh context per iteration, state in files not AI memory.

- **Porch Protocol Orchestrator (Spec 0073)**: Standalone CLI (`porch` binary, not `codev porch`) orchestrating SPIR, TICK, and BUGFIX protocols. Core architecture:
  - **State**: Pure YAML files at `codev/projects/<id>-<name>/status.yaml` (SPIR) or `codev/executions/<type>_<id>/status.yaml` (TICK/BUGFIX). Atomic writes via tmp + fsync + rename. Advisory file locking via `flock()`.
  - **Signals**: LLM output parsed for `<signal>NAME</signal>` tags. Last signal wins when multiple found.
  - **Protocol definitions**: JSON files alongside human-readable `protocol.md`. Schema at `codev-skeleton/protocols/protocol-schema.json`.
  - **Phase extraction**: Plan markdown parsed for `### Phase N: <title>` headers.
  - **IDE loop**: implement -> defend -> evaluate per plan phase.
  - **Consultation**: 3-way parallel (Gemini, Codex, Claude) with APPROVE/REQUEST_CHANGES/COMMENT verdicts.
  - **Notifications**: Console and macOS native notifications for pending gates.
  - **AF integration**: `af kickoff` creates worktree at `worktrees/<protocol>_<id>_<name>/` and starts porch.
  - **Key modules**: `state.ts`, `signal-parser.ts`, `plan-parser.ts`, `consultation.ts`, `checks.ts`, `notifications.ts`, `protocol-loader.ts`. 72 unit tests across 5 test files.
  - **YAML key constraint**: Phase and gate IDs must use underscores, not hyphens, for YAML parsing compatibility.

- **Porch Build-Verify Redesign (Spec 0075)**: Build-verify cycles as first-class citizens. Triple-nested architecture: Architect Claude -> Builder Claude (outer, just runs porch) -> Porch -> Inner Claude (does actual work). Consultation verdicts: APPROVE, REQUEST_CHANGES, COMMENT. Safe defaults: empty/short output from consultation defaults to REQUEST_CHANGES. Feedback delivered via file paths in `.porch/` directory -- Claude reads raw files rather than synthesized summaries. `on_complete` config handles automatic git commit + push after successful verification.

#### Terminal Process Lifecycle (Spec 0076)

Three-layer process hierarchy: shell process -> tmux session -> ttyd WebSocket server. When the shell exits, tmux destroys the session immediately (default behavior, `remain-on-exit` not used), but ttyd stays alive to display "Press Enter to Reconnect." The `/api/tabs/:id/running` endpoint checks `tmuxSessionExists()` (synchronous, uses `execSync` with `tmux has-session`) instead of `isProcessRunning(ttyd_pid)`. Fallback to PID check when `tmuxSession` field is missing (backward compatibility). `tmux has-session` completes in ~4ms. Fail-open behavior: `tmuxSessionExists()` returns `false` on error. (Spec 0076)

#### Porch E2E Testing Infrastructure (Spec 0078)

E2E tests use real AI interactions (~40 min runtime, ~$4/run). Vitest config (`vitest.e2e.config.ts`) with 20-minute test timeouts and sequential execution (`maxConcurrency: 1`). `PORCH_AUTO_APPROVE` environment variable enables automated gate approval in tests. Mock consult uses PATH manipulation to inject a mock script that takes precedence over the real `consult` CLI. Interactive stdin handling via `runPorchInteractive()` helper that pipes pre-configured responses. (Spec 0078)

#### Modularization Analysis (Spec 0082)

Evaluation of splitting the codebase into three packages: codev (project management), agentfarm (terminal orchestration), porch (protocol engine). Code dependency flow is unidirectional: Codev -> AgentFarm -> Porch (no circular dependencies). Recommended phased approach: extract porch first as it has the cleanest boundaries. (Spec 0082)

### Porch Evolution & Platform Modernization (Specs 0083-0096)

#### Protocol-Agnostic Spawn System (Spec 0083)

The `af spawn` command was refactored to decouple input types from protocols, making the system extensible without hardcoding protocol-specific logic. (Spec 0083)

**Three Orthogonal Concerns**:
```
Input Type (what to build from)  x  Mode (who orchestrates)  x  Protocol (what workflow)
```

- **`--use-protocol <name>`** flag: Overrides default protocol for any input type. Distinct from `--protocol <name>` which is an input type (protocol-only mode). (Spec 0083)
- **Protocol resolution precedence**: (1) Explicit `--use-protocol` flag, (2) Spec file `**Protocol**: <name>` header, (3) Protocol `default_for` in protocol.json, (4) Hardcoded fallbacks (spir for specs, bugfix for issues). (Spec 0083)
- **Protocol definition extensions in protocol.json**: Added `input` (type, required, default_for), `hooks` (pre-spawn collision-check, comment-on-issue), and `defaults` (mode) sections. (Spec 0083)
- **Protocol prompt templates**: Each protocol can provide `protocols/{name}/builder-prompt.md` with mustache-style variable substitution. Falls back to generic prompt construction if no template exists. (Spec 0083)

#### Porch Agent SDK Integration (Spec 0086)

**Builder/Enforcer/Worker Three-Layer Architecture** (Spec 0086):

```
       [ HUMAN ]
           |  (natural conversation)
+------------------------------+
|  BUILDER  (Interactive Claude)|  Claude Code in tmux
|  Calls porch, relays results |
+------------------------------+
           |
           |  porch run <id> --single-phase
           v
+------------------------------+
|  ENFORCER  (Porch)           |  Deterministic Node.js state machine
|  Enforces phases, reviews,   |
|  gates, iterations           |
+------------------------------+
      /              \
     / BUILD          \ VERIFY
    v                  v
+-----------+    +-------------+
| WORKER    |    | CONSULT CLI |
| (AgentSDK)|    | (Reviewer)  |
+-----------+    +-------------+
```

Each layer exists to solve a specific failure mode: (Spec 0086)
- **Builder**: Porch was a terrible conversational interface; humans need Claude's understanding to interact naturally.
- **Enforcer**: Claude drifts when given autonomy -- skips reviews, bypasses gates, implements everything in one shot.
- **Worker**: `claude --print` was crippled -- no tools, no file editing, stateless, silent 0-byte failures.

Key changes in Spec 0086:
- `buildWithSDK()` in `claude.ts` replaced `claude --print` subprocess with Anthropic Agent SDK `query()` -- programmatic, in-process, full tool access (Read, Edit, Bash, Glob, Grep).
- `--single-phase` flag: Builder stays in the loop between phases, receives structured `__PORCH_RESULT__` JSON with phase, status, gate, verdicts, artifact.
- `repl.ts` and `signals.ts` removed -- the Builder (interactive Claude) is the interface, Agent SDK provides structured completion instead of XML signals.

#### Porch Timeout, Termination, and Retries (Spec 0087)

Added reliability mechanisms to porch's build loop (Spec 0087):

| Mechanism | Configuration | Purpose |
|-----------|---------------|---------|
| Build timeout | `BUILD_TIMEOUT_MS` = 15 min | Prevents indefinite hang on Agent SDK stream stall |
| Build retry | `BUILD_MAX_RETRIES` = 3, backoff [5s, 15s, 30s] | Recovers from transient API failures |
| Circuit breaker | `CIRCUIT_BREAKER_THRESHOLD` = 5 consecutive failures | Halts with exit code 2 after persistent failures |
| AWAITING_INPUT | Detected via signal scan of worker output | Writes to status.yaml, exits code 3, resumes on next `porch run` |

#### Porch Build Counter (Spec 0089)

Added `PORCH_BUILD_COUNTER_KEY` constant (`'porch.total_builds'`) in `packages/codev/src/commands/porch/build-counter.ts` for standardized build counting across sessions. (Spec 0089)

#### Terminal Session Persistence (Spec 0090 TICK-001)

> **Note**: Current reconciliation strategy (Shellper-aware dual-source) is documented in the [State Split Problem & Reconciliation](#state-split-problem--reconciliation) section above.

Added `terminal_sessions` table to `global.db` with migration v3 (Spec 0090 TICK-001). Originally used **destructive reconciliation** (killing orphaned tmux sessions on startup). After Shellper (Spec 0104), reconciliation became Shellper-aware: shellper processes are preserved and reconnected rather than killed, as they hold live PTY sessions that survive Tower restart.

#### Terminal File Links and File Browser (Spec 0092)

**Port Consolidation** (Spec 0092): Eliminated `open-server.ts` and moved file viewing through Tower API endpoints, freeing ports 4250-4269.

New Tower endpoints (Spec 0092):
| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/workspace/:enc/api/tabs/file` | Create file tab, returns tab ID |
| `GET` | `/workspace/:enc/api/file/:id` | Get file content with language detection |
| `GET` | `/workspace/:enc/api/file/:id/raw` | Get raw file (images, video) |
| `POST` | `/workspace/:enc/api/file/:id/save` | Save file changes |
| `GET` | `/workspace/:enc/api/git/status` | Git status (porcelain format, max 50 files) |
| `GET` | `/workspace/:enc/api/files/recent` | Recently opened file tabs |

**Terminal File Links** (Spec 0092): `@xterm/addon-web-links` integrated into Terminal.tsx with custom regex detection for file paths (absolute, relative, with line:column numbers). `looksLikeFilePath()` heuristic distinguishes files from URLs/domains. Click handler opens file in dashboard tab with line scrolling.

New dashboard files (Spec 0092):
| File | Purpose |
|------|---------|
| `dashboard/src/components/FileViewer.tsx` | File viewer with text (line numbers + editing), image, and video support |
| `dashboard/src/lib/filePaths.ts` | Path regex and parsing utilities |

**FileTree Enhancement** (Spec 0092):
- Git status indicators (A/M/?) with color coding and 30-second periodic refresh
- Search autocomplete box with fuzzy matching on file paths
- Recent files section showing recently opened file tabs
- View mode toggle between Recent and Tree views

#### SPIDER to SPIR Rename (Spec 0093)

The SPIDER protocol was renamed to SPIR (Specify, Plan, Implement, Review) across the entire codebase. (Spec 0093)

- ~728 references to "SPIDER" across ~224 files were updated
- Directory rename: `codev-skeleton/protocols/spider/` and `codev/protocols/spider/` to `spir/`
- `protocol.json` uses `"name": "spir"` with `"alias": "spider"` for backward compatibility
- Branch naming convention updated: `spir/XXXX-feature-name/phase-name`
- Both `--use-protocol spider` (alias) and `--use-protocol spir` (new) work

#### Tower Mobile Compaction (Spec 0094)

CSS-only compaction of the Tower overview page (`templates/tower.html`) for mobile viewports (<=600px). (Spec 0094)

Changes:
- Share button hidden on mobile (pointless when already on phone)
- Project name + status + Restart/Stop on one line (flexbox row with wrap)
- Project path row hidden on mobile
- Port items (Overview, Architect, shells) compacted to horizontal rows
- `.new-shell-row` semantic class replaces fragile inline style targeting
- Recent projects: name + time + Start inline, path hidden
- Section spacing reduced
- All buttons remain tappable (min 36px touch targets, `@media (pointer: coarse)` still sets 44px)

#### Porch as Planner (Spec 0095)

**Architectural transformation**: Porch changed from an orchestrator (spawning Claude via Agent SDK in a while loop) to a pure planner (reading state and emitting structured JSON task definitions). (Spec 0095)

**New command**: `porch next <id>` replaces `porch run`. Outputs structured `PorchNextResponse` JSON:

```typescript
interface PorchNextResponse {
  status: 'tasks' | 'gate_pending' | 'complete' | 'error';
  phase: string;
  iteration: number;
  plan_phase?: string;
  tasks?: PorchTask[];
  gate?: string;
  error?: string;
  summary?: string;
}

interface PorchTask {
  subject: string;
  activeForm: string;
  description: string;
  sequential?: boolean;
}
```

**`done()` / `next()` separation** (Spec 0095):
- `porch done` handles completion signaling (running checks, setting `build_complete`)
- `porch next` handles planning only (reads state, emits tasks)
- Builder loop: `porch next` -> execute tasks -> `porch done` -> `porch next` -> ...

**Filesystem-as-truth** (Spec 0095): `porch next` infers completion from artifacts on disk rather than explicit signals. Review files exist = consultation completed. Verdicts parsed from review files. This makes the system crash-recoverable and idempotent.

**Deleted modules** (Spec 0095):
- `run.ts` (1052 lines) -- orchestrator loop
- `claude.ts` (135 lines) -- Agent SDK wrapper
- `@anthropic-ai/claude-agent-sdk` dependency removed

**New modules** (Spec 0095):
- `next.ts` (338 lines) -- core `next()` planning function
- `verdict.ts` (62 lines) -- extracted `parseVerdict()` and `allApprove()`

Net result: -1155 lines.

#### Test Infrastructure Improvements (Spec 0096)

**Unified test pipeline** replacing fragmented multi-framework setup. (Spec 0096)

**Framework changes**:
- BATS retired entirely (156 files, ~20,000 lines deleted including vendored libraries)
- All CLI integration tests migrated to Vitest (`src/__tests__/cli/*.e2e.test.ts`)
- `*.e2e.test.ts` naming convention for server-spawning tests, excluded from default `vitest.config.ts`
- Separate `vitest.cli.config.ts` with appropriate timeouts (30s vs 20min for porch e2e)

**CI pipeline** (`.github/workflows/test.yml`):

| Job | What it runs | When |
|-----|-------------|------|
| Unit Tests | `npx vitest run --coverage` | Every PR, push to main |
| Tower Integration | `vitest.e2e.config.ts` (excluding porch e2e) | Every PR, push to main |
| CLI Integration | `npx vitest run src/__tests__/cli/` | Every PR, push to main |
| Dashboard Tests | Playwright with auto-started tower | Every PR, push to main |

**Coverage**: `@vitest/coverage-v8` with thresholds of 62% lines / 55% branches (calibrated from actual baseline of 62.31% / 56.42%).

**Playwright automation**: `webServer` config in `playwright.config.ts` auto-starts tower on port 4100. `reuseExistingServer: true` for local coexistence with dev tower.

**Post-release verification**: `scripts/verify-install.mjs` replaces BATS install tests -- `npm pack` -> `npm install -g` -> verify binaries.

### Cloud, Messaging & Session Management (Specs 0097-0106)

#### Cloud Tunnel Client (Spec 0097)

The Cloud Tunnel Client replaces cloudflared with a built-in HTTP/2 role-reversal tunnel that connects the Tower to codevos.ai. The tunnel uses the `ws` library for WebSocket transport with JSON message authentication. (Spec 0097)

**Architecture**:
- Tower is the H2 *server* (not client), so it cannot initiate outbound H2 requests to codevos.ai
- WebSocket transport: Tower connects to codevos.ai via WebSocket (`ws` library + `createWebSocketStream()`), authenticating with JSON messages over the WebSocket matching the codevos.ai server protocol
- codevos.ai proxies HTTP requests and WebSocket upgrades through the tunnel to `localhost:4100`
- SSRF prevention: tunnel ONLY proxies to `localhost:4100`. The `/api/tunnel/*` path prefix is blocked before proxying. `isBlockedPath()` percent-decodes and normalizes the path (via `decodeURIComponent` + `new URL().pathname`) before checking prefixes, preventing bypass via `%2F`, `%2f`, `%61` encoding, and `..` dot segments

**Resilience**:
- Exponential backoff with jitter: 1s initial, 60s cap for transient failures
- Rate limiting: 60s first retry, escalates to 5-minute intervals on `rate_limited` responses
- Circuit breaker: stops retrying on authentication failures (HTTP 401/403)
- Auto-reconnect after network disruption or machine sleep/wake

**Registration**:
- `af tower register`: generates token via codevos.ai API, user pastes token. Cloud config stored in `~/.agent-farm/cloud.json` with enforced `0600` permissions (uses `chmodSync` after `writeFileSync` because Node only applies `mode` on file creation)
- `af tower deregister`: removes registration and stops tunnel connection
- `af tower status`: extended with cloud registration info
- `CODEVOS_URL` env var overrides default `https://codevos.ai` for local/staging instances
- `-p, --port` CLI option on register/deregister for custom-port towers (Spec 0097)

**Dashboard**: `CloudStatus` component shows tunnel connection state. Uses root-relative paths (`/api/tunnel/status`, etc.) instead of `apiUrl()` because tunnel endpoints are tower-level, not project-scoped. (Spec 0097)

#### Port Registry Removal (Spec 0098)

The per-project port allocation system (port blocks 4200-4299, 4300-4399, etc.) was removed in Spec 0098. Since Spec 0090 (Tower Single Daemon), the Tower at port 4100 is the only HTTP server -- per-project port blocks were allocated in SQLite but nothing listened on them. (Spec 0098)

**Changes**:
- `port-registry.ts` deleted (220 lines)
- All references to `dashboardPort`, `architectPort`, `builderPortRange`, `utilPortRange` removed
- Builder/UtilTerminal types no longer carry `port`/`pid` fields
- `--remote` flag removed from `af start`
- `{PORT}` in builder role resolves to 4100 (Tower port)
- `af consult` routes to Tower at 4100, not dead per-project port
- `af status` no longer shows per-project port numbers
- Project discovery replaced: `getKnownProjectPaths()` now uses `terminal_sessions` table (persistent) combined with `workspaceTerminals` in-memory cache (current session), replacing `loadPortAllocations()` (Spec 0098)

**Migration**: Migration v2 made a no-op (instead of deleted) to preserve version numbering for existing installations. Five places in `tower-server.ts` hardcode `port: 0` to preserve the JSON API shape for backward compatibility. (Spec 0098)

#### Tower Codebase Hygiene (Spec 0099)

Post-migration cleanup addressing naming, dead code, state management, and error handling. Key architectural changes: (Spec 0099)

- **Module extractions**: `gate-status.ts` (reads porch gate status from filesystem), `file-tabs.ts` (SQLite persistence for file tabs with dependency injection), `session.ts` (shared session naming with `getBuilderSessionName()`)
- **File tab persistence**: `file_tabs` SQLite table with write-through pattern. File tabs survive Tower restart via SQLite rehydration on startup
- **Error handling**: Tower error responses are structured JSON with `console.error` logging. Two conventions exist: terminal routes use `{ error: 'CODE', message: '...' }` while project/file routes use `{ error: message }`
- **Removed**: `orphan-handler.ts` deleted, `port`/`pid` fields removed from Builder/UtilTerminal types
- All user-facing messages reference Tower (not dashboard-server). `shell.ts`, `open.ts` use `TowerClient` with auth headers. `attach.ts` generates correct Tower URLs.

#### Clickable File Paths in Terminal (Spec 0101)

Wired existing `FILE_PATH_REGEX` / `parseFilePath` utilities into xterm.js via a custom `ILinkProvider` with persistent decorations. (Spec 0101)

**Architecture**:
- `FilePathLinkProvider` (`dashboard/src/lib/filePathLinkProvider.ts`): Custom `ILinkProvider` implementation with platform-aware modifier detection (Cmd+Click on macOS, Ctrl+Click on others via `navigator.platform`)
- `FilePathDecorationManager`: Uses xterm.js `registerDecoration` with `IMarker` for persistent dotted underline overlays that survive scroll and re-render. Dual approach: `ILink.decorations` for hover color change, `registerDecoration` for persistent visual indicators
- Server-side path resolution: `POST /api/tabs/file` endpoint uses `terminalId` to resolve cwd-relative paths. `PtySession` exposes a `cwd` getter for the current working directory
- Symlink-safe containment: Uses `startsWith(base + path.sep)` pattern (not bare `startsWith(base)`) plus `realpathSync` for symlink resolution
- Pattern recognition: relative, absolute, dot-relative, parent-relative, with line number, with line+column, VS Code style (Spec 0101)

#### Porch CWD/Worktree Awareness (Spec 0102)

Automatic project ID detection from current working directory when running inside a builder worktree. (Spec 0102)

**Architecture**:
- `detectProjectIdFromCwd()` in `state.ts`: Extracts project ID from CWD path using regex matching against `.builders/` worktree patterns. Handles both numeric IDs (`0073`) and named patterns (`bugfix-228`). Uses `path.resolve()` + forward-slash normalization for cross-platform safety
- `resolveProjectId()` in `state.ts`: Testable function encapsulating the full resolution priority chain: explicit arg > CWD detection > filesystem scan > error
- Integration: `getProjectId()` in `index.ts` delegates to `resolveProjectId()`. Numeric ID argument is now optional for all porch commands when invoked from within `.builders/<id>/` directories
- Detection works from subdirectories (e.g., `.builders/0073/src/commands/`)

#### Claude Agent SDK for Consultation (Spec 0103)

Replaced Claude CLI subprocess delegation in `consult` with the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). (Spec 0103)

**Architecture**:
- `@anthropic-ai/claude-agent-sdk` added as a hard dependency (not optional -- essential for consultation, avoids dynamic import complexity)
- `runClaudeConsultation()` function using `query()` async iterator. Intercepts claude model in `runConsultation()` before CLI path
- Claude has tool-using capabilities (Read, Glob, Grep) during reviews via SDK `allowedTools` parameter
- `CLAUDECODE` env var stripping: Iterates over `process.env` entries and excludes `CLAUDECODE` to prevent nesting guard from blocking Claude in builder contexts
- `SDK_MODELS` constant separates SDK-based models from CLI-based models in `MODEL_CONFIGS`
- Tool use blocks logged to stderr with `[Tool: name: detail]` format
- `doctor.ts` updated: Claude removed from `AI_DEPENDENCIES`, replaced with `verifyClaudeViaSDK()` for auth verification

#### Spawn Command Decomposition (Spec 0105 Phase 7)

`spawn.ts` (1,405 lines) decomposed into 3 focused files: (Spec 0105)

| Module | Lines | Responsibility |
|--------|-------|---------------|
| `spawn-roles.ts` | 343 | Template rendering, prompt building, protocol/mode resolution |
| `spawn-worktree.ts` | 404 | Git worktree creation, GitHub integration, collision detection, session management |
| `spawn.ts` | 570 | Orchestrator: mode-specific spawn handlers |

#### Porch Check Normalization Bug (Spec 0106)

`normalizeProtocol()` merges all phases' checks into a flat `Record<string, CheckDef>`, so if the review phase defines a `"tests"` check, it overrides the implement phase's version. Phase-scoped check definitions would prevent override collisions. (Spec 0106)

### Cloud UX, Messaging & Terminal Enhancements (Specs 0107-0118)

#### Tower Cloud Connect (OAuth UI) (Spec 0107)

Tower now supports in-browser OAuth registration for Codev Cloud, replacing the CLI-only `af tower register` flow. (Spec 0107)

**New modules**:
- `lib/nonce-store.ts` -- In-memory nonce store with 5-minute TTL and single-use semantics for OAuth state management. Module-level singleton pattern matching `tower-tunnel.ts`. (Spec 0107)
- `lib/token-exchange.ts` -- Extracted `redeemToken()` (POST to cloud server, 30s timeout, redirect-following) from `tower-cloud.ts` into a shared module usable by both CLI and tunnel endpoints. (Spec 0107)
- `lib/device-name.ts` -- Device name normalization (trim, lowercase, spaces/underscores to hyphens, strip invalid chars) and validation (1-63 chars, alphanumeric + hyphens, start/end with letter/digit). (Spec 0107)

**Enhanced tunnel endpoints** (in `tower-tunnel.ts`):
- `POST /api/tunnel/connect` -- Now dual-purpose: with `{ name, serverUrl }` body initiates OAuth (creates nonce, returns `authUrl`); without body performs smart reconnect using existing credentials. (Spec 0107)
- `GET /api/tunnel/connect/callback` -- OAuth callback handler with nonce validation, token exchange, credential writing, and HTML success/error pages. Route ordering is critical: `connect/callback` must be checked before `connect`. (Spec 0107)
- `POST /api/tunnel/disconnect` -- Full cleanup: read config first, disconnect tunnel, server-side deregister (best-effort DELETE), delete local credentials last. Order matters. (Spec 0107)
- `GET /api/tunnel/status` -- Now includes `hostname` field for UI device name defaults. (Spec 0107)

**CLI rename**: `af tower register` renamed to `af tower connect`; `af tower deregister` renamed to `af tower disconnect`. Old names preserved as hidden aliases via `towerCmd.addCommand(cmd, { hidden: true })` (not `.alias()` which shows in help output). (Spec 0107)

**Default cloud URL**: Changed from `https://codevos.ai` to `https://cloud.codevos.ai`. (Spec 0107)

#### Porch Gate Notifications (Spec 0108)

Porch now sends direct `af send architect` notifications via `execFile` when gates transition to pending, replacing the polling-based gate watcher. (Spec 0108)

**New module**: `commands/porch/notify.ts` -- `notifyArchitect(projectId, gateName, worktreeDir)` function. Fire-and-forget: `execFile` with 10s timeout, errors logged to stderr but never thrown. Called at the two gate-transition points in `next.ts` (max-iterations and post-consultation), NOT at the re-request path (which detects already-pending gates). (Spec 0108)

**Removed**: `gate-watcher.ts` (active poller) and its tests. **Preserved**: `gate-status.ts` (passive status reader) still used by dashboard API in `tower-terminals.ts` and `tower-instances.ts`. (Spec 0108)

#### Tunnel Heartbeat (Spec 0109)

`TunnelClient` now implements WebSocket ping/pong heartbeat for dead connection detection. (Spec 0109)

- Sends `ws.ping()` every 30s (`PING_INTERVAL_MS`), declares dead if no pong within 10s (`PONG_TIMEOUT_MS`)
- On timeout: transitions to `disconnected`, increments `consecutiveFailures`, triggers existing reconnection logic (exponential backoff, circuit breaker)
- `startHeartbeat(ws)` is idempotent -- calls `stopHeartbeat()` first, tracks ws instance via `heartbeatWs` property to prevent duplicate listeners
- `stopHeartbeat()` clears both timers AND removes pong listener from tracked ws via `removeAllListeners('pong')`
- Stale WebSocket guard: pong timeout checks `ws === this.ws` before triggering reconnect, preventing cross-connection interference
- `ws.ping()` errors caught -- falls through to arm pong timeout (defensive improvement over early-return, caught by Codex review)
- Integration points: `startHeartbeat()` after `setState('connected')` in `startH2Server()`; `stopHeartbeat()` in both `cleanup()` and `disconnect()`
- All implementation in `tunnel-client.ts` -- no server-side changes. (Spec 0109)

#### Messaging Infrastructure (Spec 0110)

Standardized agent naming, cross-project messaging via `POST /api/send`, and a WebSocket message bus (`/ws/messages`). (Spec 0110)

**New modules**:
- `utils/agent-names.ts` -- Agent name generation (`builder-{protocol}-{id}` format, leading zeros stripped), parsing, and case-insensitive resolution with tail-match backward compatibility (bare `0109` resolves to `builder-spir-109`). (Spec 0110)
- `servers/tower-messages.ts` -- Address resolution (`resolveTarget()` with `[project:]agent` parsing, workspace basename matching, ambiguity detection returning 409), subscriber management for WebSocket message bus, and `broadcastMessage()`. (Spec 0110)
- `utils/message-format.ts` -- Extracted `formatArchitectMessage()` and `formatBuilderMessage()` from `send.ts` into shared utility. (Spec 0110)

**POST /api/send endpoint** (in `tower-routes.ts`):
- Body: `{ to, message, from?, fromWorkspace?, workspace?, options? }`
- Resolution: `to` parsed via `parseAddress()`, resolved against workspace terminals with exact > tail match priority
- Error codes: 400 (INVALID_PARAMS), 404 (NOT_FOUND), 409 (AMBIGUOUS -- multiple workspace basenames or multiple agent tail matches)
- After writing to terminal, broadcasts structured `MessageFrame` to all `/ws/messages` subscribers
- `fromWorkspace` identifies sender's workspace (for `from.project` in broadcast), distinct from `workspace` (target resolution context). (Spec 0110)

**WebSocket /ws/messages** (in `tower-websocket.ts`):
- Subscribers receive structured JSON `MessageFrame` with timestamp, from (project + agent), to (project + agent), content, metadata
- Optional `?project=` query param filters messages to specific workspace
- Cleanup on close/error events. (Spec 0110)

**Builder naming convention**: `builder-{protocol}-{id}` (e.g., `builder-spir-109`, `builder-bugfix-42`). Worktree paths: `.builders/{protocol}-{id}[-{slug}]/`. Branch names: `builder/{protocol}-{id}[-{slug}]`. All names lowercase, leading zeros stripped from numeric IDs. (Spec 0110)

#### Dead Code Removal (Spec 0111)

Vanilla JS dashboard (`templates/dashboard/`, 16 files, ~4600 LOC) deleted along with dead `clipboard.test.ts`. Replaced by React dashboard (Spec 0085). (Spec 0111)

#### "Project" to "Workspace" Rename (Spec 0112)

Systematic rename of all "project" identifiers meaning "repository/codebase" to "workspace" throughout Tower, Agent Farm, Dashboard, CLI, and HQ packages. (Spec 0112)

**Key changes**:
- `Config.projectRoot` -> `Config.workspaceRoot` (~39 files)
- `findProjectRoot()` -> `findWorkspaceRoot()`
- `ProjectTerminals` -> `WorkspaceTerminals`, `getProjectTerminals` -> `getWorkspaceTerminals`
- URL paths `/project/` -> `/workspace/`, `/api/projects/` -> `/api/workspaces/`
- `known_projects` table -> `known_workspaces` table
- `project_path` column -> `workspace_path` in `terminal_sessions`, `file_tabs`, `known_workspaces`
- Database migration v9 uses CREATE-INSERT-DROP pattern (matching v7/v8 style)
- `codev-hq` wire protocol updated for connector consistency
- Porch `projectId` and work-unit "project" terminology intentionally unchanged. (Spec 0112)

#### Shellper Debug Logging (Spec 0113)

Comprehensive diagnostic logging across the shellper process lifecycle. (Spec 0113)

**Shellper-side** (`shellper-main.ts`, `shellper-process.ts`):
- `logStderr(message)` -- EPIPE-safe timestamped stderr write helper (try/catch, silently ignores EPIPE)
- Lifecycle events logged: startup (pid, command, socket), PTY spawn (pid, cols, rows), SIGTERM, PTY exit (code, signal), socket listen, connection accept/close, HELLO, WELCOME, SPAWN, protocol errors
- `ShellperProcess` accepts `log: (msg: string) => void` callback as constructor parameter (dependency injection for testability). (Spec 0113)

**Tower-side** (`session-manager.ts`):
- `StderrBuffer` -- Ring buffer class (500 elements) with partial-line handling, truncation, and UTF-8 replacement for capturing shellper stderr output
- `wireStderrCapture()` -- Attaches to child process stderr stream, fills StderrBuffer
- `logStderrTail()` -- On session exit, logs last N lines of stderr to Tower logger with deduplication flag (`stderrTailLogged`) preventing double logging from both `exit` and `close` events
- Optional `logger` callback in `SessionManagerConfig`, wired from Tower's `log()` utility
- SessionManager lifecycle methods log: create (start, success with pid, failure), reconnect (attempt + specific failure reason for each of 4 return-null paths), restart (count/delay, max exceeded). (Spec 0113)

**Tower event logging** (`tower-instances.ts`, `tower-terminals.ts`):
- Exit code and signal propagated through `PtySession` exit event to Tower-level logging. (Spec 0113)

#### Consultation Metrics (Spec 0115)

Every `consult` invocation now records timing, token usage, cost, and protocol context to `~/.codev/metrics.db`. (Spec 0115)

**New modules**:
- `commands/consult/metrics.ts` -- `MetricsDB` class wrapping SQLite (`better-sqlite3`, WAL mode, busy_timeout=5000). Single `consultation_metrics` table with 15 columns. `record()` never throws (try/catch with stderr warning). `query()` and `summary()` with SQL aggregation (COUNT, SUM, AVG, GROUP BY) for breakdowns by model, review_type, protocol. (Spec 0115)
- `commands/consult/usage-extractor.ts` -- Token/cost extraction: Claude (SDK `total_cost_usd` and usage fields), Gemini (JSON `stats.models.*.tokens`), Codex (JSONL `turn.completed` events, per-field completeness tracking). Static pricing constants for Gemini and Codex. All parsing wrapped in try/catch returning null on failure. (Spec 0115)
- `commands/consult/stats.ts` -- `consult stats` subcommand with summary tables, `--last N`, `--json`, `--model`, `--days`, `--protocol`, `--project-id` filters. (Spec 0115)

**Integration**: `consult/index.ts` pipes stdout unconditionally, adds `--output-format json` for Gemini and `--json` for Codex to get structured token data. Porch consultation templates in `next.ts` include `--protocol` and `--project-id` flags. (Spec 0115)

#### Shellper Resource Leakage Prevention (Spec 0116)

Addresses accumulating Unix sockets and orphaned OS processes during long Tower sessions and E2E test suites. (Spec 0116)

**Periodic cleanup**: `cleanupStaleSockets()` runs on a configurable interval (`SHELLPER_CLEANUP_INTERVAL_MS`, default 60s, min 1s) in Tower runtime. Interval cleared during graceful shutdown via `clearInterval`. (Spec 0116)

**Defensive creation**: `SessionManager.createSession()` first catch block now calls `child.kill('SIGKILL')` to prevent orphaned shellper processes when `readShellperInfo()` fails. (Spec 0116)

**Test socket isolation**: `SHELLPER_SOCKET_DIR` env var support for isolated test socket directories. Uses `/tmp/` instead of `os.tmpdir()` to avoid macOS `sun_path` 104-byte limit. (Spec 0116)

**Shared test utilities**: Extracted `startTower`, `stopServer`, port helpers from 6 duplicated E2E files into `tower-test-utils.ts` with `extraEnv` parameter. `cleanupAllTerminals()` added to every E2E test's `afterAll`. (Spec 0116)

#### Session Creation Consolidation (Spec 0117)

`defaultSessionOptions()` factory function in `terminal/index.ts` replaces 7 duplicated session creation sites across 5 files. (Spec 0117)

- `SessionDefaults` interface: `cols`, `rows`, `restartOnExit`, plus optional `restartDelay`, `maxRestarts`, `restartResetAfter`
- Accepts `Partial<SessionDefaults>` overrides via spread
- Call sites: `tower-routes.ts` (2), `tower-instances.ts` (1), `spawn-worktree.ts` (1), `pty-manager.ts` (2), `session-manager.ts` (1)
- `DEFAULT_COLS` and `DEFAULT_ROWS` constants remain exported for `shellper-process.ts` class member defaults. (Spec 0117)

#### Shellper Multi-Client Connections (Spec 0118)

Shellper now supports multiple simultaneous connections, enabling `af attach` alongside Tower. (Spec 0118)

**Protocol extension**: `HelloMessage` extended with required `clientType: 'tower' | 'terminal'` field. (Spec 0118)

**Multi-client model** (`shellper-process.ts`):
- `connections: Map<string, ConnectionEntry>` replaces `currentConnection: net.Socket`
- `broadcast()` method sends DATA and EXIT frames to all connected clients
- Tower replacement: new tower connection destroys previous tower connection only; terminal connections always coexist
- Access control: SIGNAL and SPAWN restricted to tower connections (terminal connections silently ignored); DATA and RESIZE from any client
- Backpressure: `socket.write()` returning `false` removes client from map immediately (aggressive but correct -- prevents slow clients degrading broadcast)
- Pre-HELLO frame gating: non-HELLO frames ignored until handshake completes (prevents unauthenticated PTY access)
- `pendingSockets` set tracks pre-HELLO connections for clean shutdown. (Spec 0118)

**af attach** (`commands/attach.ts`):
- Direct Unix-socket connection to shellper via `ShellperClient` with `clientType: 'terminal'`
- Raw terminal mode (no line buffering, no echo), SIGWINCH -> RESIZE frames, Ctrl-C passthrough, Ctrl-\ (0x1c) detach key
- Socket discovery: primary lookup from SQLite `terminal_sessions` table (workspace-scoped), fallback to scanning `~/.codev/run/shellper-*.sock`
- Terminal state restored on disconnect via process exit handler. (Spec 0118)

### Project Management, Reviews & Workflow (Specs 0119-0127, 0325, 0350)

#### Consult CLI Architecture (Spec 0325)

The `consult` CLI has three modes: **general** (ad-hoc prompts), **protocol-based** (structured reviews), and **stats** (metrics). (Spec 0325)

**Mode routing** (in precedence order): (Spec 0325)
1. If first arg is `stats` -> stats mode
2. If `--type` is present -> protocol mode
3. If `--prompt` or `--prompt-file` is present -> general mode
4. None -> error with usage help

**Protocol-owned prompt templates**: Each protocol owns its review prompts in a `consult-types/` subdirectory rather than using shared top-level files. Resolution: `codev/protocols/<protocol>/consult-types/<type>-review.md`. Only `integration-review.md` remains shared in `codev/consult-types/`. (Spec 0325)

| Protocol | Owned Prompts |
|----------|---------------|
| `spir` | spec-review, plan-review, impl-review, phase-review, pr-review |
| `bugfix` | impl-review, pr-review |
| `tick` | spec-review, plan-review, impl-review, pr-review |
| `maintain` | impl-review, pr-review |

**Context resolution** differs by environment: (Spec 0325)
- **Builder worktree** (detected via `/.builders/` in cwd): auto-detects project ID from porch state, resolves spec/plan via glob, impl via git diff from merge-base, PR via `gh pr list --head <branch>`, phase via `git show HEAD`
- **Architect context**: requires `--issue <N>` flag, resolves artifacts via glob and `gh pr list --search`

**PR reviews** receive the full PR diff (via `gh pr diff`) in the prompt plus local filesystem access for surrounding context. No temporary worktrees are created. (Spec 0325)

**All three models get file access**: Claude via Agent SDK tools, Codex via read-only sandbox, Gemini via `--yolo` mode with cwd set to the correct worktree. (Spec 0325)

**Porch command generation** (in `next.ts`): format changed from positional subcommands (`consult --model gemini spec 42`) to flag-based (`consult -m gemini --protocol spir --type spec`). `verify.type` values in protocol.json changed from `spec-review` to `spec`, `plan-review` to `plan`, `impl-review` to `impl`, `pr-ready` to `pr`. (Spec 0325)

#### Codex SDK Integration (Spec 0120)

Codex consultations use `@openai/codex-sdk` instead of spawning the `codex` CLI as a subprocess. This mirrors the existing Claude Agent SDK pattern. (Spec 0120)

- `runCodexConsultation()` in `consult/index.ts` uses `Codex` class with `thread.runStreamed()` for typed streaming events
- Text captured from `item.completed` events with `item.type === 'agent_message'`
- Usage data (tokens, cost) extracted from `turn.completed` structured events
- System prompt passed via `experimental_instructions_file` SDK config (requires temp file, cleaned up in `finally` block)
- Sandbox mode via `config: { sandbox: 'read-only' }`
- Cost computation uses local `CODEX_PRICING` constant; each SDK-based model owns its own cost logic
- Gemini remains subprocess-based (no SDK available)

#### Rebuttal-Based Review Advancement (Spec 0121)

Porch's review iteration loop replaced with a **build-verify-rebuttal** flow: (Spec 0121)

1. Builder creates artifact
2. Porch runs 3-way consultation (unchanged)
3. If all approve: advance immediately (unchanged)
4. If any request changes: porch emits "write rebuttal" task
5. Builder writes rebuttal file -> porch advances immediately (no second consultation)

Rebuttal files follow naming pattern: `codev/projects/<id>-<name>/<id>-<phase>-iter<N>-rebuttals.md`. The rebuttal replaces the iteration loop entirely -- `max_iterations` stays at 1, iteration counter is not incremented for rebuttals. The safety valve is unreachable and was removed. (Spec 0121)

#### Tower Shellper Reconnect Enhancement (Spec 0122)

**Bounded concurrency for reconnection probes**: The sequential `for...of` loop in `reconcileTerminalSessions()` was refactored into batched `Promise.allSettled` with a concurrency limit of 5. This prevents slow startup when many dead shellper sessions exist (e.g., 10 dead sessions with 2s timeout each would take 20s sequentially vs ~4s batched). (Spec 0122)

#### Codebase Deduplication (Spec 0123)

Architectural refactoring of ~190 net LOC removal through centralization of bypassed abstractions: (Spec 0123)

- **TowerClient completeness**: Added `signalTunnel()`, `getTunnelStatus()`, `getStatus()`, `sendNotification()` methods. Extended `createTerminal()` options to include `persistent`, `workspacePath`, `type`, `roleId`. Eliminated 4 files that bypassed TowerClient with raw `fetch()`.
- **Centralized constants**: `AGENT_FARM_DIR` exported from single location. `DEFAULT_CLOUD_URL` centralized in `cloud-config.ts`. `DEFAULT_DISK_LOG_MAX_BYTES` exported from `terminal/index.ts`. `DEFAULT_TOWER_PORT` no longer defined outside `tower-client.ts`.
- **Deduplication**: `createPtySession()` deleted (callers use `TowerClient.createTerminal()`). `prompt()`/`confirm()` imported from `cli-prompts.ts`. `isPortAvailable()` extracted from `shell.ts`. `escapeHtml()`/`readBody()` imported from `server-utils.ts`. `getTypeColor()` extracted to `utils/display.ts`. `encodeWorkspacePath`/`decodeWorkspacePath` imported in server modules instead of inlining base64url.
- **Shared utility**: `logSpawnSuccess()` helper in `spawn.ts` replaces 6 copy-pasted success blocks.
- **Intentionally skipped**: db/ logger bypass (db module runs in Tower process where CLI logger formatting may corrupt log files).

#### Test Suite Consolidation (Spec 0124)

Test suite reduced from 1,495 tests (76 files) to 1,368 tests (73 files) -- net reduction of 127 tests and 11 test files with zero coverage loss. (Spec 0124)

Removals organized into four categories:
1. Obsolete bugfix regression files (6 files) -- bugs already covered by unit tests
2. Terminal/session test consolidation -- `pty-session.test.ts` merged into `session-manager.test.ts`, `pty-manager.test.ts` reduced
3. Tunnel test consolidation -- `tunnel-client.integration.test.ts` merged into `tunnel-client.test.ts`
4. Trivial test removal -- type-check tests, string operation tests, lookup table tests, singleton pattern tests

#### Project Management Architecture (Spec 0126)

> **Note**: The Work View UI components are documented in the [Dashboard UI](#dashboard-ui-react--vite-spec-0085) section above. This entry covers the backend architecture and design rationale.

**GitHub Issues as project registry**: GitHub Issues replaced `projectlist.md` as the project tracking mechanism (Spec 0126). Issue number is the universal identifier for spec/plan/review files, branches, and worktrees. Status is **derived from what exists** (filesystem + Tower state), not manually tracked:
- Conceived = open issue, no spec file
- Specified = open issue + `codev/specs/<N>-*.md` exists
- Implementing = active Builder worktree
- Committed = open PR referencing issue
- Integrated = issue closed

**Shared GitHub utility**: `packages/codev/src/lib/github.ts` provides `fetchGitHubIssue()`, `fetchPRList()`, `fetchIssueList()`, `parseLinkedIssue()`, `parseLabelDefaults()`. (Spec 0126)

**`getProjectSummary()` replacement**: Three-tier fallback -- GitHub issue title (primary), spec file heading (fallback), status.yaml title (last resort). Only used in strict mode (porch). (Spec 0126)

**Spawn CLI rework**: `af spawn <N> --protocol <proto>` -- positional arg replaces `-p`/`--issue` flags. `--protocol` is required (no auto-detection). `--amends <N>` for TICK amendments. `--resume` reads protocol from existing worktree. Legacy zero-padded spec matching via `stripLeadingZeros()`. (Spec 0126)

**Tower `/api/overview` endpoint**: Aggregates Builder state (from filesystem + porch status.yaml), cached PR list (from `gh pr list`, 60s TTL), and cached backlog (from `gh issue list` cross-referenced with `codev/specs/` glob and `.builders/`). `POST /api/overview/refresh` for manual cache invalidation. Degraded mode when `gh` unavailable: builders shown, PR/backlog empty with error field. (Spec 0126)

**`OverviewCache` class**: In-memory cache layer in `packages/codev/src/agent-farm/servers/overview.ts` with 60s TTL for GitHub data. (Spec 0126)

**Scaffold changes**: `codev init`/`adopt` no longer create `projectlist.md` or `projectlist-archive.md`. `codev doctor` checks `gh` CLI authentication. (Spec 0126)

#### Tower Async Request Handlers (Spec 0127)

Three `execSync` calls in Tower HTTP request handlers converted to `util.promisify(child_process.exec)`: (Spec 0127)
- `handleWorkspaceGitStatus()` -- `git status --porcelain` (5s timeout, hot path polled by dashboard)
- `handleCreateWorkspace()` -- `codev init --yes` (60s timeout, cold path)
- `launchInstance()` -- `npx codev adopt --yes` (30s timeout, cold path)

This prevents the Node.js event loop from blocking during subprocess execution, keeping terminal WebSocket traffic and dashboard polling responsive.

#### Tip of the Day (Spec 0350)

Frontend-only feature: `TipBanner` component in the dashboard Work view. (Spec 0350)

- `TipBanner.tsx` -- self-contained component with no props, reads localStorage directly
- `tips.ts` -- static array of 51 tips covering af, porch, consult, workflow, dashboard, and protocol categories
- Daily rotation via `tips[dayOfYear % tips.length]` using local time
- Arrow navigation with wraparound, dismiss via localStorage keyed by `tip-dismissed-YYYY-MM-DD`
- Inline code span rendering: backtick-delimited text split and wrapped in `<code>` elements
- Positioned in WorkView between error area and first section

### Operational Features & Quality (Specs 0364, 0376, 0386, 0395, 0399, 0403, Bugfixes)

#### Dashboard UI -- Terminal Floating Controls (Spec 0364)

Terminal windows include floating controls for manual PTY resync and navigation. A `TerminalControls` component renders two small icon buttons (refresh and scroll-to-bottom) in the top-right corner of every terminal window (architect, builder, shell).

- **Refresh button**: Calls `fitAddon.fit()` to recalculate dimensions from the container, then sends a `resize` control message to the PTY backend (guarded by `ws.readyState === WebSocket.OPEN`)
- **Scroll-to-bottom button**: Calls `terminal.scrollToBottom()` on the xterm instance
- **Focus preservation**: Uses `onPointerDown` with `preventDefault()` and `tabIndex={-1}` (same pattern as `VirtualKeyboard.tsx`) to prevent stealing focus from the terminal
- **Positioning**: Absolutely positioned inside the terminal's parent flex-column div with `position: relative`. Cannot be rendered inside the `containerRef` div because xterm.js takes ownership of that element's DOM. `right: 20px` offset accounts for the xterm virtual scrollbar width.
- **Mobile support**: 32px minimum tap targets, `touch-action: manipulation` to prevent double-tap zoom, `:active` feedback for touch

**Key files**:
- `dashboard/src/components/Terminal.tsx` -- `TerminalControls` component defined and integrated
- `dashboard/src/index.css` -- CSS styles for `.terminal-controls` and `.terminal-control-btn`

#### af cron -- Tower-Resident Scheduled Task Scheduler (Spec 0399)

Tower includes a lightweight cron scheduler that loads workspace-defined task definitions from `.af-cron/*.yaml` and executes them on schedule, delivering results via the existing `af send` pipeline.

**Design decision: Tower-resident over system cron.** System cron was rejected because: (1) system cron runs with minimal env lacking user PATH and tokens, causing silent failures; (2) every YAML change requires `af cron install` sync; (3) system cron keeps firing when Tower is down, producing zombie executions. Tower already runs interval-based patterns (rate limit cleanup, shellper cleanup), so the scheduler follows the same model -- zero setup, inherits Tower's full environment, auto-detects YAML changes on each 60-second tick, and stops when Tower stops.

**Architecture**:
```
Tower Server
+-- existing intervals (rate limit, shellper cleanup)
+-- CronScheduler (tower-cron.ts)
    +-- loads task definitions from .af-cron/ per workspace (js-yaml)
    +-- tracks last-run timestamps in global.db (cron_tasks table)
    +-- executes tasks async via child_process.exec (non-blocking)
    +-- evaluates condition against command output (new Function)
    +-- sends results via shared send pipeline (format + write + broadcast)
```

**Task definition format** (`.af-cron/*.yaml`):
| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Human-readable task name |
| `schedule` | yes | Standard 5-field cron expression or shortcut (`@hourly`, `@daily`, `@startup`) |
| `enabled` | no | Default `true` |
| `command` | yes | Shell command to execute |
| `condition` | no | JS expression against `output` string; truthy = notify |
| `message` | yes | Message template with `${output}` substitution |
| `target` | no | Default `architect` |
| `timeout` | no | Default 30 seconds |
| `cwd` | no | Default workspace root |

**SQLite schema** (migration v10 on global.db):
```sql
CREATE TABLE cron_tasks (
  id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  task_name TEXT NOT NULL,
  last_run INTEGER,
  last_result TEXT,
  last_output TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(workspace_path, task_name)
);
```

**Cron parser** (`tower-cron-parser.ts`): Minimal ~80-line parser supporting `*`, `*/N`, fixed values, and comma-separated lists. No external dependencies. Shortcuts: `@hourly` = `0 * * * *`, `@daily` = `0 9 * * *` (9am, not midnight), `@startup` = runs once at Tower init.

**Execution model**: 60-second tick interval. Each tick reads `.af-cron/*.yaml` from all known workspaces (no caching -- changes picked up within 60s). Tasks execute via async `child_process.exec` with timeout. `@startup` tasks always run once per Tower start, ignoring `last_run`. Output truncated to 4KB before storing in SQLite.

**Tower API routes**:
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/cron/tasks` | List tasks (optional `?workspace=` filter) |
| `GET` | `/api/cron/tasks/:name/status` | Task status and last run info |
| `POST` | `/api/cron/tasks/:name/run` | Manually trigger a task |
| `POST` | `/api/cron/tasks/:name/enable` | Enable a disabled task |
| `POST` | `/api/cron/tasks/:name/disable` | Disable a task |

**CLI commands**: `af cron list [--all]`, `af cron status`, `af cron run <name>`, `af cron enable <name>`, `af cron disable <name>`.

**Lifecycle**: `initCron()` called in Tower's `server.listen` callback (after `initInstances()`). `shutdownCron()` called in `gracefulShutdown()` (before `shutdownInstances()`).

**Key files**:
| File | Purpose |
|------|---------|
| `servers/tower-cron.ts` | Scheduler module: YAML loading, async execution, condition evaluation, message delivery, SQLite state tracking (~400 lines) |
| `servers/tower-cron-parser.ts` | Minimal cron expression parser (~80 lines) |
| `commands/cron.ts` | CLI handler for `af cron` subcommands |

#### af send Typing Awareness -- Send Buffer (Spec 0403)

The `af send` message delivery system includes typing awareness to prevent message injection while the architect is composing input. When a user is actively typing, incoming messages are buffered and delivered after an idle period.

**Approach**: Idle detection was selected over queue-until-submit. Rationale: (1) simpler implementation (timestamp + timer vs. state machine + Enter detection); (2) universal -- works with any terminal application, not just Claude Code; (3) no edge cases with editors where Enter means newline, not "done typing."

**Input tracking** (`pty-session.ts`):
- `_lastInputAt: number` -- epoch timestamp of last user keystroke
- `recordUserInput()` -- called on every `data` frame from WebSocket (in both `pty-manager.ts` and `tower-websocket.ts`)
- `isUserIdle(thresholdMs)` -- returns `true` when `Date.now() - _lastInputAt >= thresholdMs`
- Control messages (resize, ping) do NOT update `lastInputAt` -- only actual data input counts

**Send buffer** (`send-buffer.ts`):
- `SendBuffer` class with per-session FIFO queue
- `idleThresholdMs`: default 3000ms (3 seconds of no keystrokes)
- `maxBufferAgeMs`: default 60000ms (force delivery after 60 seconds regardless of typing state)
- 500ms flush interval checks all buffered sessions
- Messages delivered in order when user becomes idle
- Dead session messages discarded with warning log
- `interrupt: true` option bypasses buffering entirely (for `--interrupt` flag)
- Force flush on graceful shutdown ensures no message loss

**API response change**: `af send` now returns `{ ok: true, terminalId, resolvedTo, deferred: boolean }` -- the `deferred` field indicates whether the message was buffered or delivered immediately.

**Lifecycle**: `startSendBuffer()` called after `initTerminals()` in Tower startup. `stopSendBuffer()` called in `gracefulShutdown()`.

**Key files**:
| File | Purpose |
|------|---------|
| `terminal/pty-session.ts` | Added `_lastInputAt`, `recordUserInput()`, `isUserIdle()` |
| `servers/send-buffer.ts` | `SendBuffer` class with per-session queuing and flush timer |
| `servers/tower-routes.ts` | Modified `handleSend` to check idle state and defer/deliver |
| `servers/tower-websocket.ts` | Added `recordUserInput()` calls on data frames |
| `servers/tower-server.ts` | Wired `startSendBuffer()`/`stopSendBuffer()` lifecycle |

#### Bugfix #274 -- Tower Startup Race Condition (Bugfix 274)

A race condition in Tower's startup sequence caused architect terminal sessions to be permanently lost during `af tower stop && af tower start`. Root cause: `initInstances()` was called BEFORE `reconcileTerminalSessions()`, allowing dashboard polls to trigger on-the-fly shellper reconnection that raced with the reconciliation process, corrupting sessions.

**Fix (two layers)**:
1. **Startup reorder** (`tower-server.ts`): `reconcileTerminalSessions()` now runs BEFORE `initInstances()`. Since `getInstances()` returns `[]` when `_deps` is null, no dashboard poll can trigger `getTerminalsForWorkspace()` during reconciliation.
2. **Reconciling guard** (`tower-terminals.ts`): Added `_reconciling` flag that blocks on-the-fly shellper reconnection in `getTerminalsForWorkspace()` while `reconcileTerminalSessions()` is running. Closes a secondary race path through `/workspace/<path>/api/state` (identified by Codex during CMAP review).

#### Bugfix #324 -- Shellper Pipe-Based Stdio Dependency (Bugfix 324)

Shellper processes were dying during Tower restarts because of a pipe-based stdio dependency. The shellper's stderr was piped to Tower via `stdio: ['ignore', 'pipe', 'pipe']`. When Tower exited, the broken pipe caused unhandled EPIPE errors that crashed the shellper.

**Fix (two parts)**:
1. **Primary** (`session-manager.ts`): Redirect shellper stderr to a log file (`socketPath.replace('.sock', '.log')`) instead of a pipe. File FDs have no parent dependency.
2. **Defense-in-depth** (`shellper-main.ts`): Add `stream.on('error', () => {})` handlers on `process.stdout` and `process.stderr` at startup.

**Key insight**: `detached: true` and `child.unref()` are necessary but not sufficient for process independence -- any pipe-based stdio creates a lifecycle dependency between parent and child processes. Use file FDs or `'ignore'` for truly independent children.

#### SPIR Review Phase -- Mandatory arch.md and lessons-learned.md Updates (Spec 0395)

As of Spec 0395, the SPIR review phase prompt and review template instruct builders to update `arch.md` and `lessons-learned.md` as part of every SPIR review, with porch enforcement via `protocol.json` checks (`review_has_arch_updates`, `review_has_lessons_updates`). TICK protocol is excluded since TICKs are small fixes unlikely to have architectural implications.

#### Development Analysis Infrastructure (Spec 0376)

Spec 0376 establishes the pattern for periodic development analysis: a pure documentation task that synthesizes data from review files, GitHub PRs/issues, git history, consult stats, and porch project state into a comprehensive analysis document. Output at `codev/resources/development-analysis-2026-02-17.md` covers autonomous builder performance, porch effectiveness, multi-agent review value, system throughput, and cost analysis.

**Research agent pattern**: Spawning a subagent to read all review files in parallel and return structured data is a reusable approach for future analyses.

#### Documentation Audit Tier System (Spec 0386)

Spec 0386 establishes a three-tier documentation audit framework for keeping all project documentation current:

- **Tier 1 (Public-facing)**: README.md, CHANGELOG.md, CLAUDE.md/AGENTS.md, docs/*.md, release notes
- **Tier 2 (Developer reference)**: codev/resources/*.md, command references
- **Tier 3 (Skeleton templates)**: codev-skeleton/ files shipped to other projects

**Key rule**: Historical release notes are read-only -- stale reference cleanup applies only to instructional/current documentation, not historical records.

## Recent Infrastructure Changes

See [CHANGELOG.md](../../CHANGELOG.md) for detailed version history including:

**v1.6.0 (Gothic)**:
- BUGFIX protocol for GitHub Issue-based bugfixes (Spec 0065)
- CLI: `af spawn N --protocol bugfix`, `af cleanup --issue N`
- Tower subcommands with improved logging
- Tutorial system scaffolded (Spec 0006 preparation)

**v1.5.x (Florence)**:
- Dashboard modularization with hot reload (Spec 0060)
- Daily activity summary (Spec 0059)
- File search with Cmd+P palette (Spec 0058)
- Dashboard tab overhaul with two-column layout (Spec 0057)
- Consult types refactor (Spec 0056)
- Dashboard file browser (Spec 0055)
- Generate image tool (Spec 0054)
- Image support in `af open` (Spec 0053)
- STL/3MF 3D model viewer (Spec 0061)
- Secure remote access with SSH tunneling (Spec 0062)
- Direct CLI access to architect session (Spec 0002-TICK-001)

**v1.4.x (Eichler)**:
- Agent Farm internals documentation (Spec 0052)
- Codev cheatsheet (Spec 0051)
- Dashboard polish (Spec 0050)

**Earlier**:
- SQLite state management (Spec 0031)
- Consult tool (Spec 0022)
- Architecture consolidation (Spec 0008)
- Tab bar status indicators (Spec 0019)
- Terminal file click (Spec 0009)

## Integration Testing Requirements

**CRITICAL**: Integration tests MUST pass before any Tower/Agent Farm release.

### Required Test Scenarios

Based on consultation with external models, these scenarios MUST be tested:

1. **Multi-Dashboard Survival Test**
   - Activate project A
   - Activate project B
   - Verify both projects remain active (project A not killed)

2. **Project View Test**
   - Navigate to Tower UI
   - Verify project list loads
   - Verify project status (active/inactive) is correct

3. **Terminal Connectivity Test**
   - Activate a project
   - Connect to architect terminal via WebSocket
   - Verify terminal receives output

4. **State Persistence Test** (Shellper, Spec 0104)
   - Activate project (creates shellper-backed architect terminal)
   - Restart Tower
   - Verify project reconnects to surviving shellper process
   - Verify architect terminal shows replay data (output continuity)
   - Verify terminal is interactive (keystrokes reach shell)

### Running Integration Tests

```bash
# Run Tower E2E tests (Playwright)
npm run test:e2e -- --grep "tower"

# Run with headed browser for debugging
npm run test:e2e -- --grep "tower" --headed
```

### Test Infrastructure Files

| File | Purpose |
|------|---------|
| `packages/codev/src/agent-farm/__tests__/tower-api.test.ts` | Tower API unit tests |
| `packages/codev/src/agent-farm/__tests__/e2e/tower.spec.ts` | Tower E2E tests (Playwright) |
| `packages/codev/src/terminal/__tests__/shellper-protocol.test.ts` | Shellper wire protocol unit tests (Spec 0104 Phase 1) |
| `packages/codev/src/terminal/__tests__/shellper-process.test.ts` | Shellper process logic unit tests (Spec 0104 Phase 1) |
| `packages/codev/src/terminal/__tests__/shellper-client.test.ts` | ShellperClient unit tests (Spec 0104 Phase 2) |
| `packages/codev/src/terminal/__tests__/session-manager.test.ts` | SessionManager unit/integration tests (Spec 0104 Phase 2) |
| `packages/codev/src/terminal/__tests__/tower-shellper-integration.test.ts` | PtySession + ShellperClient integration tests (16 tests, Spec 0104 Phase 3) |

---

**Last Updated**: 2026-02-18
**Version**: v2.0.0-rc.54 (Pre-release)
**Changes**: Documentation sweep (Spec 0422) -- deduplicated historical entries against original sections, normalized spec zero-padding, updated outdated port system and API path references for Spec 0098 (port removal) and Spec 0112 (project-to-workspace rename), consolidated cross-references.
