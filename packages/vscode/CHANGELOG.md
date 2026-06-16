# Change Log

## [Unreleased]

### Bug fixes

- **Terminals no longer freeze over time until you restart Tower.** After hours of use, architect and builder terminals could stop rendering output all at once, with a Tower restart the only (and unreliable) fix. The cause was a full-screen TUI (such as the Claude Code prompt) that redraws in place and emits very little newline-terminated output: Tower re-scanned its entire (ever-growing) reconnection buffer on every chunk of output, and the oversized snapshot it sent on connect blew past the terminal's 1 MB receive budget, so the terminal disconnected, reconnected, received the same oversized snapshot, and looped — thousands of times a minute — pegging Tower's CPU and starving every terminal. Tower now processes only each new chunk instead of re-scanning the whole buffer, the reconnection snapshot is delivered in a paced way that no longer counts against the live backpressure budget, a reconnect now asks Tower only for what it missed instead of re-downloading the whole buffer (important when Tower runs remotely), and genuine live overload now drops ephemeral output (the terminal repaints) instead of reconnecting.
- **Terminals no longer open to a blank pane until you resize the window.** Opening an architect or builder terminal could show an empty pane with just a cursor, staying blank until you nudged the window size by hand. A full-screen terminal program only repaints when the terminal size changes, and the size the extension sent on connect could match what the program already had — so it never redrew. The extension now forces a redraw shortly after connecting if the pane is still empty, the same way the web dashboard already does.
- **Terminals no longer render corrupted on open or after the window regains focus.** A terminal could come up with stacked, overlapping status lines and the cursor landing near the top of the pane instead of at the prompt — either right when it opened, or after switching away from the VSCode window (another app, lock screen, a different monitor) and returning. The only fix was to resize the window, clear, or reopen the tab. Two causes: replaying a full-screen program's screen into a freshly-opened pane could paint it into a corrupted state, and while the window is in the background the editor pauses the terminal's renderer so on return its view could be out of step with the running program. The extension now forces a clean redraw (the same one a manual resize triggers) both when a freshly-opened terminal finishes loading its history and whenever the window regains focus, so the pane comes up clean and the cursor lands where it should.

## [3.1.9] - 2026-06-08

Lockstep republish with `@cluesmith/codev@3.1.9` to keep CLI and extension versions aligned. No extension changes from 3.1.8 — see [3.1.8] below for the cycle's substantive content. The npm-side hotfix that triggered v3.1.9 didn't affect the extension; the v3.1.8 marketplace publish is functionally identical to v3.1.9.

## [3.1.8] - 2026-06-08

### What's new

- **Tower version preflight: warn when the running Tower is behind the installed CLI.** The v3.1.7 CLI preflight verified that the installed `codev` CLI was current; this release closes the matching gap on the running side. After an `npm install -g @cluesmith/codev` upgrade without a Tower restart, the installed binary is the new version but the running Tower process is still serving stale handlers from the old code. The extension now probes Tower's in-memory version on connect and shows a `Restart Tower` toast when the two diverge. One click runs `afx tower stop && afx tower start`, polls until Tower comes back up, and re-probes to confirm. The healthy path stays silent (no toast when running matches installed). The CLI-row tooltip in the Status view surfaces both versions alongside each other.
- **Codev Dev surface: bottom-panel tab + status-bar chip.** A new `Codev: Dev` tab in the bottom panel and an always-visible status-bar chip (`$(server-process) Dev: <target>`) make the running dev server visible at a glance. The tab shows target name, live-ticking uptime, and best-effort port; title-bar actions for Stop, Restart, Switch Target, and Show / Hide the Codev sidebar. The chip appears only while a dev is running and clicks through to the tab. The native `Codev: <name> (dev)` terminal stays as the output surface, with the tab and chip layered on top as status surfaces (no PTY re-plumbing).
- **Codev tab in the bottom panel.** A new `Codev` tab joins the bottom panel (alongside Problems / Output / Terminal) as a scaffold for upcoming view migrations (Recently Closed, Team, Status). Opens once on first activation for discoverability, then stays out of the way. The activitybar Codev sidebar is unchanged; this is purely additive. Currently shows a single placeholder row that hides itself automatically once real panel-side views start landing.

