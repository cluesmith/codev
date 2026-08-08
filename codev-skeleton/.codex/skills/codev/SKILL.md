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

Creates a **new directory** with the full codev structure: specs/, plans/, reviews/, protocols, CLAUDE.md, AGENTS.md, `.claude/skills/`, `.codex/skills/`, .codev/config.json, and .gitignore.

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

Updates framework files (protocols, roles, skills) from the installed `@cluesmith/codev` package. **Never touches user data** (specs, plans, reviews). Creates `.codev-new` versions for customized files. Missing Claude and Codex skills are added, while existing skill directories are preserved.

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

## Local build and install (this repository)

Test changes locally before publishing. Run from the repository root:

```bash
pnpm build                  # builds core first, then codev (including dashboard)
pnpm -w run local-install   # packs both packages, installs globally, restarts Tower
```

`local-install` (`scripts/local-install.sh`) packs `@cluesmith/codev-core` and
`@cluesmith/codev`, installs both in a single `npm install -g` (separate installs fail —
`codev-core` is not on the public registry), restores the executable bit on
`scripts/forge/**/*.sh` that `pnpm pack` strips, and restarts Tower last. Install runs while
Tower is up; only the final restart causes downtime. **Do not stop Tower first**, and do not use
`npm link` / `pnpm link` — it breaks global installs.

`pnpm build` also runs `copy-skeleton`, which copies `codev-skeleton/` into
`packages/codev/skeleton`. **Tests read that copy**, so after editing anything under
`codev-skeleton/` you must rebuild before the suite reflects your change.

### Where to run things

- `pnpm install` — repository root (installs all workspace packages)
- `pnpm build` / `pnpm test` — `packages/codev/`, or `pnpm --filter @cluesmith/codev build`
- Unit tests `packages/codev/tests/unit/` · E2E `packages/codev/tests/e2e/`
- Never run npm commands from the repository root unless told to

### Measuring code size

`tokei -e "tests/lib" -e "node_modules" -e ".git" -e ".builders" -e "dist" .`
