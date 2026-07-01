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
- **Shared Runtime**: `packages/core/` — TowerClient, auth, workspace encoding, EscapeBuffer, ReconnectPolicy
- **VS Code Extension**: `packages/vscode/` — thin client over Tower API
- **Dashboard**: `packages/dashboard/` — React SPA served by Tower
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

## Agent Farm Internals

This section provides comprehensive documentation of how the Agent Farm (`afx`) system works internally. Agent Farm is the most complex component of Codev, enabling parallel AI-assisted development through the architect-builder pattern.

### Architecture Overview

Agent Farm orchestrates multiple AI agents working in parallel on a codebase. Two clients connect to the same Tower server:

```
┌─────────────────────────────┐  ┌─────────────────────────────┐
│  Browser Dashboard          │  │  VS Code Extension          │
│  (React SPA on Tower :4100) │  │  (packages/vscode)          │
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

#### Terminal reconnect/replay contract (#1047)

When a WebSocket client attaches, Tower replays the ring buffer as a binary DATA frame **bracketed by `pause`/`resume` control frames** so the client can render the (potentially large) snapshot without counting it against its live-backpressure budget. Clients pass `?resume=<seq>` to request only the bytes after a sequence number (a *delta* reconnect) instead of the full buffer — the dominant cost saver when Tower is hosted remotely and reconnects are frequent. The ring-buffer `partial` (incomplete trailing line) is kept **whole and unbounded** so a full-screen TUI's alt-screen state replays faithfully; per-frame CPU is bounded instead by `pushData` scanning only the new chunk (not re-splitting the accumulated buffer). On the client side, a connecting terminal must **force a redraw** shortly after attach (a size-delta resize → SIGWINCH) — a full-screen TUI only repaints on a size *change*, and the connect-time resize can be a same-size no-op; both the web dashboard (`Terminal.tsx`) and the VSCode adapter (`terminal-adapter.ts`) do this. Under genuine *live* overload, clients **drop** ephemeral output (the app repaints) rather than reconnecting — reconnecting to relieve backpressure re-pulls the same payload and storms.

A client must also **render the replay at the *settled* terminal size, not the connect-time size (#1052)**. VSCode reports a freshly-opened terminal's dimensions in two steps (~120ms apart), so painting the bracketed replay immediately wraps the restored history at a transient width and strands a stale frame in the scrollback (a "ghost" status bar, visible on scroll). The VSCode adapter (`terminal-adapter.ts`) holds all output from `pause` and paints it once via a flush debounced on `setDimensions` (`REPLAY_SETTLE_MS`), so the frame lands at the final width — mirroring the web dashboard's `flushInitialBuffer` (`Terminal.tsx`). Note the lever asymmetry: a PTY-side SIGWINCH (the connect-time redraw above) repaints the app's *current frame* but cannot re-wrap xterm's existing *scrollback*, so wrong-width history must be prevented (render-once-at-settled-size), not patched after the fact.

#### Startup Readiness Barrier (#997)

Tower binds its port and starts serving immediately, but `reconcileTerminalSessions()` (which re-registers persistent sessions in the `workspaceTerminals` map) runs *after* `server.listen()`. To stop the first post-restart read from seeing a half-populated `role → terminalId` map, a monotonic settled-once barrier in `tower-terminals.ts` gates the readers of reconcile's output:

- `getRehydratedTerminalsEntry()` (the shared chokepoint behind `/api/state` and `/api/overview`) and both WS terminal-upgrade routes `await whenStartupReconcileSettled()` before reading the map. The barrier is released in `reconcileTerminalSessions()`'s `finally` (and its early `!_deps` return), with a defensive per-request timeout (`CODEV_STARTUP_READY_TIMEOUT_MS`, default 10s) so a hung reconcile can't wedge serving.
- `isStartupReconcileSettled()` is distinct from `isReconciling()` (which is false both before and after reconcile): it flips false→true once and stays true. `GET /health` exposes it as `ready` — **liveness** (`status: 'healthy'`, port up) stays separate from **readiness** (reconcile complete).

**Invariant for new Tower-startup work**: any endpoint that reads `workspaceTerminals` to build a response should route through `getRehydratedTerminalsEntry` so it inherits the gate, rather than reading the map directly.

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
3. Delegates the CLI-specific injection to the configured `HarnessProvider` (`agent-farm/utils/harness.ts`, Spec 591): claude `--append-system-prompt`, codex `-c model_instructions_file=`, gemini `GEMINI_SYSTEM_MD` env var

**Three architect creation points** where role injection is applied:
- `tower-instances.ts` → `launchInstance()` (new project activation)
- `tower-terminals.ts` → `reconcileTerminalSessions()` (startup reconnection with auto-restart options)
- `tower-terminals.ts` → `getTerminalsForWorkspace()` (on-the-fly shellper reconnection)

#### Builder Prompt: Protocol & Template Delivery (#1011)

Framework files (protocol docs, templates) live in the package skeleton (resolver tier 4) and are not guaranteed on disk in a fresh install, so builder-facing prompts must not fetch them by literal `codev/...` path. They are *delivered* through resolver-aware channels instead:

- **`{{protocol_reference}}`** — `buildPromptFromTemplate` (`agent-farm/commands/spawn-roles.ts`) fills this context variable by reading the protocol's `protocol.md` fresh through the four-tier resolver at spawn and inlining it under the prompt's "Protocol Reference (full text)" heading. Nothing is committed into the prompt, so nothing goes stale.
- **`{{> <codev-path>}}`** — a Handlebars-style include directive resolved by the shared `resolveCodevIncludes()` (`lib/skeleton.ts`): it pulls the referenced framework file fresh through the resolver (recursive, depth-guarded, unresolved includes drop to empty). It runs on two channels: at spawn (inside `protocol.md`, e.g. experiment/spike templates) and in porch's `loadPromptFile` (`commands/porch/prompts.ts`) for phase prompts (e.g. the spir/aspir plan template, which carries the machine-readable phases JSON the plan gate requires).

A `codev doctor` audit (`lib/framework-ref-audit.ts`) flags shell-fetch of framework files in a project's local `codev/` overrides; the shipped skeleton is guarded by a CI unit test.

#### Supported Architect Harnesses & Conversation Resume (#929)

**Supported architect harnesses** (Issue #929): claude and codex are supported as architects, selected via `.codev/config.json` (`shell.architect` / `shell.architectHarness`) — the same config-driven mechanism builders use, and the *recommended* one. **Gemini is builder-only** — the Gemini CLI is retiring (#778), so it is not offered or affirmed as an architect (its `GEMINI_SYSTEM_MD` builder surface stays); `doctor` warns if `gemini` is configured as an architect. (agy, the gemini successor, is deferred as an architect to #1063 — its only role-injection channel is a visible first user turn.) Harness auto-detection is **override-aware**: `getArchitectHarness` / `getBuilderHarness` resolve the harness from the override-aware command (`getResolvedCommands` → `cliOverrides` / `TOWER_ARCHITECT_CMD` / config), so a `--architect-cmd codex` / `TOWER_ARCHITECT_CMD=codex` / `--builder-cmd gemini` with no matching harness config still resolves the *non-claude* harness, not claude. (Before #929 it auto-detected from the raw config value only — an override launched the non-claude CLI but resolved the claude harness, re-arming the resume crash-loop below.) An explicit `shell.architectHarness` / `shell.builderHarness` still wins over auto-detection. OpenCode remains builder-only (file-based injection needs an ephemeral worktree). Codex reads project context (`AGENTS.md`) natively, so no architect context-file seam is needed; the `getArchitectFiles` seam #1059 added for gemini was removed with gemini's architect support.

> **Caveat — unrecognized override commands still default to the claude harness (tracked in cluesmith/codev#1062).** `#929`'s override-awareness only covers *recognized* harness commands (claude/codex/gemini/opencode, matched by `detectHarnessFromCommand`). An override command the detector does **not** recognize — e.g. `TOWER_ARCHITECT_CMD=bash`, a wrapper script, or any custom launcher — with **no** explicit `shell.architectHarness` / `shell.builderHarness` falls through `resolveHarness` to the **claude** harness (`harness.ts`, the final `return CLAUDE_HARNESS`). With a stale Claude `.jsonl` present, that can still build `<cmd> --resume <uuid>` for the unrecognized command. This is **pre-existing and narrow** (not a #929 regression — #929 strictly *improved* the recognized codex case) and separable. Mitigation today: set an explicit `shell.architectHarness` / `shell.builderHarness` when using an unrecognized launcher command.

