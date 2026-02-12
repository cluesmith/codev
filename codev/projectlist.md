# Project List

Centralized tracking of all projects with status, priority, and dependencies.

> **Quick Reference**: See `codev/resources/workflow-reference.md` for stage diagrams and common commands.

## Document Organization

**Active projects appear first, integrated projects appear last (grouped by release).**

The file is organized as:
1. **Active Projects** (conceived → committed) - sorted by priority, then ID
2. **Releases** (each containing its integrated projects)
3. **Integrated (Unassigned)** - completed work not associated with any release
4. **Terminal Projects** (abandoned, on-hold)

## Project Lifecycle

Every project goes through stages. Not all projects reach completion:

**Active Lifecycle:**
1. **conceived** - Initial idea captured. Spec file may exist but is not yet approved. **AI agents must stop here after writing a spec.**
2. **specified** - Specification approved by human. **ONLY the human can mark a project as specified.**
3. **planned** - Implementation plan created (codev/plans/NNNN-name.md exists)
4. **implementing** - Actively being worked on (one or more phases in progress)
5. **implemented** - Code complete, tests passing, PR created and awaiting review
6. **committed** - PR merged to main branch
7. **integrated** - Merged to main, deployed to production, validated, reviewed (codev/reviews/NNNN-name.md exists), and **explicitly approved by project owner**. **ONLY the human can mark a project as integrated** - AI agents must never transition to this status on their own.

**Terminal States:**
- **abandoned** - Project canceled/rejected, will not be implemented (explain reason in notes)
- **on-hold** - Temporarily paused, may resume later (explain reason in notes)

## Release Lifecycle

Releases group projects into deployable units with semantic versioning:

**Release States:**
1. **planning** - Release scope being defined, projects being assigned
2. **active** - Release is the current development focus
3. **released** - All projects integrated and deployed to production
4. **archived** - Historical release, no longer actively maintained

```yaml
releases:
  - version: "v1.0.0"           # Semantic version (required)
    name: "Optional codename"   # Optional friendly name
    status: planning|active|released|archived
    target_date: "2025-Q1"      # Optional target (quarter or date)
    notes: ""                   # Release goals or summary
```

## Project Format

```yaml
projects:
  - id: "NNNN"              # Four-digit project number
    title: "Brief title"
    summary: "One-sentence description of what this project does"
    status: conceived|specified|planned|implementing|implemented|committed|integrated|abandoned|on-hold
    priority: high|medium|low
    release: "v0.2.0"       # Which release this belongs to (null if unassigned)
    files:
      spec: codev/specs/NNNN-name.md       # Required after "specified"
      plan: codev/plans/NNNN-name.md       # Required after "planned"
      review: codev/reviews/NNNN-name.md   # Required after "integrated"
    dependencies: []         # List of project IDs this depends on
    tags: []                # Categories (e.g., auth, billing, ui)
    timestamps:              # ISO timestamps for state transitions (set when entering each state)
      conceived_at: null     # When project was first created
      specified_at: null     # When human approved the spec
      planned_at: null       # When implementation plan was completed
      implementing_at: null  # When builder started work
      implemented_at: null   # When PR was created
      committed_at: null     # When PR was merged
      integrated_at: null    # When human validated in production
    notes: ""               # Optional notes about status or decisions
```

## Numbering Rules

