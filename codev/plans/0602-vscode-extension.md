# Plan: VS Code Extension for Codev Agent Farm

## Metadata
- **ID**: 0602
- **Status**: draft
- **Specification**: `codev/specs/0602-vscode-extension.md`
- **Created**: 2026-04-06

## Executive Summary

Implement the VS Code extension as a thin client over Tower's existing API, following the approved specification. The plan is structured into 8 phases, each independently shippable. Phases 1-5 form the V1 cut line — the minimum viable extension that delivers the core value proposition (terminals + sidebar + commands). Phases 6-8 add polish features (analytics, review comments, URI scheme).

The shared types package (`@cluesmith/codev-types`) is extracted in Phase 1 as a prerequisite, since every subsequent phase depends on it.

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
    {"id": "shared_types", "title": "Phase 1: Shared Types Package"},
    {"id": "connection_manager", "title": "Phase 2: Connection Manager + Tower Auto-Start"},
    {"id": "terminal_integration", "title": "Phase 3: Terminal Integration"},
    {"id": "sidebar", "title": "Phase 4: Unified Codev Sidebar"},
    {"id": "commands", "title": "Phase 5: Command Palette + Status Bar + Keyboard Shortcuts"},
    {"id": "analytics", "title": "Phase 6: Analytics Webview"},
    {"id": "review_comments", "title": "Phase 7: Review Comments (Snippet + Decorations)"},
    {"id": "file_links", "title": "Phase 8: File Link Handling (URI Scheme + TerminalLinkProvider)"}
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

### Phase 2: Connection Manager + Tower Auto-Start
**Dependencies**: Phase 1

#### Objectives
- Implement the singleton Connection Manager with state machine
- Auto-start Tower on activation
- Register Output Channel for diagnostics
- Read auth from `~/.agent-farm/local-key`

#### Deliverables
- [ ] `src/connection-manager.ts` — singleton with state machine (DISCONNECTED → CONNECTING → CONNECTED → RECONNECTING)
- [ ] REST client with authenticated fetch (`codev-web-key` header)
- [ ] SSE client subscribing to `/api/events` with heartbeat handling and rate-limited refresh (max 1/second)
- [ ] Health check against `/api/health`
- [ ] Workspace path detection (traverse up to `.codev/config.json` root)
- [ ] Base64url encoding for workspace-scoped routes
- [ ] Tower auto-start (`afx tower start` as detached process)
- [ ] `Codev` Output Channel for diagnostic logging
- [ ] Auth via `SecretStorage` with re-read from disk on 401
- [ ] Extension settings registration (`codev.towerHost`, `codev.towerPort`, `codev.workspacePath`, `codev.autoConnect`, `codev.autoStartTower`)
- [ ] `src/extension.ts` updated to initialize Connection Manager on activation

#### Implementation Details

**Files to create:**
- `src/connection-manager.ts` — core class with state machine, REST/SSE clients
- `src/auth.ts` — local-key reading, SecretStorage caching, 401 re-read
- `src/config.ts` — `.codev/config.json` reader, workspace path detection
- `src/tower-starter.ts` — auto-start Tower as detached process

**Files to modify:**
- `src/extension.ts` — activate initializes Connection Manager
- `package.json` — add `contributes.configuration` for settings, add `ws` and `eventsource` dependencies

**State machine:**
```
DISCONNECTED → (health check) → CONNECTING → (SSE connected) → CONNECTED
CONNECTED → (SSE drops) → RECONNECTING → (backoff retry) → CONNECTING
RECONNECTING → (max retries) → DISCONNECTED
```

**Workspace detection:** Walk up from `vscode.workspace.workspaceFolders[0]` looking for `.codev/config.json`. Read Tower port from config. Match against `GET /api/workspaces`.

#### Acceptance Criteria
- [ ] Extension activates and connects to running Tower
- [ ] Extension auto-starts Tower if not running (when setting enabled)
- [ ] Status bar shows connection state (connected/offline)
- [ ] Output Channel logs connection events
- [ ] SSE events received and logged
- [ ] Auth works with local-key, re-reads on 401

#### Test Plan
- **Unit Tests**: State machine transitions, config parsing, auth key reading
- **Integration Tests**: Connect to running Tower, verify SSE stream
- **Manual Testing**: F5 with Tower running, F5 without Tower (auto-start), kill Tower (reconnection)

#### Rollback Strategy
Remove Connection Manager, revert extension.ts to hello-world scaffold.

#### Risks
- **Risk**: Tower auto-start fails due to PATH issues
  - **Mitigation**: Resolve full `afx` path from project's node_modules/.bin or global install. Log failure to Output Channel.

---

### Phase 3: Terminal Integration
**Dependencies**: Phase 2

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
- [ ] Fallback to bottom panel if `moveIntoEditor` fails
- [ ] WebSocket pool management (max 10 concurrent)

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
**Dependencies**: Phase 2

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
- [ ] Context menu actions on all tree items
- [ ] SSE-triggered refresh (rate-limited to 1/second)
- [ ] Manual refresh button

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
**Dependencies**: Phase 2, Phase 3, Phase 4

#### Objectives
- Register all 15 Command Palette commands
- Implement status bar items
- Add default keyboard shortcuts

