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

  - id: "0063"
    title: "Tower Dashboard Improvements"
    summary: "Better project management UI with tools for starting local/remote services"
    status: conceived
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
    notes: "Single row per dashboard, action buttons for local/remote start, init/adopt/update commands with terminal output."





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
    status: conceived
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
    notes: "Annotation tabs lose state when switching tabs. Need iframe caching with LRU eviction."

  - id: "0065"
    title: "BUGFIX Protocol and CLI Support"
    summary: "Lightweight protocol for minor bugfixes with af spawn --issue support"
    status: planned
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
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: null
    notes: "BUGFIX protocol for GitHub issues + af spawn --issue CLI support"









```

---

## Releases

```yaml
releases:
  - version: "v1.6.0"
    name: "TBD"
    status: planning
    target_date: null
    notes: "Next release - Tower Dashboard improvements"

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
    notes: "Bash CLI implemented, superseded by 0005 TypeScript CLI"

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

## Next Available Number

**0066** - Reserve this number for your next project

---

## Quick Reference

### View by Status
To see all projects at a specific status, search for `status: <status>` in this file.

### View by Priority
To see high-priority work, search for `priority: high`.

### Check Dependencies
Before starting a project, verify its dependencies are at least `implemented`.

### Protocol Selection
- **SPIDER**: Most projects (formal spec → plan → implement → review)
- **TICK**: Small, well-defined tasks (< 300 lines) or amendments to existing specs
- **EXPERIMENT**: Research/prototyping before committing to a project
