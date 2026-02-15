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

  - id: "0108"
    title: "Porch Gate Notifications via af send"
    summary: "Replace gate watcher polling with direct af send from porch when gates are hit"
    status: integrated
    priority: high
    release: "v2.0.3"
    files:
      spec: codev/specs/0108-porch-gate-notifications.md
      plan: codev/plans/0108-porch-gate-notifications.md
      review: codev/reviews/0108-porch-gate-notifications.md
    dependencies: []
    tags: [porch, notifications, af-send]
    timestamps:
      conceived_at: "2026-02-15"
      specified_at: "2026-02-15"
      implementing_at: "2026-02-15"
      integrated_at: "2026-02-15"
    notes: "PR #272 merged. Push-based af send from porch replaces broken poll-based gate watcher. Net -80 lines."

  - id: "0109"
    title: "Tunnel Keepalive (Heartbeat & Dead Connection Detection)"
    summary: "Add WebSocket ping/pong heartbeat to tunnel client to detect and recover from silent connection drops"
    status: integrated
    priority: high
    release: "v2.0.3"
    files:
      spec: codev/specs/0109-tunnel-keepalive.md
      plan: codev/plans/0109-tunnel-keepalive.md
      review: codev/reviews/0109-tunnel-keepalive.md
    dependencies: []
    tags: [tunnel, cloud, reliability]
    timestamps:
      conceived_at: "2026-02-15"
      specified_at: "2026-02-15"
      implementing_at: "2026-02-15"
      committed_at: "2026-02-15"
      integrated_at: "2026-02-15"
    notes: "PR #271 merged. 30s ping, 10s pong timeout. 10 new unit tests. Silent WebSocket death after sleep/wake now detected and auto-reconnected."

  - id: "0111"
    title: "Remove Dead Vanilla Dashboard Code"
    summary: "Delete templates/dashboard/ (16 dead files replaced by React dashboard in 0085)"
    status: integrated
    priority: medium
    release: "v2.0.3"
    files:
      spec: codev/specs/0111-remove-dead-vanilla-dashboard.md
      plan: codev/plans/0111-remove-dead-vanilla-dashboard.md
      review: codev/reviews/0111-remove-dead-vanilla-dashboard.md
    dependencies: []
    tags: [cleanup, dead-code, dashboard]
    timestamps:
      conceived_at: "2026-02-15"
      specified_at: "2026-02-15"
      implementing_at: "2026-02-15"
      integrated_at: "2026-02-15"
    notes: "PR #273 merged. -4614 lines of dead vanilla JS dashboard code removed."

  - id: "0112"
    title: "Workspace Rename (project → workspace for repos)"
    summary: "Rename all uses of 'project' meaning repository to 'workspace' across Tower, CLI, dashboard, and database"
    status: integrated
    priority: high
    release: "v2.0.3"
    files:
      spec: codev/specs/0112-workspace-rename.md
      plan: codev/plans/0112-workspace-rename.md
      review: codev/reviews/0112-workspace-rename.md
    dependencies: []
    tags: [naming, refactor, tower, dashboard]
    timestamps:
      conceived_at: "2026-02-15"
      specified_at: "2026-02-15"
      implementing_at: "2026-02-15"
      committed_at: "2026-02-15"
    notes: "PR #276 merged. +2360/-1826 across 100 files. DB migration v9 renames project_path → workspace_path."

  - id: "0110"
    title: "Messaging Infrastructure"
    summary: "Standardized agent naming, cross-project messaging, WebSocket message bus, POST /api/send endpoint"
    status: conceived
    priority: high
    release: null
    files:
      spec: codev/specs/0110-messaging-infrastructure.md
      plan: null
      review: null
    dependencies: ["0108", "0112"]
    tags: [messaging, af-send, dashboard, agents]
    timestamps:
      conceived_at: "2026-02-15"
      specified_at: "2026-02-15"
    notes: "Standardize agent names (builder-spir-0109), add project:agent addressing, WebSocket message bus for dashboard observability, POST /api/send endpoint. Depends on 0108."

  - id: "0113"
    title: "Shellper Debug Logging"
    summary: "Add lifecycle logging to shellper processes, capture stderr in Tower, surface exit codes/signals on session death"
    status: conceived
    priority: high
    release: null
    files:
      spec: codev/specs/0113-shellper-debug-logging.md
    dependencies: []
    tags: [shellper, logging, debugging, reliability]
    timestamps:
      conceived_at: "2026-02-15"
    notes: "Triggered by unexplained life architect shellper death on 2026-02-15. Currently zero diagnostic info when sessions die."

  - id: "0114"
    title: "Investigate Minimax for Code Reviews"
    summary: "Evaluate Minimax as a replacement for Claude in consult 3-way code reviews"
    status: conceived
    priority: medium
    release: null
    files:
      spec: null
    dependencies: []
    tags: [consult, code-review, models]
    timestamps:
      conceived_at: "2026-02-15"
    notes: "Investigate whether Minimax can replace Claude in the 3-way consultation pipeline for code reviews."

  - id: "0115"
    title: "Consultation Metrics & Cost Tracking"
    summary: "Add time/cost measurement to every consult invocation, store in SQLite for statistical analysis"
    status: conceived
    priority: high
    release: null
    files:
      spec: codev/specs/0115-consultation-metrics.md
    dependencies: []
    tags: [consult, metrics, cost, sqlite]
    timestamps:
      conceived_at: "2026-02-15"
    notes: "Track duration, cost, protocol context, review type for every consult call. SQLite storage for analytics queries."

