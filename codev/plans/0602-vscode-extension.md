---
approved: 2026-04-12
validated: [gemini, codex, claude]
---

# Plan: VS Code Extension for Codev Agent Farm

## Metadata
- **ID**: 0602
- **Status**: approved
- **Approved**: 2026-04-12
- **Specification**: `codev/specs/0602-vscode-extension.md`
- **Created**: 2026-04-06

## Executive Summary

Implement the VS Code extension as a thin client over Tower's existing API, following the approved specification. The plan is structured into 9 phases, each independently shippable. Phases 1-7 form the V1 cut line — the minimum viable extension that delivers the core value proposition (terminals + sidebar + commands + review comments). Phases 8-9 add post-V1 enhancements (analytics Webview, file link URI scheme).

The shared types package (`@cluesmith/codev-types`) is extracted in Phase 1 as a prerequisite, since every subsequent phase depends on it. Review comments (Phase 7) have no Tower dependency and can be built in parallel from Day 1.

## Success Metrics
- [ ] All specification success criteria met
- [ ] Extension compiles, lints, and bundles without errors
- [ ] F5 launches a functional extension from monorepo root
- [ ] Tower auto-starts on activation
- [ ] Terminals connect via WebSocket and render PTY output
- [ ] Sidebar shows live builder/PR/team data
- [ ] All V1 commands functional via Command Palette
- [ ] Extension published to VS Code Marketplace
- [ ] Zero critical security issues
- [ ] No degradation to existing browser dashboard

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "shared_types", "title": "Phase 1a: Shared Types Package (done)"},
    {"id": "shared_runtime", "title": "Phase 1b: Shared Runtime Package"},
    {"id": "connection_core", "title": "Phase 2a: Connection Manager + Auth"},
    {"id": "connection_reactive", "title": "Phase 2b: SSE + Tower Auto-Start"},
    {"id": "terminal_integration", "title": "Phase 3: Terminal Integration"},
    {"id": "sidebar", "title": "Phase 4: Unified Codev Sidebar"},
    {"id": "commands", "title": "Phase 5: Command Palette + Status Bar + Keyboard Shortcuts"},
    {"id": "review_comments", "title": "Phase 6: Review Comments (Snippet + Decorations)"},
    {"id": "v1_polish", "title": "Phase 7: V1 Polish + Packaging"},
    {"id": "analytics", "title": "Phase 8: Analytics Webview"},
    {"id": "file_links", "title": "Phase 9: File Link Handling (URI Scheme + TerminalLinkProvider)"}
  ]
}
```

## Phase Breakdown

### Phase 1: Shared Types Package
**Dependencies**: None

#### Objectives
- Extract shared TypeScript types into `packages/codev-types/`
- Both `@cluesmith/codev` and `codev-vscode` can import from it
- Eliminate type duplication that would cause protocol drift

#### Deliverables
- [ ] `packages/codev-types/package.json` with `"name": "@cluesmith/codev-types"`
- [ ] `packages/codev-types/src/index.ts` exporting all shared types
- [ ] WebSocket frame constants (`FRAME_CONTROL = 0x00`, `FRAME_DATA = 0x01`)
- [ ] Control message types (`resize`, `ping`, `pong`, `pause`, `resume`, `error`, `seq`)
- [ ] SSE event type catalog (`overview-changed`, `notification`, `connected`)
- [ ] API response shapes: `DashboardState`, `Builder`, `OverviewData`, `TerminalEntry`
- [ ] `packages/codev/package.json` updated to depend on `@cluesmith/codev-types`
- [ ] `packages/codev-vscode/package.json` updated to depend on `@cluesmith/codev-types`
- [ ] Existing server code imports from `@cluesmith/codev-types` instead of local copies

#### Implementation Details

**Files to create:**
- `packages/codev-types/package.json` — `"type": "module"`, `"exports"` pointing to source for dev, dist for publish
- `packages/codev-types/tsconfig.json` — ESM, declaration generation
- `packages/codev-types/src/index.ts` — barrel export
- `packages/codev-types/src/websocket.ts` — frame constants, control message types
- `packages/codev-types/src/sse.ts` — SSE event types
- `packages/codev-types/src/api.ts` — API response shapes

**Files to modify:**
- `packages/codev/src/agent-farm/servers/tower-types.ts` — import from `@cluesmith/codev-types`
- `packages/codev/src/terminal/ws-protocol.ts` — import frame constants from shared package
- `packages/codev/package.json` — add `@cluesmith/codev-types` dependency

**Key decision:** Types package uses `"type": "module"` to match the codev package. The extension's `"moduleResolution": "bundler"` handles ESM imports.

#### Acceptance Criteria
- [ ] `npm install` from root resolves all three workspace members
- [ ] `npm run build` in `packages/codev` passes with shared type imports
- [ ] `npm run check-types` in `packages/codev-vscode` passes with shared type imports
- [ ] `vsce package` produces a valid `.vsix` (workspace symlinks correctly resolved by esbuild at bundle time)
- [ ] Existing 2422 unit tests still pass

#### Test Plan
- **Unit Tests**: Type exports compile correctly
- **Integration Tests**: Server build + extension type-check both pass
- **Manual Testing**: `npm install` from root, verify symlinks

#### Rollback Strategy
Revert the extraction — types go back to local definitions. No runtime behavior change.

#### Risks
- **Risk**: Type extraction scope creep — too many types extracted at once
  - **Mitigation**: Start with WebSocket protocol types and API response shapes only. Dashboard types stay local for now.

---

### Phase 1b: Shared Runtime Package
**Dependencies**: Phase 1a

#### Objectives
- Extract shared runtime utilities from `packages/codev/src/agent-farm/lib/tower-client.ts` into `packages/shared/`
- Extract `EscapeBuffer` from `packages/dashboard/src/lib/escapeBuffer.ts`
- Both codev server and VS Code extension import from `@cluesmith/codev-shared` — no duplication
- Publish `@cluesmith/codev-shared` to npm as part of the release process

#### Deliverables
- [ ] `packages/shared/package.json` with `"name": "@cluesmith/codev-shared"`
- [ ] `packages/shared/tsconfig.json` extending `../config/tsconfig.base.json`
- [ ] `packages/shared/src/auth.ts` — `getLocalKey()`, `AGENT_FARM_DIR`, `LOCAL_KEY_PATH` extracted from `tower-client.ts`
- [ ] `packages/shared/src/workspace.ts` — `encodeWorkspacePath()`, `decodeWorkspacePath()` extracted from `tower-client.ts`
- [ ] `packages/shared/src/tower-client.ts` — `TowerClient` class and all Tower API types extracted from `tower-client.ts`
- [ ] `packages/shared/src/escape-buffer.ts` — `EscapeBuffer` class extracted from dashboard
- [ ] `packages/shared/src/constants.ts` — `DEFAULT_TOWER_PORT` and other shared constants
- [ ] `packages/shared/src/index.ts` — barrel export
- [ ] `packages/codev/src/agent-farm/lib/tower-client.ts` — replaced with re-exports from `@cluesmith/codev-shared`
- [ ] `packages/codev/package.json` — add `@cluesmith/codev-shared` as dependency (runtime, must be published)
- [ ] `packages/vscode/package.json` — add `@cluesmith/codev-shared` as dependency (esbuild bundles it, no publish needed for extension)
- [ ] `packages/dashboard/src/lib/escapeBuffer.ts` — replaced with import from `@cluesmith/codev-shared`

#### Implementation Details

**Files to create:**
- `packages/shared/package.json` — `"type": "module"`, dual exports (types → source, default → dist)
- `packages/shared/tsconfig.json` — extends base config
- `packages/shared/src/auth.ts` — extract `getLocalKey()` and path constants
- `packages/shared/src/workspace.ts` — extract `encodeWorkspacePath()` / `decodeWorkspacePath()`
- `packages/shared/src/tower-client.ts` — extract `TowerClient` class and all associated types
- `packages/shared/src/escape-buffer.ts` — extract `EscapeBuffer` from dashboard
- `packages/shared/src/constants.ts` — `DEFAULT_TOWER_PORT = 4100`
- `packages/shared/src/index.ts` — barrel export all public API

**Files to modify:**
- `packages/codev/src/agent-farm/lib/tower-client.ts` — replace with re-exports from `@cluesmith/codev-shared`
- `packages/codev/package.json` — add `@cluesmith/codev-shared` to dependencies
- `packages/dashboard/src/lib/escapeBuffer.ts` — replace with re-export from `@cluesmith/codev-shared`
- `packages/dashboard/package.json` — add `@cluesmith/codev-shared` to dependencies
- `.gitignore` — add `packages/shared/dist/`

**Key decision:** `@cluesmith/codev-shared` is a runtime dependency of `@cluesmith/codev` (the server runs under Node.js, not bundled). It must be published to npm alongside `@cluesmith/codev` during releases. The VS Code extension uses esbuild which bundles it at build time — no npm publish needed for the extension.

**TowerClient extraction:** The `TowerClient` class is the core API client used by all `afx` CLI commands. Moving it to the shared package means the extension gets the full Tower API client for free — no need to reimplement REST calls, auth, health checks, or workspace operations.

#### Acceptance Criteria
- [ ] `npm install` from root resolves all workspace members including shared
- [ ] `packages/codev/src/agent-farm/lib/tower-client.ts` is a thin re-export file
- [ ] All existing consumers of `TowerClient` work without changes (re-exports preserve the API)
- [ ] Extension can import `TowerClient` from `@cluesmith/codev-shared`
- [ ] `npm run build` in `packages/codev` passes
- [ ] All 2422+ unit tests pass
- [ ] `npm pack` + `npm install -g` succeeds (codev-shared must be published first, or use devDependency pattern for local testing)

#### Test Plan
- **Unit Tests**: Existing tower-client tests continue to pass via re-exports
- **Integration Tests**: `afx` commands work after extraction
- **Manual Testing**: `npm install` from root, verify workspace symlinks, build all packages

#### Rollback Strategy
Revert extraction — move code back to `tower-client.ts`. No runtime behavior change.

#### Risks
- **Risk**: `TowerClient` has hidden dependencies on Node.js APIs not available in extension
  - **Mitigation**: `TowerClient` uses `fetch` (available everywhere) and `fs` (only for `getLocalKey`). Extension wraps `getLocalKey` with `SecretStorage` at the consumer level.
- **Risk**: Publishing `@cluesmith/codev-shared` adds release complexity
  - **Mitigation**: Publish both packages in same release step. Version them together.

---

### Phase 2a: Connection Manager + Auth
**Dependencies**: Phase 1b

#### Objectives
- Implement the singleton Connection Manager wrapping `TowerClient` from `@cluesmith/codev-shared`
- Add VS Code-specific layers: state machine, Output Channel, SecretStorage auth wrapper, settings, activation
- No duplication of REST/auth/encoding logic — reuse `TowerClient` directly

#### Deliverables
- [ ] `src/connection-manager.ts` — singleton wrapping `TowerClient` from `@cluesmith/codev-shared`, adds state machine (DISCONNECTED → CONNECTING → CONNECTED → RECONNECTING) and VS Code integration
- [ ] `src/auth-wrapper.ts` — wraps `getLocalKey()` from shared with VS Code `SecretStorage` caching + 401 re-read
- [ ] `src/workspace-detector.ts` — uses `findProjectRoot()` pattern to traverse up from `vscode.workspace.workspaceFolders[0]` to `.codev/config.json`, reads Tower port from config
- [ ] `Codev` Output Channel for diagnostic logging (redacts auth tokens)
- [ ] Extension settings registration: all 7 settings
- [ ] Activation events: `workspaceContains:.codev/config.json` + implicit `onCommand:`
- [ ] Proper `deactivate()` — close all connections, dispose resources
- [ ] Add `ws` as runtime dependency, update `esbuild.js` externals
- [ ] `src/extension.ts` updated to initialize Connection Manager on activation
- [ ] Status bar showing connection state

#### Implementation Details

**Key principle:** The extension does NOT reimplement Tower API calls. It imports `TowerClient` from `@cluesmith/codev-shared` and wraps it with VS Code-specific concerns (state machine, Output Channel logging, SecretStorage, settings).

**Files to create:**
- `src/connection-manager.ts` — owns a `TowerClient` instance, adds state machine + reconnection + VS Code event emitters
- `src/auth-wrapper.ts` — thin wrapper: calls `getLocalKey()` from shared, caches in `SecretStorage`, re-reads on 401
- `src/workspace-detector.ts` — traverses up from workspace folder to find `.codev/config.json`, reads port

**Files to modify:**
- `src/extension.ts` — activate initializes Connection Manager, deactivate cleans up
- `package.json` — add settings, activation events, `ws` + `@cluesmith/codev-shared` dependencies
- `esbuild.js` — add `bufferutil`, `utf-8-validate` to externals

**What the extension adds on top of `TowerClient`:**
- State machine with VS Code event emitter (`onStateChange`)
- Status bar item reflecting connection state
- Output Channel logging (connection events, errors, redacted auth)
- `SecretStorage` caching for the auth key
- Settings-based host/port configuration
- Workspace auto-detection from VS Code workspace folders

**What the extension does NOT implement (reused from shared):**
- REST client with auth headers → `TowerClient.request()`
- Health check → `TowerClient.isRunning()`, `TowerClient.getHealth()`
- Workspace encoding → `encodeWorkspacePath()`
- Terminal operations → `TowerClient.createTerminal()`, etc.
- Send message → `TowerClient.sendMessage()`
- Tunnel control → `TowerClient.signalTunnel()`

**Activation:** Register `activationEvents` in `package.json`:
```json
"activationEvents": [
  "workspaceContains:.codev/config.json"
]
```
Commands activate implicitly via `onCommand:`.

#### Acceptance Criteria
- [ ] Extension activates on `codev.*` command or workspace with `codev/` directory
- [ ] Extension connects to running Tower via REST
- [ ] Health check validates protocol version
- [ ] Output Channel logs connection events (auth tokens redacted)
- [ ] Auth works with local-key, re-reads on 401
- [ ] `deactivate()` cleans up all connections
- [ ] Extension works behind HTTP proxy

#### Test Plan
- **Unit Tests**: State machine transitions, config parsing, auth key reading, workspace path traversal
- **Integration Tests**: Connect to running Tower, verify health check
- **Manual Testing**: F5 with Tower running, F5 without Tower

#### Rollback Strategy
Remove Connection Manager, revert extension.ts to scaffold.

#### Risks
- **Risk**: `ws` native bindings break esbuild bundle
  - **Mitigation**: Mark `bufferutil`, `utf-8-validate` as external. ws works without them.
- **Risk**: Workspace path detection fails for nested subdirectories
  - **Mitigation**: Walk up to filesystem root, log detected path to Output Channel

---

### Phase 2b: SSE + Tower Auto-Start
**Dependencies**: Phase 2a

#### Objectives
- Add SSE client for real-time state updates
- Auto-start Tower on activation
- Complete the reactive connection layer

#### Deliverables
- [ ] SSE client subscribing to `/api/events` with heartbeat handling (30s heartbeats don't trigger refresh)
- [ ] Rate-limited SSE-triggered refreshes (max 1/second to prevent storms)
- [ ] Tower auto-start (`afx tower start` as detached process)
- [ ] Exponential backoff reconnection (1s → 2s → 4s → 8s → max 30s)
- [ ] SSE reconnection: disable native `EventSource` auto-reconnect, use Connection Manager state machine instead to avoid double-retry

#### Implementation Details

**Files to create:**
- `src/sse-client.ts` — SSE subscription with heartbeat filtering and rate limiting
- `src/tower-starter.ts` — auto-start Tower as detached process, resolve full `afx` path

**Files to modify:**
- `src/connection-manager.ts` — integrate SSE client, add reconnection logic
- `src/extension.ts` — activate triggers Tower auto-start if `codev.autoStartTower` is true

**SSE heartbeat handling:** Filter events where `event.type === 'heartbeat'`. Only trigger TreeView/StatusBar refresh for actual state change events (`overview-changed`, `notification`).

**Tower auto-start:** Check `/api/health`. If no response and `codev.autoStartTower` is true:
1. Resolve `afx` path from `node_modules/.bin/afx` or global `which afx`
2. Spawn `afx tower start` as detached process
3. Poll `/api/health` with backoff until Tower responds (max 10 attempts)
4. If start fails, show "Tower is not running" in status bar, log error to Output Channel

#### Acceptance Criteria
- [ ] SSE events received and routed to consumers
- [ ] Heartbeats don't trigger unnecessary refreshes
- [ ] SSE bursts rate-limited to 1 refresh/second
- [ ] Tower auto-starts when not running (setting enabled)
- [ ] Clean reconnection after Tower restart

#### Test Plan
- **Unit Tests**: SSE heartbeat filtering, rate limiting logic
- **Integration Tests**: Connect SSE to Tower, kill Tower (verify reconnection), auto-start
- **Manual Testing**: F5 without Tower (auto-start), kill Tower mid-session (reconnection)

#### Rollback Strategy
Remove SSE client and Tower starter. REST connection still works for manual refreshes.

#### Risks
- **Risk**: Tower auto-start fails due to PATH issues
  - **Mitigation**: Resolve full `afx` path, try `node_modules/.bin/afx` first, then global. Log to Output Channel.
- **Risk**: Double-retry from native EventSource + custom backoff
  - **Mitigation**: Disable native EventSource reconnection, handle manually in state machine

---

### Phase 3: Terminal Integration
**Dependencies**: Phase 2a

#### Objectives
- Connect to Tower PTY sessions via WebSocket
- Render terminals in VS Code editor area (architect left, builders right)
- Handle binary protocol translation, escape buffering, backpressure

#### Deliverables
- [ ] `src/terminal-adapter.ts` — Pseudoterminal implementation with WebSocket binary protocol
- [ ] `src/escape-buffer.ts` — port of `dashboard/src/lib/escapeBuffer.ts`
- [ ] Binary protocol adapter: inbound `0x01` → `TextDecoder({ stream: true })` → `onDidWrite`, outbound → `0x01` prefix → `ws.send()`
- [ ] Control frame handling (`0x00`): resize, ping/pong, sequence numbers
- [ ] Reconnection with inline ANSI banner and ring buffer replay
- [ ] Resize deferral during replay
- [ ] Backpressure: chunk `onDidWrite` at 16KB with `setImmediate`, disconnect at 1MB
- [ ] Editor layout: architect in left group, builders as tabs in right group
- [ ] Terminal naming: `Codev: Architect`, `Codev: #42 password-hashing [implement]`, `Codev: Shell #1`
- [ ] WebSocket auth via `0x00` control message after connection (not query param)
- [ ] Respect `codev.terminalPosition` setting — only attempt `moveIntoEditor` when set to `"editor"`
- [ ] Fallback to bottom panel if `moveIntoEditor` fails
- [ ] WebSocket pool management (max 10 concurrent)
- [ ] Image paste: intercept clipboard paste in terminal, upload via `POST /api/paste-image` (note: VS Code Pseudoterminal only delivers text input — investigate clipboard API feasibility, defer if not possible)

