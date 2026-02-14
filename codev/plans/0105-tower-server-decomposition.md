# Plan: Tower Server Decomposition

## Metadata
- **Specification**: codev/specs/0105-tower-server-decomposition.md
- **Created**: 2026-02-14

## Executive Summary

Decompose `tower-server.ts` (3,418 lines) into 7 focused modules and `commands/spawn.ts` (1,405 lines) into 3 files. Each extraction phase moves one concern out of the god-object, replaces the original code with an import, and verifies the build + tests pass. The extraction order follows the spec: least-coupled first, route dispatch last.

Key design decision: A `TowerContext` interface carries shared mutable state between modules, eliminating the need for globals. The orchestrator (`tower-server.ts`) owns lifecycle — it creates dependencies in startup order and tears them down in `gracefulShutdown`.

## Success Metrics
- [ ] `tower-server.ts` ≤ 400 lines
- [ ] `commands/spawn.ts` ≤ 600 lines
- [ ] No file in `packages/codev/src/agent-farm/servers/` exceeds 900 lines
- [ ] `npm run build` succeeds
- [ ] All existing tests pass
- [ ] Each extracted module has at least one focused test file

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Extract tower-types and tower-utils"},
    {"id": "phase_2", "title": "Extract tower-tunnel"},
    {"id": "phase_3", "title": "Extract tower-instances"},
    {"id": "phase_4", "title": "Extract tower-terminals"},
    {"id": "phase_5", "title": "Extract tower-websocket"},
    {"id": "phase_6", "title": "Extract tower-routes"},
    {"id": "phase_7", "title": "Decompose spawn.ts"}
  ]
}
```

## Phase Breakdown

### Phase 1: Extract tower-types and tower-utils
**Dependencies**: None

#### Objectives
- Create `tower-types.ts` with the `TowerContext` interface and shared types (`ProjectTerminals`, `SSEClient`, etc.)
- Create `tower-utils.ts` with rate limiting, path normalization, MIME types, static file serving, and temp directory detection
- Convert the fire-and-forget `setInterval(cleanupRateLimits, ...)` to an explicit `startRateLimitCleanup()` function that returns the interval handle

#### Files
- **Create**: `packages/codev/src/agent-farm/servers/tower-types.ts`
- **Create**: `packages/codev/src/agent-farm/servers/tower-utils.ts`
- **Modify**: `packages/codev/src/agent-farm/servers/tower-server.ts` (remove extracted code, add imports)

#### Implementation Details

**tower-types.ts** (~50 lines):
```typescript
// Shared interfaces used across tower modules
export interface TowerContext {
  port: number;
  log: (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;
  terminalManager: TerminalManager;
  shepherdManager: SessionManager | null;
  projectTerminals: Map<string, ProjectTerminals>;
  db: GlobalDb;
  gateWatcher: GateWatcher;
  broadcastNotification: (n: Notification) => void;
  tunnelClient: TunnelClient | null;
  knownProjects: Set<string>;
  server: http.Server;
  terminalWss: WebSocketServer;
}

export interface ProjectTerminals { ... }  // move from tower-server.ts line 287-292
export interface SSEClient { ... }
export interface RateLimitEntry { ... }
```

**tower-utils.ts** (~120 lines) — extract from tower-server.ts:
- `isRateLimited()` (lines 56-72) + `cleanupRateLimits()` (lines 77-84) + `RateLimitEntry` (lines 45-48) + `activationRateLimits` Map (line 50)
- New: `startRateLimitCleanup(): NodeJS.Timeout` — returns the interval handle so orchestrator can clear it on shutdown
- `normalizeProjectPath()` — path normalization with symlink resolution
- `isTempDirectory()` — temp directory detection
- `getProjectName()` — extract project name from path
- `MIME_TYPES` constant (lines 1688-1702) + `serveStaticFile()` function
- `getLanguageForExtension()` — language detection helper

#### Acceptance Criteria
- [ ] `npm run build` succeeds
- [ ] All existing tests pass unchanged
- [ ] `tower-server.ts` line count reduced by ~120 lines
- [ ] No module-scope `setInterval` side effects in `tower-utils.ts`

#### Test Plan
- **Unit Tests**: `tower-utils.test.ts` — test `isRateLimited()` windowing, `cleanupRateLimits()`, `normalizeProjectPath()`, `isTempDirectory()`, `serveStaticFile()` with mock response
- **Regression**: `npm test` passes

---

### Phase 2: Extract tower-tunnel
**Dependencies**: Phase 1

#### Objectives
- Extract all cloud tunnel logic into `tower-tunnel.ts`
- Move tunnel-related module-scope state (`tunnelClient`, `configWatcher`, `configWatchDebounce`, `metadataRefreshInterval`)
- Move `handleTunnelEndpoint()` function

#### Files
- **Create**: `packages/codev/src/agent-farm/servers/tower-tunnel.ts`
- **Modify**: `packages/codev/src/agent-farm/servers/tower-server.ts` (remove extracted code, add imports)

#### Implementation Details

**tower-tunnel.ts** (~200 lines) — extract from tower-server.ts:
- `connectTunnel()` (lines ~109-142)
- `disconnectTunnel()` — new wrapper for clean disconnection
- `startConfigWatcher()` / `stopConfigWatcher()` (lines ~171-229)
- `startMetadataRefresh()` / `stopMetadataRefresh()` (lines ~145-169)
- `gatherMetadata()` (lines ~109-140)
- `handleTunnelEndpoint()` (lines ~231-280)

**State ownership**: Tunnel-related state (`tunnelClient`, `configWatcher`, `configWatchDebounce`, `metadataRefreshInterval`) lives inside `tower-tunnel.ts` as module-private variables, but lifecycle is orchestrator-driven via `initTunnel()` and `shutdownTunnel()`. The `tunnelClient` reference is also stored in `TowerContext` so other modules can read tunnel state. The orchestrator calls `initTunnel(ctx)` which sets `ctx.tunnelClient` after connection.

**API**: Export functions that `tower-server.ts` calls:
```typescript
export function initTunnel(ctx: TowerContext): Promise<void>  // sets ctx.tunnelClient
export function shutdownTunnel(): Promise<void>  // cleans up internal state
export function handleTunnelEndpoint(req, res, subPath): Promise<void>
```

#### Acceptance Criteria
- [ ] `npm run build` succeeds
- [ ] All existing tests pass (especially `tower-cloud.test.ts`, `tunnel-integration.test.ts`)
- [ ] `tower-server.ts` line count reduced by ~200 lines

#### Test Plan
- **Unit Tests**: `tower-tunnel.test.ts` — test `initTunnel()` with mock config, `handleTunnelEndpoint()` route dispatch, config watcher debouncing
- **Regression**: Existing `tower-cloud.test.ts` and `tunnel-integration.test.ts` pass

---

### Phase 3: Extract tower-instances
**Dependencies**: Phase 1

#### Objectives
- Extract project instance lifecycle logic into `tower-instances.ts`
- Move `getInstances()`, `launchInstance()`, `stopInstance()`, project registration functions

#### Files
- **Create**: `packages/codev/src/agent-farm/servers/tower-instances.ts`
- **Modify**: `packages/codev/src/agent-farm/servers/tower-server.ts`

#### Implementation Details

**tower-instances.ts** (~350 lines) — extract from tower-server.ts:
- `getInstances()` — discover projects with terminal/gate/process state
- `launchInstance()` — activate a project (adopt, create terminals, start AF)
- `stopInstance()` — deactivate a project (kill processes, cleanup)
- `registerKnownProject()` / `getKnownProjectPaths()` — project registration
- `getDirectorySuggestions()` — autocomplete for project paths (currently inline in route handler, extract as named function)

All functions receive `TowerContext` as first parameter. `shepherdManager` access goes through context.

#### Acceptance Criteria
- [ ] `npm run build` succeeds
- [ ] All existing tests pass
- [ ] `tower-server.ts` line count reduced by ~350 lines

#### Test Plan
- **Unit Tests**: `tower-instances.test.ts` — test `getInstances()` returns correct shape, `launchInstance()` with mock DB/context, `stopInstance()` cleanup
- **Regression**: E2E tests pass

---

### Phase 4: Extract tower-terminals
**Dependencies**: Phase 1, Phase 3

#### Objectives
- Extract terminal state management, tmux operations, reconciliation, file tab persistence, and shell ID allocation into `tower-terminals.ts`
- This is the largest and most coupled extraction

#### Files
- **Create**: `packages/codev/src/agent-farm/servers/tower-terminals.ts`
- **Modify**: `packages/codev/src/agent-farm/servers/tower-server.ts`

#### Implementation Details

**tower-terminals.ts** (~400 lines) — extract from tower-server.ts:

*Terminal session CRUD (lines ~295-420):*
- `getProjectTerminalsEntry()` — get-or-create entry in projectTerminals Map
- `saveTerminalSession()` — persist to in-memory + SQLite
- `deleteTerminalSession()` — remove from memory + SQLite
- `getTerminalSessionsForProject()` — query SQLite for project's sessions

*Tmux session management (lines ~430-545):*
- `createTmuxSession()` / `killTmuxSession()` — tmux lifecycle
- `tmuxSessionExists()` / `listCodevTmuxSessions()` — tmux queries
- `sanitizeTmuxName()` — name sanitization

*Terminal reconciliation (lines ~547-715):*
- `reconcileTerminalSessions()` — startup reconnection logic (uses shepherdManager from context)

*File tab persistence:*
- `saveFileTab()` / `deleteFileTab()` / `loadFileTabsForProject()` — wrappers around DB functions

*Shell ID allocation:*
- `getNextShellId()` — allocate shell-N IDs for a project

*Gate watching (lines ~1006-1025):*
- `startGateWatcher()` — periodic gate status polling
- Move `gateWatcherInterval` state here
- **Important**: `startGateWatcher()` uses `ctx.broadcastNotification` from TowerContext to send gate change notifications. Do NOT import `broadcastNotification` from tower-routes — always access it via context to avoid circular dependencies.

*Terminal list assembly:*
- `getTerminalsForProject()` (~80 lines, line ~1054) — builds the terminal list for the API response, reads `projectTerminals` Map and `terminalManager`

All functions receive `TowerContext` as first parameter.

#### Acceptance Criteria
- [ ] `npm run build` succeeds
- [ ] All existing tests pass
- [ ] `tower-server.ts` line count reduced by ~500 lines
- [ ] Terminal reconciliation works (verify with existing E2E tests)

#### Test Plan
- **Unit Tests**: `tower-terminals.test.ts` — test session CRUD operations, tmux name sanitization, shell ID allocation, file tab operations, gate watcher interval setup
- **Integration Tests**: Test reconciliation logic with mock shepherdManager
- **Regression**: E2E terminal tests pass

---

### Phase 5: Extract tower-websocket
**Dependencies**: Phase 1, Phase 4

#### Objectives
- Extract WebSocket terminal handler into `tower-websocket.ts`
- Move bidirectional WS ↔ PTY bridging logic

#### Files
- **Create**: `packages/codev/src/agent-farm/servers/tower-websocket.ts`
- **Modify**: `packages/codev/src/agent-farm/servers/tower-server.ts`

#### Implementation Details

**tower-websocket.ts** (~180 lines) — extract from tower-server.ts:

*Frame bridging (~100 lines):*
- `handleTerminalWebSocket()` — bridges WS frames to PTY sessions
- Uses `decodeFrame()`, `encodeData()`, `encodeControl()` from `../../terminal/ws-protocol.js`

*WebSocket upgrade routing (~80 lines, lines 3328-3408):*
- `handleUpgrade()` — the `server.on('upgrade', ...)` handler that parses:
  - Direct routes: `/ws/terminal/:id`
  - Project-scoped routes: `/project/:path/ws/terminal/:id`
  - Base64URL decoding, path normalization, error responses
- This lives **outside** the `http.createServer` callback, so it must be explicitly extracted here (not in Phase 6)

```typescript
export function handleTerminalWebSocket(
  ws: WebSocket,
  sessionId: string,
  ctx: TowerContext
): void

export function setupUpgradeHandler(
  server: http.Server,
  wss: WebSocketServer,
  ctx: TowerContext
): void
```

#### Acceptance Criteria
- [ ] `npm run build` succeeds
- [ ] All existing tests pass
- [ ] WebSocket terminal connections work

#### Test Plan
- **Unit Tests**: `tower-websocket.test.ts` — test frame routing with mock WebSocket and mock PTY session
- **Regression**: E2E terminal WebSocket tests pass

---

### Phase 6: Extract tower-routes
**Dependencies**: Phase 1-5 (all previous modules)

#### Objectives
- Extract the 1,514-line `http.createServer` callback into `tower-routes.ts`
- Convert inline route handlers to named functions
- Create a route dispatch table
- This is the final extraction that transforms `tower-server.ts` into a ~300-line orchestrator

#### Files
- **Create**: `packages/codev/src/agent-farm/servers/tower-routes.ts`
- **Modify**: `packages/codev/src/agent-farm/servers/tower-server.ts`

#### Implementation Details

**tower-routes.ts** (~600 lines) — extract from tower-server.ts lines 1802-3281:

*Route dispatch:*
```typescript
export async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: TowerContext
): Promise<void>
```

*Named handler functions (extracted from inline handlers):*
- `handleHealthCheck()` — GET /health
- `handleListProjects()` — GET /api/projects
- `handleProjectAction()` — POST /api/projects/:path/activate|deactivate, GET .../status
- `handleTerminalCreate()` — POST /api/terminals
- `handleTerminalList()` — GET /api/terminals
- `handleTerminalAction()` — GET/DELETE/POST /api/terminals/:id/*
- `handleStatus()` — GET /api/status
- `handleSSEEvents()` — GET /api/events
- `handleNotify()` — POST /api/notify
- `handleBrowse()` — GET /api/browse
- `handleCreate()` — POST /api/create
- `handleLaunch()` — POST /api/launch
- `handleStop()` — POST /api/stop
- `handleProjectDashboard()` — GET/POST/DELETE /project/:path/*

*SSE state:*
- `sseClients` array, `notificationIdCounter`, and `broadcastNotification()` — these stay in the **orchestrator** (`tower-server.ts`) and are passed via `TowerContext.broadcastNotification`. This avoids a circular dependency: gate watcher (in tower-terminals) also calls `broadcastNotification`, so it cannot be imported from tower-routes.
- Route handlers access `broadcastNotification` via `ctx.broadcastNotification`
- The SSE endpoint handler (`handleSSEEvents`) registers clients in the orchestrator's `sseClients` array via a callback on TowerContext

*CORS/Security:*
- CORS headers logic
- `isRequestAllowed` check at top of handler

**What remains in tower-server.ts (~300 lines):**
- Import all modules
- CLI parsing (Commander)
- Create `TowerContext`
- Create HTTP server with `handleRequest(req, res, ctx)`
- Create WebSocket server
- Initialize tunnel, gate watcher, reconciliation
- `gracefulShutdown()` — coordinates shutdown of all modules
- Signal handlers (SIGTERM, SIGINT)
- `log()` function
- Dashboard path detection (`reactDashboardPath`, `hasReactDashboard`)

#### Acceptance Criteria
- [ ] `tower-server.ts` ≤ 400 lines
- [ ] `npm run build` succeeds
- [ ] All existing tests pass
- [ ] All HTTP routes return identical responses (same status codes, headers, body shapes)
- [ ] CORS headers preserved
- [ ] Rate limiting preserved on activation endpoint

#### Test Plan
- **Unit Tests**: `tower-routes.test.ts` — test route dispatch for key endpoints (health, projects, terminals) with mock TowerContext
- **Regression**: E2E tests (`tower-baseline.e2e.test.ts`) pass, verifying full round-trip behavior

---

### Phase 7: Decompose spawn.ts
**Dependencies**: None (independent of tower-server phases)

#### Objectives
- Extract git worktree management and role/prompt generation from `commands/spawn.ts`
- Reduce `spawn.ts` from 1,405 to ≤ 600 lines

#### Files
- **Create**: `packages/codev/src/agent-farm/commands/spawn-worktree.ts`
- **Create**: `packages/codev/src/agent-farm/commands/spawn-roles.ts`
- **Modify**: `packages/codev/src/agent-farm/commands/spawn.ts`

#### Implementation Details

**spawn-worktree.ts** (~300 lines) — extract from spawn.ts:
- `createWorktree()` — git worktree add + branch creation
- `ensureDirectories()` — .builders dir setup
- `checkDependencies()` — verify git, tmux, etc.
- `initPorchInWorktree()` — porch initialization
- `checkBugfixCollisions()` — collision detection for bugfix mode
- `fetchGitHubIssue()` — gh CLI wrapper
- `executePreSpawnHooks()` — protocol hook execution

**spawn-roles.ts** (~200 lines) — extract from spawn.ts:
- `loadRolePrompt()` — read role file from codev/roles/
- `loadProtocolRole()` — read protocol-specific role
- `buildPromptFromTemplate()` — Handlebars template rendering
- `buildResumeNotice()` — resume notice generation
- `TemplateContext` interface

**spawn.ts remains as orchestrator** (~500 lines):
- `spawn()` entry point
- `validateSpawnOptions()` / `getSpawnMode()` / `generateShortId()`
- `resolveProtocol()` / `resolveMode()` / `validateProtocol()`
- `spawnSpec()` / `spawnTask()` / `spawnProtocol()` / `spawnBugfix()` / `spawnShell()` / `spawnWorktree()`
- `startBuilderSession()` / `startShellSession()` / `createPtySession()`

#### Acceptance Criteria
- [ ] `commands/spawn.ts` ≤ 600 lines
- [ ] `npm run build` succeeds
- [ ] All existing tests pass (especially `spawn.test.ts`)

#### Test Plan
- **Unit Tests**: `spawn-worktree.test.ts` — test worktree creation, collision detection, porch initialization
- **Unit Tests**: `spawn-roles.test.ts` — test template rendering, role loading, resume notice
- **Regression**: Existing `spawn.test.ts` passes unchanged

## Dependency Map
```
Phase 1 (types+utils) ──→ Phase 2 (tunnel)
         │                       │
         ├──→ Phase 3 (instances)│
         │        │              │
         │        ↓              │
         ├──→ Phase 4 (terminals)│
         │        │              │
         │        ↓              │
         ├──→ Phase 5 (websocket)│
         │                       │
         └──→ Phase 6 (routes) ←─┘
                  ↑
              (all above)

