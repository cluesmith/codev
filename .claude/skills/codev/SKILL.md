---
name: codev
description: Codev project management CLI — init, adopt, update, and doctor commands. Check this skill before running any `codev` command (except `consult`, `porch`, or `afx` which have their own skills). Use when setting up new projects, adding codev to existing repos, updating framework files, or diagnosing missing dependencies.
---

# codev - Project Management CLI

## Commands

```
codev init [project-name]      Create a new codev project directory
codev adopt                    Add codev to the current directory
codev update                   Update protocols, roles, skills from package
codev doctor                   Check system dependencies
```

## codev init

Creates a **new directory** with the full codev structure: specs/, plans/, reviews/, protocols, CLAUDE.md, AGENTS.md, .claude/skills/, .codev/config.json, .gitignore.

```bash
codev init my-app              # Interactive setup
codev init my-app -y           # Non-interactive with defaults
```

## codev adopt

Adds codev to the **current directory** (existing project). Run from the project root. If CLAUDE.md or AGENTS.md already exists, creates `.codev-new` versions and spawns Claude to merge.

```bash
codev adopt                    # Interactive
codev adopt -y                 # Skip conflict prompts
```

## codev update

Updates framework files (protocols, roles, skills) from the installed `@cluesmith/codev` package. **Never touches user data** (specs, plans, reviews). Creates `.codev-new` versions for customized files.

```bash
codev update                   # Interactive update
codev update --dry-run         # Preview changes
codev update --force           # Overwrite all framework files
codev update --agent           # Agent mode: JSON stdout, no interactive merge
```

## codev doctor

Checks all required dependencies: Node.js (>=18), git (>=2.5), gh (authenticated), and at least one AI CLI (Claude, Gemini, or Codex).

```bash
codev doctor
```

## Common mistakes

- There is NO `codev tower` command — use `afx tower start/stop`
- `codev init` creates a new directory — use `codev adopt` for existing projects
- Always run `codev adopt` and `codev update` from the project root
- `codev update` only updates framework files — it never touches specs/plans/reviews
