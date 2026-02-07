---
approved: 2026-01-29
validated: [gemini, codex, claude]
---
# Implementation Plan: Agent Farm Terminal & Dashboard Rewrite

## Metadata
- **Spec**: `codev/specs/0085-agent-farm-terminal-dashboard-rewrite.md`
- **Protocol**: SPIR
- **Created**: 2026-01-29

## Overview

Four-phase incremental migration replacing ttyd with node-pty and vanilla JS dashboard with React + Vite. Each phase is independently shippable with rollback. tmux remains required for session persistence.

## Phase 1: Node-pty Terminal Manager

**Goal**: Build the PTY management layer alongside existing ttyd. No user-facing changes yet.

### Files to Create

```
packages/codev/src/terminal/
├── pty-manager.ts          # Core PTY lifecycle (spawn, kill, resize, list)
├── pty-session.ts          # Single session: node-pty wrapper + ring buffer + disk log
├── ring-buffer.ts          # Fixed-size circular buffer (lines)
├── ws-protocol.ts          # WebSocket frame encoding/decoding (0x00 control, 0x01 data)
└── __tests__/
    ├── pty-manager.test.ts
    ├── pty-session.test.ts
    ├── ring-buffer.test.ts
    └── ws-protocol.test.ts
```

### Files to Modify

```
packages/codev/package.json              # Add node-pty dependency
packages/codev/src/agent-farm/servers/dashboard-server.ts  # Mount /api/terminals routes + /ws/terminal/:id
```

### API Contracts

#### REST Endpoints

**POST /api/terminals**
```typescript
// Request
interface CreateTerminalRequest {
  command?: string;        // Default: user's $SHELL
  args?: string[];         // Default: []
  cols?: number;           // Default: 80
  rows?: number;           // Default: 24
  cwd?: string;            // Default: project root
  env?: Record<string, string>;  // Merged with minimal base env
  label?: string;          // Display label (e.g., "builder-0085")
}

// Response: 201 Created
interface TerminalResponse {
  id: string;              // UUID
  pid: number;
  cols: number;
  rows: number;
  label: string;
  status: 'running' | 'exited';
  createdAt: string;       // ISO 8601
  wsUrl: string;           // e.g., "ws://localhost:4200/ws/terminal/<id>"
}

// Errors: 400 (invalid params), 503 (max sessions reached)
```

**GET /api/terminals**
```typescript
// Response: 200 OK
interface TerminalListResponse {
  terminals: TerminalResponse[];
}
```

**GET /api/terminals/:id**
```typescript
// Response: 200 OK → TerminalResponse
// Errors: 404 (not found)
```

**DELETE /api/terminals/:id**
```typescript
// Response: 204 No Content
// Errors: 404 (not found)
// Behavior: Sends SIGTERM to process group (-pid), then SIGKILL after 5s
```

**POST /api/terminals/:id/resize**
```typescript
// Request
interface ResizeRequest {
  cols: number;
  rows: number;
}
// Response: 200 OK → TerminalResponse (updated dimensions)
// Errors: 404 (not found), 400 (invalid dimensions)
```

**GET /api/terminals/:id/output**
```typescript
// Request query params: ?lines=100&offset=0
// Response: 200 OK
interface OutputResponse {
  lines: string[];
  total: number;           // Total lines in ring buffer
  hasMore: boolean;        // More available on disk
}
// Errors: 404 (not found)
```

#### WebSocket Handshake

```
GET /ws/terminal/:id
Headers:
  Upgrade: websocket
  Authorization: Bearer <token>    # Only required for remote access
  X-Session-Resume: <last-seq>     # Optional: resume from sequence number
```

**On connect**:
1. Validate session ID exists → 404 if not
2. If `X-Session-Resume` header present, replay ring buffer from that sequence
3. Otherwise, replay full ring buffer (last 1000 lines)
4. Begin streaming live PTY output

**Multi-client behavior**: Multiple browsers can attach to the same PTY. Output is broadcast to all. Input accepted from all (shared session). This matches tmux behavior.

#### Error Response Format

All REST errors use consistent structure:
```typescript
interface ErrorResponse {
  error: string;           // Machine-readable code: "NOT_FOUND", "INVALID_PARAMS", "MAX_SESSIONS"
  message: string;         // Human-readable description
  details?: unknown;       // Optional additional context
}
```

### Process Group Cleanup

When killing a PTY (timeout, explicit delete, or server shutdown):

