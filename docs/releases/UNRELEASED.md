# Unreleased

<!--
  TEMPLATE — copy to docs/releases/UNRELEASED.md at the start of each release cycle:

      cp docs/releases/UNRELEASED.template.md docs/releases/UNRELEASED.md

  Edit UNRELEASED.md across the cycle (the working copy). NEVER edit this
  template directly — it's the cold-start structure, untouched between cycles.

  Per-PR architect workflow (on the docs/vscode-changelog branch):
    1. cd worktrees/changelog                       # no fetch / no rebase — branches diverge by design
    2. Add the CHANGELOG entry to packages/vscode/CHANGELOG.md under [Unreleased]
       (add the [Unreleased] heading if it's missing — post-release state removes it)
    3. Add the matching release-notes entry to UNRELEASED.md under the right section:
         substantive change → its own ## section
         small vscode item  → Polish
         non-vscode change  → Other fixes
    4. Commit both files together; plain `git push` (fast-forward, no force)

  Why no rebase, ever: main moves with code merges, docs/vscode-changelog moves
  with changelog/release-notes entries — neither branch touches the other's
  files, so they diverge by design and reconcile at release time via merge.
  Rebasing rewrites commit hashes and forces force-pushes for zero real benefit.

  At release time:
    1. Rename the title to `# vX.Y.Z <Codename>` and add `Released: YYYY-MM-DD`
    2. Replace this entire comment block with the release Summary paragraph
       (one paragraph framing what shipped — lead with the biggest story)
    3. Fill in the Contributors section at the bottom
    4. git mv docs/releases/UNRELEASED.md docs/releases/vX.Y.Z-<codename>.md
    5. Commit, plain push, merge to main alongside the version bump
    6. Re-cp the template back to UNRELEASED.md to start the next cycle
-->

## IDE-mode foundation: dual-mode activation, empty-window surfaces, no more dead actions

(#1144, PR #1148)

Two changes shipped as one layer for the Codev extension.

First: the Workspace section (Architects / Spawn Builder / New Shell) is now gated on `vscode.workspace.workspaceFolders?.length > 0`. Open VS Code with no folder and those rows go quiet instead of pretending Codev is ready to act on an implicit workspace. Empty-view content ("Open a folder to use Codev") takes their place — the same pattern VS Code's own Source Control and Explorer views use for the no-folder state.

Second: a pair of context keys, `codev.hasWorkspace` (whether a folder is open) and `codev.ideMode` (whether the extension is running inside the Codev IDE fork, detected via `vscode.env.appName === 'Codev'`), model the extension's four operating quadrants explicitly. Under `onStartupFinished` activation — required so the extension can serve the fork's every-window case — the guest+no-codev-workspace quadrant is provably inert: no Tower spawn, no UI mutation, no state writes. Marketplace users opening non-codev projects see zero side-effects from having the extension installed, verified by a marketplace-inertness test as part of the PIR review.

In the Codev IDE fork, the `ideMode && !hasWorkspace` quadrant focuses the Codev container on startup, shows Open Folder / Open Recent welcome content, and fires a one-time first-run notification pointing at the CLI-preflight walkthrough. That empty-window surface doubles as the fork's welcome experience — the fork strips VS Code's core onboarding, so this is what users land in on first launch.

## Polish

- **Backlog: "Reference issue in architect" honors the architect QuickPick selection** (#1139, PR #1157). Previously the inline reference button in a multi-architect workspace would show a QuickPick to pick the target architect, then inject the reference into `architect:main` regardless of the pick — the picker was effectively a no-op for the injection. Now the picked architect name flows through to `injectArchitectText`, so the QuickPick selection actually determines which terminal receives the reference. Same fix applied to the sibling "Reference PR in architect" command on Pull Request rows. Single-architect workspaces unchanged — no picker shown, default routing preserved.
- **Sidebar defaults: Pull Requests / Recently Closed / Team / Status now collapsed by default** (#1169, PR #1171). VS Code has no manifest lever for view height ratios — the only lever is collapsing lower-priority views so the primary surfaces get more vertical space. Workspace / Agents / Backlog stay expanded by default (the three surfaces most users work in day-to-day); the other four collapse to just their header row until clicked to expand. Reclaims ~500-700px of default-visible space for the primary views. Existing users' persisted view states are respected — this only affects fresh installs / new workspaces.
- **Agents tree: group headers no longer surface builder-scoped context-menu entries** (#1170, PR #1172). Right-clicking a group header (architect, phase, or area axis) previously showed builder-only actions (View Diff, Open Worktree Window, Open Worktree Folder, Run/Stop Worktree Dev, Open Builder Terminal) with no builder to target — selecting them silently no-ops. Root cause was a contextValue collision: the header's `builder-group` value matched the `^builder-` regex the menu entries gate on. Renamed the group contextValue to `group-<kind>` (from `<kind>-group`) so it no longer collides. Same symmetric fix applied to Backlog group headers.
- **Runnable-worktrees terminology: "Dev Server" → "Dev"** (#1158, PR #1173). The runnable-worktrees feature is stack-agnostic — the `worktree.devCommand` you configure could start a Vite dev server, `cargo run`, `expo start`, a test watcher, a build script, or anything else that iterates on your project. But every user-facing surface used the phrase "Dev Server," which pushed non-web-stack users (CLI / desktop / mobile / systems) to reasonably wonder whether the feature applied to them at all. Renamed VS Code palette titles (`Codev: Run/Stop Dev Server` → `Codev: Run/Stop Dev`), command IDs (`codev.devServer.*` → `codev.dev.*`), context key (`codev.devServerRunning` → `codev.devRunning`), view id (`codev.devServer` → `codev.dev`), and 5 source file names. Also sharpened the surrounding docs prose to explicitly enumerate the range of things a dev command can start, so non-web users can see themselves in the feature. `worktree.devCommand` config field, `afx dev` CLI, and terminal tab name (`Codev: <name> (dev)`) are untouched — they were already neutral. **Breaking change for keybindings**: any user-authored `keybindings.json` entry targeting `codev.devServer.stop` / `.restart` / `.switchTarget` / `.showSidebar` / `.hideSidebar` must be updated to `codev.dev.*`.
- **Agents view (architect axis): childless architects stay visible** (#1174, PR #1175). Previously, an architect's group header vanished from the Agents view the moment its last builder was cleaned up — users had to switch to the Workspace view to find the row again mid-session. Now the architect axis sources its group-header set from the registered-architect roster rather than from `spawnedByArchitect` values observed in the current builders list, so every architect renders regardless of builder count. Childless architects appear as `MAIN (0)` etc. with the same click-to-open-terminal affordance, and get a neutral idle glyph instead of the workload-view attention rollup. Stage and area axes are unchanged (they group builders by builder-intrinsic properties, so "empty group" doesn't apply). Single-architect workspaces are unchanged (the axis picker is still hidden when only one architect exists).
- **VS Code terminal cap: raised to 25 and now configurable via `codev.maxTerminals`** (#1180, PR #1181). The extension's per-window concurrent-terminal cap was hard-coded to 10 (dating from Spec 0602's single-architect sizing) and had become impractical for multi-architect workspaces — main plus 4 sibling architects consumed 5 slots before any builder terminal opened, leaving only 5 for actual builder observation. The cap is now exposed as a `codev.maxTerminals` VS Code setting (default 25, min 5, max 100) so users can raise or lower as their machine allows. The toast that fires at the limit now points at the setting so users hitting it know they can raise the ceiling. Tower's own 100-session backstop is unchanged (defense-in-depth), well above the new client default.

## Other fixes (dashboard, porch, infrastructure)

- **Codex CMAP lane restored on macOS 26** (#1128, PR #1141). Bumps the bundled codex vendor to a signature Apple hasn't revoked. The previous vendored binary's certificate had been revoked by Apple, and macOS 26 XProtect enforces the revocation by SIGKILL'ing the binary at exec time and auto-Trashing it — every `consult -m codex ...` first-run failed with SIGKILL, and subsequent runs failed with `ENOENT` once the binary was gone. The new vendor ships the same tool with a fresh, non-revoked signature (verified via `spctl` and end-to-end round-trip on macOS 26). Any consult protocol that includes a codex lane (PIR CMAP-2, SPIR CMAP-3, general `consult -m codex`) is unblocked again.
- **VS Code extension prepublish builds all workspace dependencies** (#1154, PR #1155). The extension's `vscode:prepublish` script was only building two of its three `workspace:*` dependencies, so a fresh clone → `pnpm install` → `pnpm --filter codev-vscode run check-types` failed with `TS2307: Cannot find module '@cluesmith/codev-artifact-canvas'`. New contributors and CI cold caches hit this. Switched to a topological filter (`pnpm --filter 'codev-vscode^...' build`) that builds the whole workspace-dep graph — future-proof against any new workspace dep re-introducing the same bug.
- **`afx workspace recover` preserves per-builder architect attribution** (#1140, PR #1156). Previously, respawning builders after a Tower recovery event lost each builder's original owning architect — every revived builder got re-attributed to whichever architect owned the shell that ran `afx workspace recover`. Sibling-architect workspaces would lose their per-team builder rosters on the first post-crash recovery pass. Now the recover flow reads each builder's original owning architect from Tower state and preserves it across the respawn, so multi-architect workspaces come back with the correct ownership graph intact.
- **`codev adopt` / main architect launch no longer hijacks unrelated Claude Code sessions** (#1145, PR #1160). Previously, running `codev adopt` in a fresh workspace could resume any Claude Code session that had touched the same directory before — including personal, off-Codev conversations — because the main architect's launch fell back to picking the newest jsonl by mtime in the working directory when no Codev-owned session id was stored. The new main architect would inherit that unrelated conversation state, roleless (the resume path skips role injection). Now the mtime-based fallback is removed for architect launches: main only resumes when a Codev-recorded session id exists in Tower's global.db and its jsonl file still exists on disk. Anything else spawns fresh with a newly minted id, self-healing onto the stored-UUID path on the next launch. Builder resume continues to use discovery because builder worktrees are private cwds with no collision surface.
- **Removed sibling architects no longer resurrect after Tower recovery** (#1150, PR #1178). Previously, an architect deliberately removed via `afx workspace remove-architect --name X` could reappear on the next Tower stop/start if the DB delete had partially failed (SQLITE_BUSY, WAL fsync loss on OS crash) — the residual registration row would drive `launchInstance`'s reconciliation loop to respawn the architect, with its old `--resume`d conversation still attached, silently reverting the user's intent to remove it. Two-part fix: (1) `launchInstance`'s sibling reconciliation now gates each respawn on liveness evidence (matching `terminal_sessions` row OR a session_id whose jsonl exists on disk), pruning dead-registration rows instead of blindly respawning them; (2) `removeArchitect` now purges both layers (registration + terminal_sessions rows) atomically and surfaces DB errors instead of silently swallowing them, so a partial-removal state is retryable via a second `afx workspace remove-architect` invocation. Session-less harnesses (codex, gemini) are treated as live in the liveness gate because their rows never carry a session_id and their terminal rows are wiped on stop — the strict rule would prune legitimate siblings every stop/start.

## Breaking changes

None.

## Install

```bash
npm install -g @cluesmith/codev@X.Y.Z
afx tower stop && afx tower start
```

The VS Code extension ships separately via the Marketplace — `Codev` extension by `cluesmith.codev`, version `X.Y.Z`.

## Contributors

<!-- Filled at release time. Use the topic-first voice from prior release notes:
       - **<Name> (@<handle>)** — <topic>: <what they did across which PRs>.
       - Builders working under AIR / BUGFIX / PIR / SPIR protocols across the PRs in this release.
     Source: git log v<prev>..HEAD --merges --pretty=format:"%h %an %s" -->