### Bug fixes

- **"No active terminal" toast now self-heals and offers a recovery action.** The `Codev: No active terminal for X` toast used to fire once per session as a dead-end warning, then go silent on retry, even when Tower was actively reconnecting. Terminal resolution now runs a short bounded retry before raising any UI, so transient reconnect windows self-heal silently. When retries genuinely fail, the toast carries `Retry` (reattempt) and `Recover Builders` (opens a terminal at the main checkout running `afx workspace recover --dry-run` so the scope can be reviewed before applying — recover is workspace-wide and can revive builders the user didn't mean to touch). The recover terminal's cwd is resolved through the main checkout root even when VSCode is rooted at a builder worktree window, so `afx` runs where it must.
- **Builders no longer briefly flash into `UNCATEGORIZED` during cleanup.** When you cleaned up a builder, the Builders tree used to re-render it under the `UNCATEGORIZED` group for a few seconds before it finally disappeared. The area was re-derived every refresh from the open-issues list, so once the builder's issue was unreachable (closed on PR merge, torn down mid-cleanup, or a failed fetch) the lookup missed and the row fell back to its `Uncategorized` default. The row's `area` now memoizes the last *resolved* value while the issue is reachable, so the builder stays in its real group until the cleanup completes and it disappears for real. No regression for builders whose issue genuinely has no `area/*` label (those continue to live under `UNCATEGORIZED` throughout).
- **Terminal reconnect notice overwrites in place and wipes on reconnect.** The `[Codev: Connection lost. retrying in Xs (attempt Y/6)]` line used to print one fresh `\r\n`-terminated line per retry attempt, stacking notices in scrollback and leaving them orphaned above the resumed output once Tower came back. The line now overwrites itself in place (single line ticking `1/6 → 6/6`) and is cleared the moment the WebSocket reconnects, so a healthy reconnect leaves no trace in the terminal. The red give-up notice (after 6 failed attempts) is unchanged: it stays visible as the terminal's failure state and still carries the clickable `Reconnect` token.
- **Guarded commands always give feedback now; the silent-after-first-click behavior is gone.** Clicking a CLI-dependent command (Spawn Builder, Approve Gate, Send Message, and 12 others) while the Codev CLI is missing or outdated used to produce a modal toast on the first click of the session, then go completely silent on every subsequent click. The first-click modal stays the same (the `Run Setup` action still works); subsequent clicks now show a brief auto-dismissing status-bar message naming the state and pointing at `Codev: Recheck CLI` as the recovery path. Once a recheck confirms `ok`, the next breakage restarts at the modal again.

## [3.1.7] - 2026-06-03

### What's new

- **Codev CLI preflight on startup.** The extension now verifies that the `codev` CLI is installed and at a version at least as new as itself. Missing → opens the new `Get started with Codev` walkthrough (detect / install / verify). Outdated → upgrade notification with one-click `Update via npm`. A persistent **Codev CLI** row in the sidebar's Status view shows the current state with a recheck button.
- **Builders tree groups by stage by default.** Lifecycle stage (`SPECIFY → PLAN → IMPLEMENT → REVIEW → PR → VERIFIED`) is the new default grouping axis for the Builders tree; `area/*` grouping is still supported via a toggle. In stage mode each row reads `[<area>] #<id> <title>`; in area mode the prefix flips to `[<phase>]`. Toggle the axis from either the title-bar (`$(tag)` ↔ `$(milestone)`) **or a control on the group header itself** — both flip the grouping and the row prefix together, and the choice persists per workspace via the new `codev.buildersGroupBy` setting. Backlog grouping is unchanged.
- **Roll-up status icons on `area/*` group headers.** Each area header in the Backlog and Builders trees now carries a status glyph so you can triage at a glance without expanding the group. Backlog: filled-grey dot = area has a builder, outline-grey = open to spawn. Builders: worst-of-three across the group — `bell` (any blocked) / `comment-discussion` (any idle) / `circle-filled` (all active), reusing the row vocabulary. Counts live in the tooltip.
- **Search Backlog editor-tab webview.** A new 🔍 icon in the Backlog view's title bar opens a full editor-tab panel for exploratory triage. Filter by Area / Assignee / Author, substring-search title + body, sort any column, see a match-count footer. Rows open the issue or reference it in the architect chat. Complements (rather than replaces) the always-on sidebar tree and the `Codev: Search Backlog…` Quick Pick.
- **`[new]` prefix on freshly-created backlog rows.** Backlog items created in the last 24 hours now lead with a `[new]` prefix right after the issue number (e.g. `#930 [new] vscode: mark recently-created...`). The prefix drops off automatically as items age past 24h — no per-user "mark as seen" state, no manual dismissal.
- **Click-to-reconnect affordance on terminal give-up.** When a Codev terminal hits its bounded-retry give-up state (the corresponding reconnect-overhaul fix lives under Bug fixes), the red give-up line now carries a clickable `Reconnect` token. One click starts a fresh retry chain from the same terminal — no more close-tab + re-open-from-sidebar dance to recover from a Tower restart or a forgotten session. The click targets the terminal whose line was clicked, not whichever Codev terminal happens to be active when there are multiple open. Repeatable across cycles: if the retry exhausts again, the affordance is still there.

### Bug fixes

- **Terminal reconnect no longer spams "Connection lost" indefinitely.** When the WebSocket backing a Codev terminal closes, the adapter now retries with an exponential backoff (1s → 2s → 4s → 8s → 16s → 30s), prints one line per attempt instead of a wall of identical notices, gives up cleanly after 6 attempts with a red failure line, and fast-paths a permanent "session no longer exists" failure (Tower restart) so you don't wait through 6 retries for an unrecoverable case.
- **Run / Stop Dev Server entries hide when `worktree.devCommand` isn't configured.** The Workspace view always honoured this; the builder-row context menu, dev keybindings (`Cmd/Ctrl+Alt+R`/`S`), and command palette didn't — they would appear on every blocked builder regardless, then fail with a missing-command error on click. All four surfaces (context menu / keybindings / palette workspace-dev / palette builder-row dev) now share one `codev.hasDevCommand` context key that refreshes live on Tower connect + config-update events. Also fixes a latent Workspace-view bug where `"devCommand": ""` would still surface the Start row.
- **Codev sidebar no longer flickers empty during transient connection blips.** The data-bearing views (Builders, Backlog, Pull Requests, Recently Closed) used to all blank simultaneously while the Workspace view stayed populated, then recover on their own. The shared overview cache was overwriting populated data with `null` on transient reads (not-connected state or a failed `/api/overview` fetch); every provider rendered the falsy cache read as an empty list, blanking all four views at once. The cache now holds last-known-good data — only successful fetches commit, and it re-syncs on reconnect. Trade-off by design: a long Tower outage shows *stale* fleet data rather than blanking. A separate "disconnected" visual treatment for the data-views is out of scope.
- **Blocked-builder inline action button no longer reads as "approve."** The `✓` glyph on the inline button (which appears for every blocked builder regardless of which gate they're at) is now a neutral `→` arrow. Behaviour is unchanged — clicking still opens the approve flow — but the icon no longer over-promises "approve" on rows whose underlying gate action is View Plan, Run Dev, etc. Per-gate triage continues to live on the row's leading icon.
- **`Open Builder Terminal` and `Send Message` Quick Picks show issue # + title.** Both palette commands used to label rows with the internal builder name (e.g. `pir-1333`), while the seven other builder pickers in the extension already showed `#909 architect: treat area/*...`. The two outliers now match the established format.

## [3.1.6] - 2026-05-31

### What's new

- **Reference Issue paste includes the title.** Backlog row's "Reference Issue in Architect" action now pastes `#42 "<title>"` instead of just `#42`.
- **Review-comment polish.** Input shows a Codev-specific prompt instead of VSCode's generic placeholder, and comments are attributed to your git identity instead of a hardcoded `@architect`.
- **Open Spec / Open Review row actions.** New entries in the Builders right-click menu, alongside Open Plan. Each hides on protocols that don't produce that artifact.
- **Backlog defaults to your assigned issues.** Title-bar eye icon toggles to show-all and back; choice persists across reloads.
- **Backlog title-count reflects what's visible.** Reads `Backlog (3 of 47)` in mine-only mode, `Backlog (47)` in show-all.
- **`Codev: Search Backlog...` Quick Pick.** New command-palette entry. Fuzzy-match any open backlog issue by id, title, area, or assignee.
- **Backlog above Pull Requests in sidebar order.** User-reordered views keep their custom order.
- **`[<phase>]` prefix on builder rows.** Appears right after the issue number — stays visible when long titles clip.
- **Distinct icons per gate on blocked builders.** Spec, plan, dev, PR, and verify review each get a unique glyph instead of the universal bell.
- **`area/*` grouping in Backlog and Builders trees.** UPPERCASE group headers match VSCode's panel-header convention. Repos without `area/*` labels collapse to a flat list.

### Bug fixes

- **SCM colors on changed-file rows.** Added in green, Modified in yellow, Deleted in red. The 3.1.4 fix shipped against a wrong theory about the Git decorator; new fix uses a synthetic `resourceUri` path that Git's repository lookup ignores.
- **Cleaner Marketplace command titles.** Three entries disambiguated: palette `Codev: Open Builder Terminal...`, row-action `Codev: Open Builder Terminal`, internal `Codev (internal): Open Builder Terminal and Expand Row`.
- **`Codev:` prefix on review-comment commands.** `Codev: Submit Review Comment` and `Codev: Delete Review Comment` — matching the prefix every other command uses.
- **Removed the dead `codev.telemetry` setting.** No-op placeholder. Will reappear with a real consumer if telemetry is ever added.
- **Builder cleanup closes the terminal tab again.** The 3.0.6 fix had silently regressed.

## [3.1.1] - 2026-05-23

### What's new

- **"Open Dev URL" rows in the Workspace view.** Add an array of `{ label, url }` entries under `worktree.devUrls` in `.codev/config.json` to surface dev/staging/preview links as one-click rows in the Workspace view. Clicking opens the URL in your **default browser**. Distinct from "Open Web Interface", which always points at Tower's dashboard.
- **Per-engineer config overrides via `.codev/config.local.json`.** A gitignored sibling to `.codev/config.json` that layers your personal overrides on top of the shared project config — your local staging URLs, tunnel hostnames, etc. stay out of the file everyone else commits.
- **Workspace view live-refreshes on config edits.** Edit `.codev/config.json` or `.codev/config.local.json` and every open VSCode window's sidebar re-renders immediately; no reload needed. Driven via Tower so multiple windows stay in sync.
- **Changed-files view toggles between tree and list.** A new title-bar button on the Builders view switches a builder's expanded file list between a folder tree and a flat list. Setting: `codev.buildersFileViewAsTree`.

### Bug fixes

- **Workspace view detects dev servers started from any source.** Starting a dev from a builder row's right-click context menu now correctly flips the Workspace view's row to "Stop Dev Server" — previously the row stayed stuck on "Start Dev Server" because the check was scoped to this workspace's own target.
- **"Start Dev Server" row is hidden when `worktree.devCommand` isn't configured.** No more click → no-op / error on workspaces that don't define a dev command.
- **`.codev/config.local.json` overrides also apply when actually running the dev command.** Previously the override changed only what the sidebar displayed; the command Tower ran still came from the shared config. Now both honour the layered config.
- **Re-expanding a builder restores its folder tree.** After accordion auto-collapse (clicking a different builder), re-expanding the first builder now re-expands its folders too — not just the top builder row.

## [3.0.8] - 2026-05-20

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
