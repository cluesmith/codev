# Specification: Agent Farm Architecture Rewrite

## Metadata
- **ID**: 0067
- **Status**: conceived
- **Created**: 2026-01-12
- **Protocol**: SPIR

## Clarifying Questions Asked

**Q1: What are the primary pain points with the current architecture?**
A1: Port sprawl (100-port blocks per project), inability to capture stdout from ttyd/tmux, fire-and-forget tmux send-keys, 4,900 lines of vanilla JS dashboard, external dependencies (brew install ttyd tmux).

**Q2: Should we migrate to Electron for native app distribution?**
A2: No. 3-way consultation unanimously recommended against Electron due to remote development concerns, distribution burden, and IDE lock-in. Keep web-based architecture.

**Q3: Should we keep tmux for session persistence?**
A3: Yes, but optionally. tmux provides battle-tested session persistence that survives daemon restarts. The new architecture should control tmux via node-pty rather than ttyd, making tmux optional for session persistence.

**Q4: What framework should replace the vanilla JS dashboard?**
A4: Consultation split between React and Svelte. Both are excellent choices. Decision: React with Vite for broader ecosystem and familiarity, with component library flexibility.

## Problem Statement

Agent Farm's current architecture, while functional, has accumulated significant technical debt that limits future development:

1. **Port Sprawl**: Each terminal requires a dedicated port via ttyd. A project with 10 builders needs 10+ ports. Multi-project setups consume 100-port blocks, approaching system limits and complicating firewall/proxy configurations.

2. **No Stdout Capture**: ttyd provides bidirectional terminal access but **cannot capture stdout**. The architect cannot programmatically observe builder output, limiting automation opportunities (e.g., detecting stuck builds, extracting metrics).

3. **Fire-and-Forget Commands**: `tmux send-keys` has no acknowledgment mechanism. We cannot know if a command was received, started, or completed. This breaks reliable orchestration.

4. **Vanilla JS Monolith**: The dashboard is ~4,900 lines of vanilla JavaScript without framework support. Adding features requires DOM manipulation boilerplate. No component reuse. No type safety. High maintenance burden.

5. **External Dependencies**: Users must `brew install ttyd tmux`. This creates platform-specific friction, version incompatibilities, and installation failures that are outside our control.

6. **Custom File Browser**: We wrote our own file browser when VSCode and web frameworks provide proven solutions. This is wasted effort that could be spent on core orchestration features.

## Current State

**Terminal Layer (ttyd + tmux):**
```
┌─────────────────────────────────────────────────────────┐
│                    Dashboard Server                      │
│                      Port 4200                           │
└────────────┬───────────────────────────────┬────────────┘
             │ WebSocket proxy               │ WebSocket proxy
             ▼                               ▼
┌────────────────────────┐     ┌────────────────────────┐
│    ttyd :4201          │     │    ttyd :4202          │
│    (architect)         │     │    (builder-0034)      │
└────────────┬───────────┘     └────────────┬───────────┘
             │                               │
             ▼                               ▼
┌────────────────────────┐     ┌────────────────────────┐
│    tmux session        │     │    tmux session        │
│    "architect"         │     │    "builder-0034"      │
└────────────────────────┘     └────────────────────────┘
```

**Pain Points in Code:**

- `spawn.ts` (982 lines): Complex ttyd/tmux spawning with retry logic
- `dashboard-server.ts` (2,222 lines): Raw http.createServer with ~80 routes
- Dashboard templates (~4,900 lines): Vanilla JS/CSS/HTML across 18 files
- `shell.ts`: Fire-and-forget `spawnDetached('ttyd', args)` with no output capture

**What Works Well (PRESERVE):**
- tmux session persistence (survives everything)
- Multi-project tower view
- Git worktree isolation per builder
- SQLite state management
- REST API design patterns

## Desired State

**Single-Port Multiplexed Architecture:**
```
┌─────────────────────────────────────────────────────────┐
│                    Dashboard Server                      │
│                      Port 4200                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ React/Svelte │  │   REST API   │  │   WebSocket  │   │
│  │   Dashboard  │  │   /api/*     │  │   /ws/*      │   │
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
             │              │              │               │
             ▼              ▼              ▼               ▼
        [optional]    [optional]    [optional]    [optional]
        tmux attach   tmux attach   tmux attach   direct PTY
```

**Key Improvements:**

1. **Single Port**: All terminals multiplexed over WebSocket namespaces (e.g., `/ws/terminal/architect`, `/ws/terminal/builder-0034`)

2. **Stdout Capture**: node-pty provides `onData` callback for every byte of output. Can log, analyze, trigger events.

3. **Acknowledgment Protocol**: Custom protocol layer over PTY enables command/response patterns:
   ```typescript
   interface CommandResult {
     id: string;
     exitCode: number;
     stdout: string;
     stderr: string;
     duration: number;
   }
   ```

