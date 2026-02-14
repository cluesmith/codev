# Spec 0105: Tower Server Decomposition

## Problem

`tower-server.ts` is 3,439 lines (2,445 code) — a god-object that handles at least 8 distinct responsibilities in a single file. It contains a 1,514-line `http.createServer` callback with ~30 inline route handlers. Every new spec (0090, 0097, 0098, 0099, 0100, 0101, 0104) adds more code to this file, accelerating its growth.

This creates real problems:
- **Builder conflicts**: When two builders modify tower-server.ts simultaneously, merge conflicts are near-certain
- **Review difficulty**: CMAP reviewers struggle to assess 700-line diffs against a 3,400-line file
- **Regression risk**: Unrelated changes (e.g., tunnel config) can break terminal lifecycle because everything shares one scope
- **Context window pressure**: AI builders burn significant context just reading the file

Secondary targets (> 700 lines): `commands/spawn.ts` (1,405), `commands/consult/index.ts` (871), `commands/porch/next.ts` (713).

## Goals

1. Decompose `tower-server.ts` from ~3,400 lines to a ~300-line orchestrator that wires together focused modules
2. Each extracted module owns one responsibility, has its own tests, and can be modified independently
3. Zero behavior change — pure refactoring, no new features
4. Reduce `commands/spawn.ts` to < 500 lines by extracting reusable logic

## Non-Goals

- Rewriting the HTTP layer (no Express/Fastify migration)
- Changing the API contract (routes, response shapes)
- Adding new features or endpoints
- Refactoring files under 700 lines
- Modifying the React dashboard

## Current Structure of tower-server.ts

The file contains these distinct concerns, identified by section comments and function clusters:

| Concern | Lines (approx) | Key functions |
|---------|------:|---------------|
| Rate limiting | 50 | `isRateLimited`, `cleanupRateLimits` |
| Cloud tunnel management | 180 | `connectTunnel`, `startConfigWatcher`, `stopConfigWatcher`, `gatherMetadata` |
| Terminal state (in-memory + SQLite) | 200 | `saveTerminalSession`, `deleteTerminalSession`, `getTerminalSessionsForProject` |
| tmux session management | 200 | `createTmuxSession`, `killTmuxSession`, `listCodevTmuxSessions`, `tmuxSessionExists` |
| Terminal reconciliation | 150 | `reconcileTerminalSessions` |
| WebSocket terminal handler | 80 | `handleTerminalWebSocket` |
| Instance lifecycle | 300 | `getInstances`, `launchInstance`, `stopInstance` |
| HTTP route handler | 1,514 | The `http.createServer` callback — ~30 route handlers inline |
| File tab persistence | 40 | `saveFileTab`, `deleteFileTab`, `loadFileTabsForProject` |
| Gate watching + notifications | 50 | `startGateWatcher`, `broadcastNotification` |
| Utility functions | 100 | `getProjectName`, `normalizeProjectPath`, `isTempDirectory`, etc. |
| CLI + logging + shutdown | 150 | `program`, `log`, `gracefulShutdown` |

## Proposed Module Structure

```
packages/codev/src/agent-farm/servers/
├── tower-server.ts              # ~300 lines: wires modules, creates server, CLI
├── tower-routes.ts              # ~600 lines: route dispatch + handler functions
├── tower-instances.ts           # ~350 lines: project instance lifecycle
├── tower-terminals.ts           # ~400 lines: terminal state, tmux, reconciliation
├── tower-tunnel.ts              # ~200 lines: cloud tunnel lifecycle
├── tower-websocket.ts           # ~100 lines: WebSocket terminal handler
└── tower-utils.ts               # ~100 lines: rate limiting, path normalization, etc.
```

### Module Responsibilities

**tower-server.ts** (orchestrator, ~300 lines)
- CLI parsing (Commander)
- Creates HTTP server, wires in route handler
- Creates WebSocket server, wires in WS handler
- Starts tunnel, gate watcher, reconciliation
- Graceful shutdown coordination
- Logging setup

**tower-routes.ts** (~600 lines)
- Exported `handleRequest(req, res, context)` function
- Each route is a named function: `handleHealthCheck`, `handleGetState`, `handleActivate`, etc.
- Route dispatch table (pathname + method → handler)
- CORS, security headers

**tower-instances.ts** (~350 lines)
- `getInstances()` — discover projects
- `launchInstance()` — activate a project
- `stopInstance()` — deactivate a project
- `getDirectorySuggestions()` — autocomplete for project paths
- Project registration (`registerKnownProject`, `getKnownProjectPaths`)

**tower-terminals.ts** (~400 lines)
- Terminal session CRUD (in-memory + SQLite sync)
- tmux session management (create, kill, exists, list, sanitize)
- `reconcileTerminalSessions()` — startup reconnection
- `getTerminalsForProject()` — build terminal list for API
- Shell ID allocation

**tower-tunnel.ts** (~200 lines)
- `connectTunnel()`, `disconnectTunnel()`
- Config file watching
- Metadata gathering and refresh
- Tunnel endpoint handler (`/api/tunnel/*`)