# Low Priority

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
    notes: "ON HOLD: Benefits unclear - stateless consult already works well. May revisit if use case becomes clearer."
```

---

## Releases

```yaml
releases:
  - version: "v2.0.3"
    name: "Hagia Sophia"
    status: released
    target_date: "2026-02-15"
    notes: "Workspace rename (project→workspace), tunnel keepalive, gate notifications, dead code cleanup (-7500 lines), bugfixes #266/#269/#274/#277."

  - version: "v2.0.2"
    name: "Hagia Sophia"
    status: released
    target_date: "2026-02-14"
    notes: "Major platform rewrite. Three pillars: (1) node-pty terminal layer + Shellper session manager, (2) Cloud Tower with tunnel client and registration UI, (3) Deterministic SPIR enforcement via Porch. 30+ bug fixes."

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

### v2.0.2 Hagia Sophia (released 2026-02-14)

```yaml
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
      conceived_at: "2026-01-12"
      integrated_at: "2026-02-08"
    notes: "Meta-spec for Codev 2.0. Three pillars: (1) Terminal/Dashboard rewrite, (2) Cloud Tower with mobile PWA, (3) Deterministic SPIR enforcement. Supersedes 0066/0067."

  - id: "0069"
    title: "Checklister Agent Spike"
    summary: "Spike to build a checklister agent that enforces SPIR protocol compliance"
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0069-checklister-spike.md
    dependencies: []
    tags: [spike, workflow, protocol, v2]
    timestamps:
      conceived_at: "2026-01-16"
      integrated_at: "2026-01-20"
    notes: "Spike complete - superseded by Porch (0073) which implements state machine enforcement."

  - id: "0070"
    title: "CODEV_HQ Minimal Implementation Spike"
    summary: "Spike to validate CODEV_HQ architecture: WebSocket connection, status sync, remote approvals"
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0070-codev-hq-spike.md
    dependencies: ["0068"]
    tags: [spike, architecture, cloud, v2]
    timestamps:
      conceived_at: "2026-01-16"
      integrated_at: "2026-01-28"
    notes: "Spike complete - validated CODEV_HQ core concepts (WebSocket, status sync)."

  - id: "0072"
    title: "Ralph-SPIR Integration Spike"
    summary: "Spike to reimagine SPIR using Ralph principles: Builder owns entire lifecycle, human gates as backpressure"
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0072-ralph-spider-spike.md
    dependencies: ["0069", "0070"]
    tags: [spike, workflow, ralph, v2]
    timestamps:
      conceived_at: "2026-01-19"
      integrated_at: "2026-01-20"
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
      conceived_at: "2026-01-19"
      integrated_at: "2026-01-20"
    notes: "Builds on Ralph-SPIR spike (0072). Three-level architecture: protocols → porch → af. 8 rounds of 3-way review before merge."

  - id: "0075"
    title: "Porch Minimal Redesign"
    summary: "Redesign porch from 4800 lines to ~500 lines. Claude calls porch as a tool instead of porch spawning Claude."
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0075-porch-minimal-redesign.md
      plan: codev/plans/0075-porch-minimal-redesign.md
    dependencies: ["0073"]
    tags: [porch, workflow, v2]
    timestamps:
      conceived_at: "2026-01-21"
      integrated_at: "2026-02-01"
    notes: "Porch redesigned to 845 lines (79% reduction). All 68 unit tests pass. Claude→Porch→Claude architecture."

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
      conceived_at: "2026-01-25"
      integrated_at: "2026-02-01"
    notes: "E2E test infrastructure for porch. 3-way review identified and fixed AWAITING_INPUT gap and git add policy violation."

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
      conceived_at: "2026-01-27"
      integrated_at: "2026-02-01"
    notes: "PR #169 merged. Reverse proxy, auth, tunnel docs, push notifications, mobile polish."

  - id: "0083"
    title: "Protocol-Agnostic Spawn System"
    summary: "Refactor af spawn to decouple input types from protocols, add --use-protocol flag"
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0083-protocol-agnostic-spawn.md
      plan: codev/plans/0083-protocol-agnostic-spawn.md
    dependencies: []
    tags: [agent-farm, spawn, refactoring, v2]
    timestamps:
      conceived_at: "2026-01-27"
      integrated_at: "2026-02-01"
    notes: "PR #168 merged. Adds --use-protocol flag and data-driven hooks."

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
      conceived_at: "2026-01-29"
      integrated_at: "2026-02-01"
    notes: "PR #179 merged. node-pty replaces ttyd, React+Vite dashboard replaces vanilla JS. All terminals multiplexed on single port via WebSocket."

  - id: "0087"
    title: "Porch Timeout Termination Retries"
    summary: "Add timeout logic to porch so that when Claude hangs or fails to respond, porch can terminate and retry the operation"
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0087-porch-timeout-termination-retries.md
    dependencies: ["0073", "0075"]
    tags: [porch, reliability, timeout, retry]
    timestamps:
      conceived_at: "2026-01-31"
      integrated_at: "2026-02-13"
    notes: "Porch timeout detection, graceful termination, and automatic retry with context preservation."

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
      conceived_at: "2026-02-04"
      integrated_at: "2026-02-07"
    notes: "Phase 4 complete. Tower is single daemon, dashboard-server.ts deleted. 641 tests pass. 3-way consultation: 2 APPROVE, 1 COMMENT."

  - id: "0092"
    title: "Terminal File Links and File Browser"
    summary: "Clickable file paths via @xterm/addon-web-links + FileTree enhancement with git status"
    status: integrated
    priority: medium
    release: v2.0.0
    files:
      spec: codev/specs/0092-terminal-file-links.md
      plan: codev/plans/0092-terminal-file-links.md
      review: codev/reviews/0092-terminal-file-links.md
    dependencies: ["0090", "0085"]
    tags: [ui, ux, terminal, dashboard]
    timestamps:
      conceived_at: "2026-02-05"
      integrated_at: "2026-02-06"
    notes: "PR #189 merged. Make file paths in terminal clickable, add file browser panel."

  - id: "0093"
    title: "SPIDER to SPIR Rename"
    summary: "Complete the rename of SPIDER protocol to SPIR across entire codebase"
    status: integrated
    priority: medium
    release: v2.0.0
    files:
      spec: codev/specs/0093-spider-to-spir-rename.md
    dependencies: []
    tags: [refactor, documentation, protocols]
    timestamps:
      conceived_at: "2026-02-06"
      integrated_at: "2026-02-07"
    notes: "Rename SPIDER → SPIR (Specify, Plan, Implement, Review). ~250 files affected. Commit 4330cc8."

  - id: "0094"
    title: "Tower Mobile Compaction"
    summary: "Compact the tower overview page for mobile: inline buttons, hide paths, remove Share button, reduce vertical spacing"
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0094-tower-mobile-compaction.md
    dependencies: ["0090"]
    tags: [ui, ux, mobile, tower]
    timestamps:
      conceived_at: "2026-02-08"
      integrated_at: "2026-02-09"
    notes: "Based on real mobile screenshot showing excessive vertical spacing. Single file change (tower.html)."

  - id: "0095"
    title: "Porch as Planner (Task Integration)"
    summary: "Invert porch execution model: porch generates Claude Code tasks instead of spawning Claude. Claude Code becomes the executor, porch becomes a stateless planner."
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0095-porch-as-planner.md
    dependencies: ["0090"]
    tags: [porch, architecture, claude-code, tasks]
    timestamps:
      conceived_at: "2026-02-08"
      integrated_at: "2026-02-09"
    notes: "Porch emits task definitions, Claude Code executes. status.yaml remains for cross-session persistence."

  - id: "0097"
    title: "Cloud Tower Client (Tunnel & Registration)"
    summary: "Replace cloudflared with built-in tunnel client that connects to codevos.ai for remote tower access"
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0097-cloud-tower-client.md
      review: codev/reviews/0097-cloud-tower-client.md
    dependencies: ["0090"]
    tags: [tower, remote-access, cloud, tunnel]
    timestamps:
      conceived_at: "2026-02-10"
      integrated_at: "2026-02-13"
    notes: "WebSocket tunnel replaces cloudflared. 109 tests. PR #210 merged."

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
      conceived_at: "2026-02-11"
      integrated_at: "2026-02-12"
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
      conceived_at: "2026-02-11"
      integrated_at: "2026-02-12"
    notes: "Tower hygiene: dead code removal, TowerClient consolidation, file-tab persistence, path traversal fix. PR #212 merged."

  - id: "0100"
    title: "Porch Gate Notifications"
    summary: "Tower dashboard shows pending gates, sends af-send message to architect when builder is blocked, auto-clears on unblock"
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0100-porch-gate-notifications.md
    dependencies: ["0090"]
    tags: [tower, dashboard, porch, notifications, agent-farm]
    timestamps:
      conceived_at: "2026-02-12"
      integrated_at: "2026-02-13"
    notes: "PR merged. Gate notifications in Tower dashboard with af-send messages."

  - id: "0101"
    title: "Clickable File Paths in Terminal"
    summary: "File paths displayed in xterm.js terminals become clickable links that invoke af open, with dotted underline visual indicator"
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0101-clickable-file-paths.md
    dependencies: ["0090"]
    tags: [tower, dashboard, terminal, xterm, ux]
    timestamps:
      conceived_at: "2026-02-12"
      integrated_at: "2026-02-13"
    notes: "PR merged. Cmd+Click file paths in terminal opens them via af open. FilePathLinkProvider + FilePathDecorationManager."

  - id: "0104"
    title: "Custom Terminal Session Manager"
    summary: "Replace tmux with a purpose-built shepherd process for session persistence, eliminating alternate-screen conflicts and global state mutation"
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0104-custom-session-manager.md
    dependencies: ["0090"]
    tags: [terminal, architecture, tower, persistence]
    timestamps:
      conceived_at: "2026-02-14"
      integrated_at: "2026-02-14"
    notes: "Replace tmux with lightweight shepherd daemon (later renamed to Shellper in 0106)."

  - id: "0105"
    title: "Tower Server Decomposition"
    summary: "Decompose tower-server.ts (3,400 lines) into focused modules — pure refactoring, no behavior changes"
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0105-tower-server-decomposition.md
      plan: codev/plans/0105-tower-server-decomposition.md
      review: codev/reviews/0105-tower-server-decomposition.md
    dependencies: ["0104"]
    tags: [architecture, refactoring, tower, maintenance]
    timestamps:
      conceived_at: "2026-02-14"
      integrated_at: "2026-02-14"
    notes: "tower-server.ts decomposed from 3,439 lines into ~7 focused modules."

  - id: "0106"
    title: "Rename Shepherd to Shellper"
    summary: "Rename all Shepherd references to Shellper (shell + helper) — pure rename refactoring"
    status: integrated
    priority: medium
    release: v2.0.0
    files:
      spec: codev/specs/0106-rename-shepherd-to-shellper.md
      plan: codev/plans/0106-rename-shepherd-to-shellper.md
      review: codev/reviews/0106-rename-shepherd-to-shellper.md
    dependencies: ["0104"]
    tags: [refactoring, naming, terminal, maintenance]
    timestamps:
      conceived_at: "2026-02-14"
      integrated_at: "2026-02-14"
    notes: "Pure rename: Shepherd → Shellper. File renames, class renames, SQLite migration v8 for column renames, socket path prefix change."

  - id: "0107"
    title: "Tower Cloud Registration UI"
    summary: "Add register/deregister UI to the Tower homepage, cloning the af tower register/deregister CLI commands"
    status: integrated
    priority: high
    release: v2.0.0
    files:
      spec: codev/specs/0107-tower-cloud-registration-ui.md
      plan: codev/plans/0107-tower-cloud-registration-ui.md
      review: codev/reviews/0107-tower-cloud-registration-ui.md
    dependencies: []
    tags: [tower, cloud, ui]
    timestamps:
      conceived_at: "2026-02-14"
      integrated_at: "2026-02-14"
    notes: "Mirror af tower register/deregister in the Tower web UI. OAuth flow, tower naming, deregister button. PR #265 merged."
```

