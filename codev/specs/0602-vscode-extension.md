# Specification: VS Code Extension for Codev Agent Farm

## Metadata
- **ID**: 0602
- **Status**: draft
- **Created**: 2026-03-11
- **Protocol**: SPIR
- **Related**: Spec 0066

## Clarifying Questions Asked

**Q1: Should this replace the browser dashboard?**
A1: No. The extension coexists with the browser dashboard. Users choose their preferred interface. The Tower API layer is shared.

**Q2: Can the extension host terminals natively?**
A2: Yes. VS Code's `createTerminal({ pty })` with a custom `Pseudoterminal` can proxy I/O over WebSocket to Tower's PTY sessions. Unlike the old spec (0066), tmux is no longer in the stack — shellper handles persistence natively.

**Q3: How does architect-builder communication work?**
A3: `afx send` posts to `POST /api/send` on Tower. Tower resolves the target builder's PTY session, checks idle state (3s threshold), formats the message with `### [ARCHITECT INSTRUCTION | timestamp] ###` framing, and writes it to the PTY via shellper. The VS Code extension doesn't change this — it's a different viewport onto the same Tower infrastructure.

**Q4: What about the old spec 0066?**
A4: Spec 0066 was written 2026-01-12 against the old tmux/ttyd architecture. The stack has since moved to shellper + node-pty + custom WebSocket protocol. This spec starts fresh with the current architecture.

## Problem Statement

Codev's Agent Farm operates through a browser-based dashboard served by the Tower server on localhost:4100. While powerful, this requires developers to context-switch between VS Code and a browser window. For developers who live in VS Code, this friction adds up:

1. **Context switching** between IDE and browser to monitor builders
2. **File navigation disconnect** — clicking a file path in the browser dashboard opens an in-browser viewer, not the VS Code editor where you actually edit
3. **No IDE-native affordances** — no Command Palette integration, no status bar, no keyboard-driven builder management
4. **Duplicate window management** — browser tabs alongside IDE tabs

## Current State

**Tower Architecture (v3.x, April 2026):**
- Node.js HTTP/WebSocket server on localhost:4100
- Shellper daemon for PTY persistence (survives Tower restarts)
- React 19 + xterm.js 5.5 dashboard served at `/`
- SQLite state (local state.db per workspace + global.db system-wide)
- Binary WebSocket protocol: `0x00` = control frames (JSON), `0x01` = data frames (raw PTY bytes)
- SSE at `/api/events` for real-time push notifications (30s heartbeat)
- REST API: 30+ HTTP endpoints — global routes (`/api/overview`, `/api/send`) and workspace-scoped routes (`/workspace/:base64path/api/state`, `/workspace/:base64path/api/team`)
- `afx send` for architect↔builder messaging via `POST /api/send`
- Send buffer with typing-aware delivery (3s idle threshold, 60s max buffer age)
- Layered config system: `.codev/config.json` (project) → `~/.codev/config.json` (global) → framework defaults
- Forge abstraction layer: provider-agnostic issue/PR operations (GitHub, GitLab, Gitea) via concept commands
- `afx spawn --branch` for continuing work on existing PR branches