**tower-websocket.ts** (~100 lines)
- `handleTerminalWebSocket()` — bidirectional WS ↔ PTY
- Frame encoding/decoding delegation

**tower-utils.ts** (~100 lines)
- Rate limiting
- Path normalization
- Temp directory detection
- MIME type / language detection
- Static file serving

### Shared Context

Modules need access to shared state. Rather than globals, the orchestrator creates a `TowerContext` object passed to each module:

```typescript
interface TowerContext {
  port: number;
  log: (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;
  terminalManager: TerminalManager;
  db: GlobalDb;
  gateWatcher: GateWatcher;
  broadcastNotification: (n: Notification) => void;
  tunnelClient: TunnelClient | null;
  knownProjects: Set<string>;
}
```

**Lifecycle**: `tower-server.ts` (orchestrator) owns initialization and disposal. It creates each dependency in startup order, passes them through TowerContext, and tears them down in reverse order during `gracefulShutdown`. Individual modules do not manage their own lifecycle — they receive ready-to-use dependencies.

## Approach for spawn.ts

`commands/spawn.ts` (1,405 lines) handles builder spawning with worktree setup, protocol detection, tmux session creation, and CLAUDE.md generation. Extract:

- **spawn-worktree.ts** (~300 lines): Git worktree creation, branch naming, cleanup
- **spawn-roles.ts** (~200 lines): Role file generation (CLAUDE.md content for builders)
- Keep `spawn.ts` as the orchestrator (~500 lines)

## Constraints

1. **No API changes**: All HTTP routes must return identical responses — same status codes, headers, and body shapes for both success and error paths
2. **No import changes for consumers**: Other files that import from tower-server.ts must continue to work (verified: no external imports exist — only comment references in test files)
3. **Tests must pass**: All existing unit and E2E tests must pass. Test harness updates (import paths) are acceptable if behavioral assertions remain unchanged.
4. **Incremental extraction**: Each module extraction should be a separate commit — never move everything at once
5. **Builder 0104 compatibility**: ~~The shepherd integration (currently on a branch) modifies tower-server.ts heavily.~~ **RESOLVED**: 0104 was merged to main (commit 85cb55d). Decomposition proceeds on the post-0104 codebase.
6. **Security parity**: CORS headers, security headers, rate-limiting protections, path normalization (directory traversal defense), and `isRequestAllowed` checks must be preserved exactly as-is in their new locations
7. **Error parity**: Error codes, error messages, and error response shapes must remain identical after extraction — "zero behavior change" includes error paths
8. **Logging parity**: Log format, levels, and message structure must remain consistent across extracted modules

## Acceptance Criteria

### Size targets
- [ ] `tower-server.ts` is ≤ 400 lines
- [ ] `spawn.ts` is ≤ 600 lines
- [ ] No file in `packages/codev/src/` exceeds 900 lines (excluding test files)
- [ ] If a module exceeds its target line count while preserving cohesion, document the reason — cohesion trumps arbitrary limits

### Build and test
- [ ] `npm run build` succeeds
- [ ] All existing tests pass (test harness updates for changed imports are acceptable)

### Runtime behavior parity
- [ ] Tower starts and serves dashboard correctly
- [ ] Terminal WebSocket connections work (open/close/error paths)
- [ ] Cloud tunnel connects
- [ ] Multi-project scenarios work (5 projects active simultaneously)
- [ ] All error responses preserve existing status codes and error message shapes
- [ ] CORS headers, security headers, and rate limiting behavior unchanged
- [ ] Graceful shutdown properly tears down all subsystems

### Test coverage
- [ ] Each extracted module has at least one focused test file
- [ ] `tower-routes` tests verify route dispatch returns correct status/body for key endpoints
- [ ] `tower-terminals` tests cover session CRUD and reconciliation logic

## Risks

| Risk | Mitigation |
|------|-----------|
| ~~Merge conflict with builder 0104~~ | ~~Merge 0104 first, then decompose~~ **RESOLVED** |
| Circular dependencies between modules | TowerContext pattern avoids circular imports |
| Shared mutable state (globals) | Audit all `let` declarations at module scope — pass through context |
| Performance regression from module boundaries | Negligible — these are function calls, not RPC |
| ~~Missing re-exports break consumers~~ | ~~Grep for all imports of tower-server.ts before starting~~ **VERIFIED**: No external imports exist |

## Sequencing

~~This spec depends on **0104 (Custom Session Manager)** being merged first.~~ **RESOLVED**: 0104 merged to main (commit 85cb55d). The current `tower-server.ts` (3,418 lines) includes all 0104 changes (SessionManager, shepherd sessions).

Recommended order of extraction:
1. `tower-utils.ts` — zero dependencies, easiest to extract
2. `tower-tunnel.ts` — self-contained cloud tunnel logic
3. `tower-instances.ts` — instance lifecycle
4. `tower-terminals.ts` — terminal state and tmux (largest, most coupled)
5. `tower-websocket.ts` — WebSocket handler
6. `tower-routes.ts` — route dispatch (last, depends on all above)
7. `spawn-worktree.ts` + `spawn-roles.ts` — spawn.ts decomposition
