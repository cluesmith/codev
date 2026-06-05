# PIR-921 Thread — Codev Dev panel tab + status-bar chip

## Plan phase — investigation (start)

Issue #921: dedicated "Codev Dev" bottom-panel tab + always-visible status-bar chip for the `afx dev` PTY.

### Key findings from investigation

1. **Hard dependency #812 (codevPanel viewsContainer) is NOT landed.**
   - #812 still OPEN; no `codevPanel` in `packages/vscode/package.json` (only the `codev` activitybar container).
   - No branch / sibling builder working on it. So it is not in flight.
   - Issue #921 states it "cannot land until #812 ships." → genuine blocker / fork.

2. **Dev PTY is already a native VSCode terminal tab.**
   - `terminal-manager.ts` opens `Codev: <name> (dev)` as a `CodevPseudoterminal` (WebSocket → Tower) in `TerminalLocation.Panel`. Tracked client-side keyed `dev-<builderId>`; `listDevTerminals()` → `{builderId, terminalId}[]` (no port, no friendly target).
   - `onDidChangeDevTerminals` fires on start/stop/swap → the re-render hook both surfaces will subscribe to.
   - No Tower "dev started/stopped" SSE event; state is inferred client-side.

3. **Technical constraint**: VSCode can't embed a native terminal inside a custom panel webview. "Scrolling PTY output in the tab" ⇒ either xterm.js in a webview re-subscribing to the Tower WS (heavy; loses native search/copy/links) OR plain log lines. Reframes design calls #2 (rendering) and #3 (replace vs coexist).

4. Existing status-bar item: single connection-status item at `extension.ts:56,126` (Left, prio 100). New dev chip is a *second*, independent item (prio 99 per issue).

5. Views are all TreeDataProviders; no WebviewViewProvider exists yet. WebviewPanel (editor tab) precedent: `backlog-search-panel.ts` (theme-safe CSS via `var(--vscode-*)`, CSP nonce, postMessage). Tests: vitest in `src/__tests__/` for pure helpers.

