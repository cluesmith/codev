---
approved: 2026-01-29
validated: [gemini, codex, claude]
---
# Specification: Agent Farm Terminal & Dashboard Rewrite

## Metadata
- **ID**: 0085
- **Status**: specified
- **Created**: 2026-01-29
- **Protocol**: SPIR
- **Supersedes**: 0067 (Agent Farm Architecture Rewrite)
- **Related Issues**: #171 (mobile terminal width), #177 (node-pty proposal)

## Problem Statement

Agent Farm's terminal layer (ttyd) and dashboard (vanilla JS) have both reached their limits:

### Terminal Layer (ttyd)

1. **No programmatic control**: Cannot set terminal dimensions (cols/rows) — this directly blocked #171 (mobile 40-char width). ttyd doesn't expose `window.term` or `window.socket`, and xterm.js v5's ES module system prevents injection.

2. **Port sprawl**: Each terminal requires a dedicated port via ttyd. Multi-project setups consume 100-port blocks.

3. **No stdout capture**: ttyd provides bidirectional terminal access but cannot capture output programmatically. Cannot observe builder progress, detect stuck builds, or extract metrics.

4. **Fire-and-forget commands**: `tmux send-keys` has no acknowledgment. We cannot know if a command was received, started, or completed.

5. **External dependency**: Users must `brew install ttyd`. Platform-specific friction, version incompatibilities, installation failures outside our control.

### Dashboard (Vanilla JS)

6. **~4,900 lines of vanilla JavaScript** across 18 files without framework support. Adding features requires DOM manipulation boilerplate. No component reuse. No type safety.

7. **No state management**: Tab state, builder status, and UI interactions are managed through ad-hoc DOM manipulation and global variables.

8. **Mobile support is fragile**: CSS-only responsive design with no framework support for conditional rendering or touch interactions.

## Pillar 1: Terminal Layer — Replace ttyd with node-pty