4. **Modern Dashboard**: React + Vite with:
   - Component library (shadcn/ui or similar)
   - Type-safe state management
   - Hot module replacement
   - Tree-shaking for bundle size

5. **Zero External Dependencies**: node-pty is a pure Node.js module. tmux becomes optional for advanced session persistence.

## Stakeholders

- **Primary Users**: Developers using Agent Farm for multi-agent development
- **Secondary Users**: Remote development scenarios, CI/CD integrations
- **Technical Team**: Codev maintainers
- **Business Owners**: Project owner (Waleed)

## Success Criteria

- [ ] Single port handles all terminal sessions (no port sprawl)
- [ ] Stdout/stderr captured and accessible via API
- [ ] Dashboard rebuilt in React/Svelte with Vite
- [ ] No required external dependencies (ttyd/tmux optional)
- [ ] Command acknowledgment with exit codes and output
- [ ] All existing functionality preserved
- [ ] Migration path for existing users documented
- [ ] Performance: <100ms terminal latency, <500ms dashboard load
- [ ] Bundle size: <500KB gzipped for dashboard
- [ ] Test coverage: >80% for new code

## Constraints

### Technical Constraints

**node-pty Platform Support:**
- Native module requires node-gyp compilation
- Windows requires windows-build-tools or Visual Studio
- Pre-built binaries available for most platforms via prebuild

**WebSocket Multiplexing:**
- Must handle reconnection gracefully
- Binary protocol for efficiency (not JSON per keystroke)
- Backpressure handling for slow clients

**tmux Integration (Optional):**
- tmux provides session persistence but adds complexity
- Can spawn `tmux attach` inside node-pty for persistence
- Direct PTY mode for simpler use cases

### Business Constraints

- Must not break existing users during migration
- Incremental rollout preferred over big-bang release
- Maintain API compatibility where possible
- Documentation must be updated alongside code

## Assumptions

- Users have Node.js 18+ (already required)
- node-gyp can compile on target platforms (fallback to prebuilt binaries)
- xterm.js provides adequate terminal emulation
- React/Svelte developers can maintain the dashboard
- WebSocket connections are stable in user environments

## Solution Approaches

### Approach 1: Incremental Migration (RECOMMENDED)

**Description**: Replace components incrementally while maintaining backwards compatibility.

**Phase Order:**
1. Add node-pty terminal manager alongside ttyd (feature flag)
2. Migrate dashboard to React/Vite (keep same REST API)
3. Add WebSocket multiplexing
4. Deprecate and remove ttyd integration
5. Make tmux optional

**Pros:**
- Lower risk: Each phase is independently testable
- Backwards compatible during transition
- Can abort if issues arise
- Users migrate at their own pace

**Cons:**
- Longer total timeline
- Must maintain two implementations temporarily
- More complex codebase during transition

**Estimated Complexity**: Medium
**Risk Level**: Low

### Approach 2: Clean Rewrite

**Description**: Build new architecture from scratch, replace wholesale.

**Pros:**
- Cleaner architecture without legacy baggage
- Faster to implement (no compatibility constraints)
- Simpler codebase (no dual implementations)

**Cons:**
- High risk: All-or-nothing deployment
- Feature regression likely during transition
- Breaking change for all users simultaneously

**Estimated Complexity**: High
**Risk Level**: High

### Approach 3: Electron Migration (NOT RECOMMENDED)

**Description**: Move entire Agent Farm to an Electron app.

**Pros:**
- Native app distribution
- Tighter OS integration
- xterm.js works great in Electron

**Cons:**
- Breaks remote development (iPad, SSH tunnels)
- Distribution burden (signing, updates)
- IDE lock-in (no browser access)
- Larger footprint (~200MB app)
- Consultation unanimously rejected this approach

**Estimated Complexity**: High
**Risk Level**: High

## Open Questions

### Critical (Blocks Progress)
- [x] Should we use Electron? **Answer: No** (consultation unanimous)
- [x] React vs Svelte? **Answer: React** (broader ecosystem, team familiarity)

### Important (Affects Design)
- [ ] Should terminal output be persisted to disk for crash recovery?
- [ ] How to handle very long-running sessions (memory growth)?
- [ ] Should we implement custom terminal escape sequence extensions?

### Nice-to-Know (Optimization)
- [ ] Can we use SharedArrayBuffer for terminal rendering performance?
- [ ] Is there value in WASM-based terminal emulation?

## Performance Requirements

- **Terminal Latency**: <100ms round-trip for keystrokes
- **Dashboard Load**: <500ms first contentful paint
- **API Response**: <50ms for state queries
- **Memory**: <100MB per terminal session
- **Bundle Size**: <500KB gzipped (dashboard)
- **Concurrent Terminals**: Support 50+ simultaneous sessions

## Security Considerations

