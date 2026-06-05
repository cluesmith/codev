# PIR Review: Codev Dev surface (bottom-panel tab + always-visible status-bar chip)

Fixes #921

## Summary

Adds two complementary VSCode surfaces for the single `afx dev` PTY so a reviewer can see at a glance whether a dev is running, for which target, and stop/restart it fast without hunting the terminal dropdown. A **`codev.devServer` panel tab** (the first real view in #812's `codevPanel` container) shows a status header — target / live uptime / best-effort port — with title-bar Stop / Restart / Switch Target / Show-Hide-sidebar actions; an always-visible **status-bar chip** (`$(server-process) Dev: <target>`) appears only while a dev runs and clicks through to the tab. Both derive from the one `TerminalManager.onDidChangeDevTerminals` event, and the native `Codev: <name> (dev)` terminal stays as the output surface (coexist), so there is no PTY re-plumbing.

## Files Changed

- `packages/vscode/package.json` (+78 / -…) — `codev.devServer` view in `codevPanel`; 5 command declarations; 4 title-bar menu entries (Stop/Restart gated on running, Switch always, Show↔Hide sidebar toggle); command-palette gating
- `packages/vscode/src/views/dev-server.ts` (+125) — new `DevServerTreeProvider` (status header / placeholder / epitaph rows, 1s uptime ticker, best-effort port)
- `packages/vscode/src/views/dev-server-format.ts` (+72) — new pure helpers `formatUptime` / `extractDevPort`
- `packages/vscode/src/commands/dev-server-actions.ts` (+82) — new title-bar handlers (stop / restart / switch / show / hide)
- `packages/vscode/src/commands/dev-shared.ts` (+86) — `restartDevForTarget`, `listSwitchTargets`, `resolveDevTargetById`
- `packages/vscode/src/extension.ts` (+63 / -…) — register the view; status-bar chip lifecycle; `codev.devServerRunning` key; flip `codev.panelContainerEmpty` false
- `packages/vscode/src/terminal-manager.ts` (+25) — `builderId → startedAt` map + `getDevStartedAt` for uptime
- `packages/vscode/src/__tests__/dev-server-format.test.ts` (+63) — unit tests for the pure helpers
- `packages/vscode/src/__tests__/contributes-dev-server.test.ts` (+80) — contributes/wiring invariants
- `packages/vscode/src/__tests__/contributes-panel.test.ts` (+17 / -…) — updated #812 guards for the now-false key + second view
- `codev/resources/arch.md`, `codev/resources/lessons-learned.md` — see sections below

## Commits

- `1996981f` [PIR #921] Track dev-terminal start times for uptime
- `c80ceb49` [PIR #921] Add pure dev-status formatters (uptime, port) + tests
- `c492354c` [PIR #921] Add DevServerTreeProvider for the Codev Dev panel tab
- `500f899b` [PIR #921] Add dev-server title-bar actions (stop/restart/switch/reveal)
- `9e2520fd` [PIR #921] Wire Codev Dev view, status-bar chip, and context keys
- `a92363f3` [PIR #921] Contribute codev.devServer view, commands, title-bar menus
- `5c73dd9b` [PIR #921] Make Reveal a Codev-sidebar show/hide toggle
- `de9a52ad` [PIR #921] Rename Reveal action to 'Show Codev Sidebar' for toggle symmetry
- `0ef6ad63` [PIR #921] Rename revealInWorkspace command id to showSidebar
- `c3cd9aa1` [PIR #921] Use $(server-process) for the dev chip instead of $(zap)

(plus thread-file updates)

## Test Results

- `pnpm check-types`: ✓ pass
- `pnpm lint`: ✓ pass
- `node esbuild.js` (bundle): ✓ pass
- `pnpm test:unit`: ✓ pass (315 tests, ~17 new across `dev-server-format`, `contributes-dev-server`, and `terminal-manager` — includes the consultation-fix regression guards)
- Manual verification: performed by the reviewer at the `dev-approval` gate against the running worktree — exercised the chip + panel tab, the Show/Hide sidebar toggle, and iterated on the chip icon (`$(zap)` → `$(server-process)`, since `$(zap)` reads as AI) and the toggle's label/command-id naming.

## Architecture Updates

Updated `codev/resources/arch.md`. The existing **Panel view container (#812)** decision noted the panel was scaffolding whose placeholder "hides once real views register" — #921 makes `codev.devServer` the first such view, so I amended that line (the panel now ships non-empty, key seeded `false`) and added a **Codev Dev surface (#921)** key-design-decision bullet documenting the two-surface design, the single-event source of truth, the coexist-with-terminal choice (status surface, not an output mirror), and the `startedAt` map that backs uptime.

## Lessons Learned Updates

Added two UI/UX entries to `codev/resources/lessons-learned.md`:
- VSCode's `StatusBarItem.backgroundColor` honors only `errorBackground` / `warningBackground`; `prominentBackground` as a *background* is silently ignored, so a "prominent, not alarming" chip cue must use the **foreground** (`prominentForeground`) instead. (Verify the API's documented constraint, don't trust a spec's color name.)
- `$(zap)` now reads as the AI/sparkle glyph in VSCode — use a literal glyph (`$(server-process)`) for non-AI features.

The two-command `when`-clause toggle pattern used for Show/Hide sidebar was already captured under #952, so it isn't duplicated.

## 3-Way Consultation (single advisory pass) — findings and dispositions

PIR runs the consultation once (`max_iterations: 1`) with no automated re-review, so each finding below is dispositioned here for the human at the `pr` gate. Verdicts: **Gemini REQUEST_CHANGES**, **Codex REQUEST_CHANGES**, **Claude APPROVE**. Full outputs in `codev/projects/921-*/921-review-iter1-*.txt`.

- **[FIXED — real bug] Manual terminal-close left the surfaces stale (Codex, blocker).** Closing the dev terminal via its tab ✕ (or the dev process exiting) reached only the generic `onDidCloseTerminal` path, which unmapped the terminal but never cleared `devStartedAt` or re-fired `onDidChangeDevTerminals` — so the chip / tab / `codev.devServerRunning` stayed "running." This broke the "dev stops via terminal exit → chip disappears" acceptance criterion. Fixed in `terminal-manager.ts` (fire + clear on the generic path, guarded by `wasTracked` to avoid double-firing with the explicit Stop path). Regression guard added in `terminal-manager.test.ts` (source-level, per that file's documented harness constraint).
- **[FIXED — real plan gap] Missing tab badge (Gemini + Codex + Claude).** The plan called for a `TreeView.badge`; the view was registered via `registerTreeDataProvider`, which yields no handle to set `.badge`. Switched to `createTreeView('codev.devServer', …)` and set `devServerView.badge` while a dev runs (cleared on stop). Contributes test updated.
- **[FIXED — real plan gap] Target name not normalized (Codex).** `OverviewBuilder.id` can be the numeric `status.yaml` id (e.g. `921`), so the Builders-row dev path (`run-worktree-dev`) could render `Dev: 921`. Root-fixed by keying that path on the worktree basename (`pir-921`), matching the afx-dev / Workspace / Switch-Target convention; also added the plan's promised `formatTargetName` pure helper (strips a `builder-` role prefix) with tests, applied in the chip and the tab.
- **[REBUTTED — not a defect] "Reveal in Workspace View" replaced by Show/Hide Sidebar (Codex).** This was an explicit human directive at the `dev-approval` gate (the reviewer asked to make it a toggle and rename it); the plan predates that feedback. Claude classified it as a legitimate iterated deviation. No change warranted.

## Things to Look At During PR Review

- **Chip tint (deliberate deviation from the plan's literal wording).** The plan/issue said `prominentBackground`; the VSCode API only honors error/warning *backgrounds*, so I used `color = statusBarItem.prominentForeground` instead. If a stronger cue is wanted, `warningBackground` is the only API-honored background (the issue called it too alarming). See `extension.ts` `updateDevChip`.
- **Show/Hide sidebar toggle `when` clauses.** They hinge on `sideBarVisible && activeViewlet == 'workbench.view.extension.codev'`. If the Codev container is dragged into the *secondary* side panel, `activeViewlet` won't match and the toggle falls back to always showing "Show Codev Sidebar." Edge case (Codev defaults to the primary activity bar), but worth knowing.
- **Switch Target / Restart target ids.** `listSwitchTargets` / `resolveDevTargetById` use the worktree **basename** (e.g. `pir-809`) as the target id, matching the `afx dev` / Workspace-view convention and the chip display. A dev started via the older builder-row path (`run-worktree-dev`, which uses the overview id) could in principle not match by id — pre-existing inconsistency, not introduced here, and the dominant `afx dev` path is consistent.
- **Best-effort port.** Omitted when not derivable from `worktree.devUrls` / `devCommand` (no guessing). This repo's `devCommand` may not expose a port, so expect the Port row absent here.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-921` → **View Diff**
- **Run dev server**: VSCode sidebar → **Run Dev Server**, or `afx dev pir-921`
- **What to verify** (mapped to the plan's Test Plan):
  - chip appears bottom-left (`$(server-process) Dev: <target>`) only while a dev runs; click focuses the Codev Dev tab; disappears on stop
  - panel tab status header: correct target, live-ticking uptime, port row present only when derivable; placeholder when idle; "Stopped …" epitaph after stop
  - title-bar Stop / Restart / Switch Target behave as labeled; Show ⇄ Hide sidebar toggles correctly
  - target swap updates chip + tab in lockstep
  - #812 placeholder hidden (only Codev Dev shows, not both)
  - Dark / Light / High-Contrast render cleanly