```typescript
// Kill entire process group to prevent orphans
process.kill(-pty.pid, 'SIGTERM');
setTimeout(() => {
  try { process.kill(-pty.pid, 'SIGKILL'); } catch {}
}, 5000);
```

### Disk Log Rotation

When a session log reaches 50MB:
1. Rename current log to `<session-id>.log.1`
2. Start new `<session-id>.log`
3. Keep max 2 rotated files (100MB total per session)
4. On session cleanup, delete all log files

### node-pty Distribution

Use `@aspect-build/node-pty` which ships prebuilt binaries for:
- macOS arm64/x64
- Linux arm64/x64
- Windows x64

Fallback: If prebuilt unavailable, attempt `node-gyp` compilation with clear error message documenting required build tools.

### Exit Criteria

- [ ] PTY manager can spawn/kill/resize/list sessions
- [ ] WebSocket bidirectional I/O works (type in browser xterm.js → see output)
- [ ] Ring buffer captures last 1000 lines per session
- [ ] Disk logging writes to `.agent-farm/logs/`
- [ ] Reconnection replays ring buffer
- [ ] Multi-client broadcast works
- [ ] Process group cleanup verified (no orphan processes)
- [ ] Benchmark: keystroke latency <100ms (compare against ttyd baseline using automated keystroke script)
- [ ] 30 unit tests passing
- [ ] Config flag `terminal.backend: "node-pty"` enables new backend
- [ ] Telemetry: Log active backend to `.agent-farm/metrics.log` on startup (format: `{"event":"backend_selected","backend":"node-pty|ttyd","timestamp":"..."}`)
- [ ] Documentation: Update CLAUDE.md/AGENTS.md with `terminal.backend` config flag usage
- [ ] Documentation: Add `codev/config.json` example showing new terminal backend option

### Benchmark Methodology

```bash
# Automated keystroke latency test
# Send character via WebSocket, measure time until echo received
# Run 1000 iterations, report p50/p95/p99
# Compare ttyd baseline vs node-pty
node packages/codev/scripts/benchmark-terminal-latency.ts --backend ttyd
node packages/codev/scripts/benchmark-terminal-latency.ts --backend node-pty
```

---

## Phase 2: React Dashboard

**Goal**: Rebuild the dashboard UI in React + Vite with feature parity to current vanilla JS.

### Files to Create

```
packages/codev/dashboard/
├── src/
│   ├── components/
│   │   ├── App.tsx                # Root layout (split pane or single pane)
│   │   ├── Terminal.tsx           # xterm.js wrapper
│   │   ├── TabBar.tsx             # Tab management (builders, shells, annotations, dashboard)
│   │   ├── Tab.tsx                # Individual tab with close button
│   │   ├── StatusPanel.tsx        # Agent farm overview (builders, status)
│   │   ├── FileTree.tsx           # Project file browser
│   │   ├── SplitPane.tsx          # Resizable horizontal split
│   │   ├── BuilderCard.tsx        # Builder status card
│   │   └── MobileLayout.tsx       # Single-pane mobile layout
│   ├── hooks/
│   │   ├── useTerminal.ts         # WebSocket lifecycle + xterm.js init
│   │   ├── useBuilderStatus.ts    # Poll /api/builders for status
│   │   ├── useMediaQuery.ts       # Responsive breakpoint detection
│   │   └── useTabs.ts             # Tab state management
│   ├── lib/
│   │   ├── ws-client.ts           # WebSocket with auto-reconnect
│   │   ├── api.ts                 # REST client (typed fetch wrappers)
│   │   └── constants.ts           # Breakpoints, defaults
│   ├── main.tsx
│   └── index.css                  # Tailwind or minimal CSS
├── public/
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
└── __tests__/
    ├── Terminal.test.tsx
    ├── TabBar.test.tsx
    └── StatusPanel.test.tsx
```

### Files to Modify

```
packages/codev/src/agent-farm/servers/dashboard-server.ts  # Serve dist/ instead of templates/
packages/codev/package.json                                 # Add build script for dashboard
```

### Component Behavior

