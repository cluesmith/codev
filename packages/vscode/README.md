# Codev for VS Code

Bring Codev's Agent Farm into VS Code — monitor builders, open terminals, approve gates, run dev servers, and manage your development workflow without leaving the IDE.

## Features

- **Unified sidebar** — Workspace, Builders, Pull Requests, Backlog, Recently Closed, Team, and Status in a single pane. Blocked builders are flagged inline in Builders; live item counts appear in view titles.
- **Native terminals** — Architect / builder / shell terminals in the editor area; dev servers in the bottom panel.
- **One-click dev servers** — Start / Stop the dev server for the current workspace or any builder worktree from the sidebar (`Cmd/Ctrl+Alt+R` / `Cmd/Ctrl+Alt+S`). One runs at a time and swaps on demand. Configurable via `worktree.devCommand` in `.codev/config.json` — see the **Dev servers and runnable worktrees** section below.
- **Open Dev URL rows** — surface staging / preview / tunnel links as one-click rows in the Workspace view via `worktree.devUrls`.
- **Per-engineer config overrides** — `.codev/config.local.json` layers your personal settings (local devCommand, tunnel hostnames, staging URLs) over the shared project config without committing them.
- **Per-builder changed files** — expand any builder row to see its diff vs main inline with native SCM-style status badges. Toggle between folder tree and flat list.
- **Gate review** — toast with one-click **Approve** when a builder reaches a human-approval gate, plus inline `REVIEW(@architect):` comment threads on plan / spec files.
- **"Waiting on input" indicator** — a builder whose terminal has been idle for ≥5 minutes outside a gate gets a chat-bubble icon in Builders and is counted in the status bar.
- **Image paste** — `Cmd+Alt+V` / `Ctrl+Alt+V` in a focused Codev terminal uploads the clipboard image to Tower and injects the saved file path into the terminal.

## Requirements

