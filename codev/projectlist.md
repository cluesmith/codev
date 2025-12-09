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
  - id: "0039"
    title: "Codev CLI (First-Class Command)"
    summary: "Unified codev command as primary entry point: init, adopt, doctor, update, tower, consult"
    status: committed
    priority: high
    release: null
    files:
      spec: codev/specs/0039-codev-cli.md
      plan: codev/plans/0039-codev-cli.md
      review: null
    dependencies: ["0005", "0022"]
    tags: [cli, npm, architecture]
    notes: "PR #84 merged 2025-12-09. TICK-001 (consult TS consolidation) + TICK-002 (embedded skeleton)."

  - id: "0040"
    title: "TICK as SPIDER Amendment"
    summary: "Rework TICK to be amendments to existing SPIDER specs/plans rather than a separate protocol"
    status: integrated
    priority: high
    release: null
    files:
      spec: codev/specs/0040-tick-as-spider-amendment.md
      plan: null
      review: null
    dependencies: []
    tags: [protocols, architecture]
    notes: "Human approved 2025-12-08. Implemented 2025-12-08. Updated templates (spec.md, plan.md), rewrote TICK protocol, updated CLAUDE.md/AGENTS.md. Tested with TICK 0022-001."

  - id: "0014"
    title: "Flexible Builder Spawning"
    summary: "Generalize spawn command to accept natural language instructions, not just project specs"
    status: integrated
    priority: high
    release: "v1.0.0"
    files:
      spec: codev/specs/0014-flexible-builder-spawning.md
      plan: codev/plans/0014-flexible-builder-spawning.md
      review: null
    dependencies: ["0005"]
    tags: [cli, agents, architecture]
    notes: "Five modes: spec, task, protocol, shell, worktree. 3-way reviewed, merged PR 35, 37 unit tests added."

  - id: "0020"
    title: "Send Instructions to Builder"
    summary: "Allow architect to send follow-up instructions to running builders via agent-farm CLI or dashboard"
    status: integrated
    priority: high
    release: "v1.0.0"
    files:
      spec: codev/specs/0020-send-instructions-to-builder.md
      plan: codev/plans/0020-send-instructions-to-builder.md
      review: null
    dependencies: ["0005"]
    tags: [cli, agents, communication]
    notes: "Merged PR 31. Uses tmux load-buffer + paste-buffer. Structured message format. Consulted GPT-5 and Gemini Pro."


  - id: "0022"
    title: "Consult Tool (Stateless)"
    summary: "Replace zen MCP server with a native stateless consult tool wrapping gemini-cli and codex CLI"
    status: integrated
    priority: high
    release: "v1.0.0"
    files:
      spec: codev/specs/0022-consult-tool-stateless.md
      plan: codev/plans/0022-consult-tool-stateless.md
      review: null
    ticks: [001]
    dependencies: []
    tags: [architecture, agents, consultation]
    notes: "Merged PR 30. Python/Typer CLI at codev/bin/consult. Consultant role as collaborative partner. Consulted GPT-5 and Gemini Pro. TICK-001: Architect-mediated PR reviews (2025-12-08)."

  - id: "0024"
    title: "Builder Event Notifications"
    summary: "Notify builders via tmux send-keys when events occur (PR review completed, file changes, etc.)"
    status: specified
    priority: high
    release: null
    files:
      spec: codev/specs/0024-builder-event-notifications.md
      plan: null
      review: null
    dependencies: ["0005"]
    tags: [cli, agents, communication]
    notes: "Use tmux send-keys to notify builders of events. Example: architect completes PR review → builder gets notified. Complements 0020 (instructions) with event-driven notifications."

