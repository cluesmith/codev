---
name: codev
description: Codev project management CLI — init, adopt, bootstrap-docs, update, doctor, and the read-only check commands (check pr, check deploy, check worktree). Check this skill before running any `codev` command (except `consult`, `porch`, or `afx` which have their own skills). Use when setting up new projects, adding codev to existing repos, updating framework files, diagnosing missing dependencies, checking whether a PR is ready to merge, whether merged PRs reached the deploy branch, or whether a builder worktree can be removed.
---

# codev - Project Management CLI

## Commands

```
codev init [project-name]      Create a new codev project directory
codev adopt                    Add codev to the current directory
codev bootstrap-docs           Draft the governance docs from this codebase
codev update                   Update protocols, roles, skills from package
codev doctor                   Check system dependencies
codev check pr <N>             Read-only: is PR N ready to recommend for merge
codev check deploy <N>...      Read-only: did merged PRs reach the deploy branch
codev check worktree <id|path> Read-only: would removing a builder worktree lose data
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

On a project with code, adopt then offers to draft the governance docs (default No); with `-y` it only prints the command.

## codev bootstrap-docs

Drafts `codev/resources/{arch,lessons-learned,arch-critical,lessons-critical}.md` from the codebase and git history. Rewrites only files that are still untouched starters; curated files are never edited. Always confirms before launching the agent, then reports what changed and runs a three-way review of the drafts. Nothing is committed.

```bash
codev bootstrap-docs --dry-run # Eligible files and the launch, nothing run
codev bootstrap-docs           # Draft, report, review
```

## codev update

Updates framework files (protocols, roles, skills) from the installed `@cluesmith/codev` package. **Never touches user data** (specs, plans, reviews). Creates `.codev-new` versions for customized files. Missing Claude and Codex skills are added. A skill you never edited is replaced with the package's version; an edited one is kept and gets `<file>.codev-new` copies to merge.

```bash
codev update                   # Interactive update
codev update --dry-run         # Preview changes
codev update --force           # Overwrite all framework files
codev update --agent           # Agent mode: JSON stdout, no interactive merge
```

## codev doctor

Checks dependencies: Node.js (>=22), git (>=2.5), your forge's CLI and its auth (`gh` on GitHub), and at least one working AI model — Claude (the installed `claude` CLI: version and login), Codex, OpenCode, or Gemini (via the Antigravity CLI, `agy`).

```bash
codev doctor
```

## codev check

Read-only: never merges, pushes, comments, deletes or moves a ref. Verdict on the first line,
then one line per check (`ok`, `ATTN`, `info`, `not run`, `off`, `skip`). Exit 0 clear, 1
something needs attention (a check that could not run counts), 2 the command failed. Works
from the main checkout or any builder worktree.

```bash
codev check pr 42              # before recommending a merge: head, state, mergeability,
                               # trial merge, CI on the code, attribution, watched files,
                               # linked issue, size, files to read
codev check deploy 42 43       # after merging: on the deploy branch, in the latest green deploy run
codev check worktree spir-42   # before afx cleanup: would removal lose data
codev check worktree .builders/spir-42 --json   # a path works too; --json for agents
```

- Run `codev check pr` before `consult --type integration`: it checks mechanics, the
  consultation reviews content.
- `REMOVABLE` means no data would be lost, not that the builder is finished: an open PR is
  its own `ATTN` line and makes the exit 1.
- Configuration lives under `check.*` in `.codev/config.json` (`attribution`, `watch`, `flag`,
  `notForReading`, `deploy.branch`, `deploy.workflow`, `skip`); the keep list is
  `cleanup.keepIgnored`. A bad value is exit 2 naming the key and the file. `codev check --help`
  and `codev check <sub> --help` list the subcommands and options.

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

**Native Windows:** pnpm runs `package.json` scripts through `cmd.exe`, which cannot run the
`.sh` files that `build` and `local-install` invoke, so both fail with `'scripts' is not
recognized as an internal or external command`. Point pnpm at Git Bash once:

```
pnpm config set script-shell "C:\Program Files\Git\bin\bash.exe"
```

Use the full path, because a bare `bash` can resolve to WSL. The setting is user-global, so it
applies to every pnpm project on the machine; undo it with `pnpm config delete script-shell`.

`pnpm build` also runs `copy-skeleton`, which copies `codev-skeleton/` into
`packages/codev/skeleton`. **Tests read that copy**, so after editing anything under
`codev-skeleton/` you must rebuild before the suite reflects your change.

**Run `codev update` in this repository only with a package built from it.** An older installed
package treats unpublished skill edits as local edits: it writes `.codev-new` copies holding
the older text (a merge can fold that back in), and `--force` overwrites the edits outright.

### Where to run things

- `pnpm install` — repository root (installs all workspace packages)
- `pnpm build` / `pnpm test` — `packages/codev/`, or `pnpm --filter @cluesmith/codev build`
- Unit tests `packages/codev/tests/unit/` · E2E `packages/codev/tests/e2e/`
- Never run npm commands from the repository root unless told to

### Measuring code size

`tokei -e "tests/lib" -e "node_modules" -e ".git" -e ".builders" -e "dist" .`
