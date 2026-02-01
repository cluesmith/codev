# Review: Agent Farm Terminal & Dashboard Rewrite

## Metadata
- **Spec**: `codev/specs/0085-agent-farm-terminal-dashboard-rewrite.md`
- **Plan**: `codev/plans/0085-agent-farm-terminal-dashboard-rewrite.md`
- **Protocol**: SPIDER
- **Branch**: `builder/0085-agent-farm-terminal-dashboard-rewrite`

## Summary

Implemented the two-pillar rewrite of Agent Farm's terminal and dashboard infrastructure:
1. **Node-pty terminal manager** replacing ttyd for terminal access
2. **React + Vite dashboard** replacing vanilla JS dashboard

## Phases Completed

### Phase 1: Node-pty Terminal Manager
- Created `packages/codev/src/terminal/` module with ring buffer, WebSocket protocol, PTY session management, and terminal manager
- 46 unit tests covering all components
- Hybrid WebSocket protocol (0x00 control, 0x01 data frames)
- Ring buffer with monotonic sequence numbers for reconnection replay
- Multi-client broadcast support

### Phase 2: React Dashboard
- Created `packages/codev/dashboard/` with React 19 + Vite 6
- Components: App, Terminal, TabBar, StatusPanel, BuilderCard, FileTree, SplitPane, MobileLayout
- Custom hooks: useMediaQuery, useBuilderStatus, useTabs
- 8 component tests (TabBar, StatusPanel)
- Production bundle: 64KB gzipped (well under 200KB target)
- Dark theme matching existing dashboard

### Phase 3: WebSocket Multiplexing
- Added `terminalBackend` to Config interface
- Wired `af spawn`, `af shell`, and `af start` to create PTY sessions via REST API when backend=node-pty
- Added `terminalId` to Builder and UtilTerminal types
- All code paths fall back gracefully to ttyd if node-pty REST call fails
- Dashboard `api.ts` updated with `getTerminalWsUrl()` helper

### Phase 4: Deprecate ttyd (Partial)
- Flipped default terminal backend from `ttyd` to `node-pty`
- Flipped default dashboard frontend from `legacy` to `react`
- Made ttyd an optional dependency
- ttyd code paths preserved for rollback via `codev/config.json`

## Deviations from Plan

1. **`@aspect-build/node-pty` not found**: Plan specified `@aspect-build/node-pty` but the package doesn't exist on npm. Used `node-pty` (Microsoft's official package) instead.

2. **Phase 4 partial**: The plan requires 2 weeks of stability before removing ttyd code entirely. We flipped defaults and made ttyd optional, but preserved the ttyd code paths for rollback.

3. **Terminal component uses iframes**: Phase 2's Terminal component renders ttyd iframes (legacy approach). Full xterm.js integration for the React Terminal component requires Phase 3's WebSocket plumbing to be operational, which happens at runtime when the dashboard server starts with `node-pty` backend.

## Test Results

- Terminal manager: 46/46 passing
- Dashboard components: 8/8 passing
- TypeScript: compiles cleanly
- Vite build: succeeds (64KB gzip)

## Post-Integration Fixes (2026-02-01)

After the initial PR merged, end-to-end testing through the tower proxy revealed several issues:

### Crab Icon Garbled (Root Cause: Missing LANG)
The Claude Code crab icon rendered as ASCII underscores instead of Unicode block characters (▐▛███▜▌). **Root cause**: `pty-manager.ts` created PTY sessions without `LANG=en_US.UTF-8` in the environment. Without a UTF-8 locale, tmux re-renders the screen using ASCII fallbacks when a new client attaches. **Fix**: Add `LANG` to baseEnv in pty-manager.

### DA Response Chaff
Device Attribute response sequences (`ESC[?1;2c`, `ESC[>0;276;0c`) appeared as visible text in the terminal. These are xterm.js responses to DA queries that echo back through tmux. **Fix**: Buffer initial 300ms of WebSocket data in Terminal.tsx and apply regex filter before writing to xterm.js.

### Tab Close Broken
The TabBar sent raw IDs (e.g., `utilId`) to `DELETE /api/tabs/:id`, but the server expected prefixed IDs like `shell-<utilId>`. **Fix**: Send `tab.id` which already contains the prefix.

### Stale Shell Tabs
Utils with `pid: 0` and no `terminalId` (leftover from previous sessions) were displayed in the tab list. **Fix**: Filter in `useTabs.ts`.

### StatusPanel Feature Parity
Initial StatusPanel was a simplified version. Rewrote with full legacy feature parity: YAML project parsing, Active/Completed/Terminal sections with `<details>`, spec/plan/review/PR links in stage cells, furthest-along sorting, doc links.

### node-pty Binary Not Compiled
`npm install -g` doesn't run native addon compilation for node-pty. Required explicit `npm rebuild node-pty` after global install. The dashboard server would start but fail silently to create PTY sessions.

### Debugging Approach
The crab icon bug required multiple attempts. The breakthrough came from creating a **minimal repro** — a standalone Playwright script connecting xterm.js to the running dashboard's WebSocket endpoint. This captured raw frame data showing ASCII characters where Unicode was expected, which pointed directly to the locale issue.

## Lessons Learned

1. **Config flags enable safe migration**: The dual-backend approach (ttyd/node-pty, legacy/react) with config flags allows incremental rollout and instant rollback without code changes.

2. **REST API for terminal creation**: Using POST /api/terminals to create PTY sessions from af spawn/shell decouples the terminal lifecycle from the process that creates it. The dashboard server owns the PTY, not the spawning command.

3. **Fallback gracefully**: Every node-pty code path catches errors and falls back to ttyd. This means the feature can ship even if node-pty has platform-specific issues.

4. **Ring buffer with sequence numbers**: Monotonic sequence numbers in the ring buffer enable efficient reconnection - clients send their last sequence number and only receive missed data.

5. **PTY locale is critical**: When spawning PTY sessions that attach to tmux, `LANG=en_US.UTF-8` must be set. Without it, tmux detects a non-Unicode client and falls back to ASCII rendering for block characters, powerline symbols, and emoji — even though xterm.js supports them.

6. **Minimal reproducible examples save hours**: After multiple failed attempts to fix the crab icon by guessing (WebGL addon, customGlyphs, DA interception), a minimal repro capturing raw WebSocket frames immediately revealed the ASCII-vs-Unicode data difference and pointed to tmux locale detection.

7. **Native addons need explicit rebuild**: `npm install -g` with packages containing native addons (node-pty) may not compile the binary. Always run `npm rebuild <addon>` after global install and verify the `build/Release/` directory exists.