### Proposed Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Dashboard Server                      │
│                      Port 4200                           │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  React App   │  │   REST API   │  │   WebSocket  │   │
│  │   (Vite)     │  │   /api/*     │  │   /ws/*      │   │
│  └──────────────┘  └──────────────┘  └──────┬───────┘   │
└─────────────────────────────────────────────┼───────────┘
                                              │ multiplexed
             ┌────────────────────────────────┴────────────┐
             │              Terminal Manager               │
             │           (node-pty + xterm.js)             │
             ├──────────────┬──────────────┬───────────────┤
             ▼              ▼              ▼               ▼
        ┌────────┐    ┌────────┐    ┌────────┐    ┌────────┐
        │ PTY 1  │    │ PTY 2  │    │ PTY 3  │    │ PTY N  │
        │architect│    │builder │    │builder │    │ shell  │
        └────────┘    └────────┘    └────────┘    └────────┘
```

### Key Capabilities Gained

- **Programmatic dimension control**: `pty.resize(cols, rows)` — solves #171 directly
- **Single port**: All terminals multiplexed over WebSocket namespaces
- **Stdout capture**: `pty.onData(callback)` for every byte of output
- **Zero external deps**: node-pty is a Node.js native module (no brew install)

### tmux Integration

tmux remains **optional** for session persistence. node-pty can spawn `tmux attach` inside the PTY for persistence, or run direct PTY for simpler use cases.

### Terminal Manager API

#### REST Endpoints

```
POST   /api/terminals              # Create a new PTY session
GET    /api/terminals              # List active sessions
GET    /api/terminals/:id          # Get session info (pid, dimensions, status)
DELETE /api/terminals/:id          # Kill a PTY session
POST   /api/terminals/:id/resize   # Resize terminal { cols, rows }
GET    /api/terminals/:id/output   # Get captured stdout (paginated)
```

#### WebSocket Protocol

Connect to `ws://localhost:4200/ws/terminal/:id` for bidirectional PTY I/O.

**Hybrid protocol** (per Gemini recommendation):
- **Control messages**: JSON frames for resize, auth, session management
- **Data messages**: Raw binary frames for PTY I/O (minimize serialization overhead)

```typescript
// Control message (JSON)
interface ControlMessage {
  type: 'resize' | 'ping' | 'auth' | 'pause' | 'resume';
  payload: Record<string, unknown>;
}

// Data message (binary)
// Raw PTY output bytes — passed directly to xterm.js Terminal.write()
// Raw user input bytes — passed directly to pty.write()
```

**Message discrimination**: First byte indicates frame type:
- `0x00`: Control frame (remainder is UTF-8 JSON)
- `0x01`: Data frame (remainder is raw PTY bytes)

### Session Lifecycle & Reconnection

PTY sessions persist independently of WebSocket connections:

1. **Browser tab closes**: WebSocket disconnects, PTY continues running. Server keeps session alive for a configurable timeout (default: 5 minutes).
2. **Browser reconnects**: Client sends session ID, server replays buffered output (last N lines from ring buffer), then resumes live streaming.
3. **Timeout expires**: Server kills the PTY, cleans up resources, notifies any reconnecting clients.
4. **Explicit close**: Client or REST API sends DELETE, PTY is killed immediately.

```typescript
interface SessionConfig {
  reconnectTimeoutMs: number;   // Default: 300_000 (5 min)
  ringBufferLines: number;      // Default: 1000 (in-memory replay)
  diskLogEnabled: boolean;      // Default: true (append-only file)
  diskLogMaxBytes: number;      // Default: 50MB per session
}
```

### Stdout Capture & Storage

**Two-tier strategy** (per Gemini recommendation):

1. **Ring buffer (RAM)**: Last ~1000 lines per session for quick reconnect replay and UI refresh. Fixed memory budget per session.
2. **Append-only log (disk)**: Full session output written to `$PROJECT/.agent-farm/logs/<session-id>.log`. Capped at 50MB per session with rotation. Enables post-hoc analysis of builder output.

**Backpressure**: If WebSocket client falls behind, server pauses PTY output (`pty.pause()`) until client catches up. Prevents unbounded memory growth.

### Risks

| Risk | Mitigation |
|------|-----------|
| node-pty requires node-gyp compilation | Ship prebuilt binaries via `@aspect-build/node-pty` or `prebuild-install`. Document build-tools requirements for unsupported platforms. |
| WebSocket disconnection on unstable networks | Session persistence with configurable timeout, ring buffer replay, queued keystrokes |
| Performance regression vs ttyd | Benchmark in Phase 1 while ttyd still available as fallback. ttyd is C-based — expect comparable but slightly higher latency from Node.js. Target <100ms. |
| Long-running sessions exhaust memory | Ring buffer caps RAM usage. Disk logs rotate at 50MB. No unbounded growth. |

## Pillar 2: Dashboard — React + Vite

### Decision

**React + Vite** — selected after consultation with Gemini and Codex:

- **Gemini**: Strongly recommended React for ecosystem (shadcn/ui, Radix), state management complexity, and xterm-for-react integration wrappers.
- **Codex**: Requested framework decision be locked before spec approval.
- **htmx rejected**: Terminal emulation is inherently client-side and WebSocket-heavy. Would end up writing 90% custom JS anyway.
- **Svelte rejected**: Excellent framework, but smaller component ecosystem for the "boring" UI components we need (tabs, trees, split panes, dialogs).
- **Vanilla JS rejected**: Already proven not to scale at 4,900 lines.

### Dashboard Architecture

```
packages/codev/dashboard/          # New Vite project
├── src/
│   ├── components/
│   │   ├── Terminal.tsx           # xterm.js wrapper component
│   │   ├── TabBar.tsx            # Builder/shell/annotation tabs
│   │   ├── StatusPanel.tsx       # Builder status, agent farm overview
│   │   ├── FileTree.tsx          # Project file browser
│   │   └── SplitPane.tsx         # Resizable split layout
│   ├── hooks/
│   │   ├── useTerminal.ts        # WebSocket + xterm.js lifecycle
│   │   ├── useBuilderStatus.ts   # Polling/SSE for builder state
│   │   └── useMediaQuery.ts      # Mobile detection
│   ├── lib/
│   │   ├── ws-client.ts          # WebSocket client with reconnection
│   │   └── api.ts                # REST API client
│   ├── App.tsx
│   └── main.tsx
├── index.html
├── vite.config.ts
├── tsconfig.json
└── package.json
```

### Key Libraries

- `react` + `react-dom` (~40KB gzip) — UI framework
- `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-webgl` — terminal emulation
- `shadcn/ui` or `radix-ui` — accessible component primitives (tabs, dialogs, dropdowns)
- `vite` — build tooling with HMR

### UI/UX Requirements

- **Desktop**: Split-pane layout — architect terminal on left, tabbed content on right (same as current)
- **Mobile**: Single-pane layout, swipeable tabs, terminal locked to 40 columns
- **Responsive breakpoint**: 768px (below = mobile layout)
- **Accessibility**: Keyboard navigation for all tab/panel interactions, ARIA labels on terminal containers
- **Theme**: Dark mode default (terminal-friendly), no light mode needed

### Build & Serving

- Vite builds to `packages/codev/dashboard/dist/`
- Dashboard server serves the built assets as static files
- In development: Vite dev server with proxy to dashboard API
- In production: Pre-built, bundled with npm package

## Migration Strategy

**Incremental, not big-bang:**

| Phase | What | Entry Gate | Exit Gate | Rollback |
|-------|------|-----------|-----------|----------|
| 1 | Add node-pty terminal manager alongside ttyd | Spec approved | PTY manager passes unit tests, benchmark vs ttyd | Remove node-pty code, ttyd unaffected |
| 2 | Build React dashboard (keep same REST API) | Phase 1 exits | Dashboard feature-parity with vanilla JS | Revert to vanilla JS templates |
| 3 | WebSocket multiplexing for terminals | Phase 2 exits | All terminals on single port, reconnection works | Fall back to per-terminal ttyd ports |
| 4 | Deprecate ttyd | Phases 1-3 stable for 2 weeks | ttyd code removed, no regressions | Re-enable ttyd via config flag |
| 5 | Make tmux optional | Phase 4 exits | Direct PTY mode works, tmux still available | tmux remains default |

**Config flag**: `codev/config.json` → `"terminal.backend": "ttyd" | "node-pty"` (default: `"ttyd"` during transition, `"node-pty"` after Phase 4).

**Telemetry**: Log which backend is active to `.agent-farm/metrics.log` to track adoption during transition.

## Testing Strategy

### Terminal Manager (Pillar 1)

- **Unit tests**: PTY spawn/kill, resize, session lifecycle, ring buffer, reconnection timeout
- **Integration tests**: REST API endpoints (create/list/delete/resize), WebSocket connection + data flow
- **Load tests**: 50 concurrent PTYs with active I/O, measure latency and memory
- **Benchmark**: Compare keystroke latency vs ttyd baseline

### Dashboard (Pillar 2)

- **Component tests**: Vitest + React Testing Library for each component
- **E2E tests**: Playwright for full dashboard workflows (open terminal, switch tabs, resize, mobile layout)
- **Visual regression**: Screenshot comparison for desktop and mobile layouts

### Migration

- **Smoke tests per phase**: Automated check that core workflows work after each phase transition
- **Rollback tests**: Verify config flag switches back to previous backend cleanly

## Success Criteria

- [ ] Single port handles all terminal sessions (no port sprawl)
- [ ] Terminal dimensions controllable programmatically (cols/rows)
- [ ] Stdout/stderr captured and accessible via API
- [ ] Dashboard rebuilt in React + Vite with feature parity
- [ ] No required external dependencies (ttyd optional, tmux optional)
- [ ] All existing functionality preserved
- [ ] Mobile terminal works at 40 characters wide
- [ ] Performance: <100ms terminal latency, <500ms dashboard load
- [ ] Test coverage: >80% for new code
- [ ] Reconnection works after browser refresh (ring buffer replay)

## Performance Requirements

- **Terminal Latency**: <100ms round-trip for keystrokes
- **Dashboard Load**: <500ms first contentful paint
- **API Response**: <50ms for state queries
- **Memory**: <100MB per terminal session (ring buffer capped)
- **Disk**: <50MB per session log (with rotation)
- **Concurrent Terminals**: Support 50+ simultaneous sessions
- **Bundle Size**: <200KB gzipped for dashboard (excluding xterm.js)

## Security Considerations

- **Local-only by default**: Dashboard binds to localhost
- **Authentication**: For remote access (spec 0081), token-based auth via `Authorization` header on WebSocket upgrade and REST API calls. Token issued by tower auth flow. No auth required for localhost.
- **No input sanitization on terminal data**: Terminal data is raw PTY I/O — cannot be filtered without breaking functionality. Security boundary is authentication (who can connect) and authorization (what shell runs), not input filtering.
- **PTY environment**: Spawned with minimal env (PATH, HOME, SHELL, TERM). No secrets passed via environment unless explicitly configured.
- **CORS**: Strict same-origin for API calls
- **WebSocket origin check**: Reject connections from non-localhost origins unless authenticated

## Resolved Questions

- [x] **Framework**: React + Vite (consultation consensus + team familiarity)
- [x] **Stdout persistence**: Yes — ring buffer (RAM, 1000 lines) + append-only file (disk, 50MB cap)
- [x] **Long-running sessions**: Ring buffer caps memory. Disk logs rotate. PTY paused on backpressure.
- [x] **WebSocket protocol**: Hybrid — JSON for control, binary for data (first-byte discriminator)

## Open Questions

### Important (Affects Design)
- [ ] Should we implement custom terminal escape sequence extensions for builder-architect communication?
- [ ] Prebuilt binary strategy: `@aspect-build/node-pty` vs `prebuild-install` vs vendored binaries?

### Nice-to-Know
- [ ] Can xterm.js WebGL renderer improve performance for high-throughput sessions?
- [ ] Is there value in WASM-based terminal emulation for edge cases where node-pty can't compile?

## Expert Consultation

### Round 1 (2026-01-29)

**Gemini** — APPROVE (HIGH confidence):
- Recommended React + Vite for ecosystem and component libraries
- Proposed hybrid WebSocket protocol (JSON control + binary data)
- Proposed two-tier stdout storage (ring buffer + disk logs)
- Key concern: Reconnection strategy must be well-defined
- Killed htmx option: "Terminal emulation is inherently client-side. You'd write 90% custom JS anyway."

**Codex** — REQUEST_CHANGES (HIGH confidence):
- Wanted framework decision locked in before approval
- Missing API contracts for PTY manager and stdout capture
- Insufficient security/retention guidance
- No concrete testing plan tied to success metrics

### Round 2 (2026-01-29)

**Gemini** — APPROVE (HIGH confidence):
- "Strong, well-reasoned architecture rewrite; node-pty + React is the correct direction."
- Recommendations: Clarify multi-client behavior, kill process groups not just PIDs, prioritize prebuilds, simple loopback token for architect-to-API auth.

**Codex** — REQUEST_CHANGES (HIGH confidence):
- Wants API request/response schemas, error codes, auth handshake sequence
- Wants security flows for remote access (token issuance, CSRF)
- Wants testing tooling specifics and migration exit checklists
- **Note**: These are plan-level details, deferred to `codev/plans/0085-*.md`

## Approval

- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [x] Expert AI Consultation Round 1 Complete
- [x] Expert AI Consultation Round 2 Complete (Gemini APPROVE, Codex details deferred to plan)