### Forks raised to architect (awaiting direction before writing plan)
- #812 strategy: absorb minimal codevPanel into this PR vs ship chip+commands now & defer the tab vs pause.
- PTY-output rendering + replace/coexist (design calls #2/#3) given the embed constraint.

Design calls #1/#4/#5 will adopt the issue's canonical picks (hide-when-idle / prominentBackground / always-show Switch) unless redirected.

## Plan phase — decision + plan written

Architect decisions (via two AskUserQuestion rounds):
- Use case confirmed: ambient awareness + fast control of the single dev server, NOT terminal fidelity.
- #812 dependency is editorial (consolidation), not technical — but architect chose: **keep #921 whole, write full plan as design-of-record, HOLD for #812.** No implementation now.
- Action: raise #812 for scheduling.

Plan written to `codev/plans/921-vscode-codev-dev-surface-botto.md`. Key design decisions baked in:
- Tab = TreeDataProvider (status header + actions), NOT a webview/xterm. Output stays in the native terminal (coexist).
- Chip = 2nd StatusBarItem (Left, prio 99), prominentBackground, click→focus tab.
- Design calls: #1 placeholder+epitaph, #2 no in-tab output, #3 coexist, #4 prominentBackground, #5 Switch always-shown.
- Implementation gated on #812 (codevPanel container). Files-to-change is the shovel-ready spec for the implement phase post-#812.

Next: commit plan, porch done/next → plan-approval gate pending, notify architect to schedule #812, then hold.

## #812 landed (2026-06-05) — plan updated to active

Architect: hard prerequisite #812 merged (PR #990, c21a112). codevPanel container now on main.
Verified on origin/main:
- `viewsContainers.panel` has `codevPanel` (title "Codev").
- `views.codevPanel` has scaffolding `codev.placeholder` gated by context key `codev.panelContainerEmpty` (seeded true in extension.ts:363).
- Contract (panel-placeholder.ts): a real view registering in codevPanel must flip `codev.panelContainerEmpty` false so the signpost hides. Our `codev.devServer` is the first real tab → must set that key false on register.

Updated plan: removed the "HELD" framing → status now "unblocked, ready to implement"; folded in the panelContainerEmpty integration contract (extension.ts must flip it false; added a contributes test + manual placeholder check); dropped em dashes per new writing guidance.

Gate state: still `plan-approval` gate_pending. I cannot self-approve (strict mode). Plan is accurate and ready; waiting on the human to approve the gate. Implementation will merge origin/main first to get codevPanel, then proceed.

## Implement phase complete (plan-approval approved, #812 merged)

Implemented both surfaces on top of #812's codevPanel:
- `views/dev-server.ts` — DevServerTreeProvider (status header: Target / Running for <uptime> / Port; placeholder + epitaph states; 1s uptime ticker; best-effort port via Tower worktree config).
- `views/dev-server-format.ts` + tests — pure formatUptime + extractDevPort.
- `commands/dev-server-actions.ts` + dev-shared helpers (restartDevForTarget, listSwitchTargets, resolveDevTargetById) — Stop/Restart/Switch Target/Reveal.
- `terminal-manager.ts` — builderId→startedAt map + getDevStartedAt for uptime.
- `extension.ts` — register codev.devServer view; status-bar chip (Left, prio 99) lifecycle on onDidChangeDevTerminals; codev.devServerRunning context key; flip codev.panelContainerEmpty=false.
- `package.json` — codev.devServer view in codevPanel; 4 command decls; 4 view/title menus; commandPalette gating.
- Tests: new contributes-dev-server.test.ts; updated #812's contributes-panel.test.ts for the now-false key + 2nd view.

### Deviation worth flagging at dev-approval
- Chip "prominent" tint: VSCode `StatusBarItem.backgroundColor` ONLY honors error/warning backgrounds (verified in @types/vscode). So `prominentBackground` as a *background* is silently ignored. Implemented the issue's "prominent, not alarming" intent via `color = statusBarItem.prominentForeground` (the icon/text tint) instead. Visually verify at dev-approval; if a stronger cue is wanted, warningBackground is the only API-honored background (issue called it too alarming).

Build: check-types ✓ lint ✓ esbuild ✓. Unit: 310 pass (26 suites). Next: push, porch done → dev-approval gate.

## dev-approval feedback iter-1: Reveal → sidebar toggle

Reviewer feedback: "Reveal in Workspace View" had weak value (navigated from the richer dev tab to the poorer Workspace dev row). Observed its real effect is opening the Codev sidebar. Per direction, repurposed it as a show/hide toggle:
- Open half = `codev.devServer.revealInWorkspace` → `codev.workspace.focus` (opens sidebar + focuses Workspace view). Shown when Codev sidebar is NOT the active/visible viewlet.
- Close half = `codev.devServer.hideSidebar` → `workbench.action.closeSidebar`. Shown when it is.
- Paired via `when` on `sideBarVisible && activeViewlet == 'workbench.view.extension.codev'`, mirroring the Backlog show-all/mine-only eye/eye-closed toggle idiom. Icons $(eye)/$(eye-closed).
Build/lint/types ✓, 311 unit tests ✓. Gate still dev-approval (no porch done re-run; iterating in place).

## Review phase (dev-approval approved)

- Wrote codev/reviews/921-*.md (Summary / Files / Commits / Test Results / Arch Updates / Lessons / Things-to-look-at / How-to-test).
- arch.md: updated #812 panel bullet (codev.devServer = first real panel view → key seeded false) + added "Codev Dev surface (#921)" key-design bullet.
- lessons-learned.md: added StatusBarItem.backgroundColor (only error/warning honored → use prominentForeground) + $(zap)=AI-glyph gotchas. (The two-command when-clause toggle was already under #952.)
- PR #996 opened (body = review file, Fixes #921). Recorded with porch.
- porch structural checks ✓ (pr_exists, review_has_arch_updates, review_has_lessons_updates).
- 3-way consultation (gemini/codex/claude, type=impl) running in background — single advisory pass (max_iterations:1). Next: read verdicts, handle any REQUEST_CHANGES (fix+regression test or rebut; escalate either way), notify architect, wait at pr gate.

## Consultation results (single pass) + fixes

Verdicts: gemini=REQUEST_CHANGES, codex=REQUEST_CHANGES, claude=APPROVE.
- FIXED (real bug, codex blocker): manual dev-terminal close left chip/tab/context stale — generic onDidCloseTerminal now clears devStartedAt + fires onDidChangeDevTerminals for dev terminals (guarded by wasTracked vs double-fire). Regression guard in terminal-manager.test.ts.
- FIXED (plan gap, all 3): tab badge — switched codev.devServer to createTreeView, set devServerView.badge while running.
- FIXED (plan gap, codex): target name — OverviewBuilder.id can be numeric (status.yaml id) → run-worktree-dev now keys on worktree basename; added formatTargetName helper (strips builder- prefix) + tests, applied in chip + tab.
- REBUTTED (codex): reveal→Show/Hide toggle was the human's explicit dev-approval directive; plan predates it (Claude agreed it's a legit deviation).
Build/lint/types ✓, 315 unit tests ✓ (+4). Dispositions recorded in review "3-Way Consultation" section. Next: porch next (record verdicts, fire pr gate), notify architect leading with REQUEST_CHANGES+dispositions, wait at pr gate.