### v1.6.0 Gothic (released 2026-01-12)

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
    dependencies: []
    tags: [protocol, cli, agent-farm]
    timestamps:
      conceived_at: "2026-01-03"
      integrated_at: "2026-01-04"
    notes: "BUGFIX protocol for GitHub issues + af spawn --issue CLI support. CMAP reviewed: 2 APPROVE, 1 COMMENT."
```

### v1.5.8 Florence (released 2025-12-28)

```yaml
  - id: "0061"
    title: "3D Model Viewer (STL + 3MF)"
    summary: "Add 3D model viewing to dashboard for STL and 3MF files with multi-color support"
    status: integrated
    priority: medium
    release: v1.5.8
    files:
      spec: codev/specs/0061-stl-viewer.md
      plan: codev/plans/0061-stl-viewer.md
      review: codev/reviews/0061-stl-viewer-tick-002.md
    dependencies: []
    tags: [dashboard, ui, 3d, cad]
    timestamps:
      conceived_at: "2025-12-25"
      integrated_at: "2025-12-28"
    notes: "Three.js 3D viewer (STL + 3MF). TICK-001: quaternion trackball. TICK-002: 3MF multi-color support. Released in v1.5.2 Florence."

  - id: "0062"
    title: "Secure Remote Access"
    summary: "SSH tunnel + reverse proxy: af start --remote for one-command remote access"
    status: integrated
    priority: high
    release: v1.5.8
    files:
      spec: codev/specs/0062-secure-remote-access.md
      plan: codev/plans/0062-secure-remote-access.md
      review: codev/reviews/0062-secure-remote-access.md
    dependencies: []
    tags: [security, remote-access, ssh, agent-farm]
    timestamps:
      conceived_at: "2025-12-27"
      integrated_at: "2025-12-28"
    notes: "Reverse proxy consolidates ttyd instances behind one port. af start --remote for one-command remote access."
