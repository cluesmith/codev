---
approved: 2026-02-17
validated: [gemini, codex, claude]
---

# Spec 384: Public Documentation Audit

## Problem Statement

The Codev repository's public-facing documentation is significantly out of date. Key issues:

1. **No root README.md** — The repo has no top-level README at all. Visitors to github.com/cluesmith/codev see nothing.
2. **CHANGELOG.md is stale** — Only covers v1.0.0 and an unreleased section referencing SQLite migration. We're now at v2.0.7 with major architectural changes (Shellper, Porch, Tower single daemon, consult CLI v2).
3. **Release notes gap** — `docs/releases/` has notes through v2.0.3 but nothing for v2.0.4–v2.0.7.
4. **CLAUDE.md/AGENTS.md sync unknown** — These files claim to be identical but may have drifted.
5. **codev-skeleton/ templates may reference stale syntax** — e.g., old consult CLI syntax, old AF commands.
6. **codev/resources/ docs may reference removed features** — tmux references, old state management patterns, etc.
7. **docs/ articles may have outdated architecture descriptions** — why.md, faq.md, tips.md reference concepts from v1.x era.

## Scope

**In scope:** All markdown files that are visible on GitHub or ship to other projects via codev-skeleton.

### Tier 1: Public-facing (GitHub visitors see these)
- Root `README.md` (MISSING — must be created)
- `CHANGELOG.md`
- `CLAUDE.md` / `AGENTS.md`
- `docs/why.md`
- `docs/faq.md`
- `docs/tips.md`
- `docs/releases/` (gap analysis: v2.0.4–v2.0.7)
- `examples/todo-manager/README.md`

### Tier 2: Developer reference (used by architects/builders)
- `codev/resources/arch.md` — Architecture documentation
- `codev/resources/cheatsheet.md` — Concepts and tool reference
- `codev/resources/workflow-reference.md` — Stage-by-stage workflow
- `codev/resources/commands/overview.md` — CLI quick start
- `codev/resources/commands/codev.md` — codev CLI reference
- `codev/resources/commands/agent-farm.md` — afx CLI reference
- `codev/resources/commands/consult.md` — consult CLI reference
- `codev/resources/testing-guide.md` — Playwright and testing
- `codev/resources/protocol-format.md` — Protocol definition format
- `codev/resources/lessons-learned.md` — Extracted wisdom
- `codev/resources/lifecycle.md`
- `codev/resources/conceptual-model.md`
- `codev/resources/identity-and-porch-design.md`
- `codev/resources/agent-farm.md`

### Tier 3: Skeleton templates (ship to other projects)
- `codev-skeleton/templates/CLAUDE.md` / `AGENTS.md`
- `codev-skeleton/templates/cheatsheet.md`
- `codev-skeleton/templates/arch.md`
- `codev-skeleton/templates/lessons-learned.md`
- `codev-skeleton/templates/lifecycle.md`
- `codev-skeleton/templates/pr-overview.md`
- `codev-skeleton/resources/commands/*.md`
- `codev-skeleton/resources/workflow-reference.md`
- `codev-skeleton/builders.md`
- `codev-skeleton/DEPENDENCIES.md`
- `codev-skeleton/roles/*.md`

**Out of scope:**
- Protocol `.md` files (spir/protocol.md, tick/protocol.md, etc.) — these are operational and maintained separately
- Porch prompt files (`codev-skeleton/porch/prompts/*.md`) — these are system prompts, not documentation
- Consult type files (`codev-skeleton/protocols/*/consult-types/*.md`) — operational
- Specs, plans, reviews (`codev/specs/`, `codev/plans/`, `codev/reviews/`) — per-project artifacts
- Analysis documents (`codev/resources/cmap-value-analysis-*.md`, `vibe-vs-spir-*.md`) — point-in-time research
- `node_modules/` READMEs

## Goals

1. **Create a root README.md** that gives visitors a clear understanding of what Codev is, how to install it, and how to get started
2. **Update CHANGELOG.md** to cover v1.1.0 through v2.0.7 (can be sourced from `docs/releases/` and git history)
3. **Verify CLAUDE.md and AGENTS.md are in sync** — both root-level and skeleton templates
4. **Audit every Tier 1 and Tier 2 file** for:
   - References to removed features (tmux, ttyd, JSON state files, old CLI syntax)
   - Missing coverage of current features (Shellper, Porch, Tower single daemon, consult v2)
   - Broken or outdated examples
   - Incorrect file paths or command syntax
5. **Audit Tier 3 skeleton templates** to ensure they reflect current architecture and CLI syntax
6. **Fill the release notes gap** — create notes for v2.0.4 through v2.0.7 if they don't exist
7. **Flag files for removal** — identify any docs that are obsolete and should be archived

## Acceptance Criteria

- [ ] Root README.md exists with: project description, installation, quick start, architecture overview, links to deeper docs
- [ ] CHANGELOG.md covers all releases from v1.0.0 through v2.0.7
- [ ] CLAUDE.md and AGENTS.md are confirmed identical (root-level pair and skeleton pair)
- [ ] Zero references to tmux, ttyd, JSON state files, or `npx agent-farm` in any audited file
- [ ] All CLI examples in docs use current syntax (consult v2 `--prompt` flag, `afx tower start` not `codev tower`, etc.)
- [ ] Release notes exist for every tagged release
- [ ] Each Tier 2 file has been read and verified accurate for v2.0.7
- [ ] Each Tier 3 template has been read and verified accurate for v2.0.7
- [ ] A checklist of all changes made is included in the PR description
- [ ] Files identified as obsolete are listed with recommended action (archive or delete)

## Non-Goals

- Rewriting docs from scratch — update what exists, don't restructure
- Adding new documentation beyond the root README
- Changing the documentation tooling or rendering
- Updating protocol definitions or porch prompts

## Known Issues to Check

These are known stale references that should be verified and fixed:

| Pattern | Where to grep | Expected fix |
|---------|--------------|-------------|
| `tmux` | All `.md` files | Remove/replace with Shellper |
| `ttyd` | All `.md` files | Remove entirely |
| `state.json` or `ports.json` | All `.md` files | Replace with SQLite references |
| `npx agent-farm` | All `.md` files | Replace with `afx` commands |
| `consult general` | All `.md` files | Update to `consult --prompt` |
| `codev tower` | All `.md` files | Replace with `afx tower` |
| `dashboard-server` | All `.md` files | Replace with Tower single daemon |
| `projectlist.md` | All `.md` files | Replace with GitHub Issues |