**What works well:**
- Shellper persistence — terminals survive Tower restarts and browser refreshes
- Binary WebSocket protocol — efficient, supports resize/reconnect/replay via sequence numbers
- Ring buffer — 1000-line scrollback with sequence-number-based resume
- EscapeBuffer — buffers incomplete ANSI escape sequences split across WebSocket frames (Bugfix #630)
- ScrollController — unified scroll state machine with phase-aware resize deferral (Spec 627, Bugfix #625)
- Overview API — consolidated view of builders, PRs, backlog (with author attribution, Spec 637)
- Forge system — provider-agnostic issue/PR data; extension never needs to know which forge is configured
- SSE — real-time push for state changes (30s heartbeat, Bugfix #580)

**What doesn't translate to VS Code:**
- xterm.js in-browser rendering (replaced by VS Code's native terminal)
- Browser-based file viewer (replaced by VS Code's native editor)
- Tab management (replaced by VS Code's tab system)

## Desired State

A VS Code extension (`codev-vscode`) that provides:

1. **Native terminals** — Architect and builder PTY sessions rendered in VS Code's terminal panel, connected to Tower via WebSocket
2. **Work View sidebar** — TreeView showing builders (status, phase, blocked gates), PRs, and backlog
3. **Status bar** — Builder count, active phase, blocked gate notifications
4. **Command Palette** — All `afx` and `porch` commands accessible without leaving the IDE
5. **Native file opening** — `afx open file.ts:42` opens in VS Code's editor at line 42, not the browser
6. **Message sending** — `afx send` from Command Palette with builder picker and message input
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
- [ ] `afx spawn`, `afx send`, `afx cleanup`, `porch approve` available via Command Palette
- [ ] `afx open file.ts:42` opens file in VS Code editor at correct line
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
- Incoming `0x01` frames: strip first byte, decode `Uint8Array` → UTF-8 string via `TextDecoder('utf-8', { stream: true })` (streaming mode required to handle multi-byte Unicode split across frames), fire to `onDidWrite`
- Outgoing input: encode string → `Uint8Array`, prepend `0x01`, send over WebSocket
- Control frames (`0x00`): handle resize, ping/pong, sequence numbers for replay
- Backpressure: VS Code extension host can lock up if terminal output exceeds ~50KB/s — implement chunked delivery with `setImmediate` between chunks (not `setTimeout(0)` — Node.js event loop semantics differ from browser)

**VS Code Webview Limitations:**
- Webview state lost when hidden (use `retainContextWhenHidden` selectively for analytics only)
- CSP restrictions — must use `webview.cspSource`, no `eval` or inline scripts
- Webview cannot make authenticated HTTP calls directly — must proxy through extension host via `postMessage`

### Business Constraints
- Must not break existing browser dashboard users
- Minimal additional maintenance burden — share API layer, not UI code
- Extension auto-starts Tower if not running (detached daemon, never auto-stopped)

## Assumptions
- Tower server is running on localhost:4100 (or port from `.codev/config.json`)
- VS Code has access to the same filesystem as Tower
- `~/.agent-farm/local-key` exists for authentication
- `.codev/config.json` exists at project root (v3.0.0+ config system with layered merging)
- Node.js available in extension host environment (standard for VS Code extensions)
- Forge provider is configured and operational (extension is provider-agnostic)

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
│  │ (afx/porch)   │  │  gates)      │  │ (sidebar)     │  │
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
- **SSE client**: Subscribes to `/api/events`, routes events to TreeView/Status Bar refresh. Handles 30s heartbeat events without triggering state refreshes.
- **REST client**: Authenticated calls to all `/api/*` endpoints
- **WebSocket pool**: One WebSocket per open terminal, managed lifecycle
- **Auth**: Reads `~/.agent-farm/local-key`, sends as `codev-web-key` header (HTTP). For WebSocket, send auth via a `0x00` control message after connection (not query param — query params leak into logs and process lists). Store key in VS Code `SecretStorage` for persistence, but **re-read from disk on 401** to handle key rotation.
- **Health check**: Pings `/api/health` on activation and after SSE drops. Health response should include a protocol version for compatibility checking.
- **Output Channel**: Register `Codev` Output Channel for structured diagnostic logging (connection events, errors, reconnections). Essential for debugging.
- **Reconnection**: Exponential backoff (1s → 2s → 4s → 8s → max 30s)
- **Config**: Reads `.codev/config.json` for Tower port override and project-level settings

**Workspace-scoped routing:**
Tower has two route layers. The extension must use the correct one:
- **Global routes** (no prefix): `/api/overview`, `/api/send`, `/api/events`, `/api/health`, `/api/analytics`, `/api/cron/*`, `/api/workspaces`
- **Workspace-scoped routes** (prefixed): `/workspace/:base64urlPath/api/state`, `/workspace/:base64urlPath/api/team`, `/workspace/:base64urlPath/api/tabs/shell`, `/workspace/:base64urlPath/ws/terminal/:id`

The Connection Manager encodes the active workspace path as base64url and prefixes all workspace-scoped requests. The workspace path is determined by traversing up from VS Code's workspace folder to find the `.codev/config.json` root, then matching that path against Tower's known workspaces (via `GET /api/workspaces`). This handles cases where the user opens a subdirectory (e.g., `~/project/src`) rather than the project root.

All consumers (TreeView, Status Bar, Terminals, Commands) go through this singleton. When Tower goes offline, a single state change propagates to all UI surfaces.

### 2. Terminal Integration

Each Tower PTY session maps to a VS Code `Pseudoterminal`:

**Opening a terminal:**
1. User triggers "Open Architect Terminal" or "Open Builder #42 Terminal" via Command Palette or TreeView
2. Extension calls `GET /api/terminals` to find the terminal ID
3. Creates WebSocket to `/workspace/:base64path/ws/terminal/:id`
4. Creates `vscode.window.createTerminal({ name: "Architect" | "Builder #42 [implement]", pty })`

**Terminal layout (editor area, not bottom panel):**
All Codev terminals (architect, builders, shells) open in the **editor area** as terminal-in-editor views — not the bottom panel. This provides full vertical height and mirrors the browser dashboard's layout.

On first terminal open, the extension arranges two editor groups:
1. Move terminals into the editor area via `workbench.action.terminal.moveIntoEditor`
2. **Left editor group**: Architect terminal (single tab, always visible)
3. **Right editor group**: Builder terminals (one tab per builder) + shell terminals

```
┌──────────────┬────────────────┬────────────────┐
│ Work View    │ Architect      │ [#42][#43][sh] │
│ (sidebar     │                │ Builder #42    │
│  pane)       │                │ (terminal)     │
│              │                │                │
│ - Attention  │ Left editor    │ Right editor   │
│ - Builders   │ group          │ group          │
│ - PRs        │ (1 tab:        │ (N tabs:       │
│ - Backlog    │  architect)    │  builders +    │
│              │                │  shells)       │
└──────────────┴────────────────┴────────────────┘
```

This mirrors the browser dashboard exactly: architect on the left, builders on the right, Work View in the sidebar pane. The right editor group hosts one tab per builder plus shell terminals — click tabs to switch between them.

**Multiple builders**: Each builder is a tab in the right editor group. Click a tab to switch, or open from TreeView. All builders remain accessible — no closing/reopening.

**Shell terminals**: Open as additional tabs in the right editor group alongside builders.

**Fallback**: `workbench.action.terminal.moveIntoEditor` is an undocumented internal VS Code command that may change between versions. If it fails, the extension falls back to the standard bottom panel and logs a warning to the Output Channel.

**Binary protocol adapter:**
- **Inbound** (`0x01` data): `slice(1)` → `TextDecoder.decode(bytes, { stream: true })` → `onDidWrite.fire(string)`
- **Inbound** (`0x00` control): Parse JSON, handle ping/pong/seq
- **Outbound** (user types): `TextEncoder.encode(input)` → prepend `0x01` → `ws.send()`
- **Resize**: `setDimensions(cols, rows)` → `0x00` control frame with dimensions

**Reconnection:**
- If WebSocket drops, keep `Pseudoterminal` alive
- Print inline ANSI message: `\x1b[33m[Codev: Reconnecting to Tower...]\x1b[0m`
- On reconnect, send last-seen sequence number for ring buffer replay
- Terminal scrollback is preserved via shellper — no data loss

**Escape sequence buffering:**
WebSocket frames can split ANSI escape sequences mid-sequence (e.g., CSI, OSC, DCS). Writing a partial escape to `onDidWrite` corrupts terminal state (production Bugfix #630). The Pseudoterminal adapter must buffer incomplete trailing sequences and prepend them to the next frame — same logic as `dashboard/src/lib/escapeBuffer.ts`. This should be extracted into `@cluesmith/codev-api-client` as a shared utility.

**Resize deferral during replay:**
On reconnect, the ring buffer replays potentially large scrollback. Sending a resize control frame (`0x00` with `type: 'resize'`) while replay data is being written causes garbled rendering (production Bugfix #625). The adapter must queue resize events and flush them only after the replay write completes.

**Backpressure:**
- Chunk large `onDidWrite` calls (> 16KB) with `setImmediate` between chunks to yield to the Node.js event loop
- **Never drop PTY frames** — dropping intermediate data corrupts ANSI state (colors, cursor position) permanently. Instead, if queued data exceeds 1MB, close the WebSocket, let the UI drain, then reconnect. Tower's ring buffer with sequence numbers ensures clean replay on reconnect without data loss.
- Prevents extension host CPU spikes and "Extension causes high CPU" warnings

**Image paste:**
- Intercept clipboard paste containing image data in terminal
- Upload via `POST /api/paste-image` (same as browser dashboard's `uploadPasteImage()`)
- Insert resulting file path into terminal input

### 3. Work View TreeView

VS Code sidebar pane (like Explorer or Source Control) — not a window or Webview inside the editor. Shows operational state:

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
│   ├── #187 feat: password hashing @alice (ready)
│   └── #188 fix: dashboard layout @bob (draft)
├── 📥 Backlog (5)
│   ├── #190 Add rate limiting @alice
│   ├── #191 Improve error messages @bob
│   └── ... (2 more)
└── ✓ Recently Closed (3)
    ├── #185 feat: password reset (merged)
    └── ... (2 more)
```

**Author attribution**: Backlog and PR items show `@username` when the forge provides author data (Spec 637). Gracefully omitted when the author field is absent (e.g., some non-GitHub forges).

**Forge-agnostic**: All issue/PR data comes through Tower's overview API, which dispatches to the configured forge provider (GitHub, GitLab, Gitea). The extension never calls `gh` or any forge CLI directly. "Open in Browser" actions use URLs from the API response, not hardcoded GitHub URLs.

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
| `Codev: Spawn Builder` | Quick-pick for issue number + protocol + optional branch → `afx spawn` |
| `Codev: Send Message` | Quick-pick builder → input box for message → `POST /api/send` |
| `Codev: Open Architect Terminal` | Opens/focuses architect terminal |
| `Codev: Open Builder Terminal` | Quick-pick builder → opens terminal |
| `Codev: New Shell` | Creates ad-hoc shell terminal via `POST /api/tabs/shell` |
| `Codev: Approve Gate` | Quick-pick pending gate → `porch approve` |
| `Codev: Refresh Overview` | `POST /api/overview/refresh` |
| `Codev: View Analytics` | Opens analytics Webview panel |
| `Codev: View Team` | Opens team Webview panel (when teamEnabled) |
| `Codev: Cleanup Builder` | Quick-pick builder → `afx cleanup` |
| `Codev: Builder Status` | Quick-pick builder → shows status in notification |
| `Codev: Connect Tunnel` | Connect cloud tunnel → `POST /api/tunnel/connect` |
| `Codev: Disconnect Tunnel` | Disconnect cloud tunnel → `POST /api/tunnel/disconnect` |
| `Codev: List Cron Tasks` | Quick-pick showing all cron tasks with status |
| `Codev: Run Cron Task` | Quick-pick task → execute immediately |

### 6. File Link Handling

**Intercept `afx open`**: Register a URI handler so `afx open file.ts:42` triggers VS Code to open the file at line 42 using `vscode.workspace.openTextDocument` + `vscode.window.showTextDocument` with `vscode.Selection`.

**Terminal file path detection**: The browser dashboard uses `FilePathDecorationManager` to make file paths clickable in xterm.js. In VS Code, this is handled natively by the terminal's link provider. Register a `TerminalLinkProvider` that detects file paths and opens them in the editor on click.

### 7. Review Comments (Annotations)

The browser dashboard's `open.html` provides a custom gutter "+" button that inserts `// REVIEW(@author): comment text` lines directly into files. The VS Code extension replaces this with the native Comments API — the same mechanism used for GitHub PR inline comments.

**CommentController registration:**
- Register a `CommentController` with `id: 'codev-review'` and `label: 'Codev Review'`
- Enable the native gutter "+" button on all files via `commentingRangeProvider`
- Users click "+" on any line, type a comment, and submit — identical UX to PR reviews

**Comment persistence (file-based, shared with browser dashboard):**
- On submit: insert `// REVIEW(@architect): comment text` into the file at the target line using `vscode.workspace.applyEdit()` (`WorkspaceEdit`). This respects VS Code's undo stack, dirty buffer state, and avoids overwriting unsaved edits. **Do NOT use `POST /api/annotate/{tabId}/save`** — that endpoint calls `fs.writeFileSync` which would overwrite any unsaved VS Code buffer changes.
- On file open: scan for existing `REVIEW(...)` patterns using the same regex patterns from `open.html` (`COMMENT_PATTERNS`) and render them as `CommentThread` instances
- Re-scan on `TextDocumentChangeEvent` to update thread positions when lines shift

**Comment syntax by language:**
- JS/TS/Go/Rust/Java/Swift/Kotlin/C/C++: `// REVIEW(@author): text`
- Python/Ruby/Bash/YAML: `# REVIEW(@author): text`
- HTML/Markdown: `<!-- REVIEW(@author): text -->`
- CSS: `/* REVIEW(@author): text */`
- Files with no comment syntax (JSON, binary): disable the comment gutter "+" button

**Interop guarantee:** Both the browser dashboard and VS Code extension read/write the same in-file comment format. A comment added in VS Code appears in the browser dashboard's annotations panel, and vice versa. Concurrent modification from both clients on the same file is not supported — last writer wins.

**Actions on comment threads:**
- Edit: modify the comment line in-place via `WorkspaceEdit`
- Delete: remove the comment line from the file via `WorkspaceEdit`
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
- **Theme integration**: Inject CSS that maps VS Code theme variables (`var(--vscode-editor-background)`, `var(--vscode-editor-foreground)`) to the dashboard's custom CSS variables. Without this, the hardcoded dark-mode styles will clash with VS Code light themes.
- Data fetching proxied through extension host via `postMessage` (never expose local-key to Webview context)
- Use `retainContextWhenHidden` to preserve chart state when panel is hidden

## Prerequisite: Shared Package Extraction

Extract shared code to avoid triple-duplicating types and API client logic across server, dashboard, and extension. **Phased approach** — do not block V1 on extracting everything.

**Phase 1 (before V1)**: Extract `@cluesmith/codev-types` only. Low risk, high value.
**Phase 2 (after V1 ships)**: Extract `@cluesmith/codev-api-client` once patterns stabilize across two real consumers (dashboard + extension).

**Monorepo prerequisite**: Add a root `package.json` with `"workspaces": ["packages/*"]` before extracting. Currently no workspace manager exists. Without this, `file:` dependencies will break `vsce` packaging.

### `@cluesmith/codev-types` (Required, Phase 1)

Zero-dependency package with shared TypeScript interfaces currently duplicated between `packages/codev/src/agent-farm/types.ts` (server) and `packages/codev/dashboard/src/lib/api.ts` (dashboard):

- `DashboardState`, `Builder`, `Annotation`, `OverviewData`, `ArchitectState`, `UtilTerminal`
- WebSocket frame types (`FRAME_CONTROL = 0x00`, `FRAME_DATA = 0x01`)
- SSE event type catalog (`overview-changed`, `notification`, `connected`)
- API request/response shapes for all Tower endpoints

Without this package, the extension becomes a third independent copy of these types, making protocol drift inevitable.

### `@cluesmith/codev-api-client` (Recommended, Phase 2 — after V1)

Environment-agnostic Tower API client shared between dashboard and extension:

- REST client with authenticated fetch (local-key header)
- SSE client with reconnection logic and heartbeat handling
- WebSocket binary protocol adapter (encode/decode `0x00`/`0x01` frames)
- EscapeBuffer (from `dashboard/src/lib/escapeBuffer.ts`) for incomplete ANSI sequence handling
- Workspace path encoding (base64url) for workspace-scoped routes
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

## Extension Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `codev.towerHost` | string | `localhost` | Tower server host |
| `codev.towerPort` | number | `4100` | Tower server port (overridden by `.codev/config.json`) |
| `codev.workspacePath` | string | auto-detect | Override workspace path for Tower matching |
| `codev.terminalPosition` | `"editor"` \| `"panel"` | `"editor"` | Where to open Codev terminals (editor area or bottom panel) |
| `codev.autoConnect` | boolean | `true` | Connect to Tower on activation |
| `codev.autoStartTower` | boolean | `true` | Auto-start Tower if not running on activation |
| `codev.telemetry` | boolean | `false` | No telemetry collected. Extension respects VS Code's global telemetry setting. |

## Default Keyboard Shortcuts

| Shortcut | Command |
|----------|---------|
| `Ctrl+Shift+A` / `Cmd+Shift+A` | Codev: Open Architect Terminal |
| `Ctrl+Shift+M` / `Cmd+Shift+M` | Codev: Send Message |
| `Ctrl+Shift+G` / `Cmd+Shift+G` | Codev: Approve Gate |

Additional commands available via Command Palette but without default keybindings to avoid conflicts.

## Multi-Workspace Handling

- **Default**: Scope to current VS Code workspace folder. Match against Tower's known workspaces by path.
- **Setting**: `codev.workspacePath` override for non-standard layouts
- **Global view**: Collapsible "Other Workspaces" node in TreeView shows workspaces from other projects. Read-only (show builder count) with action to open in new VS Code window.
- **Status bar**: Always shows state for the active workspace

## Extension Lifecycle

| State | Behavior |
|-------|----------|
| **Activation** | On `codev.*` command or workspace contains `codev/` directory. Lazy — no heavy init until needed. |
| **Tower not running** | If `codev.autoStartTower` is true: run `afx tower start` as a detached process, then connect. If false or start fails: status bar shows offline, commands prompt to start manually. **Never auto-stop Tower** — it's a daemon that outlives VS Code so builders keep running. |
| **Tower already running** | Health check succeeds on activation → connect immediately. Handles the case where another VS Code window or manual `afx tower start` already launched it. |
| **Tower starts** | Health check succeeds → SSE connects → TreeView populates → status bar updates |
| **Tower restarts** | SSE drops → reconnection with backoff → terminals print reconnecting banner → WebSockets reattach → ring buffer replay |
| **VS Code reload** | Extension re-activates → reconnects to Tower → re-creates terminal Pseudoterminals → reattaches to existing shellper sessions |
| **Deactivation** | Close all WebSockets, SSE connection. Terminals disposed. No cleanup needed on Tower side. |

## Open Questions

### Critical (Blocks Progress)
- [x] Should the extension be in this monorepo or a separate repo? **RESOLVED: Monorepo.** Extension lives in this repo (e.g., `packages/codev-vscode/`), sharing types and build infrastructure.

### Critical (Blocks Progress)
- [ ] Should `afx open` use a VS Code URI scheme (`vscode://codev/open?file=...`) or a filesystem watcher approach? This is a core architectural decision — URI scheme works cross-process, filesystem watcher is fundamentally different.

### Important (Affects Design)
- [x] Should the extension auto-start Tower if it's not running? **RESOLVED: Yes.** Auto-start as detached process, never auto-stop. Setting `codev.autoStartTower` (default: true) for manual control.
- [ ] Terminal naming convention: `Architect` / `Builder #42 [implement]` or something else?

### Nice-to-Know (Optimization)
- [ ] Can the extension leverage VS Code's Git extension API for worktree visualization?
- [ ] Should the TreeView support drag-and-drop for reordering backlog?

## Error Handling UX

All errors surface through a consistent pattern:
- **Command failures** (spawn, send, approve): VS Code error notification with message. Logged to Output Channel.
- **Connection errors**: Status bar turns red, TreeView shows "Tower Offline" state. No repeated toast notifications.
- **Terminal errors**: Inline ANSI banner in the terminal (e.g., `[Codev: Connection lost, reconnecting...]`).
- **Webview errors**: Inline error message within the Webview panel, with "Retry" and "Open in Browser" actions.
- **Auth failures**: Re-read `local-key` from disk. If still failing, prompt user with "Tower authentication failed — check `~/.agent-farm/local-key`".

## Performance Requirements
- **Activation time**: < 500ms for UI shell (status bar, commands registered). Tower connection and TreeView population happen async after activation — not blocking.
- **TreeView refresh**: < 200ms from initiating refresh to UI update (excludes `/api/overview` response time). Rate-limit SSE-triggered refreshes to max 1 per second to prevent storms.
- **Terminal latency**: < 50ms input-to-echo (WebSocket round trip)
- **Status bar update**: < 100ms after state change
- **Memory**: < 50MB for analytics Webview, < 10MB for extension host
- **WebSocket backpressure**: No CPU warning at sustained 50KB/s terminal output
- **WebSocket ceiling**: Max 10 concurrent terminal WebSockets. Beyond this, show "Too many terminals — close unused terminals" warning.

## Security Considerations
- **Auth**: Read `~/.agent-farm/local-key`, send as `codev-web-key` header for HTTP. For WebSocket, send auth via `0x00` control message after connection — not query param (leaks into logs). Store in VS Code `SecretStorage`, but re-read from disk on 401 to handle key rotation.
- **Webview isolation**: Analytics/Team Webviews must NOT have direct access to local-key. All authenticated API calls proxied through extension host via `postMessage`. Strict CSP with `webview.cspSource`, no `eval`, no inline scripts, no dynamic HTML insertion.
- **Origin validation**: Only connect to `localhost` or `127.0.0.1` by default. Require explicit user confirmation for non-localhost targets, even with HTTPS.
- **No logging of secrets**: Never log headers or URLs containing the local-key. Output Channel logs connection events but redacts auth tokens.
- **Terminal input**: Messages sent via `POST /api/send` are written raw to PTY. The extension does not sanitize input (same as CLI behavior). Document this as a known characteristic.

## Test Scenarios

### Functional Tests
1. **Happy path**: Tower running → activate extension → TreeView shows builders → open architect terminal → type command → see output
2. **Send message**: Command Palette → "Send Message" → pick builder #42 → type message → message appears in builder terminal
3. **File opening**: `afx open src/index.ts:42` → VS Code editor opens file at line 42
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
- Spec 0066 (prior VS Code spec): `codev/specs/0066-vscode-companion-extension.md`
- Spec 0105 (Tower decomposition): `codev/specs/0105-tower-server-decomposition.md`
- Spec 0618 (v3.0.0 config overhaul): `codev/specs/0618-*`
- Spec 0627 (ScrollController): `codev/specs/0627-*`
- Spec 0637 (author in views): `codev/specs/0637-*`
- Spec 0647 (CLI rename af → afx): `codev/specs/0647-*`
- Architecture docs: `codev/resources/arch.md`
- WebSocket protocol: `packages/codev/src/terminal/ws-protocol.ts`
- EscapeBuffer: `packages/codev/dashboard/src/lib/escapeBuffer.ts`
- ScrollController: `packages/codev/dashboard/src/lib/scrollController.ts`
- Send buffer: `packages/codev/src/agent-farm/servers/send-buffer.ts`
- Tower routes: `packages/codev/src/agent-farm/servers/tower-routes.ts`
- Config loader: `packages/codev/src/lib/config.ts`
- Forge system: `packages/codev/src/lib/forge.ts`, `packages/codev/src/lib/forge-contracts.ts`

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| Extension host CPU spikes from high-volume terminal output | Medium | High | Chunk `onDidWrite` calls with `setImmediate`, 16KB threshold |
| Protocol drift between Tower WebSocket and extension adapter | Medium | High | Unit tests against captured binary frames, shared protocol types, version in `/api/health` |
| WebSocket backpressure causing frozen terminals | Low | High | Never drop frames — disconnect and reconnect via ring buffer replay if > 1MB queued |
| `moveIntoEditor` API instability | Medium | Medium | Fallback to bottom panel on failure, log warning to Output Channel |
| Multi-workspace confusion (actions against wrong workspace) | Medium | Medium | Scope all actions to active workspace, traverse up to `.codev/config.json` root |
| Comment thread line-drift after edits | Medium | Medium | Re-scan on `TextDocumentChangeEvent`, update thread positions |
| Concurrent annotation edits (browser + VS Code) | Low | Medium | Document as unsupported — last writer wins |
| Analytics Webview theme mismatch | Medium | Low | Map VS Code theme variables to dashboard CSS variables |
| Shared package extraction delays V1 | Medium | High | Extract types only (Phase 1), defer API client to Phase 2, establish monorepo workspace first |
| Tower not running on extension activation | High | Low | Graceful degraded state, clear messaging, offer to start Tower |
| API client behind corporate proxy fails | Medium | Medium | Accept custom HTTP agent, integrate with VS Code proxy settings |

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

**Second Consultation (2026-04-03) — Post user feedback:**
**Models Consulted**: Gemini 3 Pro, GPT-5.4 Codex, Claude (via `consult` CLI)

**Gemini 3 Pro — Critical findings:**
- **File corruption risk**: `POST /api/annotate/{tabId}/save` uses `fs.writeFileSync` which overwrites unsaved VS Code buffers. Must use `vscode.workspace.applyEdit()` instead. → **Fixed in spec.**
- **Never drop PTY frames**: Dropping frames garbles ANSI state permanently. Disconnect and reconnect with ring buffer replay instead. → **Fixed in spec.**
- **`TextDecoder` must use `{ stream: true }`**: Multi-byte Unicode split across frames produces `\uFFFD` corruption. → **Fixed in spec.**
- **Editor-split is brittle**: `moveIntoEditor` is undocumented, context-dependent. → **Made opt-in with panel fallback.**
- **Analytics theme mismatch**: Hardcoded dark CSS ignores VS Code themes. → **Added theme variable mapping.**
- **Workspace path matching**: Exact string match fails when user opens subdirectory. → **Added `.codev/config.json` root traversal.**
- **No monorepo workspace config**: `vsce` fails with unmanaged `file:` dependencies. → **Added monorepo prerequisite.**

**GPT-5.4 Codex — Key findings:**
- **Protocol versioning missing**: No handshake or version header. Extension breaks silently as Tower evolves. → **Added version in `/api/health` requirement.**
- **Error UX unspecified**: No error presentation for command failures. → **Added Error Handling UX section.**
- **WebSocket auth via query param**: Key leaks into logs. → **Changed to `0x00` control message post-connection.**
- **SSE refresh storms**: Burst of SSE events can overload extension. → **Added rate limiting (max 1/second).**
- **Comment `tabId` mapping unclear**: Dashboard tab concept doesn't translate to VS Code. → **Removed Tower endpoint dependency, use `WorkspaceEdit` only.**
- **Phased extraction**: Ship types first, defer API client until patterns stabilize. → **Added phased approach.**

**Claude — Key findings:**
- **Editor-split fragile**: Three sequential layout commands with no ordering guarantees. → **Made opt-in with setting.**
- **Auth key invalidation missing**: Stale `SecretStorage` after key rotation. → **Added re-read on 401.**
- **Missing Output Channel**: No diagnostic logging for debugging. → **Added Output Channel requirement.**
- **Missing settings schema**: Only `workspacePath` defined. → **Added full settings table.**
- **Missing keyboard shortcuts**: 14+ commands, zero keybindings. → **Added default shortcuts for critical commands.**
- **`afx open` URI scheme is critical**: Load-bearing decision, not "nice to know." → **Promoted to Critical open question.**
- **V1 scope too large**: 13 features. Recommended cutting Team View, Analytics, Cron, Cloud Tunnel from V1. → **Noted but kept full scope; plan phase will define V1 cut line.**

All findings incorporated into the relevant sections above.

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

## UX Walkthrough: Browser Dashboard vs VS Code Extension

### Starting Up

**Browser today:**
1. Run `afx tower start`
2. Open browser to `localhost:4100`
3. See the full dashboard — architect terminal on the left, work view on the right

**VS Code:**
1. Run `afx tower start` (same)
2. Open your project in VS Code — extension auto-activates when it detects `codev/` directory
3. Status bar at the bottom shows `$(server) 3 builders · 1 blocked`
4. Sidebar has a "Codev Agent Farm" panel with your Work View TreeView
5. Open the architect terminal — it splits the editor vertically (architect left, code right)
6. No browser needed

```
┌──────────────┬────────────────┬────────────────┐
│ Work View    │ Architect      │ [#42] [#43]    │
│ (sidebar     │ (terminal)     │ Builder #42    │
│  pane)       │                │ (terminal)     │
│              │                │                │
│ - Attention  │                │                │
│ - Builders   │ Left editor    │ Right editor   │
│ - PRs        │ group          │ group          │
│ - Backlog    │                │                │
└──────────────┴────────────────┴────────────────┘
```

### Monitoring Builders

**Browser today:**
- Work View tab on the right panel — builder cards showing status, phase, progress
- Click a builder card to switch to its terminal tab
- Needs Attention section at the top highlights blocked gates

**VS Code:**
- TreeView sidebar always visible alongside your code — no tab switching
- Expand "Builders" to see `#42 password-hashing [implement] ● running`
- "Needs Attention" node at the top: `#44 api-refactor — blocked on plan-approval (12m)`
- Status bar gives you the count at a glance without even looking at the sidebar

**Key difference:** In the browser, monitoring builders means you're *in the dashboard*. In VS Code, you see builder state *while editing code* — it's peripheral information, not a separate context.

### Opening a Builder Terminal

**Browser today:**
- Click the builder's tab in the tab bar (e.g., "Builder #42")
- xterm.js renders the terminal in the right panel
- You can see the architect terminal simultaneously in the left panel (split pane)

**VS Code:**
- Right-click builder in TreeView → "Open Terminal", or `Cmd+Shift+P` → "Codev: Open Builder Terminal"
- Builder terminal opens in the right editor group
- Architect stays on the left, builder on the right — same layout as the browser dashboard
- Switching builders swaps the right side, like switching tabs

**Key difference:** Nearly identical layout. The browser's is purpose-built; VS Code's uses native editor splits with terminal-in-editor views. Both give architect left, builder right, with full vertical height.

### Sending a Message to a Builder

**Browser today:**
- Switch to architect terminal tab
- Type `afx send 42 "implement the password hashing function"`
- Or use the inline send UI

**VS Code:**
- Option A: Type `afx send 42 "..."` in any VS Code terminal (identical to today)
- Option B: `Cmd+Shift+P` → "Codev: Send Message" → pick builder from dropdown → type message in input box → done
- Option C: Right-click builder #42 in TreeView → "Send Message"

**Key difference:** The Command Palette flow is faster than switching to the architect terminal. You can send a message without leaving the file you're editing.

### Clicking a File Path in Terminal Output

**Browser today:**
- Builder terminal shows `/src/auth/hash.ts:42`
- Click it → opens in the browser's built-in file viewer (Shiki highlighting, line numbers)
- It's a read-only viewer — you can't edit there

**VS Code:**
- Builder terminal shows `/src/auth/hash.ts:42`
- Click it → opens in VS Code's editor at line 42
- You're immediately in a full editor — syntax highlighting, IntelliSense, go-to-definition, edit in place

**Key difference:** This is the single biggest UX improvement. Today, file clicks dead-end in a read-only viewer. In VS Code, they land you exactly where you need to be to take action.

### Approving a Gate

**Browser today:**
- See "Needs Attention" in Work View
- Switch to your terminal
- Run `porch approve 44 plan-approval`

**VS Code:**
- Status bar shows `$(bell) Gate: plan-approval #44`
- Click it → approval prompt appears
- Or `Cmd+Shift+P` → "Codev: Approve Gate" → pick from list
- Or right-click the blocked builder in TreeView → "Approve Gate"

**Key difference:** Three clicks vs switching context to a terminal and typing a command.

### Spawning a New Builder

**Browser today:**
- Switch to architect terminal
- Type `afx spawn 190 --protocol spir`

**VS Code:**
- `Cmd+Shift+P` → "Codev: Spawn Builder"
- Quick-pick: enter issue number → pick protocol → optionally enter branch name
- Builder spawns, appears in TreeView, terminal becomes available

**Key difference:** Guided flow vs remembering CLI syntax. Also supports `--branch` for continuing on existing PR branches.

### Reviewing Code (Annotations)

**Browser today:**
- `afx open file.ts` → opens in browser annotation viewer
- Click the "+" gutter button → type a `REVIEW(@architect)` comment
- Comment is written directly into the file

**VS Code:**
- Open the file normally in your editor
- Click the native "+" gutter icon (same as GitHub PR inline comments)
- Type your review comment → it inserts `// REVIEW(@architect): text` into the file
- Same file format — interoperable with the browser dashboard

**Key difference:** Uses VS Code's native Comments API instead of a custom web UI. Feels like doing a PR review inline.

### Team & Analytics

**Browser today:**
- Team tab shows member cards, activity feed, messages
- Analytics tab shows Recharts charts (merged PR metrics, wall-clock hours)

**VS Code:**
- `Cmd+Shift+P` → "Codev: View Team" or "Codev: View Analytics"
- Opens as a Webview panel (essentially the same React components embedded in VS Code)
- Data proxied securely through the extension host

**Key difference:** Minimal — these are Webview panels, so the experience is similar. The benefit is not having to switch to a browser to see them.

### What VS Code Loses

| Feature | Why |
|---------|-----|
| **Curated split pane** | Browser's layout is automatic. VS Code mirrors the same architect-left/builder-right layout using terminal-in-editor views, set up on first terminal open. |
| **Mobile layout** | Browser dashboard has a mobile-responsive view. VS Code is desktop-only. |
| **Rich file viewer** | Browser handles images, video, PDF, 3D models inline. VS Code handles most natively except 3D. |
| **Multi-workspace overview** | Browser dashboard shows all workspaces at once. VS Code scopes to the open workspace by default. |
| **Remote access** | Browser works through cloud tunnel for remote collaboration. VS Code extension is local-only (unless using VS Code Remote SSH). |

### What VS Code Gains

| Feature | Why |
|---------|-----|
| **Zero context switching** | Never leave the IDE |
| **Native file editing** | File clicks → real editor, not a viewer |
| **Command Palette** | All operations keyboard-accessible |
| **Peripheral monitoring** | Builder state visible while coding |
| **Native review comments** | Gutter "+" feels like PR reviews |
| **IDE integration** | IntelliSense, go-to-definition, git, extensions all available alongside |

### Summary

The browser dashboard is a **dedicated control center** — best for monitoring multiple builders, remote access, and the curated split-pane experience. The VS Code extension is for **staying in flow** — you see builder state, send messages, approve gates, and click into files without ever leaving your editor.

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