#### Implementation Details

**Files to create:**
- `src/terminal-adapter.ts` — `CodevPseudoterminal` class implementing `vscode.Pseudoterminal`
- `src/escape-buffer.ts` — ANSI escape sequence buffering
- `src/terminal-manager.ts` — WebSocket pool, terminal lifecycle, editor layout

**Files to modify:**
- `src/extension.ts` — register terminal commands
- `package.json` — add commands: `codev.openArchitectTerminal`, `codev.openBuilderTerminal`, `codev.newShell`

**Binary protocol adapter (in `CodevPseudoterminal`):**
```typescript
// Inbound
ws.on('message', (data: Buffer) => {
  const type = data[0];
  if (type === FRAME_DATA) {
    const text = decoder.decode(data.slice(1), { stream: true });
    const safe = escapeBuffer.write(text);
    this.writeEmitter.fire(safe);
  } else if (type === FRAME_CONTROL) {
    this.handleControl(JSON.parse(data.slice(1).toString()));
  }
});

// Outbound
handleInput(data: string): void {
  const encoded = encoder.encode(data);
  const frame = new Uint8Array(1 + encoded.length);
  frame[0] = FRAME_DATA;
  frame.set(encoded, 1);
  this.ws.send(frame);
}
```

**Editor layout sequence:**
1. Create terminal with `createTerminal({ name, pty })`
2. `vscode.commands.executeCommand('workbench.action.terminal.moveIntoEditor')`
3. For architect: move to first editor group
4. For builders: move to second editor group (split if needed)
5. Catch errors → fallback to bottom panel

