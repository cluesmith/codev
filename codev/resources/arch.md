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
| **Protocol** | Defined workflow for a type of work (SPIR, TICK, BUGFIX, MAINTAIN, EXPERIMENT, RELEASE) |
| **SPIR** | Multi-phase protocol: Specify → Plan → Implement → Review |
| **TICK** | Amendment protocol for extending existing SPIR specs |
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
│                   Dashboard (React SPA on Tower :4100)               │
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
1. User opens dashboard at `http://localhost:4100`
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

**Workspace-scoped APIs (via Tower proxy):**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/workspace/:enc/` | Serve React dashboard for workspace |
| `GET` | `/workspace/:enc/api/state` | Get workspace state (architect, builders, shells) |
| `POST` | `/workspace/:enc/api/tabs/shell` | Create shell terminal for workspace |
| `DELETE` | `/workspace/:enc/api/tabs/:id` | Close a tab |
| `POST` | `/workspace/:enc/api/stop` | Stop all terminals for workspace |
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
- Tower server + Dashboard + WebSocket terminals: `127.0.0.1:4100`
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
  - `protocols/` - Protocol definitions (SPIR, TICK, BUGFIX, MAINTAIN, EXPERIMENT, RELEASE)
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
│   │   │   │   └── tower-tunnel.ts     # Cloud tunnel client lifecycle
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

**Framework**: Vitest (unit/integration) + Playwright (E2E browser tests)

**Location**:
- Unit tests: `packages/codev/src/__tests__/`
- E2E tests: `packages/codev/tests/e2e/`
- Config: `packages/codev/vitest.config.ts`, `packages/codev/vitest.unit.config.ts`

**Running Tests**:
```bash
cd packages/codev
npm test                     # All Vitest tests
npm run test:unit            # Unit tests only
npx playwright test          # E2E browser tests
```

See `codev/resources/testing-guide.md` for Playwright patterns and Tower regression prevention.

### 5. Porch (Protocol Orchestrator)

**Location**: `packages/codev/src/commands/porch/`

**Purpose**: Porch is a stateless planner that drives SPIR, TICK, and BUGFIX protocols via a state machine. It does NOT spawn subprocesses or call LLM APIs — it reads state, decides the next action, and emits JSON task definitions that the Builder executes.

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
| 1 | HTTP server binds to `localhost:port` | Must be listening before anything registers routes |
| 2 | SessionManager init + stale socket cleanup | Prepares shellper infrastructure |
| 3 | `initTerminals()` | Terminal management module ready |
| 4 | `startSendBuffer()` | Typing-aware message delivery ready |
| 5 | **`reconcileTerminalSessions()`** | **MUST run before step 7** — reconnects shellper sessions from previous run |
| 6 | `killOrphanedShellpers()` | **MUST run after step 5** — avoids killing sessions that were just reconnected |
| 7 | `initInstances()` | Enables workspace API handlers — triggers dashboard polling |
| 8 | `initCron()` | Scheduler starts after instances ready |
| 9 | `initTunnel()` | Cloud tunnel connects last |
| 10 | WebSocket upgrade handler installed | Terminal connections accepted |

**Known ordering bugs**:
- **Bugfix #274**: `initInstances()` before `reconcileTerminalSessions()` allowed dashboard polls to race with reconciliation, corrupting shellper sessions
- **Bugfix #341**: Killing orphaned shellpers before reconciliation killed sessions that were about to be reconnected

**Defense in depth**: During startup, `getTerminalsForWorkspace()` skips on-the-fly shellper reconnection (via `_reconciling` guard) to prevent races through alternate code paths.

### 7. Message Delivery (`af send`)

**Location**: `servers/send-buffer.ts`, `commands/send.ts`, `terminal/pty-session.ts`

Messages sent via `af send` are not injected immediately — they pass through a **typing-aware send buffer** that prevents message injection while the user is actively typing.

#### How it works

1. **User types** in terminal → WebSocket `data` event → `PtySession.recordUserInput()` updates `lastInputAt` timestamp
2. **`af send` message arrives** → Tower buffers it via `SendBuffer.enqueue()`
3. **Every 500ms**, `SendBuffer.flush()` checks each buffered session:
   - If `session.isUserIdle(3000ms)` → deliver all buffered messages
   - Else if any message age ≥ 60 seconds → deliver regardless (max buffer age)
   - Otherwise, keep buffering
4. **`--interrupt` option** → Sends Ctrl+C first, bypasses buffer entirely

#### Constants

| Constant | Default | Purpose |
|----------|---------|---------|
| Idle threshold | 3,000ms | User must be idle this long before delivery |
| Max buffer age | 60,000ms | Messages delivered regardless after this time |
| Flush interval | 500ms | How often the buffer checks for delivery |

#### Address Resolution

`af send` resolves addresses via Tower API with tail-matching: `"0109"` matches `"builder-spir-0109"`. Supports `--all` for broadcast, `--file` for file attachments (48KB max), and `--raw` to skip structured formatting.

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

### 6. TICK Protocol for Fast Iteration
**Decision**: Create lightweight protocol for simple tasks

**Rationale**:
- SPIR is excellent but heavy for simple tasks
- Fast iteration needed for bug fixes and utilities
- Single autonomous execution reduces overhead
- Multi-agent review at end maintains quality
- Fills gap between informal changes and full SPIR

### 7. Single Canonical Implementation (TypeScript agent-farm)
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

### 8. Global Registry for Multi-Workspace Support
**Decision**: Use `~/.agent-farm/global.db` (SQLite) for cross-workspace coordination

**Rationale**:
- **Cross-workspace coordination** - Multiple repos tracked simultaneously
- **Terminal session persistence** - Session metadata survives Tower restarts
- **File locking** - Prevents race conditions during concurrent operations
- **Stale cleanup** - Automatically removes entries for deleted workspaces

> **Historical note** (Spec 0008, Spec 0098): Originally allocated deterministic 100-port blocks per repository. After the Tower Single Daemon architecture (Spec 0090), per-workspace port blocks became unnecessary and were removed in Spec 0098. The global registry now tracks workspace metadata and terminal sessions instead.

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



## Troubleshooting

See the [Quick Tracing Guide](#quick-tracing-guide) for debugging entry points.

Additional issues:
- **Tests hanging**: Install `coreutils` on macOS (`brew install coreutils`)
- **Permission errors**: `chmod -R u+w /tmp/codev-test.*`
- **Agent not found**: Claude Code uses `.claude/agents/`, other tools use `codev/agents/`

## Maintenance

See [MAINTAIN protocol](../protocols/maintain/protocol.md) for codebase hygiene and documentation sync procedures.

---

**Last Updated**: 2026-02-18
**Version**: v2.0.0-rc.54 (Pre-release)
**Changes**: Refinement round 3/4 -- polish pass. See CHANGELOG.md for version history.