# Medium Priority
  - id: "0010"
    title: "Annotation Editor"
    summary: "Add Edit/Annotate mode toggle to annotation viewer for inline file editing"
    status: integrated
    priority: medium
    release: "v1.0.0"
    files:
      spec: codev/specs/0010-annotation-editor.md
      plan: codev/plans/0010-annotation-editor.md
      review: null
    dependencies: ["0007"]
    tags: [ui, dashboard, editing]
    notes: "TICK protocol. PR 34 merged 2025-12-04. Edit mode with auto-save, Cancel restores disk state. UX polish: contextual subtitles, clearer button labels. Consulted GPT-5 and Gemini Pro."

  - id: "0011"
    title: "Multi-Instance Support"
    summary: "Directory-aware titles in dashboard for distinguishing multiple agent-farm instances"
    status: integrated
    priority: medium
    release: "v1.0.0"
    files:
      spec: codev/specs/0011-multi-instance-support.md
      plan: codev/plans/0011-multi-instance-support.md
      review: null
    dependencies: ["0007"]
    tags: [ui, dashboard, multi-project]
    notes: "TICK protocol. PROJECT_NAME placeholder in templates. Meta-dashboard split to 0029."

  - id: "0013"
    title: "Document OS Dependencies"
    summary: "Clarify and document all operating system dependencies required to run agent-farm"
    status: integrated
    priority: medium
    release: "v1.0.0"
    files:
      spec: codev/specs/0013-document-os-dependencies.md
      plan: codev/plans/0013-document-os-dependencies.md
      review: null
    dependencies: []
    tags: [documentation, installation]
    notes: "TICK protocol. codev-doctor (bash) + deps.ts (TypeScript). PR 32 merged 2025-12-04. Consulted GPT-5 and Gemini Pro."

  - id: "0015"
    title: "Cleanup Protocol"
    summary: "Multi-phase protocol for systematic codebase cleanup: Audit → Prune → Validate → Sync"
    status: integrated
    priority: medium
    release: "v1.0.0"
    files:
      spec: codev/specs/0015-cleanup-protocol.md
      plan: codev/plans/0015-cleanup-protocol.md
      review: null
    dependencies: []
    tags: [protocols, maintenance]
    notes: "TICK protocol. Four phases: AUDIT→PRUNE→VALIDATE→SYNC. PR 33 merged 2025-12-04. **Will be renamed to MAINTAIN and expanded per spec 0035.**"

  - id: "0019"
    title: "Tab Bar Status Indicators"
    summary: "Show builder status (working/idle/error) in dashboard tab bar for at-a-glance monitoring"
    status: integrated
    priority: medium
    release: "v1.0.0"
    files:
      spec: codev/specs/0019-tab-bar-status-indicators.md
      plan: null
      review: null
    dependencies: ["0007"]
    tags: [ui, dashboard]
    notes: "TICK protocol. Color dots with accessibility (shapes/tooltips for colorblind). Consulted GPT-5 and Gemini Pro."

  - id: "0023"
    title: "Consult Tool (Stateful)"
    summary: "Add stateful session support to consult tool via stdio communication with persistent CLI processes"
    status: conceived
    priority: medium
    release: null
    files:
      spec: null
      plan: null
      review: null
    dependencies: ["0022"]
    tags: [architecture, agents, consultation]
    notes: "Phase 2: Stateful. Keep CLI running via stdio. Maintain session until closed. Depends on 0022."

  - id: "0035"
    title: "MAINTAIN Protocol"
    summary: "Rename CLEANUP to MAINTAIN, expand scope to include documentation maintenance (arch.md, lessons-learned.md, CLAUDE.md/AGENTS.md sync)"
    status: specified
    priority: medium
    release: null
    files:
      spec: codev/specs/0035-maintain-protocol.md
      plan: null
      review: null
    dependencies: ["0015"]
    tags: [protocols, maintenance, documentation]
    notes: "Supersedes CLEANUP (0015). Adds doc maintenance to code hygiene. Consulted Gemini/Codex. No new roles - MAINTAIN executed by Builder like any protocol."

  - id: "0037"
    title: "Tab Bar UX Improvements"
    summary: "Improve tab bar active state visibility, close button contrast, and add overflow indicator"
    status: integrated
    priority: medium
    release: null
    files:
      spec: codev/specs/0037-tab-bar-ux.md
      plan: null
      review: codev/reviews/0037-tab-bar-ux.md
    dependencies: ["0007"]
    tags: [ui, dashboard, ux]
    notes: "TICK protocol. PR 58 merged 2025-12-07. Close button improved 2025-12-07."

