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








# Medium Priority

  - id: "0061"
    title: "STL Viewer Support"
    summary: "Add 3D STL file viewing to dashboard annotation viewer for OpenSCAD and CAD tool output"
    status: implemented
    priority: medium
    release: null
    files:
      spec: codev/specs/0061-stl-viewer.md
      plan: codev/plans/0061-stl-viewer.md
      review: null
    dependencies: []
    tags: [dashboard, ui, 3d, cad]
    timestamps:
      conceived_at: "2025-12-25T00:00:00-08:00"
      specified_at: "2025-12-25T00:00:00-08:00"
      planned_at: "2025-12-25T00:00:00-08:00"
      implementing_at: "2025-12-25T00:00:00-08:00"
      implemented_at: "2025-12-26T00:00:00-08:00"
      committed_at: null
      integrated_at: null
    notes: "Three.js STL viewer with standard views, wireframe, axes, grid toggles. Uses r128 for global builds."

  - id: "0062"
    title: "Secure Remote Access"
    summary: "SSH tunnel + reverse proxy: afx tunnel outputs SSH command, one port for everything"
    status: planned
    priority: medium
    release: null
    files:
      spec: codev/specs/0062-secure-remote-access.md
      plan: codev/plans/0062-secure-remote-access.md
      review: null
    dependencies: []
    tags: [security, remote-access, ssh, agent-farm]
    timestamps:
      conceived_at: "2025-12-27T00:00:00-08:00"
      specified_at: "2025-12-27T00:00:00-08:00"
      planned_at: "2025-12-27T00:00:00-08:00"
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: null
    notes: "Imported from ../codev. Reverse proxy consolidates all ttyd instances behind one port. afx tunnel outputs SSH command."


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
    timestamps:
      conceived_at: null
      specified_at: null
      planned_at: null
      implementing_at: null
      implemented_at: null
      committed_at: null
      integrated_at: null
    notes: "Phase 2: Stateful. Keep CLI running via stdio. Maintain session until closed. Depends on 0022."







# Low Priority