```

### v0.2.0 Foundation (released)

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
      integrated_at: "2025-12-03"
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
    dependencies: []
    tags: [architecture, agents]
    timestamps:
      integrated_at: "2025-12-03"
    notes: "Bash CLI implemented, superseded by 0005 TypeScript CLI."

  - id: "0004"
    title: "Dashboard Nav UI"
    summary: "Enhanced navigation and UX for the agent-farm dashboard"
    status: integrated
    priority: medium
    release: "v0.2.0"
    files:
      spec: codev/specs/0004-dashboard-nav-ui.md
      plan: codev/plans/0004-dashboard-nav-ui.md
    dependencies: ["0005"]
    tags: [ui, dashboard]
    timestamps:
      integrated_at: "2025-12-03"
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
      integrated_at: "2025-12-03"
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
    dependencies: ["0005"]
    tags: [ui, dashboard]
    timestamps:
      integrated_at: "2025-12-03"
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
      integrated_at: "2025-12-03"
    notes: "Single TypeScript CLI, config.json, global port registry with file locking"

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
      integrated_at: "2025-12-03"
    notes: "Uses ttyd's native http link handling."

  - id: "0016"
    title: "Clarify Builder Role Definition"
    summary: "Resolved: Kept 'Builder' name but clarified it encompasses remodel, repair, maintain"
    status: integrated
    priority: medium
    release: "v0.2.0"
    dependencies: []
    tags: [documentation, naming]
    timestamps:
      integrated_at: "2025-12-03"
    notes: "Decided to keep 'Builder' after consulting Pro and Codex."

  - id: "0018"
    title: "Annotation Server Reliability"
    summary: "Fix template path and stale process detection in annotation server"
    status: integrated
    priority: medium
    release: "v0.2.0"
    dependencies: ["0008"]
    tags: [bugfix, dashboard]
    timestamps:
      integrated_at: "2025-12-03"
    notes: "Fixed template path and stale process detection."
```