#### Deliverables
- [ ] All 15 commands registered and functional (spawn, send, approve, cleanup, terminals, cron, tunnel, analytics, team, refresh, status)
- [ ] Quick-pick flows for spawn (issue + protocol + branch), send (builder + message), approve (gate list)
- [ ] Status bar: builder count + blocked gates (left-aligned)
- [ ] Status bar click → quick-pick of pending actions
- [ ] Keyboard shortcuts: `Cmd+Shift+A` (architect), `Cmd+Shift+M` (send), `Cmd+Shift+G` (approve)
- [ ] Image paste handling in terminal (`POST /api/paste-image`)

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

### V1 CUT LINE
**Phases 1-5 constitute V1** — a complete, functional extension with terminals, sidebar, commands, and status bar. Phases 6-8 are post-V1 enhancements.

---

### Phase 6: Analytics Webview
**Dependencies**: Phase 2

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

### Phase 7: Review Comments (Snippet + Decorations)
**Dependencies**: Phase 2

#### Objectives
- Add review comment insertion via snippet and Command Palette
- Highlight existing review comments with Decorations API

#### Deliverables
- [ ] `Codev: Add Review Comment` command — inserts comment at cursor with language-appropriate syntax
- [ ] `rev` snippet contributing via `contributes.snippets`
- [ ] `src/review-decorations.ts` — scans for `REVIEW(...)` patterns, applies colored background + gutter icon
- [ ] Decoration refresh on file open and text change

#### Implementation Details

**Files to create:**
- `src/commands/review.ts` — insert review comment with language detection
- `src/review-decorations.ts` — decoration provider
- `snippets/review.json` — `rev` snippet definition

**Files to modify:**
- `package.json` — add command, snippet contribution

**Language detection:** Map `vscode.TextDocument.languageId` to comment syntax.

#### Acceptance Criteria
- [ ] `rev` + Tab inserts correct comment syntax for file type
- [ ] Command inserts comment at cursor line
- [ ] Existing REVIEW comments highlighted with colored background
- [ ] Decorations update when file changes

#### Test Plan
- **Unit Tests**: Language-to-comment-syntax mapping
- **Manual Testing**: Insert comments in JS, Python, HTML, CSS files. Verify decorations render.

#### Rollback Strategy
Remove snippet and decoration provider. No impact on core functionality.

---

### Phase 8: File Link Handling (URI Scheme + TerminalLinkProvider)
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

**VS Code detection in CLI:**
```typescript
const isVSCode = process.env.TERM_PROGRAM === 'vscode' || process.env.VSCODE_PID;
if (isVSCode) {
  exec(`open "vscode://codev/open?file=${encodeURIComponent(file)}&line=${line}"`);
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
Phase 1 (types) ──→ Phase 2 (connection) ──→ Phase 3 (terminals)
                                          ──→ Phase 4 (sidebar)
                                          ──→ Phase 5 (commands) ← Phase 3, Phase 4
                                          ──→ Phase 6 (analytics)
                                          ──→ Phase 7 (review comments)
                    Phase 3 ──────────────→ Phase 8 (file links)
```

Phases 3, 4, 6, and 7 can run in parallel after Phase 2.

## Integration Points

### Tower Server (existing)
- **REST API**: `/api/overview`, `/api/send`, `/api/health`, `/api/workspaces`, `/api/cron/*`, `/api/tunnel/*`
- **WebSocket**: `/workspace/:path/ws/terminal/:id` — binary protocol
- **SSE**: `/api/events` — real-time state push
- **Workspace-scoped**: `/workspace/:base64path/api/state`, `/api/team`, `/api/tabs/shell`

### CLI (`afx open` modification)
- Phase 8 modifies the `afx open` command to detect VS Code and emit URI
- Backwards compatible — non-VS-Code environments unchanged

## Risk Analysis

| Risk | Probability | Impact | Mitigation | Phase |
|------|------------|--------|------------|-------|
| Type extraction scope creep | Medium | Medium | Limit to protocol + API types only | 1 |
| Tower auto-start PATH issues | Medium | Low | Resolve full afx path, log errors | 2 |
| `moveIntoEditor` API instability | Medium | Medium | Try/catch with panel fallback | 3 |
| EscapeBuffer divergence | Low | High | Port dashboard tests alongside code | 3 |
| 7 TreeView providers cause excessive API calls | Low | Medium | Single cached overview call | 4 |
| Keyboard shortcut conflicts | Medium | Low | Test defaults, allow rebinding | 5 |
| Analytics theme mismatch | Medium | Low | Inject VS Code CSS variables | 6 |

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

## Approval
- [ ] Technical Lead Review
- [ ] Engineering Manager Approval
- [ ] Resource Allocation Confirmed
- [ ] Expert AI Consultation Complete

## Notes

**V1 cut line**: Phases 1-5 are the minimum viable extension. Ship these first, then iterate with phases 6-8. This follows the consultation recommendation to not let scope block V1.

**Parallel execution**: Phases 3, 4, 6, and 7 can be built in parallel by different builders after Phase 2 completes. Phase 5 depends on 3 and 4 (needs terminals and sidebar to wire up commands).

**Monorepo prerequisite**: Already done — npm workspaces set up with root `package.json`, extension scaffold at `packages/codev-vscode/`, cross-package imports verified.

---

## Amendment History

This section tracks all TICK amendments to this plan.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
