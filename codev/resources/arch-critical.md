# arch-critical.md — Always-On System-Shape Facts (HOT tier)

<!-- HOT tier: capped facts + a bounded map of arch.md. Always injected into every porch
phase prompt and into CLAUDE.md/AGENTS.md. CAP: <=10 facts, <=12 map topics, <=35 lines.
To add a fact, DEMOTE a weaker one into arch.md (displacement). MAINTAIN polices the cap
and keeps the map in sync with arch.md's top-level sections. See codev/resources/arch.md. -->

## Critical facts (consult before deciding)
- Framework files resolve at RUNTIME via the four-tier chain (.codev/ → codev/ → cache → skeleton); they are NOT copied into projects. Don't wire features to "scaffold copies it."
- Governance docs are two-tier (Spec 987): HOT arch-critical.md/lessons-critical.md are capped + always-injected; COLD arch.md/lessons-learned.md are reference. Route new facts/lessons by tier; never grow a hot file past its cap (demote to cold).
- Two trees: codev/ = our instance, codev-skeleton/ = the template shipped to adopters. Mirror every framework change in BOTH.
- CLAUDE.md and AGENTS.md MUST stay byte-identical (same content, two tool ecosystems).
- Porch is a pure planner: it emits task JSON, Claude Code executes. Never hand-edit status.yaml.
- State lives in a single user-global ~/.agent-farm/global.db (Issue #1118 retired the per-workspace state.db; architect/builders keyed by workspace_path); one Tower on port 4100. Never modify state by hand.
- Worktrees in .builders/ are Agent-Farm-managed — never delete manually (use afx cleanup); run afx from the main workspace root only.
- Forge concept commands abstract the VCS provider — add a dedicated concept; don't bolt env flags onto a shared one.
- Two human gates (spec-approval, plan-approval) plus the pr gate; only humans transition conceived→specified and committed→integrated.
- Never `git add -A` / `.` / `--all` — stage files explicitly.

## Map of arch.md (consult when…)
- Invariants & Constraints — touching state, ports, worktrees, or anything "MUST remain true."
- Installation Architecture — touching init/adopt/update or the four-tier resolver.
- Agent Farm Internals — changing spawn, Tower, terminals, or inter-agent messaging.
- Repository Dual Nature — before editing any framework file (codev/ vs skeleton).
- Core Components — locating where logic lives or wiring a new module.
- Key Design Decisions — before reversing a design choice (the "why").
- System-Wide Patterns — adding cross-cutting behavior.
- Integration Points — crossing a subsystem or process boundary.
- Monorepo Structure — adding a package or build wiring.
- Technology Stack — choosing or upgrading a dependency.
- VS Code Extension — changing sidebar views, commands, or keybindings.
- Glossary — when a term is unfamiliar.