Phase 7 (spawn) — independent, can run in parallel with Phases 2-6
```

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Circular imports between modules | Low | High | `tower-types.ts` holds shared interfaces; one-way dependency flow |
| Subtle behavior change in route extraction | Medium | High | E2E tests catch regressions; compare route dispatch table before/after |
| `shepherdManager` coupling across 4+ modules | Medium | Medium | All access goes through `TowerContext`; single initialization point |
| Module-scope side effects leak into tests | Low | Medium | Convert all `setInterval` to explicit lifecycle functions |

## Commit Strategy

**Each phase MUST end with an atomic commit** before the next phase begins (per spec constraint #4). Commit format:

```
[Spec 0105][Phase: N-name] refactor: Extract <module> from tower-server.ts
```

The commit must include: the new module file, the updated tower-server.ts, and any new test files. `npm run build` and `npm test` must pass before committing.

## Validation Checkpoints
1. **After Phase 1**: Build passes, rate limiting still works
2. **After Phase 3**: Instance lifecycle E2E works (activate/deactivate projects)
3. **After Phase 4**: Terminal WebSocket connections work end-to-end
4. **After Phase 6**: Full E2E suite passes — tower-server.ts is now ≤ 400 lines
5. **After Phase 7**: Spawn command works for all modes (spec, task, bugfix, shell, worktree, protocol)

## Error and Logging Parity

Per spec constraints 7-8, all phases must preserve:
- **Error responses**: Same HTTP status codes and JSON error shapes for all failure paths
- **Log messages**: Same format (`log('LEVEL', 'message')`) and same message content — the `log()` function stays in the orchestrator and is passed via TowerContext
- Tests should spot-check at least one error path per extracted module (e.g., 404 for unknown terminal, 429 for rate limit, 400 for invalid path encoding)
