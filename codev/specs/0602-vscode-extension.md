# Specification: VS Code Extension for Codev Agent Farm

## Metadata
- **ID**: 0602
- **Status**: draft
- **Created**: 2026-03-11
- **Protocol**: SPIR
- **Supersedes**: Spec 0066 (VSCode Companion Extension — outdated, pre-shellper architecture)

## Clarifying Questions Asked

**Q1: Should this replace the browser dashboard?**
A1: No. The extension coexists with the browser dashboard. Users choose their preferred interface. The Tower API layer is shared.

**Q2: Can the extension host terminals natively?**
A2: Yes. VS Code's `createTerminal({ pty })` with a custom `Pseudoterminal` can proxy I/O over WebSocket to Tower's PTY sessions. Unlike the old spec (0066), tmux is no longer in the stack — shellper handles persistence natively.

**Q3: How does architect-builder communication work?**
A3: `af send` posts to `POST /api/send` on Tower. Tower resolves the target builder's PTY session, checks idle state (3s threshold), formats the message with `### [ARCHITECT INSTRUCTION | timestamp] ###` framing, and writes it to the PTY via shellper. The VS Code extension doesn't change this — it's a different viewport onto the same Tower infrastructure.

**Q4: What about the old spec 0066?**
A4: Spec 0066 was written 2026-01-12 against the old tmux/ttyd architecture. The stack has since moved to shellper + node-pty + custom WebSocket protocol. This spec starts fresh with the current architecture.

## Problem Statement

Codev's Agent Farm operates through a browser-based dashboard served by the Tower server on localhost:4100. While powerful, this requires developers to context-switch between VS Code and a browser window. For developers who live in VS Code, this friction adds up:

1. **Context switching** between IDE and browser to monitor builders
2. **File navigation disconnect** — clicking a file path in the browser dashboard opens an in-browser viewer, not the VS Code editor where you actually edit
3. **No IDE-native affordances** — no Command Palette integration, no status bar, no keyboard-driven builder management
4. **Duplicate window management** — browser tabs alongside IDE tabs

## Current State

**Tower Architecture (v1.x, March 2026):**
- Node.js HTTP/WebSocket server on localhost:4100
- Shellper daemon for PTY persistence (survives Tower restarts)
- React 19 + xterm.js 5.5 dashboard served at `/`
- SQLite state (local state.db per workspace + global.db system-wide)
- Binary WebSocket protocol: `0x00` = control frames (JSON), `0x01` = data frames (raw PTY bytes)
- SSE at `/api/events` for real-time push notifications
- REST API: 30+ HTTP endpoints for state, terminals, overview, analytics, file browsing
- `af send` for architect↔builder messaging via `POST /api/send`
- Send buffer with typing-aware delivery (3s idle threshold, 60s max buffer age)

**What works well:**
- Shellper persistence — terminals survive Tower restarts and browser refreshes
- Binary WebSocket protocol — efficient, supports resize/reconnect/replay via sequence numbers
- Ring buffer — 1000-line scrollback with sequence-number-based resume
- Overview API — consolidated view of builders, PRs, backlog
- SSE — real-time push for state changes