# Low Priority
  - id: "0036"
    title: "Tab Bar Actions & Tooltips"
    summary: "Add open-in-new-tab, reload, hover tooltips; remove unused Refresh/Stop All buttons"
    status: integrated
    priority: low
    release: null
    files:
      spec: codev/specs/0036-af-open-in-tab.md
      plan: codev/plans/0036-af-open-in-tab.md
      review: null
    dependencies: ["0007", "0037"]
    tags: [ui, dashboard, cleanup]
    notes: "TICK protocol. Addressed 3-way review feedback: use tab.port, implemented /file endpoint for reload, added keyboard a11y."

  - id: "0006"
    title: "Tutorial Mode"
    summary: "Interactive onboarding for new Codev users"
    status: integrated
    priority: low
    release: "v1.0.0"
    files:
      spec: codev/specs/0006-tutorial-mode.md
      plan: codev/plans/0006-tutorial-mode.md
      review: codev/reviews/0006-tutorial-mode.md
    dependencies: []
    tags: [documentation, onboarding]
    notes: "PR #36 merged 2025-12-05"

  - id: "0012"
    title: "Hide tmux Status Bar"
    summary: "Cleaner dashboard UI by removing the tmux status bar from embedded terminals"
    status: specified
    priority: low
    release: null
    files:
      spec: codev/specs/0012-hide-tmux-status-bar.md
      plan: null
      review: null
    dependencies: []
    tags: [ui, dashboard]
    notes: "TICK protocol. tmux set-option status off. Add toggle for debugging. Consulted GPT-5 and Gemini Pro."

  - id: "0017"
    title: "Platform Portability Layer"
    summary: "Implement transpilation from .codev/ source to platform-specific configs (CLAUDE.md, GEMINI.md, AGENTS.md)"
    status: specified
    priority: low
    release: null
    files:
      spec: codev/specs/0017-platform-portability-layer.md
      plan: null
      review: null
    dependencies: []
    tags: [architecture, portability]
    notes: "SPIDER protocol. HIGH COMPLEXITY WARNING: May be premature (YAGNI). One-way transpilation. Consulted GPT-5 and Gemini Pro."

  - id: "0029"
    title: "Overview Dashboard"
    summary: "Centralized dashboard showing all running agent-farm instances with launch capability"
    status: integrated
    priority: medium
    release: "v1.1.0"
    files:
      spec: codev/specs/0029-overview-dashboard.md
      plan: codev/plans/0029-overview-dashboard.md
      review: null
    dependencies: ["0008", "0011"]
    tags: [ui, dashboard, multi-project]
    notes: "TICK protocol. af tower command. PR 41 merged 2025-12-05."

  - id: "0030"
    title: "Markdown Syntax Highlighting in Annotator"
    summary: "Enable syntax highlighting for markdown files in the annotation viewer"
    status: integrated
    priority: low
    release: "v1.1.0"
    files:
      spec: codev/specs/0030-markdown-syntax-highlighting.md
      plan: null
      review: null
    dependencies: ["0010"]
    tags: [ui, annotation, markdown]
    notes: "Hybrid approach: syntax visible but muted, content styled. Prism broke lines; custom renderer works. PR 49 merged 2025-12-06."

  - id: "0031"
    title: "SQLite for Runtime State"
    summary: "Replace JSON files with SQLite for atomic, concurrent-safe runtime state management"
    status: integrated
    priority: high
    release: "v1.1.0"
    files:
      spec: codev/specs/0031-sqlite-runtime-state.md
      plan: codev/plans/0031-sqlite-runtime-state.md
      review: null
    dependencies: []
    tags: [infrastructure, database, concurrency]
    notes: "SPIDER protocol. Fixes race conditions in state.json and ports.json. Uses better-sqlite3 with WAL mode. 3-way reviewed. Merged 2025-12-05."

  - id: "0032"
    title: "Consolidate Templates"
    summary: "Move dashboard and annotate templates from codev/ to agent-farm/templates/"
    status: integrated
    priority: medium
    release: "v1.1.0"
    files:
      spec: codev/specs/0032-consolidate-templates.md
      plan: codev/plans/0032-consolidate-templates.md
      review: null
    dependencies: []
    tags: [infrastructure, cleanup, agent-farm]
    notes: "TICK protocol. PR 46 merged 2025-12-06."

  - id: "0033"
    title: "Rename Command"
    summary: "Add af rename command to rename builders and utility terminals"
    status: integrated
    priority: low
    release: "v1.1.0"
    files:
      spec: null
      plan: null
      review: null
    dependencies: ["0031"]
    tags: [cli, agent-farm]
    notes: "Simple feature. Uses SQLite atomic UPDATE. Added getUtil(), renameBuilder(), renameUtil() to state.ts."

  - id: "0034"
    title: "Table Alignment in Markdown Annotator"
    summary: "Auto-pad markdown table cells so pipes align vertically across rows"
    status: integrated
    priority: low
    release: "v1.1.0"
    files:
      spec: codev/specs/0034-table-alignment.md
      plan: codev/plans/0034-table-alignment.md
      review: codev/reviews/0034-table-alignment.md
    dependencies: ["0030"]
    tags: [ui, annotation, markdown]
    notes: "Two-pass rendering with code block awareness. Preserves alignment markers (:---:). Consulted Gemini/Codex. PR 51 merged 2025-12-06."