- [Codev CLI](https://github.com/cluesmith/codev) installed (`npm install -g @cluesmith/codev`)
- Tower running (`afx tower start`) or auto-start enabled (default)
- A Codev workspace (`.codev/` or `codev/` directory in your project)

## Getting Started

1. Install the extension
2. Open a Codev project in VS Code
3. The extension auto-detects the workspace and connects to Tower
4. Click the Codev icon in the Activity Bar to see your builders, PRs, and backlog
5. *(Optional)* Add `worktree.devCommand` to `.codev/config.json` to unlock one-click dev servers — see the **Dev servers and runnable worktrees** section below

## Sidebar tour

The Codev sidebar contains seven collapsible views:

- **Workspace** — Open Architect, Open Web Interface, Spawn Builder, New Shell, and Start / Stop Dev Server rows. Any `worktree.devUrls` you've configured appear here as **Open Dev URL** rows.
- **Builders** — every active builder, with status (active / blocked / waiting on input / awaiting). Click a row to open its terminal *and* expand its changed-files list. Right-click for the full builder action menu (see the **Builder actions (right-click)** section below). The title bar carries buttons to toggle accordion mode and tree-vs-list file view.
- **Pull Requests** — open PRs in the repo, with a live count in the title.
- **Backlog** — open issues without a builder. Inline row actions drop the issue's `#<id>` into the architect input, preview the issue, spawn a builder for it, open it in the browser, or copy the issue number.
- **Recently Closed** — recently closed PRs; manual refresh from the title bar.
- **Team** — per-member counts (`Assigned: N`, `Open PRs: N`, `Last 7d: X merged, Y closed`). Manual refresh from the title bar.
- **Status** — connection state; click to reconnect if Tower drops.

## Builder actions (right-click)

Right-click any builder in the Builders view for three grouped action menus:

**Primary**

| Action | Description |
|---|---|
| Open Builder Terminal | Same as left-click — opens the AI terminal in the right editor group |
| Approve Gate | Approve the builder's current human-approval gate (blocked rows only) |
| View Plan | Open the plan file for this builder (PIR builders only) |

**Worktree**

| Action | Description |
|---|---|
| View Diff | Open a single unified diff editor showing `main…HEAD` with a file-list pane and status icons |
| Open Worktree in New Window | Open `.builders/<id>/` as its own VS Code window for native SCM and per-file diffs |
| Open Worktree Folder | Reveal `.builders/<id>/` in Finder / Explorer / xdg-open |

**Dev**

| Action | Description |
|---|---|
| Run Worktree Setup | Re-apply `worktree.symlinks` + `worktree.postSpawn` to the existing worktree (idempotent — use when the lockfile changed or config was extended after spawn) |
| Run Dev Server | Spawn the dev PTY in this builder's worktree; prompts to swap if another dev is running |
| Stop Dev Server | Kill the running dev PTY and close its tab |

## Dev servers and runnable worktrees

Codev can run a single dev server at a time — either for your main checkout, or for any builder's worktree — and swap between them on demand. The single-slot model is deliberate: dev PTYs reuse main's ports so OAuth callbacks, cookies, and webhooks keep working unchanged.

### Starting and stopping

- **For the current workspace** — the **Start Dev Server** row in the Workspace view, or `Cmd/Ctrl+Alt+R`. **Stop Dev Server** (only visible while running) or `Cmd/Ctrl+Alt+S`.
- **For a builder worktree** — right-click the builder → **Run Dev Server** / **Stop Dev Server**.
- Starting one target while another is already running prompts you to swap (the old PTY is killed cleanly, then the new one starts).

### Configuration: `.codev/config.json`

Add a `worktree` block to your project's `.codev/config.json`. Without `devCommand` configured, the Start Dev Server row stays hidden — it would have nothing to run.

```jsonc
{
  "worktree": {
    "devCommand": "pnpm dev",
    "symlinks": [
      ".env.local",
      ".env.development.local",
      "packages/*/.env.local"
    ],
    "postSpawn": [
      "pnpm install --frozen-lockfile"
    ],
    "devUrls": [
      { "label": "Staging",   "url": "https://staging.example.com" },
      { "label": "Storybook", "url": "http://localhost:6006" }
    ]
  }
}
```

- **`devCommand`** — the foreground command that starts your dev server. Run by the sidebar Start Dev Server rows and the CLI (`afx dev main`, `afx dev <builder-id>`).
- **`symlinks`** — glob patterns of files to symlink from the main checkout into each new builder worktree (env files, generated configs, etc.). Symlinks, not copies — edits in main reflect instantly in any running dev session. Root `.env` and `.codev/config.json` are always symlinked regardless.
- **`postSpawn`** — shell commands run sequentially inside each new worktree after creation (e.g. `pnpm install --frozen-lockfile`). A non-zero exit aborts the spawn loudly so the half-built worktree stays for inspection.
- **`devUrls`** — array of `{ label, url }` entries that show up as one-click **Open Dev URL** rows in the Workspace view. Distinct from Open Web Interface, which always points at the Tower dashboard.

### Per-engineer overrides: `.codev/config.local.json`

Create a sibling `.codev/config.local.json` (gitignored) to override or extend the shared config with your personal values:

```jsonc
{
  "worktree": {
    "devCommand": "pnpm dev --port 3001",
    "devUrls": [
      { "label": "My tunnel", "url": "https://amr.ngrok.app" }
    ]
  }
}
```

Both files are watched live — every open VS Code window's sidebar re-renders on save, and the override applies both to what the Workspace view shows *and* to the command Tower actually runs.

### URLs are load-bearing

Dev PTYs use the same ports as your main checkout intentionally — OAuth callbacks, CORS allowlists, cookie scoping, and webhook URLs are all keyed off origin. Before starting a sidebar dev server, stop any manually-run `pnpm dev` first, or the new PTY will fail to bind with `EADDRINUSE`.

### Recipes for other stacks

The pnpm example above adapts directly to npm / yarn / bun / cargo / poetry / go. See [Runnable Worktree Recipes](https://github.com/cluesmith/codev/blob/main/CLAUDE.md#runnable-worktree-recipes) in the project's `CLAUDE.md` for ready-to-paste blocks.

## Layout

```
+------------+----------------+----------------+
| Codev      | Architect      | [42] [43]      |
| (sidebar)  | (terminal)     | Builder 42     |
|            |                | (terminal)     |
| - Workspace|                |                |
| - Builders | Left editor    | Right editor   |
| - PRs      | group          | group          |
| - Backlog  |                |                |
| - Recent   |                |                |
| - Team     |                |                |
| - Status   |                |                |
+------------+----------------+----------------+
| Bottom panel: dev server (when running)      |
+----------------------------------------------+
```

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl+K A` | Open Architect Terminal |
| `Cmd/Ctrl+K D` | Send Message (pick a builder + type a message) |
| `Cmd/Ctrl+K G` | Approve Gate |
| `Cmd/Ctrl+Alt+C` | Toggle the Codev sidebar (show & focus, or close if active) |
| `Cmd/Ctrl+Alt+R` | Start Dev Server (current workspace) |
| `Cmd/Ctrl+Alt+S` | Stop Dev Server (current workspace) |
| `Cmd/Ctrl+Alt+V` | Paste clipboard image into the focused Codev terminal — uploads to Tower and injects the saved file path |

## Commands

All actions are also reachable via the Command Palette (`Cmd/Ctrl+Shift+P`):

| Command | Notes |
|---|---|
| Codev: Open Builder Terminal | Pick a builder |
| Codev: New Shell | Create a persistent shell terminal |
| Codev: Spawn Builder | Issue number + protocol (SPIR / ASPIR / AIR / BUGFIX / PIR / …) + optional branch |
| Codev: Cleanup Builder | Remove a completed builder's worktree |
| Codev: Refresh Overview / Refresh Team | Manually refresh sidebar data |
| Codev: Reconnect to Tower | Re-establish the WebSocket if Tower drops |
| Codev: Connect / Disconnect Tunnel | Cloud tunnel for remote access |
| Codev: Cron Tasks | List, run, enable, or disable cron tasks |
| Codev: Add Review Comment | Insert a `REVIEW(@architect):` comment at cursor |

Right-click actions on builders and workspace rows are listed in the **Builder actions (right-click)** section above.

## When a builder spawns

Whenever a new builder starts (e.g. you ran `afx spawn 42`), the extension can open its terminal for you. Choose how with the `codev.autoOpenBuilderTerminal` setting:

- **Notify** *(default)* — a toast appears with an **Open Terminal** button.
- **Auto** — the terminal opens immediately in the right editor group.
- **Off** — no toast, no terminal. Click the builder in the sidebar when you want it.

## Gate review

When a builder reaches a human-approval gate, a toast surfaces it with the issue and gate context plus a per-gate quick action (View Plan / Run Dev / Review) and an **Approve** button. The seen-toast set persists across reloads, so a still-blocked builder doesn't re-toast on every window reload. Silence the toasts with `codev.gateToasts.enabled: false`.

## Review comments

- **Snippet** — type `rev` + Tab in markdown files to insert a review comment.
- **Command** — `Cmd/Ctrl+Shift+P` → "Codev: Add Review Comment" inserts with the correct comment syntax for any file type.
- **Highlighting** — existing `REVIEW(...)` lines are highlighted with a colored background.
- **Inline threads** — leave `REVIEW(@architect):` threads on plan / spec files via VS Code's Comments API; submit and delete from the gutter.

## Settings

| Setting | Default | Description |
|---|---|---|
| `codev.towerHost` | `localhost` | Tower server host |
| `codev.towerPort` | `4100` | Tower server port |
| `codev.workspacePath` | auto-detect | Override workspace path for Tower matching |
| `codev.terminalPosition` | `editor` | Terminal placement (`editor` or `panel`) |
| `codev.autoConnect` | `true` | Connect to Tower on activation |
| `codev.autoStartTower` | `true` | Auto-start Tower if not running |
| `codev.autoOpenBuilderTerminal` | `notify` | Behavior on builder-spawn events (`off` / `notify` / `auto`) |
| `codev.overviewRefreshSeconds` | `60` | Auto-refresh Builders / PRs / Backlog / Recently Closed every N seconds while the sidebar is visible (`0` = event-only) |
| `codev.gateToasts.enabled` | `true` | Show a toast when a builder reaches a human-approval gate |
| `codev.buildersAutoCollapse` | `true` | Builders view accordion — expanding one builder auto-collapses the others |
| `codev.buildersFileViewAsTree` | `true` | Render a builder's changed-files list as a folder tree (`false` for a flat list) |

## Advanced

- **PIR protocol** — for changes that need pre-PR review of running code (mobile, UI, integration). Exposed in the Spawn Builder picker. See [`codev/protocols/pir/protocol.md`](https://github.com/cluesmith/codev/blob/main/codev-skeleton/protocols/pir/protocol.md).
- **Worktree recipes for other stacks** — npm / yarn / bun / cargo / poetry / go ready-to-paste blocks in [`CLAUDE.md`](https://github.com/cluesmith/codev/blob/main/CLAUDE.md#runnable-worktree-recipes).