| Component | Current Vanilla JS | React Equivalent |
|-----------|-------------------|-----------------|
| Split pane | CSS flexbox + drag handle in layout.js | `<SplitPane>` with resize state |
| Tab bar | DOM manipulation in tabs.js | `<TabBar>` + `useTabs` hook |
| Terminal iframe | `<iframe src="ttyd-url">` | `<Terminal>` with useTerminal hook (xterm.js direct) |
| File tree | Custom fetch + DOM in files.js | `<FileTree>` with lazy loading |
| Builder status | Polling + DOM updates in dashboard.js | `<StatusPanel>` + useBuilderStatus |
| Mobile layout | CSS media queries only | `<MobileLayout>` with useMediaQuery (40 cols terminal) |

### Mobile Specifics

```typescript
// useMediaQuery.ts
const isMobile = useMediaQuery('(max-width: 768px)');

// Terminal.tsx
const cols = isMobile ? 40 : fitAddon.proposeDimensions()?.cols ?? 80;
```

### Build Integration

```jsonc
// packages/codev/package.json scripts
{
  "build:dashboard": "cd dashboard && vite build",
  "dev:dashboard": "cd dashboard && vite",
  "build": "tsc && npm run build:dashboard"  // existing build + dashboard
}
```

Dashboard `dist/` is committed to the npm package (not to git). The dashboard server serves from `dist/` in production, or proxies to Vite dev server in development.

### Exit Criteria

- [ ] All current dashboard features work in React version
- [ ] Desktop: Split-pane layout matches current behavior
- [ ] Mobile: Single-pane at 768px breakpoint, 40-col terminal
- [ ] Tabs: Open/close/switch for builders, shells, annotations, dashboard
- [ ] File tree: Browse project files, click to open annotation
- [ ] Builder status: Shows all builders with status
- [ ] Keyboard navigation works for tabs and panels
- [ ] ARIA labels on terminal containers
- [ ] Vitest component tests for Terminal, TabBar, StatusPanel
- [ ] Playwright E2E: Open dashboard → open terminal → type command → see output
- [ ] Playwright E2E: Switch tabs, resize split pane
- [ ] Playwright E2E: Mobile viewport → verify single-pane layout
- [ ] Accessibility: `npx playwright test --project=accessibility` with axe integration
- [ ] Dashboard loads in <500ms (Playwright trace measurement)
- [ ] Bundle size <200KB gzip (excluding xterm.js)
- [ ] Config flag `dashboard.frontend: "react" | "legacy"` for rollback
- [ ] Documentation: Update CLAUDE.md/AGENTS.md with `dashboard.frontend` config flag usage
- [ ] Documentation: Add developer guide for running Vite dev server with API proxy

---

## Phase 3: WebSocket Multiplexing

**Goal**: All terminals served through single port 4200 via WebSocket namespaces. No more per-terminal ttyd ports.

### Files to Modify

```
packages/codev/src/terminal/pty-manager.ts    # Already has WS support from Phase 1
packages/codev/src/agent-farm/commands/start.ts  # Stop spawning ttyd processes when backend=node-pty
packages/codev/src/agent-farm/commands/spawn.ts  # Create PTY via REST API instead of ttyd
packages/codev/src/agent-farm/commands/shell.ts  # Create PTY via REST API instead of ttyd
packages/codev/src/agent-farm/utils/shell.ts     # Remove ttyd spawn logic (behind config flag)
```

### Session-to-Builder Mapping

```typescript
// When af spawn creates a builder:
// 1. POST /api/terminals { label: "builder-0085", command: "claude", cwd: worktree }
// 2. Store terminal ID in builder state (SQLite)
// 3. Dashboard connects to ws://localhost:4200/ws/terminal/<id>

// State DB schema addition:
// ALTER TABLE builders ADD COLUMN terminal_id TEXT;
```

### Exit Criteria

- [ ] `af spawn` creates PTY via API (when backend=node-pty)
- [ ] `af shell` creates PTY via API (when backend=node-pty)
- [ ] Dashboard connects to terminals via single-port WebSocket
- [ ] No ttyd processes spawned when backend=node-pty
- [ ] Port allocation simplified (only 4200 needed per project)
- [ ] Reconnection works after browser refresh
- [ ] All existing `af` commands work with new backend
- [ ] Dual-backend regression: Run full test suite with both `ttyd` and `node-pty` configs
- [ ] Telemetry: Log terminal creation/destruction events to `.agent-farm/metrics.log`
- [ ] Documentation: Update `af spawn`/`af shell` docs to note single-port behavior when backend=node-pty

---

## Phase 4: Deprecate ttyd

**Goal**: Remove ttyd code path after 2 weeks of stable node-pty usage.

### Prerequisites

