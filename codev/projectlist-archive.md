# Project Archive

Completed and terminal projects. See `projectlist.md` for active projects.

> Projects are moved here once `integrated` or `abandoned` for 3+ days.

## Integrated Projects

Projects that have been completed and validated in production.

```yaml
  - id: "0058"
    title: "File Search Autocomplete"
    summary: "VSCode-like Cmd+P quick file finder with substring matching and autocomplete"
    status: integrated
    priority: medium
    release: null
    files:
      spec: codev/specs/0058-file-search-autocomplete.md
      plan: codev/plans/0058-file-search-autocomplete.md
      review: codev/reviews/0058-file-search-autocomplete.md
    dependencies: ["0055"]
    tags: [dashboard, ui, search]
    timestamps:
      conceived_at: "2025-12-15T00:00:00-08:00"
      specified_at: "2025-12-15T16:00:00-08:00"
      planned_at: "2025-12-15T16:30:00-08:00"
      implementing_at: "2025-12-15T17:00:00-08:00"
      implemented_at: "2025-12-15T18:00:00-08:00"
      committed_at: "2025-12-15T18:30:00-08:00"
      integrated_at: "2025-12-16T00:00:00-08:00"
    notes: "Quick file finder (Cmd+P + Files tab). PR #110 merged 2025-12-15."
  - id: "0059"
    title: "Daily Activity Summary"
    summary: "Clock button in dashboard that uses AI to summarize today's work and time spent"
    status: integrated
    priority: medium
    release: null
    files:
      spec: codev/specs/0059-daily-activity-summary.md
      plan: codev/plans/0059-daily-activity-summary.md
      review: codev/reviews/0059-daily-activity-summary.md
    dependencies: []
    tags: [dashboard, ui, ai, productivity]
    timestamps:
      conceived_at: "2025-12-15T17:00:00-08:00"
      specified_at: "2025-12-15T17:30:00-08:00"
      planned_at: "2025-12-15T18:00:00-08:00"
      implementing_at: "2025-12-15T18:30:00-08:00"
      implemented_at: "2025-12-15T20:00:00-08:00"
      committed_at: "2025-12-15T20:15:00-08:00"
      integrated_at: "2025-12-16T00:00:00-08:00"
    notes: "What did I do today? button with AI summary. PR #111 merged 2025-12-15."
  - id: "0039"
    title: "Codev CLI (First-Class Command)"
    summary: "Unified codev command as primary entry point: init, adopt, doctor, update, tower, consult"
    status: integrated
    priority: high
    release: null
    files:
      spec: codev/specs/0039-codev-cli.md
      plan: codev/plans/0039-codev-cli.md
      review: codev/reviews/0039-codev-cli.md
    ticks: [001, 002, 003, 004, 005]
    dependencies: ["0005", "0022"]
    tags: [cli, npm, architecture]
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-09T21:54:55-08:00"
    notes: "PR #84 merged 2025-12-09. TICK-001 (consult TS consolidation) + TICK-002 (embedded skeleton) + TICK-003 (revert to copy-on-init for AI accessibility). TICK-005 (codev import) PR #88 merged 2025-12-11."
  - id: "0040"
    title: "TICK as SPIR Amendment"
    summary: "Rework TICK to be amendments to existing SPIR specs/plans rather than a separate protocol"
    status: integrated
    priority: high
    release: null
    files:
      spec: codev/specs/0040-tick-as-spider-amendment.md
      plan: null
      review: null
    dependencies: []
    tags: [protocols, architecture]
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-08T17:09:10-08:00"
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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-05T05:23:04-08:00"
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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-04T12:39:10-08:00"
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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-04T12:39:10-08:00"
    notes: "Merged PR 30. Python/Typer CLI at codev/bin/consult. Consultant role as collaborative partner. Consulted GPT-5 and Gemini Pro. TICK-001: Architect-mediated PR reviews (2025-12-08)."
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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-04T17:07:28-08:00"
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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-05T06:15:10-08:00"
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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-04T15:23:49-08:00"
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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-04T16:54:48-08:00"
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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-05T13:58:34-08:00"
    notes: "TICK protocol. Color dots with accessibility (shapes/tooltips for colorblind). Consulted GPT-5 and Gemini Pro."
  - id: "0053"
    title: "af open Image Support"
    summary: "Extend af open to display images (PNG, JPG, GIF, WebP, SVG) with zoom controls"
    status: integrated
    priority: medium
    release: "v1.3.0"
    files:
      spec: codev/specs/0053-af-open-image-support.md
      plan: codev/plans/0053-af-open-image-support.md
      review: codev/reviews/0053-af-open-image-support.md
    dependencies: []
    tags: [agent-farm, dashboard, ui]
    timestamps:
      conceived_at: "2025-12-11T15:00:00-08:00"
      specified_at: "2025-12-11T15:00:00-08:00"
      planned_at: "2025-12-11T15:00:00-08:00"
      implementing_at: "2025-12-13T11:02:00-08:00"
      implemented_at: "2025-12-13T11:20:00-08:00"
      committed_at: "2025-12-13T11:25:00-08:00"
      integrated_at: "2025-12-13T12:30:00-08:00"
    notes: "PR #103 merged 2025-12-13. Image support validated."
  - id: "0052"
    title: "Agent Farm Internals Documentation"
    summary: "Comprehensive arch.md section on af internals: ports, tmux, state, worktrees, dashboard"
    status: integrated
    priority: medium
    release: "v1.2.0"
    files:
      spec: codev/specs/0052-agent-farm-internals-docs.md
      plan: null
      review: codev/reviews/0052-agent-farm-internals-docs.md
    dependencies: []
    tags: [documentation, architecture, agent-farm]
    timestamps:
      conceived_at: "2025-12-11T11:15:00-08:00"
      specified_at: "2025-12-11T11:15:00-08:00"
      planned_at: null
      implementing_at: "2025-12-11T11:15:00-08:00"
      implemented_at: "2025-12-11T12:30:00-08:00"
      committed_at: "2025-12-11T12:45:00-08:00"
      integrated_at: "2025-12-11T13:00:00-08:00"
    notes: "PR #99 merged 2025-12-11"
  - id: "0051"
    title: "Codev Cheatsheet"
    summary: "Comprehensive cheatsheet with philosophies, concepts (protocols, roles, hierarchy), and tools reference"
    status: integrated
    priority: medium
    release: "v1.2.0"
    files:
      spec: codev/specs/0051-codev-cheatsheet.md
      plan: codev/plans/0051-codev-cheatsheet.md
      review: codev/reviews/0051-codev-cheatsheet.md
    dependencies: []
    tags: [documentation, onboarding]
    timestamps:
      conceived_at: "2025-12-11T10:50:00-08:00"
      specified_at: "2025-12-11T10:50:00-08:00"
      planned_at: "2025-12-11T10:50:00-08:00"
      implementing_at: "2025-12-11T10:50:00-08:00"
      implemented_at: "2025-12-11T11:30:00-08:00"
      committed_at: "2025-12-11T11:45:00-08:00"
      integrated_at: "2025-12-11T12:00:00-08:00"
    notes: "PR #98 merged 2025-12-11"
  - id: "0050"
    title: "Dashboard Polish"
    summary: "UX improvements: clickable title only for expand, show TICKs in project view, poll for projectlist.md creation"
    status: integrated
    priority: medium
    release: "v1.2.0"
    files:
      spec: codev/specs/0050-dashboard-polish.md
      plan: codev/plans/0050-dashboard-polish.md
      review: codev/reviews/0050-dashboard-polish.md
    dependencies: []
    tags: [dashboard, ui, ux]
    timestamps:
      conceived_at: "2025-12-11T10:40:00-08:00"
      specified_at: "2025-12-11T10:40:00-08:00"
      planned_at: "2025-12-11T10:40:00-08:00"
      implementing_at: "2025-12-11T10:40:00-08:00"
      implemented_at: "2025-12-11T11:00:00-08:00"
      committed_at: "2025-12-11T11:10:00-08:00"
      integrated_at: "2025-12-11T13:30:00-08:00"
    notes: "PR #97 merged 2025-12-11"
  - id: "0035"
    title: "MAINTAIN Protocol"
    summary: "Rename CLEANUP to MAINTAIN, expand scope to include documentation maintenance (arch.md, lessons-learned.md, CLAUDE.md/AGENTS.md sync)"
    status: integrated
    priority: medium
    release: "v1.2.0"
    files:
      spec: codev/specs/0035-maintenance-framework.md
      plan: null
      review: null
    dependencies: ["0015"]
    tags: [protocols, maintenance, documentation]
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: "2025-12-06T15:40:02-08:00"
      integrated_at: "2025-12-11T15:30:00-08:00"
    notes: "PR #56 merged 2025-12-06. Integrated 2025-12-11. Supersedes CLEANUP (0015). Adds doc maintenance to code hygiene. Consulted Gemini/Codex. No new roles - MAINTAIN executed by Builder like any protocol."
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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-07T20:40:59-08:00"
    notes: "TICK protocol. PR 58 merged 2025-12-07. Close button improved 2025-12-07."
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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-08T17:09:10-08:00"
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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-05T13:58:34-08:00"
    notes: "PR #36 merged 2025-12-05"
  - id: "0012"
    title: "Hide tmux Status Bar"
    summary: "Cleaner dashboard UI by removing the tmux status bar from embedded terminals"
    status: integrated
    priority: low
    release: "v1.2.0"
    files:
      spec: codev/specs/0012-hide-tmux-status-bar.md
      plan: codev/plans/0012-hide-tmux-status-bar.md
      review: codev/reviews/0012-hide-tmux-status-bar.md
    dependencies: []
    tags: [ui, dashboard]
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: "2025-12-10T12:24:00-08:00"
      implementing_at: "2025-12-10T12:24:38-08:00"
      implemented_at: "2025-12-10T12:36:14-08:00"
      committed_at: "2025-12-11T07:27:10-08:00"
      integrated_at: "2025-12-11T07:45:00-08:00"
    notes: "TICK protocol. PR #90 merged 2025-12-11. Adds 'tmux set-option -t sessionName status off' after all session creations. 3-way integration review completed (Gemini/Codex APPROVE, Claude noted scope creep but approved)."
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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-06T06:57:59-08:00"
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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-06T07:21:53-08:00"
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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-05T15:32:52-08:00"
    notes: "SPIR protocol. Fixes race conditions in state.json and ports.json. Uses better-sqlite3 with WAL mode. 3-way reviewed. Merged 2025-12-05."
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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-06T06:57:59-08:00"
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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-05T15:37:11-08:00"
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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: "2025-12-06T07:21:53-08:00"
    notes: "Two-pass rendering with code block awareness. Preserves alignment markers (:---:). Consulted Gemini/Codex. PR 51 merged 2025-12-06."
```