#### Acceptance Criteria
- [ ] Architect terminal opens in left editor group
- [ ] Builder terminal opens as tab in right editor group
- [ ] Terminal renders PTY output correctly (ANSI colors, cursor movement)
- [ ] Typing in terminal sends input to PTY
- [ ] Terminal survives VS Code reload (reconnects to shellper via Tower)
- [ ] Resize works correctly (including during replay)
- [ ] No CPU spikes at sustained terminal output

#### Test Plan
- **Unit Tests**: EscapeBuffer (port dashboard tests), binary protocol encoding/decoding, backpressure chunking
- **Integration Tests**: Connect to Tower terminal, send input, verify output
- **Manual Testing**: Open architect + builder, type commands, resize window, kill Tower (reconnection), heavy output (`cat` large file)

#### Rollback Strategy
Remove terminal adapter, revert to scaffold. Connection Manager stays functional.

#### Risks
- **Risk**: `moveIntoEditor` fails on some VS Code versions
  - **Mitigation**: Try/catch with panel fallback, log warning to Output Channel
- **Risk**: EscapeBuffer diverges from dashboard implementation
  - **Mitigation**: Port tests alongside code, verify against same fixtures

---

### Phase 4: Unified Codev Sidebar
**Dependencies**: Phase 2b

#### Objectives
- Register Codev View Container with Activity Bar icon
- Implement all sidebar TreeView sections
- Live refresh via SSE events