- Phases 1-3 stable for 2 weeks (no regressions reported)
- Config flag defaults flipped to `node-pty`

### Files to Modify/Delete

```
# Remove ttyd-specific code
packages/codev/src/agent-farm/utils/shell.ts      # Remove ttyd spawn functions
packages/codev/templates/ttyd-index.html           # Delete
packages/codev/src/agent-farm/servers/dashboard-server.ts  # Remove ttyd proxy routes

# Update documentation
CLAUDE.md / AGENTS.md                               # Remove ttyd prerequisites
INSTALL.md                                          # Remove brew install ttyd
codev/resources/commands/agent-farm.md              # Update terminal references
```

### Exit Criteria

- [ ] No ttyd references in codebase (except historical docs)
- [ ] `brew install ttyd` no longer required
- [ ] Config flag `terminal.backend` removed (node-pty is only option)
- [ ] All tests pass without ttyd installed
- [ ] INSTALL.md updated

---

## Authentication

**Simple approach**: Authentication is handled by the existing tower URL mechanism. Tower generates long, unique, unguessable URLs (e.g., `https://tower.example.com/abc123def456`). Knowledge of the URL = authorization. No additional token/cookie/header auth needed.

- **Local access**: No auth. Dashboard binds to `localhost:4200`.
- **Remote access**: Tower proxy generates unique URL per session. URL secrecy is the auth boundary.
- **WebSocket**: Same origin check for localhost; for remote, the unique URL path serves as the credential.

---

## Testing Tooling

### Unit/Integration Tests
- **Framework**: Vitest (already used in project)
- **Mocking**: `vitest-mock-extended` for node-pty mocks
- **Coverage**: `vitest --coverage` with >80% threshold

### E2E Tests
- **Framework**: Playwright
- **Accessibility**: `@axe-core/playwright` for automated a11y scanning
- **Mobile**: Playwright device emulation (iPhone 12, Galaxy S21)
- **CI Integration**: GitHub Actions workflow, runs on PR

### Load/Benchmark Tests
- **Custom script**: `packages/codev/scripts/benchmark-terminal-latency.ts`
- **Metrics**: p50/p95/p99 keystroke latency, memory per session
- **Threshold**: Fail CI if p95 >100ms or memory >100MB/session
- **Concurrency test**: Spawn 50 PTYs, send input to all, verify no data corruption

### Dual-Backend Regression (Phases 1-3)

During migration, CI runs test suite twice:
```yaml
# .github/workflows/test.yml
strategy:
  matrix:
    terminal-backend: [ttyd, node-pty]
```

Removed after Phase 4 (ttyd deprecation).

---

## Dependency Summary

| Package | Version | Purpose |
|---------|---------|---------|
| `@aspect-build/node-pty` | latest | PTY with prebuilt binaries |
| `@xterm/xterm` | ^5.x | Terminal emulator |
| `@xterm/addon-fit` | ^0.10.x | Auto-resize terminal |
| `@xterm/addon-webgl` | ^0.18.x | GPU-accelerated rendering |
| `react` | ^19.x | UI framework |
| `react-dom` | ^19.x | React DOM renderer |
| `vite` | ^6.x | Build tool |
| `@vitejs/plugin-react` | latest | React fast refresh |
| `ws` | ^8.x | WebSocket server (already a dependency) |

---

## Risk Register

| Risk | Phase | Probability | Impact | Mitigation |
|------|-------|------------|--------|-----------|
| node-pty won't compile on user's machine | 1 | Medium | High | Prebuilt binaries, clear error messages, fallback docs |
| React dashboard slower than vanilla JS | 2 | Low | Medium | Bundle analysis, code splitting, measure FCP |
| WebSocket reconnection edge cases | 3 | Medium | Medium | Extensive E2E tests, ring buffer replay, sequence numbers |
| Removing ttyd breaks edge case | 4 | Low | High | 2-week stabilization period, config flag rollback |

---

## Timeline (Phases, Not Dates)

Phases are sequential with dependencies. No time estimates per project policy.

```
Phase 1 (Terminal Manager) → Phase 2 (React Dashboard) → Phase 3 (WS Multiplexing)
                                                           ↓
                                                    Phase 4 (Deprecate ttyd)
```

Phases 1 and 2 could potentially run in parallel (different codepaths), but sequential is safer for a single builder.

**Note**: tmux remains required. node-pty spawns shells inside tmux sessions for persistence.
