# Specification: VSCode Companion Extension for Agent Farm

## Metadata
- **ID**: 0066
- **Status**: conceived
- **Created**: 2026-01-12
- **Protocol**: SPIR

## Clarifying Questions Asked

**Q1: Should this be a full rewrite of Agent Farm as a VSCode extension?**
A1: No. After extensive investigation (3-way consultation with Gemini, Codex, and Claude), all three models agreed that a full rewrite would result in significant capability loss due to VSCode API limitations, particularly around terminal output capture.

**Q2: What is the VSCode Terminal API's capability for capturing stdout?**
A2: VSCode Terminal API can create terminals (`createTerminal`) and send input (`sendText`), but **cannot reliably capture stdout/stderr**. This is documented in [microsoft/vscode#190941](https://github.com/microsoft/vscode/issues/190941) and remains an open feature request. The deprecated `onDidWriteTerminalData` is proposed API only and cannot be used in published extensions.

**Q3: What should the relationship be between Agent Farm and the VSCode extension?**
A3: The VSCode extension should be a **thin client/companion** to the existing Agent Farm backend. Agent Farm continues to own terminals (ttyd/tmux), state (SQLite), and Claude session lifecycle. The extension provides VSCode-native affordances.

## Problem Statement

Agent Farm currently operates through a web-based dashboard served on localhost. While functional and powerful, this architecture requires users to:
1. Switch between VSCode and a browser window
2. Manage browser tabs alongside IDE tabs
3. Lose context when moving between editing code and monitoring builders

VSCode users (our primary audience) would benefit from tighter IDE integration without sacrificing the robust terminal management that ttyd + tmux provide.

## Current State

**Agent Farm Architecture (v1.6.0):**
- Node.js HTTP server on port 4200 serving dashboard
- ttyd terminals exposing tmux sessions (one per builder/architect)
- SQLite state database (.agent-farm/state.db)
- Global port registry (~/.agent-farm/global.db) for multi-project
- Git worktree isolation per builder
- REST API for state polling and tab management

**User Experience Pain Points:**
- Browser window required alongside VSCode
- Context switching between IDE and dashboard
- No keyboard shortcuts from within VSCode
- File clicks in terminal open new browser tabs, not VSCode

**What Works Well:**
- tmux session persistence (survives browser refresh, dashboard restart)
- ttyd bidirectional terminal access
- Multi-project tower view
- Reliable clipboard integration

## Desired State

A VSCode extension that:
1. Provides **quick access** to Agent Farm commands via Command Palette
2. Shows **builder status** in Status Bar or sidebar
3. Opens **builder terminals** in VSCode's native terminal panel (attached to existing tmux sessions)
4. **Opens files** from terminal in VSCode editor (not browser annotation viewer)
5. Provides **dashboard-lite** view via Webview for status overview
6. **Coexists** with the web dashboard (not replaces it)

Users can choose their preferred interface:
- **Browser dashboard**: Full-featured, multi-monitor friendly, remote-accessible
- **VSCode extension**: IDE-integrated, keyboard-driven, no context switch

## Stakeholders
- **Primary Users**: Developers using VSCode + Agent Farm
- **Secondary Users**: Remote development scenarios (via VSCode Remote SSH)
- **Technical Team**: Codev maintainers
- **Business Owners**: Project owner (Waleed)

## Success Criteria
- [ ] `af` commands accessible via VSCode Command Palette
- [ ] Builder status visible in VSCode Status Bar
- [ ] Terminal sessions openable in VSCode terminal panel
- [ ] File clicks from terminal open in VSCode editor
- [ ] Webview panel shows builder status summary
- [ ] Extension works when Agent Farm is running (companion mode)
- [ ] Extension gracefully handles Agent Farm not running
- [ ] No degradation to existing web dashboard functionality
- [ ] Extension published to VSCode Marketplace

## Constraints

### Technical Constraints

**VSCode Terminal API Limitations (CRITICAL):**
- **Cannot capture terminal stdout/stderr** - No API for reading terminal buffer
- **Cannot embed terminals in webviews** - No iframe support for VSCode terminal
- **Terminal state not persisted** across VSCode restarts
- Extension host runs per-window; multi-window coordination requires external broker

**Workaround Strategy:**
Keep ttyd + tmux as the authoritative terminal layer. VSCode extension spawns terminals via `tmux attach -t <session>`, which maintains persistence through tmux while providing native VSCode terminal UX.

**Webview Limitations:**
- [Webview UI Toolkit deprecated](https://github.com/microsoft/vscode-webview-ui-toolkit) as of January 2025
- Webview state lost when hidden (unless `retainContextWhenHidden`, which has memory cost)
- Rendering bugs reported with webviews + terminal panel interaction

### Business Constraints
- Extension must not break existing web dashboard users
- Extension should enhance, not replace, current capabilities
- Minimal additional maintenance burden

## Assumptions
- Agent Farm daemon runs independently (started via `af start`)
- VSCode has access to the same filesystem as Agent Farm
- tmux is available on the system
- Users have the Claude Code CLI installed

## Solution Approaches

### Approach 1: Companion Extension (RECOMMENDED)

**Description**: Thin VSCode extension that acts as a client to Agent Farm's REST API. Agent Farm remains the orchestrator; extension provides VSCode-native UI.

**Architecture:**
```
┌─────────────────────────────────────┐
│         VSCode Extension            │
│  ┌──────────────┐ ┌──────────────┐  │
│  │Command Palette│ │ Status Bar │   │
│  └──────────────┘ └──────────────┘  │
│  ┌──────────────┐ ┌──────────────┐  │
│  │ Webview Panel │ │VSCode Terminals │
│  │ (status view) │ │(tmux attach)  │ │
│  └──────────────┘ └──────────────┘  │
└───────────────┬─────────────────────┘
                │ REST API calls
                ▼
┌─────────────────────────────────────┐
│         Agent Farm Backend          │
│  ┌──────────────┐ ┌──────────────┐  │
│  │ Dashboard    │ │ SQLite State │  │
│  │ Server :4200 │ │ .agent-farm/ │  │
│  └──────────────┘ └──────────────┘  │
│  ┌──────────────┐ ┌──────────────┐  │
│  │ ttyd Terminals│ │ tmux Sessions│  │
│  │ (web access) │ │ (persistence)│  │
│  └──────────────┘ └──────────────┘  │
└─────────────────────────────────────┘
```

**Pros:**
- Low risk: Agent Farm core unchanged
- Incremental: Each feature can ship independently
- Best of both: VSCode convenience + proven terminal infrastructure
- Fallback: Web dashboard always available

**Cons:**
- Requires Agent Farm running (`af start` still needed)
- Two UIs to maintain (though extension is thin)

**Estimated Complexity**: Medium
**Risk Level**: Low

### Approach 2: Full VSCode Migration (NOT RECOMMENDED)

**Description**: Rewrite Agent Farm entirely as a VSCode extension, eliminating ttyd/tmux/web dashboard.

**Pros:**
- Single unified UI
- VSCode Marketplace distribution only
- No external dependencies (ttyd, tmux)

**Cons:**
- **Terminal stdout capture impossible** - Breaks observation capability
- **Session persistence lost** - Terminals die with VSCode
- **Multi-project view degraded** - No tower equivalent
- **IDE lock-in** - Loses browser-based/remote access
- **Massive rewrite** - 6000+ lines of dashboard code
- **Higher maintenance** - Extension API changes frequently

**Estimated Complexity**: High
**Risk Level**: High

### Approach 3: Deep Integration with Claude Code Extension

**Description**: Leverage the official Claude Code VSCode extension's multi-session support and subagent capabilities.

**Pros:**
- Potentially simpler (build on existing foundation)
- Native Claude integration

**Cons:**
- Claude Code extension doesn't expose extension API for third parties
- Would require coordination with Anthropic
- Architecture unclear without API access

**Estimated Complexity**: Unknown
**Risk Level**: High (dependency on external party)

## Open Questions

### Critical (Blocks Progress)
- [x] Can VSCode Terminal API capture stdout? **Answer: No** (researched, confirmed limitation)
- [x] Should this replace or complement web dashboard? **Answer: Complement** (consensus from consultation)

### Important (Affects Design)
- [ ] Should extension auto-detect Agent Farm running, or require explicit start?
- [ ] Should webview status panel be sidebar or editor tab?
- [ ] How to handle multi-project scenarios in VSCode?

### Nice-to-Know (Optimization)
- [ ] Can extension use VSCode's Git extension for worktree visualization?
- [ ] Is there value in Tree View for builder hierarchy?

## Performance Requirements
- **Startup Time**: Extension activation < 500ms
- **API Polling**: Same as dashboard (1-second interval for state)
- **Terminal Spawn**: < 2 seconds for tmux attach
- **Memory**: Webview panel < 50MB

## Security Considerations
- Extension only communicates with localhost Agent Farm
- No cloud services or external API calls
- File operations limited to project directory
- Same security model as current Agent Farm

## Test Scenarios

### Functional Tests
1. **Happy Path**: Start Agent Farm → Open VSCode → Spawn builder via Command Palette → View status → Open terminal → Send message
2. **Agent Farm Not Running**: Extension shows graceful error, prompts to start
3. **Multiple Projects**: Extension detects correct Agent Farm instance for current workspace

### Non-Functional Tests
1. **Performance**: Measure activation time, API response latency
2. **Memory**: Monitor webview memory under sustained use
3. **Remote**: Test via VSCode Remote SSH to verify terminal attachment works

## Dependencies
- **External Services**: None (localhost only)
- **Internal Systems**: Agent Farm backend (existing)
- **Libraries/Frameworks**: VSCode Extension API, potentially React for webview

## References
- [VSCode Extension API Documentation](https://code.visualstudio.com/api)
- [VSCode Terminal API Issue #190941](https://github.com/microsoft/vscode/issues/190941) - stdout capture feature request
- [VSCode Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [Git Worktree Manager Extension](https://github.com/jackiotyu/git-worktree-manager) - reference implementation
- [Claude Code VSCode Extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code)

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| VSCode Terminal API never adds stdout capture | High | Medium | Keep ttyd as primary; extension uses tmux attach |
| Webview blanking bugs affect UX | Medium | Low | Provide "open in browser" fallback; keep web dashboard |
| Extension host per-window breaks multi-project | Medium | Medium | Detect workspace root, communicate with correct Agent Farm port |
| Maintenance burden of two UIs | Medium | Medium | Keep extension thin; most logic stays in Agent Farm backend |

## Expert Consultation

**Date**: 2026-01-12
**Models Consulted**: Gemini 3 Pro, GPT-5 Codex, Claude

### Gemini (RECOMMEND - Hybrid)
- Keep tmux backend, extension spawns `tmux attach`
- Phase-based migration: Dashboard → Terminals → Status CLI → Worktrees
- "Extension Logic: Command Palette, Webview, Terminal Manager wraps tmux attach"

### Codex (DO NOT RECOMMEND full rewrite)
- "Keep Agent Farm as standalone orchestrator, build companion extension"
- Critical blocker: Terminal stdout capture unavailable
- Webview instability issues documented
- Security concerns with extensions as attack vector

### Claude (DO NOT RECOMMEND full rewrite)
- "Hybrid approach: VSCode as companion, Agent Farm as orchestrator"
- "Core value proposition of Agent Farm is observability of parallel Claude sessions"
- "The safer path is a hybrid architecture where Agent Farm remains the orchestrator"
- Recommends lightweight companion extension

**Consensus**: 2/3 explicitly recommend against full rewrite. All 3 recommend hybrid/companion approach. All 3 identify VSCode Terminal stdout capture as critical limitation.

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [x] Expert AI Consultation Complete

## Notes

**Why Hybrid Over Full Migration:**
The consultation revealed a fundamental architectural mismatch. Agent Farm's value comes from:
1. **Observable terminals** - ttyd provides bidirectional access; VSCode Terminal API cannot capture output
2. **Persistent sessions** - tmux survives everything; VSCode terminals die with IDE
3. **IDE agnosticism** - Browser works everywhere; VSCode extension locks to one IDE
4. **Proven reliability** - Current architecture is battle-tested; rewrite introduces risk

A companion extension provides VSCode users with better integration (no browser switching) while preserving the robust terminal infrastructure that makes Agent Farm reliable.

---

## Amendments

This section tracks all TICK amendments to this specification.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
