# Change Log

What's changed in the Codev VS Code extension, version by version, written for the developers who use it.

## [3.0.8] - 2026-05-19

### What's new

- **Count badge on the Codev activity-bar icon.** The sidebar icon now carries a numeric badge for builders that need your attention.
- **Builders waiting silently for input now surface as "waiting on input."** A builder whose terminal has been idle for more than 5 minutes, and isn't blocked at a gate or finished, gets a chat-bubble icon in the Builders tree and an `N waiting` segment in the status bar.
- **Single-click a builder row to expand its file list.** Clicking a builder row now opens its terminal *and* expands the file list underneath — previously the expand chevron was a separate click.
- **Send a backlog issue to the architect inline.** Each backlog row has a new inline button that pastes the issue's `#<id>` reference straight into the architect input, no copy-paste step.
- **Issue markdown previews update live.** Leave an issue preview open and it refreshes in place when the underlying issue changes (new comment, label edit, etc.) instead of going stale.

## [3.0.7] - 2026-05-20

### What's new

- **Per-builder changed files, inline.** A builder row in the Builders view is now expandable to the list of files it changed vs the default branch; clicking a file opens its 2-way diff (read-only merge-base base ↔ worktree file). Rows use VSCode's native Source Control look — the file-type icon plus a colored one-letter status badge (A/M/D/R/C/T, plus `!` for unmerged) and tinted label, driven by your theme's `gitDecoration.*` tokens (the built-in Git decorator can't see the gitignored `.builders/` worktrees, so Codev supplies its own). Git is throttled to ~1 spawn / 15s per expanded builder; collapsed builders never run git.
- **Codev: View Diff** — a command + builder right-click that opens a builder worktree's whole delta vs the default branch in VSCode's Multi Diff Editor. Base content is served by a read-only `codev-diff:` provider running `git -C <worktree>` directly, so it works for the gitignored `.builders/` worktrees the Git extension can't discover; handles add/modify/delete/rename/copy and binary files. Coexists with Open Worktree in New Window.
- **Accordion mode for the Builders tree** — expanding one builder auto-collapses the others, so a reviewer never has diffs from unrelated worktrees open at once. Toggle via the new `codev.buildersAutoCollapse` setting (default on), a Builders title-bar button (fold/unfold icon reflects state), or the Command Palette. Builder rows now carry a stable id, fixing expansion being reset on every overview poll.
- **Live-status dot for active builders** — an active builder row shows a green filled dot (the running-process idiom) instead of the old `play` icon that read like a press-to-start button; blocked builders keep the amber bell.
- **Image paste into Codev terminals** — `Cmd+Alt+V` (macOS) / `Ctrl+Alt+V` (Windows/Linux) in a focused Codev terminal uploads a clipboard image to Tower and injects the saved file path into the terminal — the same path-injection UX as the web dashboard and VSCode's own built-in terminal. Codev terminals are `Pseudoterminal`-backed, so VSCode's built-in image-paste bridge never fires for them; this reimplements it (per-OS clipboard read: macOS `osascript`, Linux `wl-paste`/`xclip`, Windows PowerShell). Cmd+V is untouched — normal text paste stays fully native.
- **Backlog hides issues that already have a builder** — an issue with an active builder no longer appears in the Backlog (nor counts toward "Backlog (N)"), so you can't accidentally spawn a second builder for it. Matches the web dashboard. Note `hasBuilder` is machine-local — it reflects this machine's builders, not a teammate's on another machine.

## [3.0.6] - 2026-05-18

### What's new

- **Codev-managed dev server for the current workspace.** New **Start Dev Server** / **Stop Dev Server** rows in the sidebar's Workspace view run `worktree.devCommand` for whatever folder the window is rooted at — the main checkout (CLI: `afx dev main`) or, if you opened a `.builders/<id>/` worktree as its own window, that builder. One dev runs at a time across {main + all builders}; starting another prompts to swap. The two rows are mutually exclusive: **Start** when stopped, **Stop** when running.
- **Dev server terminals open in the bottom panel** (not an editor group). A dev server is a long-running log, not a tab you switch between; `type: 'dev'` terminals now always use the panel regardless of `codev.terminalPosition`. Architect (left group) and builder/shell (right) are unchanged.
- **Builder terminal tabs are labeled by issue** — a builder's tab now reads `Codev: #<issueId> <issueTitle>` (matching its sidebar row) instead of the internal `builder-<protocol>-<id>` agent name. The title is capped at 25 characters on a whole-word boundary (with `…`); the `#<id>` prefix is kept whole. Falls back to the agent name when overview data or a builder match is unavailable. Architect / Shell / dev tab names are unchanged.
- **Team view is a per-member snapshot.** Expanding a teammate shows `Assigned: N` and `Open PRs: N` count summaries plus `Last 7d: X merged, Y closed` — the full issue/PR lists already live in the Backlog and Pull Requests views. A Refresh button in the Team title bar forces a re-fetch (Team otherwise only updates as a side effect of other Tower activity).
- **A symmetric keyboard-shortcut family** — `Cmd+Alt+C` / `Ctrl+Alt+C` toggles the Codev sidebar (opens & focuses it if hidden, closes it if it's the active view); `Cmd/Ctrl+Alt+R` and `Cmd/Ctrl+Alt+S` start / stop the current workspace's dev server. The existing `Cmd/Ctrl+K` A / D / G (open architect, send message, approve gate) are unchanged.
- **Workspace sidebar gained Spawn Builder and New Shell** rows, next to Open Architect and Open Web Interface.
- **Gate-pending toasts with one-click Approve.** When a builder reaches a human-approval gate, a toast surfaces it with a per-gate action (View Plan / Run Dev / Review) and an **Approve** button. The approval dialog now shows the issue + gate context. Silence with the new `codev.gateToasts.enabled` setting.
- **Inline review comments on plan/spec files** via VSCode's Comments API — leave `REVIEW(@architect):` threads in the editor, not only the text snippet.
- **PIR protocol support** — PIR in the Spawn Builder picker, a View Plan action for PIR builders, and context-menu actions scoped per protocol.
- **Open Worktree in New Window** — opens `.builders/<id>/` as its own VSCode window. Replaces the former "Codev: View Diff" (3.0.3), which couldn't reliably render multi-file worktree diffs; a real worktree window gives native SCM + diffs.
- **Builder right-click menu reordered** — primary actions first (open terminal, approve), then worktree actions, then dev actions, grouped so the common ones are at the top.
- **"Needs Attention" is merged into Builders.** Blocked builders are flagged inline in the Builders view (bell icon) instead of a separate section, and gate toasts point at the builder's pane. The standalone Needs Attention view is gone.
- **Live item counts** in the Builders / Pull Requests / Backlog / Recently Closed view titles; Recently Closed gained a refresh button.
- **Backlog is actionable** — "Codev: View Issue" opens an issue in the right pane, assigned-to-me issues are surfaced, and you can click-to-spawn a builder from a backlog issue.
- **Periodic sidebar refresh while visible**, every `codev.overviewRefreshSeconds` (default 60; `0` = event-only, the previous behavior). A shared 30s Tower-side cache throttles GitHub calls across windows.

### Bug fixes

- The sidebar survives SSE event bursts without losing state (last-write-wins in the overview cache).
- Builder terminal tabs close automatically on cleanup instead of lingering as dead "Process exited" tabs.
- Tower PTY dimensions sync on terminal open, fixing wrapped/truncated output.
- Gate-pending toast: the issue title is quoted (no longer reads like an error), and the seen-set persists across reloads so a still-blocked builder doesn't re-toast on every window reload.
- State-change actions (Approve Gate, Cleanup Builder, …) now wait for Tower and refresh the sidebar immediately, instead of leaving it briefly stale.
- Approving a gate from the sidebar targets the correct (canonical) gate name and runs `porch approve` in the right working directory — previously it could mis-resolve for renamed/shared gates or non-root worktrees.
- Clicking a backlog issue reuses a single editor group for the preview instead of opening a new split group on every click after the first.
- Team per-member counts (Assigned / Open PRs / the 7-day merged & closed) now show the true totals instead of silently capping at 20 — they read GitHub's search `issueCount` rather than the length of the (20-node-limited) result list.

## [3.0.4] - 2026-05-13

### Bug fixes

- **Lower `engines.vscode` floor from `^1.110.0` to `^1.105.0`** so the extension installs on Cursor 3.3.30 (VSCode 1.105.1), Antigravity 1.107.0, and AWS Kiro 0.12.184 (VSCode 1.107.1). Windsurf and standard VSCode (≥1.110) are unaffected. `@types/vscode` pinned to `~1.105.0` so tsc validates against the actual supported API surface.

## [3.0.3] - 2026-05-13

### What's new

- **Right-click any builder → six review/test/setup actions.** New context-menu surface on the Codev sidebar's Builders and Needs Attention views (#690), backed by the runnable-worktrees primitives from #689:
  - **Codev: Open Builder Terminal** — opens that builder's AI terminal (same action as left-clicking the row, now also discoverable via right-click).
  - **Codev: Open Worktree Folder** — opens `.builders/<id>/` in the OS file manager (Finder / Explorer / xdg-open).
  - **Codev: Run Worktree Setup** — applies the configured `worktree.symlinks` AND runs `worktree.postSpawn` against the existing worktree (mirrors what spawn does, minus the git steps). Idempotent — existing symlinks are preserved, missing ones added. Use when the lockfile changed and dependencies need reinstalling, when `symlinks` or `postSpawn` was extended after the builder spawned, when a symlink was accidentally deleted, or to recover from an aborted setup. Output streams live. CLI equivalent: `afx setup <builder-id>`.
  - **Codev: View Diff** — opens a single unified diff editor showing `main ↔ <builder>` with a file-list pane and status icons (added / modified / deleted). One tab regardless of how many files changed; matches VSCode's built-in "Working Tree" view. Works across worktrees because each `.builders/<id>/` is a real git worktree sharing the parent repo's object database.
  - **Codev: Run Dev Server** — reads `worktree.devCommand` from `.codev/config.json`, asks Tower to spawn the dev process in the builder's worktree, and opens it as a VSCode terminal tab labeled `Codev: <name> (dev)`. If another builder's dev is already running, a modal asks whether to swap — confirming kills the old PTY, waits for it to exit, then starts the new one.
  - **Codev: Stop Dev Server** — kills the running dev PTY and closes its VSCode tab.
- Each builder action pairs with a CLI equivalent (`afx dev <id>`, `afx dev --stop`, `afx setup <id>`) for users who prefer the terminal. Same Tower API, same conventions.
- **Theme-aware Codev brand icon** on terminal tabs. The single-SVG approach added in 3.0.2 rendered as solid black on dark themes (VSCode doesn't resolve `currentColor` on terminal-tab icons); we now ship `codev-light.svg` + `codev-dark.svg` and pass them as the `{ light, dark }` pair to `createTerminal`.
- **Command palette tightened.** `codev.openBuilderById` is now declared but hidden from the palette (it needs a builder-id arg and would silently fail). `codev.addReviewComment` only appears when a markdown file is active. `codev.helloWorld` renamed to "Codev: Show Connection State" so its palette entry actually says what it does.

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