---

## Integrated (Unassigned)

Completed projects not associated with any formal release.

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
      integrated_at: "2025-12-16"
    notes: "Split 4,738 line monolith into ~22 modular files."

  - id: "0102"
    title: "Porch CWD / Worktree Awareness"
    summary: "Auto-detect project/bug ID from CWD when running inside a builder worktree"
    status: integrated
    priority: medium
    release: null
    files:
      spec: codev/specs/0102-porch-cwd-worktree-awareness.md
    dependencies: []
    tags: [porch, ux, cli]
    timestamps:
      conceived_at: "2026-02-12"
      integrated_at: "2026-02-13"
    notes: "PR #230 merged. detectProjectIdFromCwd() + resolveProjectId() with priority chain. 18 tests."

  - id: "0103"
    title: "Consult Claude via Agent SDK"
    summary: "Replace CLI subprocess delegation for Claude with Agent SDK, enabling tool-using reviews"
    status: integrated
    priority: high
    release: null
    files:
      spec: codev/specs/0103-consult-claude-agent-sdk.md
    dependencies: []
    tags: [consult, claude, sdk, agent-sdk]
    timestamps:
      conceived_at: "2026-02-13"
      integrated_at: "2026-02-13"
    notes: "PR #231 merged. Agent SDK replaces CLI subprocess for Claude consultation. 7 tests."