```

---

## Releases

```yaml
releases:
  - version: "v1.1.0"
    name: null
    status: planning
    target_date: null
    notes: "Polish and improvements"

  - version: "v1.0.0"
    name: "Architect"
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
    notes: "Fixed: (1) Template path now looks in codev/templates/ instead of deleted agent-farm/templates/, (2) Dashboard API now verifies annotation processes are alive before returning 'existing' entries, cleans up stale state automatically."
```

---

## Integrated (Unassigned)

Completed projects not associated with any formal release (ad-hoc fixes, documentation, improvements).

```yaml
# (none currently)
```

---

## Terminal Projects

Projects that are paused or canceled.

```yaml
  - id: "0003"
    title: "End of Day Reporter"
    summary: "Automated summary of development activity for daily standups"
    status: on-hold
    priority: low
    release: null
    files:
      spec: codev/specs/0003-end-of-day-reporter.md
      plan: null
      review: null
    dependencies: []
    tags: [automation, reporting]
    notes: "Paused per project owner"

  - id: "0027"
    title: "Architecture Documenter as Protocol"
    summary: "Evaluate whether architecture-documenter should be a protocol rather than a subagent"
    status: abandoned
    priority: low
    release: null
    files:
      spec: null
      plan: null
      review: null
    dependencies: []
    tags: [architecture, protocols, agents]
    notes: "Superseded by 0028, which was then superseded by 0035 (MAINTAIN protocol)."

  - id: "0021"
    title: "Multi-CLI Builder Support"
    summary: "Support spawning builders with Gemini CLI or Codex CLI in addition to Claude Code"
    status: on-hold
    priority: high
    release: null
    files:
      spec: codev/specs/0021-multi-cli-builder-support.md
      plan: null
      review: null
    dependencies: ["0005"]
    tags: [cli, agents, portability]
    notes: "CLI Adapter pattern. On hold - other CLIs lack agentic capabilities needed for builder role."

  - id: "0028"
    title: "Librarian Role"
    summary: "Replace architecture-documenter agent with a broader Librarian role that owns all documentation stewardship"
    status: abandoned
    priority: medium
    release: null
    files:
      spec: codev/specs/0028-librarian-role.md
      plan: null
      review: null
    dependencies: []
    tags: [roles, documentation, architecture]
    notes: "After consulting Gemini/Codex, decided against new roles. Documentation maintenance absorbed into MAINTAIN protocol (spec 0035)."

  - id: "0025"
    title: "Docker Container"
    summary: "Provide Docker image with all codev dependencies pre-installed for easy onboarding"
    status: abandoned
    priority: low
    release: null
    files:
      spec: null
      plan: null
      review: null
    dependencies: []
    tags: [infrastructure, onboarding]
    notes: "Abandoned 2025-12-08. Low value - npm install is simple enough."

  - id: "0026"
    title: "Annotation Viewer Improvements"
    summary: "UX improvements to annotation viewer: wider text boxes, triple-return to save"
    status: abandoned
    priority: low
    release: null
    files:
      spec: null
      plan: null
      review: null
    dependencies: []
    tags: [ui, dashboard]
    notes: "Abandoned 2025-12-08. Current UX is sufficient."
