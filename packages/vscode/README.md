# Codev for VS Code

Bring Codev's Agent Farm into VS Code — monitor builders, open terminals, approve gates, and manage your development workflow without leaving the IDE.

## Features

- **Unified Sidebar** — Needs Attention, Builders, Pull Requests, Backlog, Team, and Status in a single pane
- **Native Terminals** — Architect and builder terminals in the editor area with full vertical height
- **Status Bar** — Connection state, builder count, blocked gates at a glance
- **Command Palette** — Open terminals, send messages, approve gates via keyboard
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
| Codev      | Architect      | [#42] [#43]    |
| (sidebar)  | (terminal)     | Builder #42    |
|            |                | (terminal)     |
| - Attention|                |                |
| - Builders | Left editor    | Right editor   |
| - PRs      | group          | group          |
| - Backlog  |                |                |
| - Team     |                |                |
| - Status   |                |                |
+------------+----------------+----------------+
```

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| Codev: Open Architect Terminal | `Cmd+K, A` | Open the architect terminal in the left editor group |
| Codev: Send Message | `Cmd+K, D` | Pick a builder, type a message, send via Tower |
| Codev: Approve Gate | `Cmd+K, G` | Approve a blocked builder's gate |
| Codev: Open Builder Terminal | | Pick a builder and open its terminal |
| Codev: New Shell | | Create a new persistent shell terminal |
| Codev: Spawn Builder | | Issue number + protocol + optional branch |
| Codev: Cleanup Builder | | Remove a completed builder's worktree |
| Codev: Refresh Overview | | Manually refresh sidebar data |
| Codev: Connect Tunnel | | Connect cloud tunnel for remote access |
| Codev: Disconnect Tunnel | | Disconnect cloud tunnel |
| Codev: Cron Tasks | | List, run, enable, or disable cron tasks |
| Codev: Add Review Comment | | Insert a `REVIEW(@architect):` comment at cursor |

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