## Terminal Projects

Projects that are paused or canceled.

```yaml
  - id: "0024"
    title: "Builder Event Notifications"
    summary: "Notify builders via tmux send-keys when events occur (PR review completed, file changes, etc.)"
    status: abandoned
    priority: high
    release: null
    files:
      spec: codev/specs/0024-builder-event-notifications.md
      plan: null
      review: null
    dependencies: ["0005"]
    tags: [cli, agents, communication]
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: null
    notes: "Abandoned 2025-12-13. Manual notification via af send is sufficient."
  - id: "0017"
    title: "Platform Portability Layer"
    summary: "Implement transpilation from .codev/ source to platform-specific configs (CLAUDE.md, GEMINI.md, AGENTS.md)"
    status: abandoned
    priority: low
    release: null
    files:
      spec: codev/specs/0017-platform-portability-layer.md
      plan: null
      review: null
    dependencies: []
    tags: [architecture, portability]
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: null
    notes: "Abandoned 2025-12-13. YAGNI - dual-writing CLAUDE.md and AGENTS.md is simpler and sufficient."
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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: null
    notes: "Superseded by 0028, which was then superseded by 0035 (MAINTAIN protocol)."
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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: null
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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: null
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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: null
    notes: "Abandoned 2025-12-08. Current UX is sufficient."
```