```

---

  - id: "0038"
    title: "Consult PR Mode"
    summary: "Add pr subcommand to consult tool for optimized PR reviews with pre-fetched data and verdict extraction"
    status: integrated
    priority: medium
    release: null
    files:
      spec: codev/specs/0038-consult-pr-mode.md
      plan: null
      review: null
    dependencies: ["0022"]
    tags: [cli, consultation, performance]
    notes: "TICK protocol. Implemented as part of consult tool evolution. Pre-fetch PR diff/comments/specs, extract verdict from output."

  - id: "0041"
    title: "E2E Test Suite"
    summary: "Automated end-to-end tests for @cluesmith/codev npm package installation and CLI commands"
    status: integrated
    priority: high
    release: null
    files:
      spec: codev/specs/0041-e2e-test-suite.md
      plan: codev/plans/0041-e2e-test-suite.md
      review: codev/reviews/0041-e2e-test-suite.md
    dependencies: ["0039"]
    tags: [testing, npm, ci]
    notes: "SPIDER protocol. PR #78 merged 2025-12-08. BATS-based tests with XDG sandboxing, CI for macOS+Linux."

  - id: "0042"
    title: "Namespace Builder Sessions"
    summary: "Add project namespace to tmux sessions and builder IDs to prevent cross-project collisions"
    status: integrated
    priority: high
    release: null
    files:
      spec: null
      plan: null
      review: null
    dependencies: []
    tags: [agent-farm, multi-project, bug-fix]
    notes: "TICK protocol (hotfix). Changed session naming from 'builder-{spec_id}' to 'builder-{project}-{spec_id}'. PR #75."

  - id: "0043"
    title: "Codex Reliability for Codev"
    summary: "Get Codex CLI running consistently and rapidly with codev consultations"
    status: integrated
    priority: high
    release: null
    files:
      spec: codev/specs/0043-codex-reliability.md
      plan: codev/plans/0043-codex-reliability.md
      review: codev/reviews/0043-codex-reliability.md
    dependencies: ["0022"]
    tags: [cli, consultation, codex]
    notes: "Merged PR #83. Replaced undocumented CODEX_SYSTEM_MESSAGE with experimental_instructions_file, added model_reasoning_effort=low."

  - id: "0044"
    title: "Architect-Builder Workflow Clarity"
    summary: "Document and enforce clear workflow stages between architect and builder roles"
    status: implementing
    priority: high
    release: null
    files:
      spec: codev/specs/0044-architect-builder-workflow.md
      plan: codev/plans/0044-architect-builder-workflow.md
      review: null
    dependencies: []
    tags: [protocol, workflow, spider]
    notes: "7-stage workflow with clear human gates. Delete SPIDER-SOLO, add consult --type parameter, create review type prompts."

  - id: "0045"
    title: "Project List UI"
    summary: "Visual dashboard tab showing project status across 7 lifecycle stages with welcome onboarding"
    status: committed
    priority: high
    release: null
    files:
      spec: codev/specs/0045-project-list-ui.md
      plan: codev/plans/0045-project-list-ui.md
      review: null
    dependencies: ["0007"]
    tags: [ui, dashboard, onboarding]
    notes: "PR #85 merged 2025-12-09. Projects tab with Kanban view, welcome screen, parser, terminal states."

## Next Available Number

**0046** - Reserve this number for your next project

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