- **Local-only by default**: Dashboard binds to localhost
- **No credential exposure**: PTY spawned with minimal env
- **Input sanitization**: WebSocket messages validated
- **CORS**: Strict same-origin for API calls
- **Optional auth**: Token-based auth for remote access scenarios

## Test Scenarios

### Functional Tests
1. **Happy Path**: Spawn terminal → Type command → See output → Close terminal
2. **Reconnection**: Disconnect WebSocket → Reconnect → Resume session
3. **Multi-terminal**: Open 10 terminals → Type in each → No crosstalk
4. **Long output**: Run command producing 100MB output → No memory explosion
5. **Binary data**: cat binary file → Terminal handles gracefully

### Non-Functional Tests
1. **Latency**: Measure keystroke round-trip under load
2. **Memory**: Monitor heap growth over 24-hour session
3. **Concurrency**: 50 simultaneous terminals with active I/O
4. **Recovery**: Kill dashboard → Restart → Sessions persist (with tmux)

## Dependencies

- **External Services**: None (localhost only)
- **Internal Systems**: SQLite state, git worktrees, Claude CLI
- **Libraries/Frameworks**:
  - `node-pty` - Pseudo-terminal spawning
  - `xterm.js` - Browser terminal emulator
  - `ws` - WebSocket server
  - `react` + `vite` - Dashboard framework
  - `@xterm/addon-fit` - Terminal resizing
  - `@xterm/addon-webgl` - GPU-accelerated rendering

## References

- [node-pty GitHub](https://github.com/microsoft/node-pty) - Microsoft's PTY library
- [xterm.js GitHub](https://github.com/xtermjs/xterm.js) - Terminal emulator
- [VSCode Terminal Implementation](https://github.com/microsoft/vscode/tree/main/src/vs/workbench/contrib/terminal) - Reference architecture
- [Spec 0066: VSCode Companion Extension](./0066-vscode-companion-extension.md) - Related companion work

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| node-pty compilation fails on user machines | Medium | High | Provide prebuilt binaries, fallback instructions, Docker option |
| Performance regression vs ttyd | Low | Medium | Benchmark early, optimize WebSocket protocol |
| React learning curve for maintainers | Low | Low | Use familiar patterns, document component architecture |
| tmux session loss during migration | Medium | Medium | Feature flag for opt-in, test migration path extensively |
| WebSocket disconnection on unstable networks | Medium | Medium | Implement reconnection with session ID, queue pending keystrokes |

## Expert Consultation

**Date**: 2026-01-12
**Models Consulted**: Gemini 3 Pro, GPT-5 Codex

### Gemini (RECOMMEND Complete Re-architecture)
- "VERDICT: RECOMMEND COMPLETE RE-ARCHITECTURE"
- Replace ttyd + tmux with node-pty + xterm.js
- Single port WebSocket multiplexing
- React + Vite for dashboard
- "Do NOT move to Electron"
- Migration: Terminal layer first (4-6 weeks), then dashboard (3-4 weeks)

### Codex (RECOMMEND Hybrid Rewrite)
- "Adopt a hybrid rewrite focused on (a) replacing ttyd+tmux with a first-party terminal layer built on node-pty + WebSocket transport and (b) rebuilding the dashboard UI with Svelte + Vite"
- "Keep the overall Web-dashboard + CLI topology for now"
- "Do NOT move to Electron"
- Concerns: node-pty native compilation, WebSocket backpressure

### Consensus
Both models strongly recommend:
1. Replace ttyd with node-pty + WebSocket multiplexing
2. Modernize dashboard with React/Svelte + Vite
3. Keep web architecture (no Electron)
4. Phased migration approach
5. tmux optional for session persistence

## Approval

- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [x] Expert AI Consultation Complete

## Notes

**Why This Matters:**

The current architecture was a pragmatic bootstrap using proven tools (ttyd, tmux). It worked well enough to build Agent Farm's core value proposition. But now we're hitting limits:

1. **Observability**: Can't watch what builders are doing programmatically
2. **Scalability**: Port sprawl blocks multi-project workflows
3. **Maintainability**: 4,900 lines vanilla JS is unsustainable
4. **User Experience**: brew dependencies cause friction

The proposed architecture solves all four while maintaining what works (tmux persistence, worktree isolation, REST API patterns).

**Migration Strategy:**

Users can opt-in to new terminal backend via config flag. The dashboard can be rebuilt independently. Once stable, ttyd becomes deprecated but remains available for fallback. tmux transitions from required to optional.

**Relationship to Spec 0066:**

This spec (0067) provides the robust backend that makes 0066 (VSCode Companion) more valuable. The VSCode extension can use the same WebSocket multiplexing protocol to embed terminals, share state, and provide IDE integration without reimplementing terminal management.

---

## Amendments

This section tracks all TICK amendments to this specification.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