**What doesn't translate to VS Code:**
- xterm.js in-browser rendering (replaced by VS Code's native terminal)
- Browser-based file viewer (replaced by VS Code's native editor)
- Tab management (replaced by VS Code's tab system)

## Desired State

A VS Code extension (`codev-vscode`) that provides:

1. **Native terminals** — Architect and builder PTY sessions rendered in VS Code's terminal panel, connected to Tower via WebSocket
2. **Work View sidebar** — TreeView showing builders (status, phase, blocked gates), PRs, and backlog
3. **Status bar** — Builder count, active phase, blocked gate notifications
4. **Command Palette** — All `af` and `porch` commands accessible without leaving the IDE
5. **Native file opening** — `af open file.ts:42` opens in VS Code's editor at line 42, not the browser
6. **Message sending** — `af send` from Command Palette with builder picker and message input
7. **Review comments** — Native Comments API gutter "+" for adding `REVIEW(@author)` comments, interoperable with browser dashboard annotations
8. **Shell terminals** — Ad-hoc shell sessions via Tower, with shellper persistence (survives restarts)
9. **Needs Attention** — TreeView section + status bar for PRs needing review and builders blocked on approval gates
10. **Cloud tunnel status** — Connection state, tower name, uptime in status bar; connect/disconnect commands
11. **Team View** — Webview panel showing team members, activity, and messages (conditional on `teamEnabled`)
12. **Analytics** — Webview panel embedding the existing Recharts analytics dashboard
13. **Connection resilience** — Graceful handling of Tower offline/restart, shellper reconnection

Users can use the browser dashboard, the VS Code extension, or both simultaneously. Both consume the same Tower API.

## Stakeholders
- **Primary Users**: Developers using VS Code as their primary IDE with Codev
- **Secondary Users**: Remote development scenarios (VS Code Remote SSH)
- **Technical Team**: Codev maintainers
- **Business Owners**: Project owner

## Success Criteria
- [ ] Architect terminal opens in VS Code terminal panel, connected to Tower PTY via WebSocket
- [ ] Builder terminals open in VS Code terminal panel with correct naming (`Builder #42 [implement]`)
- [ ] Work View TreeView shows builders, PRs, and backlog from `/api/overview`
- [ ] Status bar shows builder count and blocked gate count
- [ ] `af spawn`, `af send`, `af cleanup`, `porch approve` available via Command Palette
- [ ] `af open file.ts:42` opens file in VS Code editor at correct line
- [ ] Review comments via Comments API gutter "+" — interoperable with browser dashboard annotations
- [ ] Shell terminals created via Command Palette, connected to Tower with shellper persistence
- [ ] Needs Attention section in TreeView shows blocked builders and PRs needing review
- [ ] Cloud tunnel status visible in status bar with connect/disconnect commands
- [ ] Team View Webview panel shows members, activity, messages (when teamEnabled)
- [ ] Analytics Webview panel renders existing Recharts dashboard
- [ ] Cron tasks manageable via Command Palette (run, enable, disable)
- [ ] Image paste in terminal uploads via `POST /api/paste-image`
- [ ] Extension detects Tower offline and shows degraded state (grey UI, reconnection banner)
- [ ] Terminal sessions survive VS Code reload (reconnect to shellper via Tower)
- [ ] Extension activates in < 500ms
- [ ] No degradation to existing browser dashboard functionality
- [ ] Extension published to VS Code Marketplace

## Constraints

### Technical Constraints

**VS Code Pseudoterminal API:**
- `Pseudoterminal.onDidWrite` expects UTF-8 strings, not binary — requires translation from the `0x01` data frames
- `Pseudoterminal.handleInput` provides strings — must encode to binary `0x01` frames for Tower
- `Pseudoterminal.setDimensions` maps to `0x00` control frames for PTY resize
- No native stdout capture — but irrelevant since Tower/shellper handle observation

**WebSocket Binary Protocol Translation:**
- Incoming `0x01` frames: strip first byte, decode `Uint8Array` → UTF-8 string via `TextDecoder`, fire to `onDidWrite`
- Outgoing input: encode string → `Uint8Array`, prepend `0x01`, send over WebSocket
- Control frames (`0x00`): handle resize, ping/pong, sequence numbers for replay
- Backpressure: VS Code extension host can lock up if terminal output exceeds ~50KB/s — implement chunked delivery with debouncing

**VS Code Webview Limitations:**
- Webview state lost when hidden (use `retainContextWhenHidden` selectively for analytics only)
- CSP restrictions — must use `webview.cspSource`, no `eval` or inline scripts
- Webview cannot make authenticated HTTP calls directly — must proxy through extension host via `postMessage`

### Business Constraints
- Must not break existing browser dashboard users
- Minimal additional maintenance burden — share API layer, not UI code
- Extension must work with Tower running independently (`af tower start` still required)

## Assumptions
- Tower server is running on localhost:4100 (or user-configured port)
- VS Code has access to the same filesystem as Tower
- `~/.agent-farm/local-key` exists for authentication
- Node.js available in extension host environment (standard for VS Code extensions)

## Solution Approaches

### Approach 1: Thin Client Extension (RECOMMENDED)

**Description**: VS Code extension acts as a thin client to Tower's existing API. Native VS Code UI for operational controls (TreeView, Status Bar, Command Palette, Terminals). Webview only for analytics (Recharts). All state and terminal management stays in Tower/shellper.

**Architecture:**
```
┌─────────────────────────────────────────────────────────┐
│                   VS Code Extension                      │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Command       │  │ Status Bar   │  │ Work View     │  │
│  │ Palette       │  │ (builders,   │  │ TreeView      │  │
│  │ (af/porch)    │  │  gates)      │  │ (sidebar)     │  │
│  └──────────────┘  └──────────────┘  └───────────────┘  │
│                                                          │
│  ┌──────────────────────────┐  ┌──────────────────────┐  │
│  │ Terminal Panel            │  │ Analytics Webview    │  │
│  │ (Pseudoterminal ↔ WS)    │  │ (Recharts bundle)    │  │
│  └────────────┬─────────────┘  └──────────┬───────────┘  │
│               │                            │              │
│  ┌────────────▼────────────────────────────▼───────────┐  │
│  │           Connection Manager (singleton)             │  │
│  │  • SSE client (/api/events)                          │  │
│  │  • WebSocket pool (per terminal)                     │  │
│  │  • REST client (/api/*)                              │  │
│  │  • Auth (local-key header)                           │  │
│  │  • State machine: DISCONNECTED → CONNECTING →        │  │
│  │    CONNECTED → RECONNECTING                          │  │
│  └────────────┬────────────────────────────────────────┘  │
└───────────────┼──────────────────────────────────────────┘
                │ HTTP + WebSocket + SSE (localhost:4100)
┌───────────────▼──────────────────────────────────────────┐
│                    Tower Server                           │
│  HTTP Routes · WebSocket · SSE · Send Buffer · SQLite     │
│                        ↕                                  │
│                    Shellper Daemons                        │
│              (persistent PTY sessions)                    │
└──────────────────────────────────────────────────────────┘
```

**Pros:**
- Tower stays the single source of truth — no state duplication
- Native VS Code UX (theming, keybindings, command routing)
- Incremental delivery — each component ships independently
- Browser dashboard remains fully functional
- Minimal new server-side code

**Cons:**
- Two UIs to maintain (though extension is thin — no terminal rendering logic)
- Requires Tower running (no standalone mode)

**Estimated Complexity**: Medium-High
**Risk Level**: Medium

### Approach 2: Embedded Dashboard (NOT RECOMMENDED)

**Description**: Embed the entire React dashboard in a VS Code Webview panel, effectively wrapping the browser experience.

**Pros:**
- Maximum code reuse — same React components
- Feature parity from day one

**Cons:**
- Feels like a browser in an IDE — no native keybindings, no theme integration
- Webview limitations (CSP, state loss, memory cost of `retainContextWhenHidden`)
- No Command Palette or TreeView integration
- Terminal-in-webview performance issues
- Users would ask "why not just open the browser?"

**Estimated Complexity**: Low
**Risk Level**: Medium (poor UX despite low effort)

## Component Design

### 1. Connection Manager

Singleton service managing all communication with Tower:

- **State machine**: `DISCONNECTED` → `CONNECTING` → `CONNECTED` → `RECONNECTING`
- **SSE client**: Subscribes to `/api/events`, routes events to TreeView/Status Bar refresh
- **REST client**: Authenticated calls to all `/api/*` endpoints
- **WebSocket pool**: One WebSocket per open terminal, managed lifecycle
- **Auth**: Reads `~/.agent-farm/local-key`, sends as `codev-web-key` header (HTTP) or query param (WebSocket)
- **Health check**: Pings `/api/health` on activation and after SSE drops
- **Reconnection**: Exponential backoff (1s → 2s → 4s → 8s → max 30s)

All consumers (TreeView, Status Bar, Terminals, Commands) go through this singleton. When Tower goes offline, a single state change propagates to all UI surfaces.

### 2. Terminal Integration

Each Tower PTY session maps to a VS Code `Pseudoterminal`:

**Opening a terminal:**
1. User triggers "Open Architect Terminal" or "Open Builder #42 Terminal" via Command Palette or TreeView
2. Extension calls `GET /api/terminals` to find the terminal ID
3. Creates WebSocket to `/ws/terminal/:id`
4. Creates `vscode.window.createTerminal({ name: "Architect" | "Builder #42 [implement]", pty })`

**Binary protocol adapter:**
- **Inbound** (`0x01` data): `slice(1)` → `TextDecoder.decode()` → `onDidWrite.fire(string)`
- **Inbound** (`0x00` control): Parse JSON, handle ping/pong/seq
- **Outbound** (user types): `TextEncoder.encode(input)` → prepend `0x01` → `ws.send()`
- **Resize**: `setDimensions(cols, rows)` → `0x00` control frame with dimensions

**Reconnection:**
- If WebSocket drops, keep `Pseudoterminal` alive
- Print inline ANSI message: `\x1b[33m[Codev: Reconnecting to Tower...]\x1b[0m`
- On reconnect, send last-seen sequence number for ring buffer replay
- Terminal scrollback is preserved via shellper — no data loss

**Backpressure:**
- Chunk large `onDidWrite` calls (> 16KB) with `setTimeout(0)` between chunks
- Prevents extension host CPU spikes and "Extension causes high CPU" warnings

**Image paste:**
- Intercept clipboard paste containing image data in terminal
- Upload via `POST /api/paste-image` (same as browser dashboard's `uploadPasteImage()`)
- Insert resulting file path into terminal input

### 3. Work View TreeView

Sidebar panel showing operational state:

```
CODEV AGENT FARM
├── ⚠ Needs Attention (2)
│   ├── #44 api-refactor — blocked on plan-approval (12m)
│   └── PR #187 — ready for review (3h)
├── 🔨 Builders (3)
│   ├── #42 password-hashing [implement] ● running
│   ├── #43 dashboard-polish [review] ● running
│   └── #44 api-refactor [plan-approval] ⏸ blocked
├── 📋 Pull Requests (2)
│   ├── #187 feat: password hashing (ready)
│   └── #188 fix: dashboard layout (draft)
├── 📥 Backlog (5)
│   ├── #190 Add rate limiting
│   ├── #191 Improve error messages
│   └── ... (2 more)
└── ✓ Recently Closed (3)
    ├── #185 feat: password reset (merged)
    └── ... (2 more)
```

**Data source**: `GET /api/overview` (same as browser dashboard Work View)
**Refresh**: On SSE events + manual refresh button
**Actions (context menu):**
- Needs Attention: Approve Gate, Open PR in Browser
- Builder: Open Terminal, Send Message, View Status
- PR: Open in Browser, View Diff
- Backlog: Spawn Builder
- Recently Closed: Open PR, View Artifacts

### 4. Status Bar

Left-aligned status bar item showing at-a-glance state:

- **Connected**: `$(server) 3 builders · 1 blocked`
- **Blocked gate**: `$(bell) Gate: spec-approval #44` (click to approve)
- **Offline**: `$(circle-slash) Tower Offline` (red)

Click action opens the Work View sidebar or shows a quick-pick of pending actions.

### 5. Command Palette

Commands registered under `Codev:` prefix:

| Command | Action |
|---------|--------|
| `Codev: Spawn Builder` | Quick-pick for issue number + protocol → `af spawn` |
| `Codev: Send Message` | Quick-pick builder → input box for message → `POST /api/send` |
| `Codev: Open Architect Terminal` | Opens/focuses architect terminal |
| `Codev: Open Builder Terminal` | Quick-pick builder → opens terminal |
| `Codev: New Shell` | Creates ad-hoc shell terminal via `POST /api/tabs/shell` |
| `Codev: Approve Gate` | Quick-pick pending gate → `porch approve` |
| `Codev: Refresh Overview` | `POST /api/overview/refresh` |
| `Codev: View Analytics` | Opens analytics Webview panel |
| `Codev: View Team` | Opens team Webview panel (when teamEnabled) |
| `Codev: Cleanup Builder` | Quick-pick builder → `af cleanup` |
| `Codev: Builder Status` | Quick-pick builder → shows status in notification |
| `Codev: Connect Tunnel` | Connect cloud tunnel → `POST /api/tunnel/connect` |
| `Codev: Disconnect Tunnel` | Disconnect cloud tunnel → `POST /api/tunnel/disconnect` |
| `Codev: List Cron Tasks` | Quick-pick showing all cron tasks with status |
| `Codev: Run Cron Task` | Quick-pick task → execute immediately |

### 6. File Link Handling

**Intercept `af open`**: Register a URI handler so `af open file.ts:42` triggers VS Code to open the file at line 42 using `vscode.workspace.openTextDocument` + `vscode.window.showTextDocument` with `vscode.Selection`.

**Terminal file path detection**: The browser dashboard uses `FilePathDecorationManager` to make file paths clickable in xterm.js. In VS Code, this is handled natively by the terminal's link provider. Register a `TerminalLinkProvider` that detects file paths and opens them in the editor on click.

### 7. Review Comments (Annotations)

The browser dashboard's `open.html` provides a custom gutter "+" button that inserts `// REVIEW(@author): comment text` lines directly into files. The VS Code extension replaces this with the native Comments API — the same mechanism used for GitHub PR inline comments.

**CommentController registration:**
- Register a `CommentController` with `id: 'codev-review'` and `label: 'Codev Review'`
- Enable the native gutter "+" button on all files via `commentingRangeProvider`
- Users click "+" on any line, type a comment, and submit — identical UX to PR reviews

**Comment persistence (file-based, shared with browser dashboard):**
- On submit: insert `// REVIEW(@architect): comment text` into the file at the target line using language-appropriate comment syntax
- Save via `POST /api/annotate/{tabId}/save` (same endpoint the browser dashboard uses)
- On file open: scan for existing `REVIEW(...)` patterns using the same regex patterns from `open.html` (`COMMENT_PATTERNS`) and render them as `CommentThread` instances

**Comment syntax by language:**
- JS/TS: `// REVIEW(@author): text`
- Python/Bash/YAML: `# REVIEW(@author): text`
- HTML/Markdown: `<!-- REVIEW(@author): text -->`
- CSS: `/* REVIEW(@author): text */`

**Interop guarantee:** Both the browser dashboard and VS Code extension read/write the same in-file comment format. A comment added in VS Code appears in the browser dashboard's annotations panel, and vice versa.

**Actions on comment threads:**
- Edit: modify the comment line in-place, re-save
- Delete: remove the comment line from the file, re-save
- Resolve: delete the comment (review comments are transient — resolved means addressed)

### 8. Shell Terminals

The browser dashboard has a "+ Shell" button that creates ad-hoc shell terminals via `POST /api/tabs/shell`. These are distinct from architect and builder terminals — they're user-created shells for manual commands.

- **Command**: `Codev: New Shell` creates a shell terminal connected to Tower
- Same `Pseudoterminal` + WebSocket architecture as architect/builder terminals
- Shell terminals are persistent via shellper (survive Tower restarts)
- Named `Shell #1`, `Shell #2`, etc. (matching dashboard convention)
- Listed in the terminal dropdown alongside architect and builder terminals

### 9. Needs Attention

The browser dashboard's `NeedsAttentionList` component aggregates items requiring immediate action. The extension surfaces these prominently:

- **TreeView**: Top-level "Needs Attention" node (always visible when non-empty)
- **Status bar**: Blocked gate count shown with bell icon — click to approve
- **No toast notifications** — avoid interrupting flow; use TreeView and status bar only
- Items: builders blocked on approval gates (with time-waiting), PRs needing review

### 10. Cloud Tunnel Status

The browser dashboard's `CloudStatus` component shows tunnel connection state for remote access:

- **Status bar item**: Shows tunnel state (connected with tower name + uptime, disconnected, auth failed)
- **Commands**: `Codev: Connect Tunnel` (`POST /api/tunnel/connect`), `Codev: Disconnect Tunnel` (`POST /api/tunnel/disconnect`)
- **Auto-hide**: Hidden when running on codevos.ai (cloud-hosted, same behavior as dashboard)
- **States**: not registered (grey), connecting (yellow), connected (green + tower name), disconnected (grey), auth failed (red)

### 11. Team View

The browser dashboard's `TeamView` shows team members, activity, and messages when `teamEnabled` is true:

- **Webview panel**: Rendered only when `GET /api/team` returns `enabled: true`
- Member cards: name, GitHub handle, role, assigned issues, open PRs, recent activity (7-day window)
- Messages section: reverse chronological, author + timestamp + body
- Data proxied through extension host via `postMessage` (same pattern as Analytics Webview)
- **Command**: `Codev: View Team` opens the panel

### 12. Cron Task Management

Tower has a full cron API (`GET /api/cron/tasks`, `POST run/enable/disable`) that the dashboard doesn't expose. The extension surfaces this via commands:

| Command | Action |
|---------|--------|
| `Codev: List Cron Tasks` | Quick-pick showing all cron tasks with status |
| `Codev: Run Cron Task` | Quick-pick task → `POST /api/cron/tasks/:name/run` |
| `Codev: Enable Cron Task` | Quick-pick task → `POST /api/cron/tasks/:name/enable` |
| `Codev: Disable Cron Task` | Quick-pick task → `POST /api/cron/tasks/:name/disable` |

### 13. Analytics Webview

Single Webview panel embedding the existing Recharts analytics page:

- Build a separate Vite entry point (`analytics-embed.html`) that renders only the analytics components
- Load via `webview.html` using `asWebviewUri` for asset paths
- Data fetching proxied through extension host via `postMessage` (never expose local-key to Webview context)
- Use `retainContextWhenHidden` to preserve chart state when panel is hidden

## Prerequisite: Shared Package Extraction

Before building the extension, extract shared code to avoid triple-duplicating types and API client logic across server, dashboard, and extension.

### `@cluesmith/codev-types` (Required)

Zero-dependency package with shared TypeScript interfaces currently duplicated between `packages/codev/src/agent-farm/types.ts` (server) and `packages/codev/dashboard/src/lib/api.ts` (dashboard):

- `DashboardState`, `Builder`, `Annotation`, `OverviewData`, `ArchitectState`, `UtilTerminal`
- WebSocket frame types (`FRAME_CONTROL = 0x00`, `FRAME_DATA = 0x01`)
- SSE event type catalog (`overview-changed`, `notification`, `connected`)
- API request/response shapes for all Tower endpoints

Without this package, the extension becomes a third independent copy of these types, making protocol drift inevitable.

### `@cluesmith/codev-api-client` (Recommended)

Environment-agnostic Tower API client shared between dashboard and extension:

- REST client with authenticated fetch (local-key header)
- SSE client with reconnection logic
- WebSocket binary protocol adapter (encode/decode `0x00`/`0x01` frames)
- Connection state machine (`DISCONNECTED → CONNECTING → CONNECTED → RECONNECTING`)
- Must accept a custom HTTP agent — VS Code extensions run behind corporate proxies and need to integrate with `vscode.workspace.getConfiguration('http').get('proxy')`

### Changes to Main `@cluesmith/codev` Package

1. Export types cleanly from `types.ts` for the shared types package
2. Move protocol constants (`0x00`, `0x01`) to shared package
3. Make auth helpers (local-key reading) importable
4. Reference shared types in Tower route response bodies
5. Define SSE event type catalog as shared constants

### What NOT to Extract

- **Terminal rendering** — xterm.js (browser) vs `Pseudoterminal` (VS Code) are fundamentally different
- **UI components** — React (browser) vs Extension API share nothing
- **Dashboard package** — already semi-independent with its own `package.json`; extraction not needed yet

## Multi-Workspace Handling

- **Default**: Scope to current VS Code workspace folder. Match against Tower's known workspaces by path.
- **Setting**: `codev.workspacePath` override for non-standard layouts
- **Global view**: Collapsible "Other Workspaces" node in TreeView shows workspaces from other projects. Read-only (show builder count) with action to open in new VS Code window.
- **Status bar**: Always shows state for the active workspace

## Extension Lifecycle

| State | Behavior |
|-------|----------|
| **Activation** | On `codev.*` command or workspace contains `codev/` directory. Lazy — no heavy init until needed. |
| **Tower not running** | Status bar shows offline. Commands show "Tower is not running — start with `af tower start`". TreeView shows empty state. |
| **Tower starts** | Health check succeeds → SSE connects → TreeView populates → status bar updates |
| **Tower restarts** | SSE drops → reconnection with backoff → terminals print reconnecting banner → WebSockets reattach → ring buffer replay |
| **VS Code reload** | Extension re-activates → reconnects to Tower → re-creates terminal Pseudoterminals → reattaches to existing shellper sessions |
| **Deactivation** | Close all WebSockets, SSE connection. Terminals disposed. No cleanup needed on Tower side. |

## Open Questions

### Critical (Blocks Progress)
- [x] Should the extension be in this monorepo or a separate repo? **RESOLVED: Monorepo.** Extension lives in this repo (e.g., `packages/codev-vscode/`), sharing types and build infrastructure.

### Important (Affects Design)
- [ ] Should `af open` use a VS Code URI scheme (`vscode://codev/open?file=...`) or a filesystem watcher approach?
- [ ] Should the extension auto-start Tower if it's not running, or always require manual start?
- [ ] Terminal naming convention: `Architect` / `Builder #42 [implement]` or something else?

### Nice-to-Know (Optimization)
- [ ] Can the extension leverage VS Code's Git extension API for worktree visualization?
- [ ] Should the TreeView support drag-and-drop for reordering backlog?

## Performance Requirements
- **Activation time**: < 500ms
- **TreeView refresh**: < 200ms after SSE event
- **Terminal latency**: < 50ms input-to-echo (WebSocket round trip)
- **Status bar update**: < 100ms after state change
- **Memory**: < 50MB for analytics Webview, < 10MB for extension host
- **WebSocket backpressure**: No CPU warning at sustained 50KB/s terminal output

## Security Considerations
- **Auth**: Read `~/.agent-farm/local-key`, send as `codev-web-key` header. Store in VS Code's `SecretStorage` after first read.
- **Webview isolation**: Analytics Webview must NOT have direct access to local-key. All authenticated API calls proxied through extension host via `postMessage`.
- **Origin validation**: Only connect to localhost (or user-configured host). Warn if non-localhost target without HTTPS.
- **No logging of secrets**: Never log headers or URLs containing the local-key.
- **CSP**: Webviews use `webview.cspSource`, no `eval`, no inline scripts.

## Test Scenarios

### Functional Tests
1. **Happy path**: Tower running → activate extension → TreeView shows builders → open architect terminal → type command → see output
2. **Send message**: Command Palette → "Send Message" → pick builder #42 → type message → message appears in builder terminal
3. **File opening**: `af open src/index.ts:42` → VS Code editor opens file at line 42
4. **Gate approval**: Status bar shows blocked gate → click → approve → builder resumes
5. **Tower offline**: Stop Tower → status bar turns red → TreeView greys out → restart Tower → everything recovers
6. **Shell terminal**: Command Palette → "New Shell" → shell opens in terminal panel → persists across Tower restart
7. **Needs Attention**: Builder blocks on gate → "Needs Attention" node appears in TreeView with time-waiting
8. **Cloud tunnel**: Connect tunnel → status bar shows tower name + uptime → disconnect → status bar updates
9. **Team View**: Open team panel → shows members, activity, messages → refresh updates data
10. **Cron task**: Command Palette → "Run Cron Task" → pick task → task executes → result shown

### Non-Functional Tests
1. **Performance**: Measure activation time, terminal latency, TreeView refresh speed
2. **Memory**: Monitor extension host and Webview memory under sustained use (8+ hours)
3. **Reconnection**: Kill Tower mid-session, verify clean recovery
4. **Concurrent terminals**: Open 5+ builder terminals simultaneously, verify no CPU spikes

## Dependencies
- **External Services**: None (localhost only)
- **Internal Systems**: Tower server (existing), shellper (existing), all existing REST/WebSocket/SSE APIs
- **Internal Packages (new)**: `@cluesmith/codev-types` (shared interfaces), `@cluesmith/codev-api-client` (shared Tower client)
- **Libraries/Frameworks**: VS Code Extension API, `ws` (WebSocket client), `eventsource` (SSE client), React + Vite (analytics + team Webviews)
- **Build**: `@vscode/vsce` for packaging and Marketplace publishing

## References
- Spec 0066 (superseded): `codev/specs/0066-vscode-companion-extension.md`
- Tower server architecture: `codev/specs/0105-tower-server-decomposition.md`
- Architecture docs: `codev/resources/arch.md`
- WebSocket protocol: `packages/codev/src/terminal/ws-protocol.ts`
- Send buffer: `packages/codev/src/agent-farm/servers/send-buffer.ts`
- Tower routes: `packages/codev/src/agent-farm/servers/tower-routes.ts`

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| Extension host CPU spikes from high-volume terminal output | Medium | High | Chunk `onDidWrite` calls, debounce at 16KB threshold |
| Protocol drift between Tower WebSocket and extension adapter | Medium | High | Unit tests against captured binary frames, shared protocol types |
| WebSocket backpressure causing frozen terminals | Low | High | Flow control with buffering, drop frames if > 1MB queued |
| Multi-workspace confusion (actions against wrong workspace) | Medium | Medium | Scope all actions to active workspace, confirm cross-workspace operations |
| Webview CSP breaks analytics rendering | Low | Low | Test Recharts bundle in VS Code Webview during development, fallback to "open in browser" |
| Tower not running on extension activation | High | Low | Graceful degraded state, clear messaging, offer to start Tower |
| Type duplication across server/dashboard/extension | High | High | Extract `@cluesmith/codev-types` shared package before building extension |
| API client behind corporate proxy fails | Medium | Medium | Make `@cluesmith/codev-api-client` accept custom HTTP agent, integrate with VS Code proxy settings |

## Expert Consultation

**Date**: 2026-03-11
**Models Consulted**: Gemini 3 Pro, GPT-5.1 Codex

**Gemini 3 Pro — Key Recommendations:**
- Confirmed `Pseudoterminal` + WebSocket proxy is the correct terminal approach
- Recommended hybrid UI: native TreeView/StatusBar/Commands + Webview only for analytics
- Emphasized backpressure handling for terminal output (> 50KB/s threshold)
- Suggested Webview security: proxy all auth through extension host via `postMessage`, never expose local-key to Webview DOM
- Recommended connection state machine with inline ANSI reconnection banners in terminals

**GPT-5.1 Codex — Key Recommendations:**
- Confirmed SSE reuse for state updates (separate from terminal WebSockets)
- Recommended `TextDecoder('utf-8', { fatal: false })` for binary frame decoding with partial frame caching
- Suggested storing local-key in VS Code's `SecretStorage` for secure persistence
- Warned about protocol drift risk — recommended unit tests against captured binary traffic
- Recommended lazy activation (delay heavy init until user triggers command)

**Consensus**: Both models agree on thin client approach, native VS Code UI for operational controls, Webview only for analytics, and `Pseudoterminal` + WebSocket for terminals. Both flag terminal backpressure and protocol drift as top risks.

All consultation feedback has been incorporated into the relevant sections above.

**Gap Analysis Review (2026-03-13):**
**Model Consulted**: Gemini 3 Pro (via thinkdeep)
- Validated shared package extraction strategy (`codev-types` + `codev-api-client`)
- Confirmed shell terminals should use Tower Pseudoterminal (not VS Code native) for shellper persistence
- Recommended against toast notifications for Needs Attention — use TreeView + status bar only
- Suggested deferring Team View to post-V1 (admin feature, not editor-context), but included as conditional Webview
- Warned about corporate proxy compatibility for API client — must accept custom HTTP agent

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [x] Expert AI Consultation Complete

## Notes

**Why a new spec instead of amending 0066:**
Spec 0066 was written against a fundamentally different architecture (tmux + ttyd). The current stack (shellper + node-pty + custom binary WebSocket protocol) changes every technical assumption in that spec. A fresh spec is cleaner than a TICK amendment that rewrites 90% of the document.

**Relationship to browser dashboard:**
This extension is additive. The browser dashboard continues to work. Both UIs consume the same Tower API. No server-side changes are required for the initial version. Future Tower API enhancements (e.g., a multi-topic WebSocket for state + terminals on one connection) would benefit both clients.

**Dashboard features deliberately excluded from the extension:**
- **File tree browser** — VS Code's native Explorer is superior; no need to replicate
- **Rich file viewer** (images, video, PDF, 3D models) — VS Code handles all natively except 3D; not worth a custom viewer
- **Split pane layout** — VS Code's native panel system handles this
- **Mobile layout / virtual keyboard** — not applicable to desktop IDE
- **Tab system** — maps naturally to VS Code's native tabs (terminals, editors, Webview panels)
- **Tip of the Day** — could be a future nice-to-have notification, not V1
- **Message bus WebSocket** (`/ws/messages`) — could add activity indicator later, not workflow-critical

---

## Amendments

This section tracks all TICK amendments to this specification.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