#### Deliverables
- [ ] View Container registration with custom icon in Activity Bar
- [ ] `src/views/needs-attention.ts` — TreeDataProvider for blocked builders and PRs needing review
- [ ] `src/views/builders.ts` — TreeDataProvider for active builders with status/phase
- [ ] `src/views/pull-requests.ts` — TreeDataProvider for open PRs with author
- [ ] `src/views/backlog.ts` — TreeDataProvider for backlog issues with author
- [ ] `src/views/recently-closed.ts` — TreeDataProvider for recently closed items
- [ ] `src/views/team.ts` — TreeDataProvider for team members with activity (conditional on `teamEnabled`)
- [ ] `src/views/status.ts` — TreeDataProvider for Tower/tunnel/cron status
- [ ] Context menu actions on all tree items (actions that depend on Phase 3/5 registered as no-ops with "Coming soon" message until those phases complete)
- [ ] "Other Workspaces" collapsible node showing workspaces from other projects (read-only, show builder count)
- [ ] SSE-triggered refresh (rate-limited to 1/second)
- [ ] Manual refresh button
- [ ] Handle initial load failure gracefully (show "Unable to connect" state)

#### Implementation Details

**Files to create:**
- `src/views/` directory with one file per TreeView section
- `src/views/overview-cache.ts` — shared cache for `/api/overview` data, refreshed on SSE
- `src/icons/codev.svg` — Activity Bar icon

