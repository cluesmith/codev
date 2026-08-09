---
name: runnable-worktrees
description: Make builder worktrees runnable — the `.codev/config.json` `worktree` block (symlinks, postSpawn, devCommand), the `afx dev` CLI, VSCode dev controls, and per-stack config recipes. Use when configuring a repo so reviewers can run a builder's branch, when `afx dev` fails to bind or start, when a dev process is orphaned holding a port, or when asked why worktree dev uses the same ports as main.
---

# Runnable worktrees

When configured, each builder worktree (`.builders/<id>/`) becomes runnable: reviewers can run
whatever your dev command starts — a dev server, `cargo run`, `expo start`, a test watcher, a
build script — against the builder's branch without `cd`'ing, installing, or hunting for the
command. Opt-in via `.codev/config.json`; unconfigured repos see zero behavior change.

## Config: the `worktree` block

```jsonc
{
  "worktree": {
    "symlinks":   ["..."],   // globs symlinked from the workspace root into each new worktree
    "postSpawn":  ["..."],   // shell commands run inside each new worktree after createWorktree
    "devCommand": "..."      // consumed by `afx dev <builder-id|main>`
  }
}
```

- **`symlinks`** — globs resolve from the workspace root and link into the worktree at the same
  relative path. Root `.env` and `.codev/config.json` are *always* symlinked regardless.
  **Symlinks, not copies**, so edits to main's env files reflect instantly in a running dev
  session. A directory match is silently skipped (a glob cannot mask the worktree's own source)
  **unless** the entry ends in a slash: `".local-user-data/"` is treated as a literal path and
  links the directory whole — shared with the parent, not branch-isolated. A dangling link is
  fine if the source does not exist yet.
- **`postSpawn`** — commands run sequentially with `cwd` = worktree path. A non-zero exit aborts
  the spawn loudly; the half-built worktree stays for inspection.
- **`devCommand`** — the foreground command that starts your dev process. Required for
  `afx dev`.

**Codev does not auto-detect your stack.** Pick a recipe below.

## CLI

```bash
afx dev <builder-id>     # start dev in that builder's worktree
afx dev main             # start dev in the MAIN workspace (Codev-managed)
afx dev --stop           # stop the running dev PTY (builder or main)
afx setup <builder-id>   # re-apply symlinks + postSpawn to an existing worktree (idempotent)
```

**One dev PTY at a time**, across {main + all builders} — deliberate; see *URLs are
load-bearing*. `main` is a reserved target running `worktree.devCommand` in the main checkout as
a Codev-managed, swappable PTY, symmetric with builders. Starting a second target prompts to
swap; a same-target request prints the existing terminal URL and exits. Dev PTYs are
**non-persistent** — a Tower restart or crash kills them; re-run to restart.

**Start main's dev with `afx dev main`, not a bare `pnpm dev`.** A hand-run `pnpm dev` is
invisible to Codev (which never kills what it did not spawn), so a builder dev started while it
holds the ports either fails to bind or — worse — serves main's code under the worktree URL.
`afx dev main` makes it a managed PTY that swap-detection can stop cleanly. This only helps if
used consistently.

## VSCode

Right-click a builder row in the Codev sidebar (Builders or Needs Attention):

- **Open Builder Terminal** — that builder's AI terminal in a tab (same as left-click).
- **Open Worktree Folder** — `.builders/<id>/` in the OS file manager.
- **Run Worktree Setup** — re-applies `worktree.symlinks` and `worktree.postSpawn` to an
  existing worktree (the git steps are skipped). Idempotent. Use when the lockfile changed, when
  `symlinks`/`postSpawn` grew after the builder spawned, when a link was deleted, or when the
  original setup aborted. Streams install output in a fresh terminal. CLI: `afx setup <id>`.
- **View Diff** — unified `main...HEAD` diff for that worktree with a file-list pane.
- **Run Dev** / **Stop Dev** — spawn or kill the dev PTY as a `Codev: <name> (dev)` tab;
  prompts to swap if another dev is running.

The sidebar's **Workspace** view carries a dev control for whatever folder the window is rooted
at — the main checkout resolves to `main`, a `.builders/<id>/` window resolves to that builder.
The row tooltip names the resolved target. Commands are also in the palette (Cmd+Shift+P); no
default keybindings.

## URLs are load-bearing

The dev PTY intentionally uses **the same ports and URLs as main**. OAuth callbacks, CORS
allowlists, cookie scoping, CSP `connect-src` and webhook URLs are all keyed off origin, so
running a worktree on a different port would break them.

Consequence: stop main's dev before starting a builder's, or the spawned dev fails at bind time
with `EADDRINUSE`.

## Cleanup and orphan recovery

`afx dev --stop` and the swap path kill the entire PTY **process group** (SIGTERM, then SIGKILL
after 5s), which signals every grandchild of a monorepo orchestrator (`pnpm dev`, `turbo dev`,
`pnpm -r --parallel run dev`) at once. Ports are reclaimed by the OS as a consequence — Codev
never manipulates ports directly.

If Tower hard-crashes mid-dev and a process is left holding a port outside Codev's records:

```bash
lsof -ti :<port> | xargs kill
lsof -ti :3000,:3001,:4000 | xargs kill
```

## Recipes

**pnpm monorepo (Next.js / Turbo)**
```json
{"worktree": {"symlinks": [".env.local", ".env.development.local", "packages/*/.env", "packages/*/.env.local", "turbo.json"], "postSpawn": ["pnpm install --frozen-lockfile"], "devCommand": "pnpm dev"}}
```

**npm** — `{"symlinks": [".env.local", ".env.development"], "postSpawn": ["npm ci"], "devCommand": "npm run dev"}`

**yarn** — `{"symlinks": [".env.local"], "postSpawn": ["yarn install --frozen-lockfile"], "devCommand": "yarn dev"}`

**bun** — `{"symlinks": [".env.local"], "postSpawn": ["bun install --frozen-lockfile"], "devCommand": "bun dev"}`

**cargo** — `{"symlinks": [".env"], "postSpawn": [], "devCommand": "cargo run"}`

**poetry / uv** — `{"symlinks": [".env", ".env.local"], "postSpawn": ["uv sync"], "devCommand": "uv run python -m myapp"}`

**go mod** — `{"symlinks": [".env"], "postSpawn": ["go mod download"], "devCommand": "go run ./cmd/server"}`
