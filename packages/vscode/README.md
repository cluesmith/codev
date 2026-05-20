# Codev for VS Code

Bring Codev's Agent Farm into VS Code — monitor builders, open terminals, approve gates, and manage your development workflow without leaving the IDE.

## Features

- **Unified Sidebar** — Workspace, Builders, Pull Requests, Backlog, Recently Closed, Team, and Status in a single pane (blocked builders are flagged inline in Builders, with live item counts in the view titles)
- **Native Terminals** — Architect / builder / shell terminals in the editor area with full vertical height; dev servers run in the bottom panel
- **Managed dev servers** — start/stop the dev server for the current workspace or any builder worktree from the sidebar; one runs at a time and swaps on demand
- **Gate review** — a toast with one-click **Approve** when a builder reaches a human-approval gate, plus inline `REVIEW(@architect):` comment threads on plan/spec files
- **Live Spawn Notifications** — Get notified (or auto-open a terminal) the moment a new builder starts
- **Status Bar** — Connection state, builder count, blocked gates at a glance
- **Command Palette & shortcuts** — Open terminals, send messages, approve gates, toggle the sidebar
- **Auto-Connect** — Detects Codev workspaces and connects to Tower automatically
- **Auto-Start Tower** — Starts Tower if not running (configurable)

## Requirements

- [Codev CLI](https://github.com/cluesmith/codev) installed (`npm install -g @cluesmith/codev`)
- Tower running (`afx tower start`) or auto-start enabled (default)
- A Codev workspace (`.codev/` or `codev/` directory in your project)

## Getting Started

1. Install the extension
2. Open a Codev project in VS Code
3. The extension auto-detects the workspace and connects to Tower
4. Click the Codev icon in the Activity Bar to see your builders, PRs, and backlog

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

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| Codev: Open Architect Terminal | `Cmd+K, A` | Open the architect terminal in the left editor group |
| Codev: Send Message | `Cmd+K, D` | Pick a builder, type a message, send via Tower |
| Codev: Approve Gate | `Cmd+K, G` | Approve a blocked builder's gate |
| Toggle Codev Sidebar | `Cmd+Alt+C` / `Ctrl+Alt+C` | Show & focus the Codev sidebar, or close it if it's the active view |
| Codev: Open Builder Terminal | | Pick a builder and open its terminal |
| Codev: New Shell | | Create a new persistent shell terminal |
| Codev: Spawn Builder | | Issue number + protocol + optional branch |
| Codev: Cleanup Builder | | Remove a completed builder's worktree |
| Codev: Start / Stop Dev Server (this workspace) | `Cmd/Ctrl+Alt+R` / `Cmd/Ctrl+Alt+S` | Run/stop the dev server for the current workspace (sidebar Workspace rows) |
| Codev: Run / Stop Dev Server | | Run/stop a builder worktree's dev server (builder right-click) |
| Codev: Open Worktree in New Window | | Open `.builders/<id>/` as its own VSCode window |
| Codev: Run Worktree Setup | | Re-apply `worktree.symlinks` + `postSpawn` to an existing worktree |
| Codev: Refresh Overview | | Manually refresh sidebar data |
| Codev: Refresh Team | | Re-fetch the Team view's GitHub data |
| Codev: Connect Tunnel | | Connect cloud tunnel for remote access |
| Codev: Disconnect Tunnel | | Disconnect cloud tunnel |
| Codev: Cron Tasks | | List, run, enable, or disable cron tasks |
| Codev: Add Review Comment | | Insert a `REVIEW(@architect):` comment at cursor |

## When a Builder Spawns

Whenever a new builder starts (e.g. you ran `afx spawn 42`), the extension can open its terminal for you. Choose how with the `codev.autoOpenBuilderTerminal` setting:

- **Notify** (default) — A toast appears with an **Open Terminal** button.
- **Auto** — The terminal opens immediately in the right editor group.
- **Off** — No toast, no terminal. Click the builder in the sidebar when you want it.

## Review Comments

- **Snippet**: Type `rev` + Tab in markdown files to insert a review comment
- **Command**: `Cmd+Shift+P` → "Codev: Add Review Comment" inserts with correct comment syntax for any file type
- **Highlighting**: Existing `REVIEW(...)` lines are highlighted with a colored background

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `codev.towerHost` | `localhost` | Tower server host |
| `codev.towerPort` | `4100` | Tower server port |
| `codev.workspacePath` | auto-detect | Override workspace path |
| `codev.terminalPosition` | `editor` | Terminal placement (`editor` or `panel`) |
| `codev.autoConnect` | `true` | Connect to Tower on activation |
| `codev.autoStartTower` | `true` | Auto-start Tower if not running |
| `codev.autoOpenBuilderTerminal` | `notify` | Behavior on builder-spawned events (`off` / `notify` / `auto`) |
| `codev.overviewRefreshSeconds` | `60` | Auto-refresh Builders/PRs/Backlog/Recently Closed every N seconds while the sidebar is visible (`0` = event-only) |
| `codev.gateToasts.enabled` | `true` | Show a toast when a builder reaches a human-approval gate |
| `codev.telemetry` | `false` | No telemetry collected |