**Files to modify:**
- `package.json` — `contributes.viewsContainers`, `contributes.views`, `contributes.menus` for context actions
- `src/extension.ts` — register all TreeView providers

**Data flow:**
```
SSE event → Connection Manager → overview-cache refresh → TreeView.refresh()
                                                      → (rate limited, max 1/sec)
```

**Team section visibility:** Check `state.teamEnabled` from `/api/state`. Hide the Team TreeView when false.

#### Acceptance Criteria
- [ ] Codev icon appears in Activity Bar
- [ ] All 7 sections render with correct data
- [ ] Context menu actions work (Open Terminal, Send Message, Approve Gate, etc.)
- [ ] TreeView refreshes on SSE events within 200ms
- [ ] Team section hidden when `teamEnabled` is false
- [ ] Forge-agnostic: no hardcoded GitHub URLs

#### Test Plan
- **Unit Tests**: TreeDataProvider returns correct tree items, cache refresh logic, rate limiting
- **Integration Tests**: Connect to Tower, verify sidebar populates with real data
- **Manual Testing**: Click through all context menu actions, verify SSE refresh, toggle team visibility

#### Rollback Strategy
Remove view registrations from package.json, delete views/ directory. Extension still has terminals + connection.

#### Risks
- **Risk**: 7 TreeView providers create excessive API calls
  - **Mitigation**: Single cached `/api/overview` call shared by all work view sections. Only Team and Status use separate endpoints.

---

### Phase 5: Command Palette + Status Bar + Keyboard Shortcuts
**Dependencies**: Phase 2b (most commands), Phase 3 (terminal commands), Phase 4 (sidebar wiring)

#### Objectives
- Register all 15 Command Palette commands
- Implement status bar items
- Add default keyboard shortcuts

#### Deliverables
- [ ] All 15 commands registered and functional (spawn, send, approve, cleanup, terminals, cron, tunnel, analytics, team, refresh, status)
- [ ] Quick-pick flows for spawn (issue + protocol + branch), send (builder + message), approve (gate list)
- [ ] Status bar: builder count + blocked gates (left-aligned)
- [ ] Status bar click → quick-pick of pending actions
- [ ] Keyboard shortcuts: `Cmd+K, A` (architect), `Cmd+K, D` (send/deliver message), `Cmd+K, G` (approve) — chord bindings, verified no conflicts with built-in VS Code shortcuts
- [ ] Wire up Phase 4 context menu no-ops with real handlers (Open Terminal → Phase 3, Approve Gate → Phase 5)

#### Implementation Details