```

---

## Releases

```yaml
releases:
  - version: "v3.1.9"
    name: "Jacobean"
    status: released
    target_date: "2026-06-08"
    notes: "Hotfix republish of v3.1.8 with `workspace:*` dependencies resolved to concrete versions. The v3.1.8 publish accidentally used `npm publish` instead of `pnpm publish`, leaving `'@cluesmith/codev-core': 'workspace:*'` in the published `@cluesmith/codev@3.1.8` package.json — end users running `npm install -g @cluesmith/codev@3.1.8` hit `npm error code EUNSUPPORTEDPROTOCOL` because npm doesn't understand the `workspace:` protocol. v3.1.9 republishes the same code through `pnpm publish` (which rewrites `workspace:*` to `3.1.9`). Verified post-publish: `npm view @cluesmith/codev@3.1.9 dependencies` shows `'@cluesmith/codev-core': '3.1.9'`. No code changes from v3.1.8 — see v3.1.8 entry for the substantive content. VSCode extension is unaffected (esbuild-bundled, the workspace:* strings in its package.json are inert at runtime); the marketplace publish of v3.1.8 stands."
  - version: "v3.1.8"
    name: "Jacobean"
    status: released
    target_date: "2026-06-08"
    notes: "Tower-restart story closes its loop plus a deadline-driven consult lane migration. **Note: the npm publish of this version was broken** — `@cluesmith/codev@3.1.8` shipped with `'@cluesmith/codev-core': 'workspace:*'` unresolved (npm publish was used instead of pnpm publish). v3.1.9 republishes the same code correctly. The git tag, GitHub release, and vscode marketplace publish of v3.1.8 are unaffected and remain as the canonical reference for this cycle's substantive changes. Cross-package: Tower restart no longer leaves builder/architect terminals stranded — unfiltered `lsof` no longer kills client sockets (including the VSCode extension host's), and persistent sessions keep their ids across restart (#991/#999); startup-readiness barrier closes the rare reconcile-race edge case with an optional `/health.ready` signal (#997/#1004); web terminal matches VSCode's near-instant give-up on dead sessions via Origin-discriminated 4404 close code (#971/#992). Gemini consult lane swaps from the retiring Gemini CLI to the Antigravity CLI (`agy`) ahead of Google's 2026-06-18 deprecation, with non-blocking COMMENT skip when agy isn't installed or authenticated (#778/#988); `codev doctor` now checks agy presence + auth state. VSCode What's new: Tower version preflight on connect with `Restart Tower` action when the running Tower is behind the installed CLI (#983/#1000), Codev Dev surface — bottom-panel tab + status-bar chip on top of the existing PTY (#921/#996), Codev tab joins the bottom panel as scaffold for upcoming view migrations (#812/#990). VSCode Bug fixes: 'No active terminal' toast self-heals via bounded retry and surfaces a Recover Builders action when retries genuinely fail (#982/#1006), builders no longer briefly flash into UNCATEGORIZED during cleanup via ResolvedEnrichmentCache gating on source reachability (#907/#1003), terminal reconnect notice overwrites in place and wipes on successful reconnect (#1001/#1002), guarded commands always give feedback via modal-first/ephemeral-after pattern through a reusable showPreflightFeedback helper (#989/#995). Other fixes: dashboard Needs Attention no longer drops merged-but-gate-pending builders (#966/#980), `consult -m claude` bills against the Claude subscription when OAuth and API key are both set in the environment (#985/#986), CI runs vscode + dashboard vitest (#967/#993)."
  - version: "v3.1.7"
    name: "Jacobean"
    status: released
    target_date: "2026-06-03"
    notes: "VSCode-extension-heavy Jacobean patch plus npm-side fixes. VSCode What's new: Codev CLI preflight on startup with 'Get started with Codev' walkthrough (#791/#955), Builders tree group-by-stage default with stage/area toggle on title-bar AND group header (#952/#970), area-header roll-up status icons on Backlog and Builders trees (#926/#959), Search Backlog editor-tab webview (#920/#957), [new] prefix on freshly-created backlog rows (#930/#949), click-to-reconnect affordance on terminal give-up (#939 + #936/#962). Bug fixes: terminal reconnect no longer spams 'Connection lost' indefinitely — bounded retry + give-up after 6 attempts + stale-session fast-path (#936/#962), sidebar no longer blanks empty during transient connection blips — overview cache holds last-known-good (#916/#976), Run/Stop Dev Server entries hide when worktree.devCommand isn't configured across menu + keybindings + palette (#975/#978), blocked-builder inline action button neutral arrow instead of misleading checkmark (#933/#963), Open Builder Terminal + Send Message Quick Picks now show '#<id> <title>' (#925/#951). Cross-package: transport-agnostic reconnect-policy extracted to @cluesmith/codev-core, web dashboard terminal adopts 6-attempt give-up (was 50) + true reconnect on refresh button (#961/#972), Overview wire types consolidated into @cluesmith/codev-types (#875/#973), worktree.symlinks supports directory entries via trailing-slash opt-in (#805/#947), SPIR/ASPIR review iteration ceiling lowered 8→3 (#964). Internal: lint rule banning bare vscode.commands.registerCommand (#956/#958), scrollController test realigned with the v3.0.0-rc.6 mitigation (bugfix-974/#977)."
  - version: "v3.1.6"
    name: "Jacobean"
    status: released
    target_date: "2026-05-31"
    notes: "VSCode-extension-heavy release plus one substantive cross-package rework. VSCode Backlog UX overhaul: mine-only-by-default + show-all eye-icon toggle (#809/#910), title-count reflects what's visible (#911/#914), 'Codev: Search Backlog...' Quick Pick from the command palette (#918/#938), area/* grouping in Backlog and Builders trees with UPPERCASE headers (#811/#886, #818/#890, #885/#893, #895/#897), sidebar default order Backlog above Pull Requests (#932/#940), Reference Issue paste includes title (#808/#899). VSCode Builders tree clarity: [<phase>] prefix on every row, gate-specific icons (spec/plan/dev/PR/verify each get a unique glyph) on blocked builders (#810/#941); Open Spec / Open Review row actions (#793/#908). Cross-package: SPIR #927 / PR #928 Needs Attention surface rework keys PR-readiness on the universal pr gate across all protocols, retires pr_ready_for_human field + recentlyMergedIssueIds projection, adds verify-approval to shared GATE_LABELS (which lights up the verify-review icon in VSCode); prerequisite Bugfix #887 / PR #888 gave BUGFIX a pr gate to close the v3.1.4 timing gap. SCM colors on builder file rows fixed for real this time (#799/#942) — v3.1.4's fix shipped against the wrong theory (Git decorator gates on URI scheme — it doesn't, matches by repository path), new fix uses a synthetic resourceUri path Git's repository lookup ignores. Other fixes: dashboard styling for dev-approval (#931/#935), dashboard skips stale post-merge prReady rows (#901/#902), Dashboard E2E flake fix (#828/#917), codev doctor warns on missing pr gate (#943/#944), porch done idempotent (#904), parseArea helper extracted to codev-core (#819/#876), architect docs treat area/* as the organizing axis (#909/#912), gemini consult lane bumped (#878/#879), scaffolding gitignores .architect-role.md (#880/#881). v3.1.5 was tagged as a lockstep version bump but never published; v3.1.6 supersedes it."
  - version: "v3.1.4"
    name: "Jacobean"
    status: released
    target_date: "2026-05-27"
    notes: "Three patch ships on the Jacobean line. #851 (CI): verify-install probes afx instead of removed af (fallout from v3.1.3's codev-afx-wrapper removal — main was red since v3.1.3 merge). #871 (porch consultation policy): asymmetric COMMENT vs REQUEST_CHANGES — ADVANCE on all-APPROVE-or-COMMENT, RE-ITER on any REQUEST_CHANGES with no normal-flow cap, max_iterations kept as high safety ceiling (default 1→8); reported by external adopter's architect via 21-iter natural experiment that retracted their own per-N-cap proposal; PIR's max_iterations=1 now correctly enforces single-pass advisory CMAP. #874 (Needs Attention regression closure): canonical pr_ready_for_human signal across all 5 protocols closes the BUGFIX gap shipped in v3.1.3 (PR #845 gated on blocked==='PR review' but BUGFIX has no pr gate). v3.1.2-style dual-CMAP discipline caught both architect-side blockers on PR #874 (isPrCreatingPhase over-matched RESEARCH's investigate/critique; NeedsAttentionList builder fallback dropped BUGFIX builders before prReady check) that the builder's own unanimous CMAP missed."
  - version: "v3.1.3"
    name: "Jacobean"
    status: released
    target_date: "2026-05-24"
    notes: "Workspace recover for machine-reboot resilience (#833, @amrmelsayed) — enumerates porch projects, identifies builders whose shellper died, respawns them via afx spawn --resume; builder + main-architect conversation resume via on-disk jsonl discovery. CLI cleanup (#847): codev afx / codev agent-farm / codev af wrapper invocations removed (process.argv[1] invocation-style fragility surfaced in PR #833 integration review); standalone af bin removed (deprecated since v3.0.1). Multi-architect story is now end-to-end coherent across lifecycle, persistence, surface, isolation, and recovery."
  - version: "v3.1.2"
    name: "Jacobean"
    status: released
    target_date: "2026-05-23"
    notes: "Critical hotfix on Jacobean. Closes #826: cross-workspace sibling-architect leak introduced by v3.1.1's #786 lifecycle work. Schema-level fix (Option A) — adds workspace_path column to state.db.architect with composite PK, makes all state accessors workspace-scoped, canonicalizes paths via realpath at the boundary. Caught and fixed entirely pre-publish via the dual-CMAP discipline (7 iterations across PRs #827 + #834, each catching a real bug the builder's own CMAP missed)."
  - version: "v3.1.1"
    name: "Jacobean"
    status: released
    target_date: "2026-05-23"
    notes: "First Jacobean release. Bundles multi-architect routing fix (#774), the #786 multi-architect lifecycle/persistence/UX feature pass (remove-architect, graceful-stop persistence, identity preservation, surface enumeration, VSCode Architects tree, race fix), the #823 multi-architect coordination follow-up (dashboard attribution, inter-agent messaging docs, builder thread file, VSCode add-refresh SSE), and Amr's two substantial VSCode extension rounds (file trees, View Diff, accordion, image paste, count badges, waiting-on-input, dev URLs, config.local.json). Skipped v3.0.8 (locally built, never published) and v3.1.0 (orphan dep-only packages briefly published; @cluesmith/codev never reached 3.1.0)."
  - version: "v3.0.8"
    name: "Ionic"
    status: superseded
    target_date: "2026-05-19"
    notes: "Built locally and tested end-to-end (verify-phase scenarios passed), never published to npm. Content superseded by v3.1.1 which bundled additional work that landed before publish. Tag v3.0.8 was created and pushed to GitHub but is intentionally orphan w.r.t. npm — kept as a historical breadcrumb of the multi-architect routing fix (#774) and the v3.0.6 VSCode round."
  - version: "v3.0.7"
    name: "Ionic"
    status: released
    target_date: "2026-05-18"
    notes: "Bugfix patch — architect pane layout fix for N>1 sibling architects (#766 - missing CSS for new wrappers shipped in v3.0.6); Gitea/Forgejo forge crash + field normalization (#749 + #750 reported by external adopter Chris Dodge)."
  - version: "v3.0.6"
    name: "Ionic"
    status: released
    target_date: "2026-05-18"
    notes: "Multi-architect dashboard tabs (#761) completes the v3.0.5 routing primitive — sibling architects are now clickable in the browser. PIR protocol (#691) lands; VSCode extension workflow round (#737) adds workspace dev runner, gate toasts, plan-review comments, View Issue/Artifact commands."
  - version: "v3.0.5"
    name: "Ionic"
    status: released
    target_date: "2026-05-18"
    notes: "Multi-architect builder→architect message routing (#755); baked architectural decisions for SPIR/AIR/ASPIR issues (#746); bugfixes for BUGFIX consult templates (#742), SPIR one-PR-per-spec ambiguity (#744), afx spawn untracked-files strictness (#745); codex SDK XProtect cert fix. v3.0.4 was a vscode-marketplace-only release; lockstep moved to 3.0.5 to keep all workspace packages aligned."
  - version: "v3.0.3"
    name: "Ionic"
    status: released
    target_date: "2026-05-12"
    notes: "Runnable worktrees (worktree.symlinks/postSpawn/devCommand, afx dev, afx setup), VSCode review tooling (sidebar context menu, View Diff, Run/Stop Dev Server), lockstep version bumps (pnpm bump-version), VSCode reliability fixes (#682 follow-up, #718, #728)."
  - version: "v3.0.2"
    name: "Ionic"
    status: released
    target_date: "2026-05-07"
    notes: "Linear forge provider with hybrid GitHub fallback, Tower bridge mode for container-bridging, doc governance (update-arch-docs skill + MAINTAIN Lives-where matrix and audit-then-update split), bug fixes."

  - version: "v3.0.1"
    name: "Ionic"
    status: released
    target_date: "2026-04-30"
    notes: "VS Code extension, configurable forges (GitHub/Gitea/GitLab), configurable harnesses (Claude/Codex/Gemini/OpenCode), per-stage consults, Teams tab, multi-PR builders. v3.0.0 was deprecated due to a broken publish; v3.0.1 is the actual stable release."

  - version: "v2.0.0"
    name: "Hagia Sophia"
    status: released
    target_date: "2026-02-14"
    notes: "Shellper terminal session manager, Tower server decomposition, Cloud Connect, mobile-friendly dashboard, porch protocol orchestrator"

  - version: "v1.6.0"
    name: "Gothic"
    status: released
    target_date: "2025-12-22"
    notes: "Release candidate workflow, expanded protocol library"

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

**0063** - Reserve this number for your next project

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
