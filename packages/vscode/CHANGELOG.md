# Change Log

What's changed in the Codev VS Code extension, version by version, written for the developers who use it.

## [3.0.2] - 2026-05-10

### What's new

- **Workspace sidebar view.** New top-level section above Needs Attention with two shortcut rows: **Open Architect** (same as `Cmd+K A`) and **Open Web Interface** (opens the Tower dashboard for the current workspace in your browser).
- **Click a builder row to open its terminal.** Builders and the blocked-row entries in Needs Attention are now actionable — clicking opens that builder's terminal in the editor area, focused and ready for input.
- **Reconnect to Tower from anywhere.** New `Codev: Reconnect to Tower` command in the Command Palette, plus the status-bar `Codev: Offline` / `Codev: Reconnecting…` indicator now triggers a reconnect on click. (#728)
- **Refresh and reconnect icons on the sidebar.** Each Work view (Needs Attention, Builders, Pull Requests, Backlog) has a refresh icon in its title bar, and the Status view has a reconnect icon — so you no longer need the Command Palette to recover from a stale view. (#718)
- **Branded terminal tabs.** Architect, builder, and shell terminals now display the Codev icon on their tab instead of VS Code's default `>_` glyph, so you can tell Codev terminals apart at a glance.

### Bug fixes

- **The extension no longer gets stuck on "Offline" when VS Code starts before Tower.** Previously a failed initial connection parked the extension at `disconnected` with no retry; you'd have to reload the window. It now self-heals within ~30 seconds of Tower coming up, with no user action. (#728)
- **The sidebar now stays in sync with Tower across restarts and crashed builders.** It used to silently show empty even though `afx status` and the Tower dashboard listed your builders correctly. (#718)
- **Clicking a builder row no longer fails with "No active terminal for 153"** (or whatever the issue number was). The sidebar's short ID and Tower's canonical role ID now resolve to the same terminal.
- **Architect terminal opens with keyboard focus.** Whether you launch it from the sidebar, the Command Palette, or `Cmd+K A`, the terminal is ready for input — previously the tab was revealed but not focused.
- **Auto-spawning a builder no longer steals focus from what you were typing.** Background paths (auto-spawn, terminal-link expansion) reveal the terminal without stealing focus; only intentional click actions (sidebar row, link, QuickPick, "Open Terminal" toast) focus.
- **Newly-opened terminal tabs no longer show a blank pane until you press a key.** First-paint priming works around a VS Code rendering quirk where async writes after `open()` could be dropped on a brand-new editor-area terminal.
- **Spawning a builder from a symlinked workspace path** no longer silently mismatches Tower's registered path. (#682-followup)
- **Reopening a builder terminal in rapid succession** no longer occasionally leaks the previous session's connection. (#682-followup)

## [3.0.0] - 2026-04-26

First public release on the Visual Studio Marketplace. Versioned to align with the broader Codev release line (skipping 0.x → 3.0.0).

### What's included

- **Tower connection** — auto-connects on activation, auto-starts Tower if it isn't already running, reconnects automatically if the session drops. Status-bar indicator shows the current connection state.
- **Codev sidebar** — Needs Attention, Builders, Pull Requests, Backlog, Recently Closed, Team, and Status views, populated from your live workspace. Updates automatically when builders are spawned.
- **Embedded terminals** — open the architect, any builder, or a fresh shell as a VS Code terminal backed by Tower. Configurable position (editor area or bottom panel).
- **Command Palette** — spawn builder, send message, approve gate, cleanup builder, refresh overview, connect/disconnect tunnel, list cron tasks, open architect/builder terminals, new shell, add review comment.
- **Keyboard shortcuts** — `Ctrl/Cmd+K A` opens the architect terminal, `Ctrl/Cmd+K D` sends a message, `Ctrl/Cmd+K G` approves a gate.
- **Builder spawn behaviour** — auto-open or notify when Tower reports a new builder spawn, configurable via `codev.autoOpenBuilderTerminal`.
- **Review comment snippets** in markdown.
- **Settings** — configure `towerHost`, `towerPort`, `workspacePath` override, `autoConnect`, `autoStartTower`, `terminalPosition`, and `autoOpenBuilderTerminal`. No telemetry collected.
