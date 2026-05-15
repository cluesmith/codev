# {{PROJECT_NAME}} - AI Agent Instructions

> **Note**: This file follows the [AGENTS.md standard](https://agents.md/) for cross-tool compatibility with Cursor, GitHub Copilot, and other AI coding assistants. A Claude Code-specific version is maintained in `CLAUDE.md`.

## Project Overview

This project uses **Codev** for AI-assisted development.

## Available Protocols

- **SPIR**: Multi-phase development with consultation (`codev/protocols/spir/protocol.md`)
- **ASPIR**: Autonomous SPIR — no human gates on spec/plan (`codev/protocols/aspir/protocol.md`)
- **AIR**: Autonomous Implement & Review for small features (`codev/protocols/air/protocol.md`)
- **BUGFIX**: Bug fixes from GitHub issues (`codev/protocols/bugfix/protocol.md`)
- **PIR**: Plan / Implement / Review — issue-driven with two human gates (plan-approval, dev-approval) (`codev/protocols/pir/protocol.md`)
- **EXPERIMENT**: Disciplined experimentation (`codev/protocols/experiment/protocol.md`)
- **MAINTAIN**: Codebase maintenance (`codev/protocols/maintain/protocol.md`)
- **RESEARCH**: Multi-agent research with 3-way investigation, synthesis, and critique (`codev/protocols/research/protocol.md`)

## File Resolution (How Codev Finds Protocols and Templates)

Codev resolves protocol files, prompts, agent definitions, and roles through a four-tier lookup (highest priority first):

1. `.codev/<path>` — user override (project-local customization)
2. `codev/<path>` — project-local copy (customized and checked in)
3. Runtime cache
4. **Installed package skeleton** — ships with `@cluesmith/codev` (the default for every standard protocol)

**The absence of `codev/protocols/<name>/` on disk is not a missing reference** — it's the normal case for any protocol you haven't customized. The protocol resolves from the installed package's skeleton at runtime. Only protocols you want to customize need to live in your repo's `codev/protocols/`.

**Implication for `codev update` and CLAUDE.md / AGENTS.md merges:** when an updated template references a protocol, do NOT drop the reference because `codev/protocols/<name>/` is absent locally. The protocol resolves via the package skeleton, and dropping the reference removes it from your available-protocol list while it's still callable from the CLI.

## Protocol Verification (When You Don't Recognize a Protocol Name)

If the user mentions a protocol name you don't immediately recognize, verify against the CLI before responding:

```bash
afx spawn --protocol <name> --help
```

This succeeds if the protocol is registered (including via the skeleton fallback in tier 4 of the resolution chain) and errors helpfully otherwise. The CLI is the source of truth — defer to it when in doubt.

## Key Locations

- **Specs**: `codev/specs/` - Feature specifications (WHAT to build)
- **Plans**: `codev/plans/` - Implementation plans (HOW to build)
- **Reviews**: `codev/reviews/` - Reviews and lessons learned
- **Protocols**: `codev/protocols/` - Development protocols

## Quick Start

1. For new features, start with the Specification phase
2. Create exactly THREE documents per feature: spec, plan, and review
3. Follow the protocol phases as defined in the protocol files
4. Use multi-agent consultation when specified

## File Naming Convention

Use sequential numbering with descriptive names:
- Specification: `codev/specs/1-feature-name.md`
- Plan: `codev/plans/1-feature-name.md`
- Review: `codev/reviews/1-feature-name.md`

## Git Workflow

**NEVER use `git add -A` or `git add .`** - Always add files explicitly.

Commit messages format:
```
[Spec 1] Description of change
[Spec 1][Phase: implement] feat: Add feature
```

## CLI Commands

Codev provides three CLI tools:

- **codev**: Project management (init, adopt, update, doctor)
- **afx**: Agent Farm orchestration (start, spawn, status, cleanup)
- **consult**: AI consultation for reviews (general, protocol, stats)

For complete reference, see `codev/resources/commands/`:
- `codev/resources/commands/overview.md` - Quick start
- `codev/resources/commands/codev.md` - Project commands
- `codev/resources/commands/agent-farm.md` - Agent Farm commands
- `codev/resources/commands/consult.md` - Consultation commands

## Configuration

Agent Farm is configured via `.codev/config.json` at the project root. Created during `codev init` or `codev adopt`. Override via CLI flags: `--architect-cmd`, `--builder-cmd`, `--shell-cmd`.

```json
{
  "shell": {
    "architect": "claude",
    "builder": "claude",
    "shell": "bash"
  }
}
```

## For More Info

Read the full protocol documentation in `codev/protocols/`.