**Files to create:**
- `src/commands/spawn.ts` — Spawn Builder with quick-pick flow
- `src/commands/send.ts` — Send Message with builder picker + input
- `src/commands/approve.ts` — Approve Gate with pending gates list
- `src/commands/cleanup.ts` — Cleanup Builder
- `src/commands/cron.ts` — Cron task management (list, run, enable, disable)
- `src/commands/tunnel.ts` — Connect/disconnect tunnel
- `src/status-bar.ts` — Status bar item management

**Files to modify:**
- `package.json` — `contributes.commands`, `contributes.keybindings`
- `src/extension.ts` — register all commands and status bar

**Spawn flow:**
1. Input box: issue number
2. Quick-pick: protocol (spir, aspir, air, bugfix, tick)
3. Optional input: branch name
4. Execute via Tower API or CLI

**Send flow:**
1. Quick-pick: select builder from active list
2. Input box: message text
3. `POST /api/send` with builder ID and message

#### Acceptance Criteria
- [ ] All 15 commands accessible via `Cmd+Shift+P` → "Codev:"
- [ ] Spawn/send/approve flows complete end-to-end
- [ ] Status bar shows correct builder count and gate count
- [ ] Keyboard shortcuts work
- [ ] Error notifications shown on command failure

#### Test Plan
- **Unit Tests**: Command registration, quick-pick option generation
- **Integration Tests**: Send message to builder, verify delivery
- **Manual Testing**: Run every command via Command Palette, verify keyboard shortcuts

#### Rollback Strategy
Remove command registrations. Sidebar and terminals continue to work.

#### Risks
- **Risk**: Keyboard shortcut conflicts with existing VS Code bindings
  - **Mitigation**: Test default shortcuts, document conflicts, allow user rebinding

---