```

---

## Terminal Projects

Projects that have been abandoned or put on hold.

```yaml
  - id: "0023"
    title: "Consult Tool (Stateful)"
    summary: "Add stateful session support to consult tool"
    status: on_hold
    priority: low
    notes: "ON HOLD: Benefits unclear - stateless consult already works well."

  - id: "0063"
    title: "Tower Dashboard Improvements"
    summary: "Better project management UI with tools for starting local/remote services"
    status: abandoned
    priority: high
    release: v1.6.0
    files:
      spec: codev/specs/0063-tower-dashboard-improvements.md
    tags: [tower, ui, dashboard]
    timestamps:
      conceived_at: "2025-12-28"
    notes: "Abandoned - superseded by React dashboard rewrite (0085), Tower single daemon (0090), and terminal file links (0092)."

  - id: "0064"
    title: "Dashboard Tab State Preservation"
    summary: "Cache iframes instead of recreating them to preserve scroll position and edit mode"
    status: abandoned
    files:
      spec: codev/specs/0064-dashboard-tab-state-preservation.md
    tags: [dashboard, ui, dx]
    timestamps:
      conceived_at: "2025-12-29"
    notes: "Abandoned - iframe architecture replaced by React dashboard (0085). React manages component state natively."

  - id: "0066"
    title: "VSCode Companion Extension"
    summary: "Thin VSCode extension providing IDE integration with Agent Farm backend"
    status: abandoned
    files:
      spec: codev/specs/0066-vscode-companion-extension.md
    tags: [vscode, extension, ui, dx]
    timestamps:
      conceived_at: "2026-01-12"
    notes: "Abandoned - superseded by 0068 Cloud Tower approach."

  - id: "0067"
    title: "Agent Farm Architecture Rewrite"
    summary: "Replace ttyd/tmux with node-pty, modernize dashboard with React/Svelte"
    status: abandoned
    files:
      spec: codev/specs/0067-agent-farm-architecture-rewrite.md
    tags: [architecture, agent-farm, terminal, dashboard]
    timestamps:
      conceived_at: "2026-01-12"
    notes: "Abandoned - superseded by 0085 (Agent Farm Terminal & Dashboard Rewrite)."

  - id: "0076"
    title: "Skip close confirmation for terminated shells"
    summary: "Fix incomplete Bugfix #132 - detect terminated shells correctly"
    status: abandoned
    files:
      spec: codev/specs/0076-skip-close-confirmation-terminated-shells.md
      plan: codev/plans/0076-skip-close-confirmation-terminated-shells.md
    tags: [ux, agent-farm, bugfix]
    timestamps:
      conceived_at: "2026-01-24"
    notes: "Obsolete - terminal lifecycle completely replaced by Tower Single Daemon (Spec 0090)"

  - id: "0084"
    title: "Tower Mobile-Friendly UI"
    summary: "Ensure tower dashboard is fully mobile-friendly"
    status: abandoned
    tags: [tower, mobile, ui, v2]
    timestamps:
      conceived_at: "2026-01-28"
    notes: "Abandoned - merged into 0091 which was then also abandoned."

  - id: "0091"
    title: "Tower Mobile UX Refresh"
    summary: "Full mobile UX for tower: responsive layout, touch targets, QR code sharing"
    status: abandoned
    tags: [ui, ux, mobile, tower, v2]
    timestamps:
      conceived_at: "2026-02-05"
    notes: "Abandoned. Audit showed mobile UX is already in good shape. No significant work needed."
```

---

## Next Available Number

**0112** - Reserve this number for your next project

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