**Conversation resume is Claude-main-only.** `launchInstance` resumes a prior session only when the configured harness implements `HarnessProvider.buildResume` — currently just claude (its sessions live at `~/.claude/projects/<encoded-cwd>/*.jsonl`). Codex architects (and resumed codex/gemini *builders*, via `spawn.ts` `discoverResumeSession`) return `null` from `buildResume` and relaunch fresh with role injection. This gating fixes a latent crash-loop where a non-Claude harness + a stale Claude `.jsonl` built an invalid `<cmd> --resume <claude-uuid>` invocation and shellper restart-looped to death.

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
- **Remove**: `afx workspace remove-architect <name>` (also dashboard close-X + VSCode right-click). Server refuses `main`. Removing an architect with in-flight builders proceeds — builders fall back to `main` routing.
- **Graceful stop**: `afx workspace stop` sets the `intentionallyStopping` flag (`tower-instances.ts`) so the six cascaded exit handlers (4 in `tower-instances.ts`, 2 in `tower-terminals.ts`) skip the `setArchitectByName(workspacePath, name, null)` call. Sibling rows in `state.db.architect` survive the stop, scoped by `workspace_path`.
- **Graceful start**: `launchInstance` creates `main` if absent (gate changed from `entry.architects.size === 0` to `!entry.architects.has('main')`), then iterates persisted siblings via `getArchitects(resolvedPath)` — workspace-scoped (Bugfix #826) — and re-spawns each via `addArchitect`. Critical ordering: main FIRST (otherwise `addArchitect`'s `size > 0` guard rejects the sibling spawn). The workspace scoping prevents architects registered in workspace A from leaking into workspace B at launch — schema-level isolation rather than per-call-site guards.
- **Crash recovery**: rows in `terminal_sessions` survive because Tower didn't clean them up; `reconcileTerminalSessions()` reconnects via shellper sockets.
- **Permanent exit** (max-restart exhaustion): exit handlers run WITHOUT the intentional-stop flag set, so `setArchitectByName(workspacePath, name, null)` fires and the row is auto-deleted (Spec 786 OQ-B — `state.db` mirrors reality).
- **Stop-all** (`tower-routes.ts:handleWorkspaceStopAll`): explicit "tear everything down" — full wipe of `terminal_sessions` and per-workspace `state.db.architect` rows. Semantically distinct from `stopInstance` which preserves sibling registration.

**Persistence layers**:
- `state.db.architect` — durable per-architect registration. Schema: `(workspace_path TEXT NOT NULL, id TEXT NOT NULL, pid, port, cmd, started_at, terminal_id)` with composite primary key `(workspace_path, id)` (Bugfix #826 migration v11). Workspace scoping is part of the schema: the same architect name (e.g. `main`) can exist in multiple workspaces without collision, and queries scoped to one workspace's `workspace_path` cannot return rows from another. `pid`/`port` persist as `0` (Spec 755 limitation); the live values come from Tower's `PtySession` only.
- `terminal_sessions` — global runtime session registry. Wiped on graceful stop (`stopInstance` and `stop-all`); preserved on crash. Reconciliation reads `role_id` to re-key the in-memory architect map. Not used as a workspace-scoping signal — the architect table carries that directly.

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

**Building**: `npm run build` in `packages/codev/` includes `build:dashboard`. Output: ~64KB gzipped.

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
- **TypeScript/Node.js**: Primary language for agent-farm orchestration CLI
- **Shell/Bash**: Thin wrappers and installation scripting
- **Markdown**: Documentation format for specs, plans, reviews, and agent definitions
- **Git**: Version control with worktree support for isolated builder environments
- **YAML**: Configuration format for protocol manifests
- **JSON**: Configuration format for agent-farm (`.codev/config.json` at project root) and state management

### Agent-Farm CLI (TypeScript)
- **commander.js**: CLI argument parsing and command structure
- **better-sqlite3**: SQLite database for atomic state management (WAL mode)
- **tree-kill**: Process cleanup and termination
- **Shellper processes**: Detached Node.js processes for terminal session persistence (Spec 0104)
- **node-pty**: Native PTY sessions with WebSocket multiplexing (Spec 0085)
- **React 19 + Vite 6**: Dashboard SPA at `packages/dashboard/` (standalone workspace member)
- **xterm.js**: Terminal emulator in the browser dashboard (with `customGlyphs: true` for Unicode)

### VS Code Extension
- **VS Code Extension API**: TreeViews, Pseudoterminal, StatusBar, Commands, Decorations
- **esbuild**: Bundles extension + codev-core into single `dist/extension.js`
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

The repository uses pnpm workspaces with the following packages:

| Package | npm Name | Purpose |
|---------|----------|---------|
| `packages/codev` | `@cluesmith/codev` | CLI + Tower server (published to npm) |
| `packages/core` | `@cluesmith/codev-core` | Shared runtime: TowerClient, auth, workspace encoding, EscapeBuffer, ReconnectPolicy (published to npm) |
| `packages/types` | `@cluesmith/codev-types` | Shared TypeScript types: WebSocket protocol, API shapes, SSE events (dev dependency only) |
| `packages/config` | `@cluesmith/config` | Shared tsconfig base (cross-project) |
| `packages/dashboard` | `@cluesmith/codev-dashboard` | React dashboard SPA (built into codev package) |
| `packages/vscode` | `codev` (Marketplace) | VS Code extension |

**Dependency graph:**
```
codev-types (types only, dev dep)
     ↓
codev-core (runtime: TowerClient, auth, EscapeBuffer)
     ↓
codev (CLI + Tower)        vscode (extension)        dashboard (React SPA)
  imports core               imports core              imports core/escape-buffer
  imports types (dev)        imports types (dev)        imports types (dev)
```

**Build order:** `pnpm build` from root builds types → core → codev (including dashboard). `codev-types` is built first because the VS Code extension's esbuild bundle resolves the package's runtime `exports.default` (`./dist/index.js`); a missing `types/dist` breaks the extension build even though tsc and vite resolve it from source via `exports.types` (`./src/index.ts`).

**Publishing:** `codev-core` must be published to npm before `codev` (runtime dependency).

## VS Code Extension

The VS Code extension (`packages/vscode`) is a thin client over Tower's existing API. It adds VS Code-specific UI on top of `TowerClient` from `@cluesmith/codev-core` — no Tower logic is reimplemented.

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    VS Code Extension                          │
│                                                               │
│  ConnectionManager (singleton)                                │
│  ├── TowerClient (from @cluesmith/codev-core)                │
│  ├── AuthWrapper (SecretStorage + readLocalKey)               │
│  ├── WorkspaceDetector (traverse up to .codev/ or codev/)    │
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
│  esbuild → dist/extension.js (bundles codev-core inline)      │
└──────────────┬───────────────────────────────────────────────┘
               │ HTTP + WebSocket + SSE (localhost:4100)
┌──────────────▼───────────────────────────────────────────────┐
│                    Tower Server                               │
│              (unchanged — same API as browser dashboard)      │
└──────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Thin client**: All state stays in Tower/shellper. Extension is a viewport, not a second orchestrator.
- **TowerClient reuse**: Extension imports `TowerClient` from `codev-core` — same class the CLI uses. No duplicate REST/auth/encoding logic.
- **TerminalLocation.Editor**: Terminals open directly in editor area via `ViewColumn.One` (architect) and `ViewColumn.Two` (builders). Uses stable VS Code API, not the undocumented `moveIntoEditor` command.
- **Subpath exports**: `codev-core` uses subpath exports (`./tower-client`, `./escape-buffer`, etc.) to prevent Node builtins from leaking into the dashboard's Vite build.
- **Injectable auth**: `TowerClient` accepts a `getAuthKey` callback. CLI uses `ensureLocalKey()` (creates key if missing). Extension uses `readLocalKey()` + `SecretStorage` (never creates keys).
- **Editor-tab webviews (#920)**: Richer-than-TreeView surfaces use `vscode.window.createWebviewPanel` (editor area), not a sidebar `WebviewView`. Pattern: the panel is a thin view that posts debounced criteria to the extension host; **filtering/sorting runs host-side** in vscode-free pure helpers (`views/backlog-filter.ts`, vitest-tested) so logic stays testable and sensitive data (e.g. issue bodies) never crosses into the webview — only display rows do. HTML/CSS/JS live in a sibling `*.template.ts` (no esbuild asset-copy step); theming is **CSS variables only** (`--vscode-*`) so dark/light/high-contrast render natively; CSP is nonce'd. First instance: the "Search Backlog" panel (`webviews/backlog-search-panel.ts`), fed by the dedicated `issue-search` forge concept → `GET /api/issue-search` (kept separate from `issue-list` so `/api/overview` stays body-free).
- **Panel view container (#812)**: The extension contributes view containers to **two** locations — `activitybar.codev` (the 7-section sidebar) and `panel.codevPanel` (bottom panel, wide-short geometry). The panel exists as scaffolding for views whose shape suits a wide layout (timelines, rosters, tables); migrations are tracked separately (#813/#814/#815). Panel views are plain `TreeDataProvider`s, identical in kind to sidebar providers — VS Code lets the same view types live in either location. A `codev.panelContainerEmpty` context key gates a placeholder view that hides once real views register — **#921's `codev.devServer` is the first such view, so the panel now ships non-empty** (the key is seeded `false`). VS Code gives no control over panel-tab *position* (it lands last, in the `…` overflow), so the extension does a one-time, globalState-guarded reveal (`workbench.view.extension.codevPanel`) on first activation for discoverability.
- **Codev Dev surface (#921)**: The single `afx dev` PTY gets two complementary surfaces, both driven off the one `TerminalManager.onDidChangeDevTerminals` event (single source of truth, so chip and tab never drift on start/stop/swap): a `codev.devServer` panel `TreeDataProvider` (first real `codevPanel` tenant — status header of target / live-ticking uptime / best-effort port, plus title-bar Stop / Restart / Switch-Target / Show-Hide-sidebar actions gated by a `codev.devServerRunning` key) and an always-visible **status-bar chip** (`StatusBarItem`, left, priority 99) shown only while a dev runs, clicking through to the tab. The native `Codev: <name> (dev)` terminal stays as the output surface (coexist) — the new tab is a status/control surface, not an output mirror, so there is no second PTY/xterm re-plumbing. Uptime needs a start time `listDevTerminals()` doesn't carry, so `TerminalManager` keeps a `builderId → startedAt` map. Pure formatters (`views/dev-server-format.ts`: uptime, port-from-config) are vitest-tested.
- **Startup CLI preflight (#791)**: On `activate()` the extension verifies the `codev` CLI is installed and at least its own `package.json` version (`codev --version`, resolved like `resolveAfxPath`, cached per session, 400ms-bounded, fire-and-forget so activation never blocks). Missing → `Get started with Codev` walkthrough; outdated → upgrade notification; either dismissed → CLI-dependent commands no-op with one "run setup" toast. Commands register through two helpers — `reg` (unguarded) and `regCli` (guarded) — so the registrar name *is* the guard policy (no separate list). Preflight also sets the `codev.cliReady` context key, which drives the walkthrough's Verify-step completion. Lives in `src/preflight/` (`preflight-core.ts` pure + unit-tested, `preflight.ts` vscode glue).
- **Markdown Preview / artifact-canvas host integration (#859)**: The first integration of the shared `@cluesmith/codev-artifact-canvas` React surface into a host. A read-only `CustomTextEditor` (`codev.markdownPreview`, `priority: "option"` so it never replaces the default `.md` editor; selector scoped to `**/codev/{specs,plans,reviews}/**/*.md`) renders an artifact and lets a reviewer add comments by hovering a block and clicking `+`. It is the extension's **first bundled React webview**: a *second* esbuild entry (`esbuild.js`, browser/IIFE, bundles react/react-dom/the canvas + emits `markdown-preview.css`), type-checked by a dedicated `tsconfig.webview.json` (DOM libs) since the host `tsconfig.json` excludes the browser dir. Host↔webview bridge (`markdown-preview/preview-provider.ts`, HTML in a sibling `preview-template.ts` per #920; the two `postMessage` directions are a named protocol in `markdown-preview/messages.ts`, `HostToWebviewMessage` / `WebviewToHostMessage`, shared by both ends so they can't drift — #1107): the host posts **raw** document text + parsed markers; the webview mounts `<ArtifactCanvas>`; the reviewer's `+`/Enter opens an **inline composer rendered in-flow below the block** (`overlays/CommentComposer.tsx`, portalled into a placeholder there — #1107 replaced the old center-top `showInputBox`); on submit `onAddComment(line, text)` → host `WorkspaceEdit` → the round-trip goes through the file text. (Host-side inbound `postMessage` data is untrusted, so the host still validates payload fields at runtime despite the named type.) **Cross-cutting invariants this established**: (1) the on-disk REVIEW-marker convention (`<!-- REVIEW(@author): text -->`, a marker annotates the nearest non-marker line above it) lives in `@cluesmith/codev-core/review-markers` so every host (vscode now, dashboard later) writes/parses identical bytes — the editor Comments-API path (`comments/plan-review.ts`) shares it. (2) The canvas renderer runs markdown-it with **`html: true` + DOMPurify as the sole guard** (#1042 amends spec-945 D7: safe static HTML renders, scripts/handlers/`javascript:` stripped, document JS never executes) and **strips full-line HTML comments before block parsing** with a cleaned→original line map (#1036), so markers never render as text and never split a multi-line block while `data-line` stays accurate.
- **Builders diff-review: navigation + active-file sync (#1060/#1066)**: The "current builder/file" in a diff review is **derived from the active editor, not stored**. The diff-inject registry (`diff-inject-codelens.ts`) maps each right-side worktree fsPath → `{ builderId, relPath, hunks }`; because a worktree-absolute path is unique per builder, two builders that changed the same relative path stay distinct. Everything keys off `getDiffInjectEntry(activeEditor.fsPath)`: cross-file keyboard nav (`codev.diffNextFile`/`diffPreviousFile`, #1060) and the Builders-tree active-file reveal (#1066). Navigation walks **one builder's** changed-file list (it never crosses builders) in the **visible tree order** — depth-first via `flattenTreeOrder(buildFilePathTree(...))` in tree-view mode, raw git `--name-status` order in flat mode — and **wraps** at both ends (`computeNavTarget` modulo) to match VSCode's built-in hunk navigation, which also wraps. The reveal (#1066, Explorer-style, gated by `codev.buildersAutoReveal`) requires two pieces of TreeView groundwork: file rows carry a stable `<builderId>::<relPath>` id and `BuildersProvider.getParent` reconstructs the full chain (file → compacted folder(s) → builder → group), since `reveal` matches by id and walks parents while the subtree is still collapsed. It fires on **both** the active-editor change AND the diff-inject registry change, because a programmatic diff open registers its entry *after* the editor activates (same dual-trigger the lens context-key sync uses).
- **Agents view + group-by axes (#1104)**: The sidebar's primary work view is **Agents** (view id `codev.agents`, formerly `codev.builders` — only the user-facing id/label changed; internal symbols like `BuildersProvider` and the `codev.buildersGroupBy` setting keep their names). It groups in-flight builders by **exactly one of three axes** (`stage` | `area` | `architect`), each a `BuilderGrouping` strategy in `views/builder-grouping.ts`; `architect` groups by `spawnedByArchitect` (null folds into `main`, matching the affinity router) and a childless architect produces no group, so the work view shows owners-of-work while the *full* roster stays in Workspace > Architects. The axis is a single toolbar button (see the no-`toggled` lesson). The architect roster the Add-Architect flow needs rides on **`/api/overview` as `architects: ArchitectState[]`** (additive wire field), built by a shared `liveArchitects(entry, manager)` helper in `tower-routes.ts` reused by the `/api/state` dashboard-state path so the two payloads can't drift — `liveArchitects` (running-session set, from `terminal_sessions`) is distinct from state.ts's `getArchitects` (persisted `architect` table). `Codev: Add Architect` is conversational: it resolves `main` from that roster and routes a request via `sendMessage('architect:main', …)` rather than creating the architect directly.
- **Running-Tower version probe (#983)**: A second preflight dimension catches the case the CLI check structurally can't — an `npm install -g` upgrade that updated the on-disk binary but left **Tower running stale in-memory code**. Tower exposes read-only `GET /api/version` (`{ version, startedAt }`, wire type `TowerVersionInfo` in `codev-types`, served from `RouteContext` so it reports the *running* process's version, not the disk binary; unauthenticated like `/health`). On each `connected` transition the extension probes it (`TowerClient.getVersion()`, returning the raw `{ status }` so the preflight distinguishes a 404 "Tower too old to report" from an unreachable Tower). Divergence fires **only on `running < installedCLI`** — the case a restart actually fixes; running-vs-extension is left to #791 (a restart can't load code that isn't installed). The toast offers a `Restart Tower` action (`afx tower stop && afx tower start`, local host only — safe to self-invoke because #991 scoped `afx tower stop` to the listening process; remote hosts get informational wording). The two async inputs (installed-CLI version, running-Tower version) are reconciled against the startup race by re-probing once the CLI check resolves. Decision/wording logic is pure + unit-tested in `preflight-core.ts` (`decideTowerStatus`, `towerDivergenceMessage`).

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
├── packages/core/                      # @cluesmith/codev-core (shared runtime)
│   └── src/
│       ├── tower-client.ts             # TowerClient class (injectable auth)
│       ├── auth.ts                     # readLocalKey() + ensureLocalKey()
│       ├── workspace.ts               # encodeWorkspacePath() / decodeWorkspacePath()
│       ├── constants.ts               # DEFAULT_TOWER_PORT, AGENT_FARM_DIR
│       └── escape-buffer.ts           # EscapeBuffer (ANSI sequence buffering)
├── packages/types/                     # @cluesmith/codev-types (shared interfaces)
│   └── src/
│       ├── websocket.ts               # FRAME_CONTROL, FRAME_DATA, ControlMessage
│       ├── sse.ts                     # SSEEventType, SSENotification
│       └── api.ts                     # DashboardState, OverviewData, TeamApiResponse, etc.
├── packages/config/                    # @cluesmith/config (shared tsconfig)
│   └── tsconfig.base.json
├── packages/dashboard/                 # @cluesmith/codev-dashboard (React SPA)
│   └── src/                           # React 19 + Vite 6 + xterm.js + Recharts
├── packages/vscode/                    # VS Code extension (Marketplace: cluesmith.codev-vscode)
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
│   │       ├── tower-client.ts         # Re-exports from @cluesmith/codev-core
│   │       └── templates.ts            # Template file handling
│   ├── bin/                            # CLI entry points
│   │   ├── codev.js                    # codev command
│   │   ├── afx.js                      # afx command (af.js deprecated, redirects)
│   │   ├── af.js                       # Deprecated; redirects to afx
│   │   ├── consult.js                  # consult command
│   │   ├── team.js                     # team command
│   │   ├── porch.js                    # porch command
│   │   └── generate-image.js           # generate-image command
│   ├── dashboard-dist/                 # Dashboard build output (copied from packages/dashboard/dist)
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

### 7. Message Delivery (`afx send`)

**Location**: `servers/send-buffer.ts`, `commands/send.ts`, `terminal/pty-session.ts`

Messages sent via `afx send` are not injected immediately — they pass through a **typing-aware send buffer** that prevents message injection while the user is actively typing.

#### How it works

1. **User types** in terminal → WebSocket `data` event → `PtySession.recordUserInput()` updates `lastInputAt` timestamp
   - **PTY produces output** → `PtySession.onPtyData()` updates `lastDataAt` timestamp (Spec 467: used by dashboard for shell idle detection)
2. **`afx send` message arrives** → Tower buffers it via `SendBuffer.enqueue()`
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

`afx send` resolves addresses via Tower API with tail-matching: `"0109"` matches `"builder-spir-0109"`. Supports `--all` for broadcast, `--file` for file attachments (48KB max), and `--raw` to skip structured formatting.

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

**Core module**: `src/lib/forge.ts`
- `executeForgeCommand(concept, envVars, options)` — async dispatcher
- `executeForgeCommandSync(concept, envVars, options)` — sync variant
- `loadForgeConfig(workspaceRoot)` — loads `.codev/config.json` forge section
- `validateForgeConfig(config)` — validates concept overrides

**Configuration**: `.codev/config.json` `forge` section maps concept names to shell commands. Set to `null` to disable a concept. Omit to use the default (`gh`-based) command.

**15 concepts**: `issue-view`, `pr-list`, `issue-list`, `issue-comment`, `pr-exists`, `recently-closed`, `recently-merged`, `user-identity`, `team-activity`, `on-it-timestamps`, `pr-merge`, `pr-search`, `pr-view`, `pr-diff`, `auth-status`.

**Environment variables**: Each concept receives `CODEV_*` env vars (e.g., `CODEV_ISSUE_NUMBER`, `CODEV_PR_NUMBER`) that the command uses to parameterize its output.

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