1. **Sequential**: Use next available number (0001-9999)
2. **Reservation**: Add entry to this file FIRST before creating spec
3. **Renumbering**: If collision detected, newer project gets renumbered
4. **Gaps OK**: Deleted projects leave gaps (don't reuse numbers)

## Usage Guidelines

### When to Add a Project

Add a project entry when:
- You have a concrete idea worth tracking
- The work is non-trivial (not just a bug fix or typo)
- You want to reserve a number before writing a spec

### Status Transitions

```
conceived → [HUMAN] → specified → planned → implementing → implemented → committed → [HUMAN] → integrated
     ↑                                                                                   ↑
Human approves                                                                    Human approves
   the spec                                                                      production deploy

Any status can transition to: abandoned, on-hold
```

**Human approval gates:**
- `conceived` → `specified`: Human must approve the specification
- `committed` → `integrated`: Human must validate production deployment

### Priority Guidelines

- **high**: Critical path, blocking other work, or significant business value
- **medium**: Important but not urgent, can wait for high-priority work
- **low**: Nice to have, polish, or speculative features

### Tags

Use consistent tags across projects for filtering:
- `auth`, `security` - Authentication and security features
- `ui`, `ux` - User interface and experience
- `api`, `architecture` - Backend and system design
- `testing`, `infrastructure` - Development and deployment
- `billing`, `credits` - Payment and monetization
- `features` - New user-facing functionality

---

## Active Projects

Projects currently in development (conceived through committed), sorted by priority then ID.

```yaml
# High Priority

  - id: "0091"
    title: "Tower Mobile UX Refresh"
    summary: "Full mobile UX for tower: responsive layout, touch targets, QR code sharing, terminal usability on small screens"
    status: abandoned
    priority: medium
    release: v2.1.0
    files:
      spec: null
      plan: null
      review: null
    dependencies: ["0090"]
    tags: [ui, ux, mobile, tower, v2]
    timestamps:
      conceived_at: "2026-02-05T10:00:00-08:00"
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: null
    notes: "Abandoned. Audit showed mobile UX is already in good shape (MobileLayout component, responsive breakpoints, touch targets, safe area handling). No significant work needed."

  - id: "0092"
    title: "Terminal File Links and File Browser"
    summary: "Clickable file paths via @xterm/addon-web-links + FileTree enhancement with git status"
    status: integrated
    priority: medium
    release: null
    notes: "PR #189"
    files:
      spec: codev/specs/0092-terminal-file-links.md
      plan: codev/plans/0092-terminal-file-links.md
      review: codev/reviews/0092-terminal-file-links.md
    dependencies: ["0090", "0085"]
    timestamps:
      integrated_at: "2026-02-06"
    tags: [ui, ux, terminal, dashboard]
    timestamps:
      conceived_at: "2026-02-05T15:15:00-08:00"
      specified_at: "2026-02-05T15:15:00-08:00"
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: null
    notes: "Make file paths in terminal clickable, add file browser panel"

  - id: "0093"
    title: "SPIDER to SPIR Rename"
    summary: "Complete the rename of SPIDER protocol to SPIR across entire codebase"
    status: integrated
    priority: medium
    release: null
    files:
      spec: codev/specs/0093-spider-to-spir-rename.md
      plan: null
      review: null
    dependencies: []
    tags: [refactor, documentation, protocols]
    timestamps:
      conceived_at: "2026-02-06T10:00:00-08:00"
      specified_at: "2026-02-06T10:00:00-08:00"
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: "2026-02-07"
      integrated_at: "2026-02-07"
    notes: "Rename SPIDER → SPIR (Specify, Plan, Implement, Review). ~250 files affected. Commit 4330cc8."

  - id: "0072"
    title: "Ralph-SPIR Integration Spike"
    summary: "Spike to reimagine SPIR using Ralph principles: Builder owns entire lifecycle, human gates as backpressure"
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0072-ralph-spider-spike.md
      plan: null
      review: null
    dependencies: ["0069", "0070"]
    tags: [spike, workflow, ralph, v2]
    timestamps:
      conceived_at: "2026-01-19T10:00:00-08:00"
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2026-01-20T10:00:00-08:00"
    notes: "Spike complete - learnings incorporated into Porch (0073)."

  - id: "0073"
    title: "Porch - Protocol Orchestrator"
    summary: "Standalone CLI that runs SPIR/TICK/BUGFIX protocols as interactive REPL with state machine enforcement and human approval gates"
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0073-porch-protocol-orchestrator.md
      plan: codev/plans/0073-porch-protocol-orchestrator.md
      review: codev/reviews/0073-porch-protocol-orchestrator.md
    dependencies: ["0072"]
    tags: [porch, workflow, ralph, v2]
    timestamps:
      conceived_at: "2026-01-19T10:00:00-08:00"
      specified_at: "2026-01-19T12:00:00-08:00"
      planned_at: "2026-01-19T14:00:00-08:00"
      implementing_at: "2026-01-19T16:00:00-08:00"
      implemented_at: "2026-01-20T08:00:00-08:00"
      committed_at: "2026-01-20T09:00:00-08:00"
      integrated_at: "2026-01-20T10:00:00-08:00"
    notes: "Builds on Ralph-SPIR spike (0072). Three-level architecture: protocols → porch → af. 8 rounds of 3-way review before merge."

  - id: "0076"
    title: "Skip close confirmation for terminated shells"
    summary: "Fix incomplete Bugfix #132 - use tmuxSessionExists instead of isProcessRunning to correctly detect terminated shells"
    status: abandoned
    priority: medium
    release: null
    notes: "Obsolete - terminal lifecycle completely replaced by Tower Single Daemon (Spec 0090)"
    files:
      spec: codev/specs/0076-skip-close-confirmation-terminated-shells.md
      plan: codev/plans/0076-skip-close-confirmation-terminated-shells.md
      review: null
    dependencies: []
    tags: [ux, agent-farm, bugfix]
    timestamps:
      conceived_at: "2026-01-24T00:30:00-08:00"
      specified_at: "2026-01-26T00:00:00-08:00"
      planned_at: "2026-01-26T00:00:00-08:00"
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: null
    notes: "Bugfix #132 (PR #138) was incomplete - checks ttyd PID instead of tmux session. This spec fixes the root cause."

  - id: "0078"
    title: "Porch E2E Testing Infrastructure"
    summary: "E2E test harness for porch that validates the full SPIR protocol lifecycle with real AI interactions"
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0078-porch-e2e-testing.md
      plan: codev/plans/0078-porch-e2e-testing.md
      review: codev/reviews/0078-porch-e2e-testing.md
    dependencies: ["0073", "0075"]
    tags: [testing, porch, e2e, v2]
    timestamps:
      conceived_at: "2026-01-25T18:00:00-08:00"
      specified_at: "2026-01-25T18:30:00-08:00"
      planned_at: "2026-01-25T19:00:00-08:00"
      implementing_at: "2026-01-25T19:30:00-08:00"
      implemented_at: "2026-01-25T20:00:00-08:00"
      committed_at: "2026-01-25T20:30:00-08:00"
      integrated_at: "2026-02-01T00:00:00-08:00"
    notes: "E2E test infrastructure for porch. 3-way review (Gemini/Codex/Claude) identified and fixed AWAITING_INPUT gap and git add policy violation."

  - id: "0081"
    title: "Web Tower - Mobile Access to All Agent Farms"
    summary: "Reverse proxy for tower-server to access all projects through one port with auth, Cloudflare tunnel, and ntfy.sh notifications"
    status: integrated
    priority: medium
    release: v2.0.0
    files:
      spec: codev/specs/0081-simple-web-terminal-access.md
      plan: codev/plans/0081-simple-web-terminal-access.md
      review: codev/reviews/0081-simple-web-terminal-access.md
    dependencies: []
    tags: [tower, remote-access, mobile, v2]
    timestamps:
      conceived_at: "2026-01-27T10:00:00-08:00"
      specified_at: "2026-01-27T12:00:00-08:00"
      planned_at: "2026-01-27T14:00:00-08:00"
      implementing_at: "2026-01-28T01:10:00-08:00"
      implemented_at: "2026-01-28T01:25:00-08:00"
      committed_at: "2026-01-28T01:35:00-08:00"
      integrated_at: "2026-02-01T00:00:00-08:00"
    notes: "PR #169 merged. Reverse proxy, auth, tunnel docs, push notifications, mobile polish. TICK-001: Updated proxy routing for node-pty WebSocket multiplexing (Spec 0085)."

  - id: "0087"
    title: "Porch Timeout Termination Retries"
    summary: "Add timeout logic to porch so that when Claude (as the worker) hangs or fails to respond, porch can terminate and retry the operation"
    status: specified
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0087-porch-timeout-termination-retries.md
      plan: null
      review: null
    dependencies: ["0073", "0075"]
    tags: [porch, reliability, timeout, retry]
    timestamps:
      conceived_at: "2026-01-31T07:40:00-08:00"
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: null
    notes: "User-requested. Claude workers in porch can hang indefinitely. Need timeout detection, graceful termination, and automatic retry with context preservation."

  - id: "0075"
    title: "Porch Minimal Redesign"
    summary: "Redesign porch from 4800 lines to ~500 lines. Claude calls porch as a tool instead of porch spawning Claude."
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0075-porch-minimal-redesign.md
      plan: codev/plans/0075-porch-minimal-redesign.md
      review: null
    dependencies: ["0073"]
    tags: [porch, workflow, v2]
    timestamps:
      conceived_at: "2026-01-21T12:00:00-08:00"
      specified_at: "2026-01-21T12:30:00-08:00"
      planned_at: "2026-01-21T12:30:00-08:00"
      implementing_at: "2026-01-21T20:00:00-08:00"
      implemented_at: "2026-01-21T20:25:00-08:00"
      committed_at: "2026-01-22T00:00:00-08:00"
      integrated_at: "2026-02-01T00:00:00-08:00"
    notes: "Code on main. Porch redesigned to 845 lines (79% reduction). All 68 unit tests pass. Claude→Porch→Claude architecture."

  - id: "0070"
    title: "CODEV_HQ Minimal Implementation Spike"
    summary: "Spike to validate CODEV_HQ architecture: WebSocket connection, status sync, remote approvals"
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0070-codev-hq-spike.md
      plan: null
      review: null
    dependencies: ["0068"]
    tags: [spike, architecture, cloud, v2]
    timestamps:
      conceived_at: "2026-01-16T07:54:00-08:00"
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2026-01-28T08:00:00-08:00"
    notes: "Spike complete - validated CODEV_HQ core concepts (WebSocket, status sync)."

  - id: "0069"
    title: "Checklister Agent Spike"
    summary: "Spike to build a checklister agent that enforces SPIR protocol compliance"
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0069-checklister-spike.md
      plan: null
      review: null
    dependencies: []
    tags: [spike, workflow, protocol, v2]
    timestamps:
      conceived_at: "2026-01-16T07:54:00-08:00"
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2026-01-20T10:00:00-08:00"
    notes: "Spike complete - superseded by Porch (0073) which implements state machine enforcement."

  - id: "0068"
    title: "Codev 2.0 - Cloud Tower + Deterministic Core"
    summary: "Major platform rewrite: cloud-hosted tower, mobile access, deterministic SPIR enforcement"
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0068-codev-2.0.md
      plan: null
      review: null
    dependencies: []
    tags: [architecture, cloud, mobile, workflow, v2]
    timestamps:
      conceived_at: "2026-01-12T00:00:00-08:00"
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2026-02-08"
    notes: "Meta-spec for Codev 2.0. Three pillars: (1) Terminal/Dashboard rewrite, (2) Cloud Tower with mobile PWA, (3) Deterministic SPIR enforcement. Supersedes 0066/0067."

  - id: "0067"
    title: "Agent Farm Architecture Rewrite"
    summary: "Replace ttyd/tmux with node-pty, modernize dashboard with React/Svelte"
    status: abandoned
    priority: medium
    release: null
    files:
      spec: codev/specs/0067-agent-farm-architecture-rewrite.md
      plan: null
      review: null
    dependencies: ["0068"]
    tags: [architecture, agent-farm, terminal, dashboard]
    timestamps:
      conceived_at: "2026-01-12T00:00:00-08:00"
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: null
    notes: "ABANDONED: Superseded by 0085 (Agent Farm Terminal & Dashboard Rewrite). 0067 was too broad and coupled to 0068. 0085 narrows scope and reconsiders framework choice."

  - id: "0066"
    title: "VSCode Companion Extension"
    summary: "Thin VSCode extension providing IDE integration with Agent Farm backend"
    status: abandoned
    priority: low
    release: null
    files:
      spec: codev/specs/0066-vscode-companion-extension.md
      plan: null
      review: null
    dependencies: []
    tags: [vscode, extension, ui, dx]
    timestamps:
      conceived_at: "2026-01-12T00:00:00-08:00"
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: null
    notes: "ABANDONED: Superseded by 0068 Cloud Tower approach. Instead of IDE-specific extension, we're building cloud-hosted tower with mobile PWA that works from any device."

  - id: "0063"
    title: "Tower Dashboard Improvements"
    summary: "Better project management UI with tools for starting local/remote services"
    status: abandoned
    priority: high
    release: v1.6.0
    files:
      spec: codev/specs/0063-tower-dashboard-improvements.md
      plan: null
      review: null
    dependencies: []
    tags: [tower, ui, dashboard]
    timestamps:
      conceived_at: "2025-12-28T08:20:00-08:00"
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: null
    notes: "Abandoned - superseded by React dashboard rewrite (0085), Tower single daemon (0090), and terminal file links (0092)."





# Medium Priority

  - id: "0061"
    title: "3D Model Viewer (STL + 3MF)"
    summary: "Add 3D model viewing to dashboard for STL and 3MF files with multi-color support"
    status: integrated
    priority: medium
    release: v1.5.2
    files:
      spec: codev/specs/0061-stl-viewer.md
      plan: codev/plans/0061-stl-viewer.md
      review: codev/reviews/0061-stl-viewer-tick-002.md
    dependencies: []
    tags: [dashboard, ui, 3d, cad]
    timestamps:
      conceived_at: "2025-12-25T00:00:00-08:00"
      specified_at: "2025-12-25T00:00:00-08:00"
      planned_at: "2025-12-25T00:00:00-08:00"
      implementing_at: "2025-12-25T00:00:00-08:00"
      implemented_at: "2025-12-26T00:00:00-08:00"
      committed_at: "2025-12-28T00:00:00-08:00"
      integrated_at: "2025-12-28T00:00:00-08:00"
    notes: "Three.js 3D viewer (STL + 3MF). Uses ES Modules with Three.js r160. TICK-001: quaternion trackball. TICK-002: 3MF multi-color support. Released in v1.5.2 Florence."

  - id: "0062"
    title: "Secure Remote Access"
    summary: "SSH tunnel + reverse proxy: af start --remote for one-command remote access"
    status: integrated
    priority: high
    release: v1.5.2
    files:
      spec: codev/specs/0062-secure-remote-access.md
      plan: codev/plans/0062-secure-remote-access.md
      review: codev/reviews/0062-secure-remote-access.md
    dependencies: []
    tags: [security, remote-access, ssh, agent-farm]
    timestamps:
      conceived_at: "2025-12-27T00:00:00-08:00"
      specified_at: "2025-12-27T00:00:00-08:00"
      planned_at: "2025-12-27T00:00:00-08:00"
      implementing_at: "2025-12-27T00:00:00-08:00"
      implemented_at: "2025-12-28T00:00:00-08:00"
      committed_at: "2025-12-28T00:00:00-08:00"
      integrated_at: "2025-12-28T00:00:00-08:00"
    notes: "Reverse proxy consolidates ttyd instances behind one port. af start --remote for one-command iPad/remote access. Released in v1.5.2 Florence."

  - id: "0023"
    title: "Consult Tool (Stateful)"
    summary: "Add stateful session support to consult tool via stdio communication with persistent CLI processes"
    status: on_hold
    priority: low
    release: null
    files:
      spec: null
      plan: null
      review: null
    dependencies: ["0022"]
    tags: [architecture, agents, consultation]
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: null
    notes: "ON HOLD: Benefits unclear - stateless consult already works well. May revisit if use case becomes clearer."







# Low Priority

  - id: "0064"
    title: "Dashboard Tab State Preservation"
    summary: "Cache iframes instead of recreating them to preserve scroll position and edit mode when switching tabs"
    status: abandoned
    priority: medium
    release: null
    files:
      spec: codev/specs/0064-dashboard-tab-state-preservation.md
      plan: null
      review: null
    dependencies: []
    tags: [dashboard, ui, dx]
    timestamps:
      conceived_at: "2025-12-29T08:15:00-08:00"
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: null
    notes: "Abandoned - iframe architecture replaced by React dashboard (0085). React manages component state natively."










```

---

## Releases

```yaml
releases:
  - version: "v2.0.0"
    name: "TBD"
    status: planning
    target_date: "2026-Q3"
    notes: "Major platform rewrite. Three pillars: (1) node-pty terminal layer, React dashboard, (2) Cloud Tower with mobile PWA, (3) Deterministic SPIR enforcement via workflow engine."

  - version: "v1.6.0"
    name: "Gothic"
    status: released
    target_date: "2026-01-12"
    notes: "Key features: BUGFIX protocol (af spawn --issue), CMAP 3-way parallel reviews, git remote detection"

  - version: "v1.5.8"
    name: "Florence"
    status: released
    target_date: "2025-12-28"
    notes: "Secure remote access, 3D model viewer (STL/3MF), annotation proxy fixes"

  - version: "v1.5.0"
    name: "Florence (initial)"
    status: released
    target_date: "2025-12-19"
    notes: "Dashboard modularization, file browser, file search, activity summary, tab overhaul"

  - version: "v1.4.0"
    name: "Eichler"
    status: released
    target_date: "2025-12-15"
    notes: "Dashboard overhaul, documentation improvements, AI-guided release process"

  - version: "v1.3.0"
    name: "Doric"
    status: released
    target_date: "2025-12-13"
    notes: "Image generation, file browser, media viewer, documentation"

  - version: "v1.2.0"
    name: "Cordoba"
    status: released
    target_date: "2025-12-11"
    notes: "Documentation, cheatsheet, agent farm internals, codev import command"

  - version: "v1.1.0"
    name: "Bauhaus"
    status: released
    target_date: null
    notes: "Polish and improvements"

  - version: "v1.0.0"
    name: "Alhambra"
    status: released
    target_date: "2025-12-05"
    notes: "First stable release with full architect-builder workflow, tower dashboard, and migration tooling"

  - version: "v0.2.0"
    name: "Foundation"
    status: released
    target_date: null
    notes: "Initial release establishing core infrastructure: test framework, architect-builder pattern, TypeScript CLI, and dashboard"
```

### v1.6.0 (planning)

```yaml
  - id: "0065"
    title: "BUGFIX Protocol and CLI Support"
    summary: "Lightweight protocol for minor bugfixes with af spawn --issue support"
    status: integrated
    priority: high
    release: v1.6.0
    files:
      spec: codev/specs/0065-bugfix-protocol.md
      plan: codev/plans/0065-bugfix-protocol.md
      review: null
    dependencies: []
    tags: [protocol, cli, agent-farm]
    timestamps:
      conceived_at: "2026-01-03T10:00:00-08:00"
      specified_at: "2026-01-03T10:00:00-08:00"
      planned_at: "2026-01-03T11:00:00-08:00"
      implementing_at: "2026-01-03T12:00:00-08:00"
      implemented_at: "2026-01-03T14:00:00-08:00"
      committed_at: "2026-01-04T00:00:00-08:00"
      integrated_at: "2026-01-04T09:00:00-08:00"
    notes: "BUGFIX protocol for GitHub issues + af spawn --issue CLI support. CMAP reviewed: 2 APPROVE, 1 COMMENT. Key feature for v1.6.0."
```

### v1.0.0 (active)

9 projects in recommended order:

| Order | ID | Title | Phase |
|-------|------|-------|-------|
| 1 | 0013 | Document OS Dependencies | Foundation |
| 2 | 0022 | Consult Tool (Stateless) | Foundation |
| 3 | 0015 | Cleanup Protocol | Foundation |
| 4 | 0014 | Flexible Builder Spawning | Core CLI |
| 5 | 0020 | Send Instructions to Builder | Core CLI |
| 6 | 0019 | Tab Bar Status Indicators | Dashboard UX |
| 7 | 0010 | Annotation Editor | Dashboard UX |
| 8 | 0011 | Multi-Instance Support | Dashboard UX |
| 9 | 0006 | Tutorial Mode | Onboarding |

See Active Projects section above for full details and current status.

### v0.2.0 - Foundation (released)

```yaml
  - id: "0001"
    title: "Test Infrastructure"
    summary: "BATS-based test framework for Codev installation and protocols"
    status: integrated
    priority: high
    release: "v0.2.0"
    files:
      spec: codev/specs/0001-test-infrastructure.md
      plan: codev/plans/0001-test-infrastructure.md
      review: codev/reviews/0001-test-infrastructure.md
    dependencies: []
    tags: [testing, infrastructure]
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-03T03:46:44-08:00"
    notes: "64 tests passing, pre-commit hook installed"

  - id: "0002"
    title: "Architect-Builder Pattern"
    summary: "Multi-agent orchestration with git worktrees for parallel development"
    status: integrated
    priority: high
    release: "v0.2.0"
    files:
      spec: codev/specs/0002-architect-builder.md
      plan: codev/plans/0002-architect-builder.md
      review: null
    dependencies: []
    tags: [architecture, agents]
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-03T03:46:44-08:00"
    notes: "Bash CLI implemented, superseded by 0005 TypeScript CLI. TICK-001: Direct CLI access (af architect). TICK-002: Protocol-agnostic spawn system (planned 2026-01-27)."

  - id: "0004"
    title: "Dashboard Nav UI"
    summary: "Enhanced navigation and UX for the agent-farm dashboard"
    status: integrated
    priority: medium
    release: "v0.2.0"
    files:
      spec: codev/specs/0004-dashboard-nav-ui.md
      plan: codev/plans/0004-dashboard-nav-ui.md
      review: null
    dependencies: ["0005"]
    tags: [ui, dashboard]
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-03T03:46:44-08:00"
    notes: "Integrated with TypeScript CLI"

  - id: "0005"
    title: "TypeScript CLI"
    summary: "Migrate architect CLI from bash to TypeScript with npm distribution"
    status: integrated
    priority: high
    release: "v0.2.0"
    files:
      spec: codev/specs/0005-typescript-cli.md
      plan: codev/plans/0005-typescript-cli.md
      review: codev/reviews/0005-typescript-cli.md
    dependencies: ["0002"]
    tags: [cli, typescript, npm]
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-03T03:46:44-08:00"
    notes: "Published as agent-farm@0.1.0 to npm"

  - id: "0007"
    title: "Split-Pane Dashboard"
    summary: "Architect always visible on left, tabbed interface on right for files/builders/shells"
    status: integrated
    priority: medium
    release: "v0.2.0"
    files:
      spec: codev/specs/0007-split-pane-dashboard.md
      plan: codev/plans/0007-split-pane-dashboard.md
      review: null
    dependencies: ["0005"]
    tags: [ui, dashboard]
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-03T03:46:44-08:00"
    notes: "Supersedes 0004 left-nav approach"

  - id: "0008"
    title: "Architecture Consolidation"
    summary: "Eliminate brittleness by consolidating triple implementation to single TypeScript source"
    status: integrated
    priority: high
    release: "v0.2.0"
    files:
      spec: codev/specs/0008-architecture-consolidation.md
      plan: codev/plans/0008-architecture-consolidation.md
      review: codev/reviews/0008-architecture-consolidation.md
    dependencies: ["0005"]
    tags: [architecture, cli, refactoring]
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-03T03:46:44-08:00"
    notes: "Completed 2025-12-03. Single TypeScript CLI, config.json, global port registry with file locking"

  - id: "0009"
    title: "Terminal File Click to Annotate"
    summary: "Click on file paths in terminal output to open them in the annotation viewer"
    status: integrated
    priority: medium
    release: "v0.2.0"
    files:
      spec: codev/specs/0009-terminal-file-click.md
      plan: codev/plans/0009-terminal-file-click.md
      review: codev/reviews/0009-terminal-file-click.md
    dependencies: ["0007"]
    tags: [ui, dashboard, dx]
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-03T11:43:50-08:00"
    notes: "Uses ttyd's native http link handling. Fixed annotation server startup wait. Deleted broken custom xterm.js templates."

  - id: "0016"
    title: "Clarify Builder Role Definition"
    summary: "Resolved: Kept 'Builder' name but clarified it encompasses remodel, repair, maintain - not just new construction"
    status: integrated
    priority: medium
    release: "v0.2.0"
    files:
      spec: null
      plan: null
      review: null
    dependencies: []
    tags: [documentation, naming]
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-03T03:58:51-08:00"
    notes: "Decided to keep 'Builder' after consulting Pro and Codex. Updated codev/resources/conceptual-model.md with expanded definition. 'Building' = build, remodel, repair, extend, validate, document, maintain."

  - id: "0018"
    title: "Annotation Server Reliability"
    summary: "Fix template path and stale process detection in annotation server"
    status: integrated
    priority: medium
    release: "v0.2.0"
    files:
      spec: null
      plan: null
      review: null
    dependencies: ["0008"]
    tags: [bugfix, dashboard]
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-03T05:15:28-08:00"
    notes: "Fixed: (1) Template path now looks in codev/templates/ instead of deleted agent-farm/templates/, (2) Dashboard API now verifies annotation processes are alive before returning 'existing' entries, cleans up stale state automatically."
```

---

## Integrated (Unassigned)

Completed projects not associated with any formal release (ad-hoc fixes, documentation, improvements).

```yaml
  - id: "0060"
    title: "Dashboard Modularization"
    summary: "Split dashboard-split.html into separate CSS and JS files for maintainability"
    status: integrated
    priority: medium
    release: null
    files:
      spec: codev/specs/0060-dashboard-modularization.md
      plan: codev/plans/0060-dashboard-modularization.md
      review: codev/reviews/0060-dashboard-modularization.md
    dependencies: []
    tags: [dashboard, refactoring, dx]
    timestamps:
      conceived_at: "2025-12-16T00:00:00-08:00"
      specified_at: "2025-12-16T00:00:00-08:00"
      planned_at: "2025-12-16T00:00:00-08:00"
      implementing_at: "2025-12-16T00:00:00-08:00"
      implemented_at: "2025-12-16T00:00:00-08:00"
      committed_at: "2025-12-16T00:00:00-08:00"
      integrated_at: "2025-12-16T00:00:00-08:00"
    notes: "Split 4,738 line monolith into ~22 modular files. Architect estimate: 7 hours. Actual: ~14 minutes."
```

---

```yaml
  - id: "0083"
    title: "Protocol-Agnostic Spawn System"
    summary: "Refactor af spawn to decouple input types from protocols, add --use-protocol flag"
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0083-protocol-agnostic-spawn.md
      plan: codev/plans/0083-protocol-agnostic-spawn.md
      review: null
    dependencies: []
    tags: [agent-farm, spawn, refactoring, v2]
    timestamps:
      conceived_at: "2026-01-27T12:00:00-08:00"
      specified_at: "2026-01-27T12:00:00-08:00"
      planned_at: "2026-01-27T12:00:00-08:00"
      implementing_at: "2026-01-28T00:30:00-08:00"
      implemented_at: "2026-01-28T00:45:00-08:00"
      committed_at: "2026-01-28T01:05:00-08:00"
      integrated_at: "2026-02-01T00:00:00-08:00"
    notes: "PR #168 merged. Adds --use-protocol flag and data-driven hooks."

  - id: "0084"
    title: "Tower Mobile-Friendly UI"
    summary: "Ensure tower dashboard is fully mobile-friendly with touch targets, responsive layout, and QR code sharing"
    status: abandoned
    priority: medium
    release: v2.1.0
    files:
      spec: null
      plan: null
      review: null
    dependencies: ["0081"]
    tags: [tower, mobile, ui, v2]
    timestamps:
      conceived_at: "2026-01-28T10:00:00-08:00"
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: null
    notes: "Abandoned - merged into 0091 (Tower Mobile UX Refresh) which is now the canonical mobile UX project."

  - id: "0085"
    title: "Agent Farm Terminal & Dashboard Rewrite"
    summary: "Replace ttyd with node-pty terminal layer and modernize vanilla JS dashboard with React"
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0085-agent-farm-terminal-dashboard-rewrite.md
      plan: codev/plans/0085-agent-farm-terminal-dashboard-rewrite.md
      review: codev/reviews/0085-agent-farm-terminal-dashboard-rewrite.md
    dependencies: []
    tags: [architecture, agent-farm, terminal, dashboard, v2]
    timestamps:
      conceived_at: "2026-01-29T00:00:00-08:00"
      specified_at: "2026-01-29T00:00:00-08:00"
      planned_at: "2026-01-29T12:00:00-08:00"
      implementing_at: "2026-01-29T14:00:00-08:00"
      implemented_at: "2026-01-30T00:00:00-08:00"
      committed_at: "2026-01-30T12:00:00-08:00"
      integrated_at: "2026-02-01T00:00:00-08:00"
    notes: "PR #179 merged. node-pty replaces ttyd, React+Vite dashboard replaces vanilla JS. All terminals multiplexed on single port via WebSocket."

  - id: "0090"
    title: "Tower as Single Daemon Architecture"
    summary: "Refactor so tower is the single daemon managing all projects. af dash becomes API client, not separate server."
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0090-tower-single-daemon.md
      plan: codev/plans/0090-tower-single-daemon.md
      review: codev/reviews/0090-tower-single-daemon.md
    dependencies: ["0085"]
    tags: [architecture, tower, agent-farm, v2]
    timestamps:
      conceived_at: "2026-02-04T00:00:00-08:00"
      specified_at: "2026-02-04T12:00:00-08:00"
      planned_at: "2026-02-04T12:00:00-08:00"
      implementing_at: "2026-02-04T14:00:00-08:00"
      implemented_at: "2026-02-05T02:30:00-08:00"
      committed_at: "2026-02-05T02:30:00-08:00"
      integrated_at: "2026-02-07T00:00:00-08:00"
    notes: "Phase 4 complete. Tower is single daemon, dashboard-server.ts deleted. 641 tests pass. 3-way consultation: 2 APPROVE, 1 COMMENT."

  - id: "0094"
    title: "Tower Mobile Compaction"
    summary: "Compact the tower overview page for mobile: inline buttons, hide paths, remove Share button, reduce vertical spacing"
    status: integrated
    priority: high
    release: v2.1.0
    files:
      spec: codev/specs/0094-tower-mobile-compaction.md
      plan: null
      review: null
    dependencies: ["0090"]
    tags: [ui, ux, mobile, tower]
    timestamps:
      conceived_at: "2026-02-08T03:00:00-08:00"
      specified_at: "2026-02-08T03:00:00-08:00"
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2026-02-09"
    notes: "Based on real mobile screenshot showing excessive vertical spacing. Single file change (tower.html)."

  - id: "0095"
    title: "Porch as Planner (Task Integration)"
    summary: "Invert porch execution model: porch generates Claude Code tasks instead of spawning Claude. Claude Code becomes the executor, porch becomes a stateless planner called between task batches."
    status: integrated
    priority: high
    release: v2.1.0
    files:
      spec: codev/specs/0095-porch-as-planner.md
      plan: null
      review: null
    dependencies: ["0090"]
    tags: [porch, architecture, claude-code, tasks]
    timestamps:
      conceived_at: "2026-02-08T03:30:00-08:00"
      specified_at: "2026-02-08T03:30:00-08:00"
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2026-02-09"
    notes: "Architectural redesign. Porch currently spawns Claude via Agent SDK and manages build-verify loop. Proposal: porch emits task definitions, Claude Code executes. status.yaml remains for cross-session persistence."

  - id: "0097"
    title: "Cloud Tower Client (Tunnel & Registration)"
    summary: "Replace cloudflared with built-in tunnel client that connects to codevos.ai for remote tower access"
    status: conceived
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0097-cloud-tower-client.md
      plan: null
      review: null
    dependencies: ["0090"]
    tags: [tower, remote-access, cloud, tunnel]
    timestamps:
      conceived_at: "2026-02-10T00:00:00-08:00"
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: null
    notes: "Client-side companion to codevos.ai server spec 0001. Replaces cloudflared with native tunnel. Written by codevos.ai builder agent."
```

  - id: "0098"
    title: "Per-Project Port Registry Removal"
    summary: "Remove vestigial per-project port allocation system. Tower at 4100 is the only server; port blocks are dead code."
    status: integrated
    priority: medium
    release: v2.0.0
    files:
      spec: codev/specs/0098-port-registry-removal.md
      plan: codev/plans/0098-port-registry-removal.md
      review: codev/reviews/0098-port-registry-removal.md
    dependencies: ["0090"]
    tags: [architecture, cleanup, agent-farm]
    timestamps:
      conceived_at: "2026-02-11T00:00:00-08:00"
      specified_at: "2026-02-11T00:00:00-08:00"
      planned_at: "2026-02-12T00:00:00-08:00"
      implementing_at: "2026-02-12T00:00:00-08:00"
      implemented_at: "2026-02-12T00:00:00-08:00"
      committed_at: "2026-02-12T00:00:00-08:00"
      integrated_at: "2026-02-12T00:00:00-08:00"
    notes: "Removed 220 lines of dead port-registry code. Fixed broken consult routing. PR #211 merged."

  - id: "0099"
    title: "Tower Codebase Hygiene"
    summary: "Dead code removal, naming drift fixes, CLI consolidation onto TowerClient, state management fixes, error handling, dedup"
    status: integrated
    priority: medium
    release: v2.0.0
    files:
      spec: codev/specs/0099-tower-codebase-hygiene.md
      plan: codev/plans/0099-tower-codebase-hygiene.md
      review: codev/reviews/0099-tower-codebase-hygiene.md
    dependencies: ["0098"]
    tags: [architecture, cleanup, agent-farm, maintenance]
    timestamps:
      conceived_at: "2026-02-11T00:00:00-08:00"
      specified_at: "2026-02-11T00:00:00-08:00"
      planned_at: "2026-02-12T00:00:00-08:00"
      implementing_at: "2026-02-12T00:00:00-08:00"
      implemented_at: "2026-02-12T00:00:00-08:00"
      committed_at: "2026-02-12T00:00:00-08:00"
      integrated_at: "2026-02-12T00:00:00-08:00"
    notes: "Tower hygiene: dead code removal, TowerClient consolidation, file-tab persistence, path traversal fix. PR #212 merged."

## Next Available Number

**0100** - Reserve this number for your next project

---

## Quick Reference

### View by Status
To see all projects at a specific status, search for `status: <status>` in this file.

### View by Priority
To see high-priority work, search for `priority: high`.

### Check Dependencies
Before starting a project, verify its dependencies are at least `implemented`.

### Protocol Selection
- **SPIR**: Most projects (formal spec → plan → implement → review)
- **TICK**: Small, well-defined tasks (< 300 lines) or amendments to existing specs
- **EXPERIMENT**: Research/prototyping before committing to a project