### Phase 6: Review Comments (Snippet + Decorations)
**Dependencies**: None (VS Code Snippets and Decorations API don't require Tower connection)

#### Objectives
- Add review comment insertion via snippet and Command Palette
- Highlight existing review comments with Decorations API
- Can be built in parallel with all other phases from Day 1

#### Deliverables
- [ ] `Codev: Add Review Comment` command — inserts comment at cursor with language-appropriate syntax
- [ ] `rev` snippet contributing via `contributes.snippets`
- [ ] `src/review-decorations.ts` — scans for `REVIEW(...)` patterns, applies colored background + gutter icon
- [ ] Decoration refresh on file open and text change
- [ ] Language-to-comment-syntax mapping (JS/TS/Go/Rust/Java/Python/Ruby/Bash/YAML/HTML/CSS)
- [ ] Warning for non-commentable files (JSON, binary)

#### Implementation Details

**Files to create:**
- `src/commands/review.ts` — insert review comment with language detection
- `src/review-decorations.ts` — decoration provider scanning for `REVIEW(...)` patterns
- `snippets/review.json` — `rev` snippet definition

**Files to modify:**
- `package.json` — add command, snippet contribution

**Language detection:** Map `vscode.TextDocument.languageId` to comment syntax. Comprehensive mapping covering all common languages.

#### Acceptance Criteria
- [ ] `rev` + Tab inserts correct comment syntax for file type
- [ ] Command inserts comment at cursor line
- [ ] Existing REVIEW comments highlighted with colored background
- [ ] Decorations update when file changes

#### Test Plan
- **Unit Tests**: Language-to-comment-syntax mapping
- **Manual Testing**: Insert comments in JS, Python, HTML, CSS, Go files. Verify decorations render.

#### Rollback Strategy
Remove snippet and decoration provider. No impact on any other phase.

---

### Phase 7: V1 Polish + Packaging
**Dependencies**: Phases 2a, 2b, 3, 4, 5, 6

#### Objectives
- Final integration testing across all V1 phases
- `vsce package` verification
- Marketplace readiness

#### Deliverables
- [ ] `vsce package` produces a valid `.vsix` file
- [ ] Workspace symlinks (`@cluesmith/codev-types`) correctly bundled by esbuild (not left as `file:` references)
- [ ] Extension README for Marketplace listing
- [ ] All V1 success criteria verified end-to-end
- [ ] Extension size audit (Marketplace has size constraints)

#### Acceptance Criteria
- [ ] `.vsix` installs cleanly in a fresh VS Code instance
- [ ] Extension activates, connects, shows sidebar, opens terminals
- [ ] No console errors, no missing dependencies at runtime
- [ ] Extension activation time < 500ms (spec requirement)

#### Test Plan
- **Manual Testing**: Install `.vsix` in clean VS Code, run full workflow
- **Packaging**: `vsce package` succeeds without warnings

#### Rollback Strategy
Not applicable — this is a validation phase.

---

### V1 CUT LINE
**Phases 1-7 constitute V1** — a complete, functional extension with shared types, connection management, terminals, sidebar, commands, review comments, and verified packaging. Phases 8-9 are post-V1 enhancements.

---

### Phase 8: Analytics Webview
**Dependencies**: Phase 2a

#### Objectives
- Embed Recharts analytics dashboard in a Webview panel
- Theme integration with VS Code

#### Deliverables
- [ ] Separate Vite entry point (`analytics-embed.html`) in dashboard package
- [ ] `src/analytics-panel.ts` — WebviewPanel with CSP, theme variable injection
- [ ] Data proxied through extension host via `postMessage`
- [ ] `retainContextWhenHidden` for chart state preservation
- [ ] VS Code theme variable mapping to dashboard CSS variables

#### Implementation Details

**Files to create:**
- `src/analytics-panel.ts` — Webview panel management
- `dashboard/analytics-embed.html` — separate Vite entry point (in main codev package)

**Files to modify:**
- `dashboard/vite.config.ts` — add second entry point for analytics embed
- `package.json` — add `codev.viewAnalytics` command

**Theme mapping:** Inject CSS variables at Webview creation:
```css
:root {
  --bg-primary: var(--vscode-editor-background);
  --text-primary: var(--vscode-editor-foreground);
  --border-color: var(--vscode-panel-border);
}
```

#### Acceptance Criteria
- [ ] Analytics panel opens via Command Palette
- [ ] Charts render correctly with VS Code theme colors
- [ ] Data refreshes on panel focus
- [ ] Panel survives hide/show cycle

#### Test Plan
- **Manual Testing**: Open analytics in light and dark themes, verify chart readability

#### Rollback Strategy
Remove analytics command and panel. No impact on core functionality.

---

### Phase 9: File Link Handling (URI Scheme + TerminalLinkProvider)
**Dependencies**: Phase 3

#### Objectives
- Register `vscode://codev/open` URI handler
- Modify `afx open` CLI to emit URIs when VS Code is detected
- Register TerminalLinkProvider for clickable file paths in terminal output

#### Deliverables
- [ ] `src/uri-handler.ts` — `UriHandler` for `vscode://codev/open?file=...&line=...`
- [ ] `src/terminal-link-provider.ts` — detect file paths in terminal output, open on click
- [ ] Modify `afx open` CLI in `packages/codev` to detect VS Code and emit URI

#### Implementation Details

**Files to create:**
- `src/uri-handler.ts` — parse URI, open file at line
- `src/terminal-link-provider.ts` — regex-based file path detection

**Files to modify:**
- `src/extension.ts` — register URI handler and TerminalLinkProvider
- `packages/codev/src/agent-farm/commands/open.ts` — detect VS Code (check `TERM_PROGRAM` or `VSCODE_PID` env var), emit `open vscode://codev/open?file=...&line=...` instead of Tower API call

**VS Code detection in CLI (cross-platform):**
```typescript
const isVSCode = process.env.TERM_PROGRAM === 'vscode' || process.env.VSCODE_PID;
if (isVSCode) {
  const uri = `vscode://codev/open?file=${encodeURIComponent(file)}&line=${line}`;
  // Cross-platform URI open
  if (process.platform === 'darwin') exec(`open "${uri}"`);
  else if (process.platform === 'win32') exec(`start "" "${uri}"`);
  else exec(`xdg-open "${uri}"`);
} else {
  // existing Tower API call
}
```

#### Acceptance Criteria
- [ ] `afx open file.ts:42` from VS Code terminal opens file in editor at line 42
- [ ] File paths in terminal output are clickable and open in editor
- [ ] `afx open` still works from non-VS-Code terminals (falls back to Tower)

#### Test Plan
- **Unit Tests**: URI parsing, file path regex matching
- **Integration Tests**: `afx open` from VS Code integrated terminal
- **Manual Testing**: Click file paths in builder terminal output

#### Rollback Strategy
Remove URI handler and link provider. `afx open` continues to work via Tower API.

---

## Dependency Map
```
Phase 1a (types, done) ──→ Phase 1b (shared runtime) ──→ Phase 2a (connection)
                                                      ──→ Phase 2b (SSE + auto-start) ──→ Phase 4 (sidebar)
                                                      ──→ Phase 3 (terminals)
                                            Phase 2b + 3 + 4 ──→ Phase 5 (commands)
                                                   Phase 2a ──→ Phase 8 (analytics, post-V1)
                                                   Phase 3 ──→ Phase 9 (file links, post-V1)

Phase 6 (review comments) ── NO DEPENDENCIES ── can run in parallel from Day 1

All V1 phases (1a, 1b, 2a, 2b, 3-6) ──→ Phase 7 (V1 polish + packaging)
```

Phases 3, 4, and 6 can run in parallel. Phase 6 (review comments) has zero dependencies and can start immediately.

## Integration Points

### Tower Server (existing)
- **REST API**: `/api/overview`, `/api/send`, `/api/health`, `/api/workspaces`, `/api/cron/*`, `/api/tunnel/*`
- **WebSocket**: `/workspace/:path/ws/terminal/:id` — binary protocol
- **SSE**: `/api/events` — real-time state push
- **Workspace-scoped**: `/workspace/:base64path/api/state`, `/api/team`, `/api/tabs/shell`

### CLI (`afx open` modification)
- Phase 9 modifies the `afx open` command to detect VS Code and emit URI
- Backwards compatible — non-VS-Code environments unchanged

## Risk Analysis

| Risk | Probability | Impact | Mitigation | Phase |
|------|------------|--------|------------|-------|
| Type extraction scope creep | Medium | Medium | Limit to protocol + API types only | 1 |
| `ws` native bindings break esbuild | High | High | Mark `bufferutil`, `utf-8-validate` as external | 2a |
| `vsce package` fails with workspace symlinks | Medium | High | esbuild resolves at bundle time; add packaging test to Phase 1 | 1, 7 |
| Tower auto-start PATH issues | Medium | Low | Resolve full afx path, log errors | 2b |
| SSE double-retry (native + custom backoff) | Medium | Medium | Disable native EventSource reconnection | 2b |
| HTTP proxy not configured in enterprise | Medium | Medium | Integrate with VS Code proxy settings, `https-proxy-agent` | 2a |
| `moveIntoEditor` API instability | Medium | Medium | Check `terminalPosition` setting first, try/catch with panel fallback | 3 |
| `@cluesmith/codev-shared` must be published to npm | Medium | High | Publish alongside codev in same release step, version together | 1b |
| Image paste infeasible via Pseudoterminal | High | Low | Investigate clipboard API, defer if not possible | 3 |
| 7 TreeView providers cause excessive API calls | Low | Medium | Single cached overview call | 4 |
| Phase 4 context menu actions depend on later phases | Medium | Low | Register as no-ops, wire up in Phase 5 | 4 |
| Keyboard shortcut conflicts | Low | Low | Chord bindings (`Cmd+K, A/D/G`) verified unassigned by default | 5 |
| `afx open` URI is macOS-only | High | Medium | Cross-platform: `open` / `start` / `xdg-open` | 9 |
| Analytics theme mismatch | Medium | Low | Inject VS Code CSS variables | 8 |

## Validation Checkpoints
1. **After Phase 2**: Extension connects to Tower, auto-starts it, shows connection state
2. **After Phase 3**: Terminals work end-to-end (open, type, resize, reconnect)
3. **After Phase 5 (V1)**: Full functional extension — terminals, sidebar, commands, status bar
4. **Before Marketplace**: All phases complete, manual test pass, no security issues

## Documentation Updates Required
- [ ] Update `CLAUDE.md` / `AGENTS.md` with VS Code extension development instructions
- [ ] Update `codev/resources/arch.md` with extension architecture
- [ ] Extension README for Marketplace listing
- [ ] Update `codev/resources/commands/overview.md` with `afx open` URI scheme changes

## Post-Implementation Tasks
- [ ] Performance validation (activation time, terminal latency)
- [ ] Security review (auth handling, Webview CSP)
- [ ] Marketplace publishing setup (publisher account, CI pipeline)
- [ ] User acceptance testing with team

## Expert Review

**Date**: 2026-04-06
**Models Consulted**: Gemini 3 Pro, GPT-5.4 Codex, Claude (via `consult` CLI)

**First Consultation — Key Feedback (incorporated):**
- **Gemini**: V1 cut line violates spec (review comments are V1). Phase 7 dependency on Phase 2 is wrong. Image paste belongs in Phase 3. HTTP proxy support missing. Missing settings and protocol version check. → All fixed.
- **Codex**: WebSocket auth control message missing. Shell terminal command flow missing. `afx open` is macOS-only. Activation time target not addressed. → All fixed.
- **Claude**: Phase 2 too large (5 subsystems) — split into 2a/2b. `ws` native bindings break esbuild. Phase 4 context menu actions create circular dependency. Missing activation events. `vsce package` needs testing with workspace symlinks. → All fixed.

**Second Consultation (2026-04-12) — Validation:**
- **Gemini**: All first-round feedback addressed. Found: activation event should use `.codev/config.json` not `codev/`, `Cmd+K, M` conflicts with Change Language Mode, UX walkthrough references post-V1 gutter "+". → All fixed.
- **Codex**: All first-round feedback addressed. Found: Phase 7 JSON id mismatch (`commands_v1`), activation events inconsistent between deliverables and code snippet. → All fixed.
- **Claude**: All first-round feedback addressed. Found: dependency map self-reference, Phase 8/9 CLI reference mismatch, `ws` not in Phase 2a deliverables, activation time not in Phase 7 criteria. → All fixed.

## Approval
- [ ] Technical Lead Review
- [ ] Engineering Manager Approval
- [ ] Resource Allocation Confirmed
- [x] Expert AI Consultation Complete

## Notes

**V1 cut line**: Phases 1-7 are V1. Review comments (Phase 6) are explicitly V1 per the spec. The V1 Polish phase (7) ensures packaging works before Marketplace publishing.

**Parallel execution**: Phase 6 (review comments) has zero dependencies and can start Day 1. Phases 3 and 4 can run in parallel after Phase 2b. Most Phase 5 commands only need Phase 2b (not 3 or 4).

**Monorepo prerequisite**: Already done — npm workspaces set up with root `package.json`, extension scaffold at `packages/codev-vscode/`, cross-package imports verified.

**No duplication by design**: Phase 1b extracts `TowerClient`, auth, workspace encoding, and `EscapeBuffer` into `@cluesmith/codev-shared` before any extension code is written. Phase 2a wraps the shared `TowerClient` with VS Code-specific concerns (state machine, SecretStorage, Output Channel) instead of reimplementing REST calls.

**Consultation feedback incorporated**: Phase 2 split into 2a/2b per Claude recommendation. Review comments moved into V1 per Gemini/Codex. Image paste feasibility flagged per Codex. Cross-platform `afx open` per Codex. `ws` bundling risk per Claude. All missing settings/activation events added.

---

## Amendment History

This section tracks all TICK amendments to this plan.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
