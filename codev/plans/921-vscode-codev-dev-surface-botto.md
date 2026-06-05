# PIR Plan: Codev Dev surface (bottom-panel tab + always-visible status-bar chip)

> **Status: unblocked and ready to implement.** The hard prerequisite #812 (the
> shared `codevPanel` bottom-panel viewsContainer) landed via PR #990 (merged at
> c21a112) and is on `main`. This plan is the design the implement phase executes
> once the `plan-approval` gate is approved. The earlier "held pending #812"
> framing no longer applies.

## Understanding

`afx dev` runs a **single** dev PTY (one slot across `{main + all builders}`,
because they all bind main's ports, so only one can run at a time). Today that
PTY is surfaced only as a generic VSCode terminal tab named `Codev: <name> (dev)`
(`terminal-manager.ts` openDevTerminal: a `CodevPseudoterminal` over a Tower
WebSocket, placed in `TerminalLocation.Panel`). It looks identical to any other
terminal, so a reviewer (typically someone running `afx dev <builder>` to
exercise a builder's running worktree at PIR's `dev-approval` gate) cannot tell
at a glance:

- Is a dev running at all?
- Which target is it? (`main` vs `pir-809`, easy to lose track of across worktrees.)
- How do I stop or restart it fast, without hunting the terminal dropdown or
  opening the Workspace sidebar view (which costs sidebar real-estate each time)?

The Workspace view's Start/Stop Dev row partially addresses this, but only while
the sidebar is on that view. The genuine need is **ambient awareness plus fast
control of the single dev server**, surfaced where it is always visible and
quick to act on.

### The use case is awareness and control, not terminal fidelity

This framing (confirmed with the architect) is load-bearing. The user does not
need ANSI-faithful scrollback, search, or copy in a *new* surface. The existing
native terminal tab already does that well and **stays**. The new surfaces exist
to answer "is it running / which target / stop-restart" at a glance. That rules
out the heavy "re-implement a terminal in a webview (xterm.js plus a second Tower
WS subscription)" path: it adds failure surface and re-implements terminal
features for no use-case gain.

### How this integrates with #812's container

#812 shipped the `codevPanel` container (`viewsContainers.panel`, title "Codev")
plus a scaffolding placeholder view (`codev.placeholder`) gated by the
`codev.panelContainerEmpty` context key (seeded `true` in
`extension.ts`). The documented contract: when a real view registers in
`codevPanel`, it flips `codev.panelContainerEmpty` to `false`, and the
placeholder hides itself. Our `codev.devServer` view is that first real tab, so
the implementation must set that context key `false` on registration. (#813 /
#814 / #815 will do the same as they migrate in; the key is shared scaffolding,
not owned by any one tab.)

## Proposed Change

Two complementary surfaces, both driven off the existing dev-terminal lifecycle
(`TerminalManager.onDidChangeDevTerminals`, `listDevTerminals()`), with the
native terminal tab left intact as the output surface (coexist).

### Surface 1: Codev Dev panel tab (`codev.devServer`)

A **`TreeDataProvider`** (not a webview) registered in #812's `codevPanel`
container. TreeDataProvider is chosen deliberately: it matches every existing
Codev view (`status.ts`, `team.ts`, `recently-closed.ts`), needs no webview /
CSP / xterm machinery, and is the right weight for a status surface. Because the
use case is status plus control (output stays in the native terminal), a tree of
status rows plus title-bar actions fully covers it.

- **Tab title**: `Codev Dev`.
- **Rows (status header) while running**:
  - `Target: <name>` (`main` or `pir-XXX`, from the dev terminal's `builderId`
    mapped to a friendly name; reuse `resolveWorkspaceDevTarget` naming).
  - `Running for <uptime>` (for example `4m 32s`), refreshed every second by a
    timer that fires `onDidChangeTreeData` while a dev is running and is disposed
    on stop.
  - `Port: <n>`, **best-effort**: derive from `worktree.devUrls` / `devCommand`
    config when present; **omit the row entirely if undetectable** (no guessing).
- **Idle / stopped states** (design call #1 plus lifecycle):
  - Never-run / idle: the view shows a single placeholder row
    (`No dev running. Start via afx dev <target> or the Workspace view`). The tab
    is present-but-empty rather than vanishing, so the container tab strip stays
    stable. The chip remains the always-visible "is it running" signal.
  - After a dev stops: an epitaph row (`Stopped. Last target <name>, ran <Xs>`)
    until the user dismisses it or starts another dev. The actual log remains in
    the native terminal, so we do not try to preserve output here.
- **Tab badge**: a small activity dot on the `Codev Dev` tab when a dev is
  running and the user is focused on another `codevPanel` tab (VSCode
  `TreeView.badge`).
- **Title-bar actions** (`view/title`, `group: navigation`, gated by a
  `codev.devServerRunning` context key where the action requires a live dev):
  - `Stop Dev Server` (`$(debug-stop)`) calls `codev.devServer.stop`.
  - `Restart Dev Server` (`$(debug-restart)`) calls `codev.devServer.restart`
    (stop the current target, then start the same target).
  - `Switch Target` (`$(arrow-swap)`) calls `codev.devServer.switchTarget`: a
    Quick Pick of `main` plus builders, reusing the single-slot swap semantics of
    `startDevForTarget`. **Always shown** (design call #5, consistent placement).
  - `Reveal in Workspace View` (`$(eye)`) calls `codev.devServer.revealInWorkspace`:
    focus `codev.workspace` and its Dev Server row.

### Surface 2: status-bar chip

- A **second, independent** `StatusBarItem` (`StatusBarAlignment.Left`, priority
  **99**, left of the existing connection / builder-count item at 100).
- **Visibility**: created when a dev starts, disposed when it stops (driven by
  `onDidChangeDevTerminals`).
- **Text**: `$(zap) Dev: <target>` (for example `$(zap) Dev: pir-809`).
- **Background**: `new vscode.ThemeColor('statusBarItem.prominentBackground')`
  (design call #4, canonical; theme-safe, no hand-coded color).
- **Tooltip**: `Codev dev server running for <target>. Click to focus Codev Dev panel`.
- **Click**: `codev.devServer.focus`, which reveals the `Codev Dev` tab (opens the
  panel if closed, switches to the tab if on another). A thin breadcrumb, no Quick
  Pick layer between chip and tab.

### Shared lifecycle plumbing

- A small client-side map `builderId -> startedAt`, populated when
  `openDevTerminal` fires and cleared on `closeDevTerminal`, so uptime and the
  epitaph "ran Xs" have a start time (`listDevTerminals()` currently carries only
  `{builderId, terminalId}`).
- Both surfaces subscribe to the **single** `onDidChangeDevTerminals` event and
  re-derive state from `listDevTerminals()` (single source of truth). Target swaps
  (stop A, start B) update both surfaces in lockstep because both reads go through
  the same event plus list.

### Resolved design calls (from the issue)

| # | Question | Decision |
|---|----------|----------|
| 1 | Tab when no dev running | Present-but-placeholder (stable tab strip; the chip is the always-visible signal). Post-stop shows an epitaph row. |
| 2 | PTY output rendering | No output rendering in-tab. Status-header tree only; output stays in the native terminal. Justified by the use case (awareness / control, not fidelity). A plain-log tail is a possible future enhancement, explicitly out of scope here. |
| 3 | Replace vs coexist with native terminal | Coexist. The native `Codev: <name> (dev)` terminal stays as the output surface; safest for muscle memory and avoids re-plumbing. |
| 4 | Chip background | `prominentBackground`. |
| 5 | `Switch Target` visibility | Always shown. |

## Files to Change

All under `packages/vscode/`. The branch will first merge `origin/main` to pick up
#812's `codevPanel` container before these changes apply.

- `packages/vscode/src/views/dev-server.ts` (new): `DevServerTreeProvider`
  implementing `TreeDataProvider<vscode.TreeItem>`, rendering the status header /
  placeholder / epitaph rows, owning the 1s uptime refresh timer, exposing
  `onDidChangeTreeData`. Subscribes to `terminalManager.onDidChangeDevTerminals`.
- `packages/vscode/src/views/dev-server-format.ts` (new, pure helpers):
  `formatUptime(ms)`, target-name derivation, port-from-config extraction. Pure
  and unit-tested (vitest, `src/__tests__/`).
- `packages/vscode/src/commands/dev-server-actions.ts` (new): thin command
  handlers `stop` / `restart` / `switchTarget` / `revealInWorkspace` / `focus`,
  delegating to existing `dev-shared.ts` (`startDevForTarget`, `stopDevForTarget`)
  and `terminalManager`.
- `packages/vscode/src/terminal-manager.ts`: add the `builderId -> startedAt` map
  (set in `openDevTerminal` near :220, cleared in `closeDevTerminal` near :244)
  and a getter so the view and chip can read start times. No change to existing
  terminal behavior.
- `packages/vscode/src/extension.ts`: create and dispose the chip `StatusBarItem`
  (driven by `onDidChangeDevTerminals`); register the `codev.devServer.*` commands
  (`regCli` guard); register the `codev.devServer` tree view; set
  `codev.panelContainerEmpty` to `false` once `codev.devServer` is registered (so
  #812's placeholder yields); maintain the `codev.devServerRunning` context key.
- `packages/vscode/package.json`:
  - add `codev.devServer` view inside the existing `codevPanel` viewsContainer
    under `contributes.views`;
  - add the five `codev.devServer.*` command declarations (titles plus icons);
  - add the four `view/title` menu entries (`when: view == codev.devServer`,
    `group: navigation`, plus `codev.devServerRunning` gating where needed).

## Risks and Alternatives Considered

- **Risk: placeholder coexistence with #812.** If our view registers but does not
  flip `codev.panelContainerEmpty` false, both the placeholder signpost and the
  real tab show. Mitigation: set the key false on registration (per #812's
  contract above); covered by a contributes/extension test.
- **Risk: port is often undetectable.** `listDevTerminals()` carries no port and
  there is no stdout parsing today. Mitigation: best-effort from config only, omit
  the row when unknown rather than guess. Acceptance is written as "port if known".
- **Risk: uptime needs a start timestamp not currently tracked.** Mitigation: the
  small `startedAt` map in `TerminalManager`; if a dev predates extension
  activation (reconnect), show `Running` without a duration rather than a wrong one.
- **Risk: the two surfaces drift out of sync on swaps.** Mitigation: both derive
  from the single `onDidChangeDevTerminals` plus `listDevTerminals()`, with no
  independent state.
- **Risk: regressing the Workspace view's dev row.** Mitigation: this PR only adds
  surfaces and reads the same `listDevTerminals()`; no change to `workspace.ts`'s
  row logic. Covered by the test plan.
- **Alternative: xterm.js webview plus replace the native terminal (design call
  #2/#3 heavy path).** Rejected: re-implements terminal features for no use-case
  gain, adds a second WS subscription and CSP / webview surface. The native
  terminal already serves output.
- **Alternative: ship chip plus commands first, defer only the tab.** Technically
  viable (the chip has no #812 dependency) and was proposed; the architect chose to
  keep #921 whole. Now moot since #812 has landed. Recorded for history.

## Test Plan

The reviewer exercises this at the `dev-approval` gate, running the worktree via
`afx dev <builder>` or VSCode's Run Dev Server.

- **Unit (vitest, `src/__tests__/dev-server-format.test.ts`)**: `formatUptime`
  (seconds, minutes, `4m 32s`, hour rollover, 0s edge); target-name derivation
  (`main` vs `pir-XXX`); port extraction (present in config yields value, absent
  yields null / omit).
- **Unit (contributes)**: `codev.devServer` is declared in the `codevPanel`
  container; extension registration flips `codev.panelContainerEmpty` false
  (mirrors #812's existing `contributes-panel.test.ts`).
- **Manual, chip**: start `afx dev main` and `afx dev <builder>`; the chip appears
  bottom-left as `$(zap) Dev: <target>` with the prominent tint; tooltip correct;
  click focuses the Codev Dev tab (opening the panel if closed). Stop, the chip
  disappears.
- **Manual, tab**: the status header shows the correct target, live-ticking uptime,
  and port when derivable (omitted otherwise); title-bar Stop / Restart / Switch
  Target / Reveal-in-Workspace each behave as labeled; the activity-dot badge shows
  when running and focused on another `codevPanel` tab; the post-stop epitaph row
  appears.
- **Manual, swap lockstep**: with `pir-809` dev running, Switch Target to `main`;
  both the chip and the tab update to `main` together; the single-slot swap prompt
  fires as today.
- **Manual, Workspace view parity**: the existing Start/Stop Dev row reflects the
  same state; no regression.
- **Manual, placeholder**: with #812's placeholder present, registering our view
  hides the signpost (only `Codev Dev` shows, not both).
- **Themes**: the chip and tab render cleanly in Dark, Light, and High-Contrast
  (ThemeColor / theme CSS vars only, no hand-coded colors).

## Dependency and Sequencing

1. #812 (`codevPanel` container) has landed (PR #990, c21a112). No longer blocking.
2. Implementation merges `origin/main` first to pick up `codevPanel`, then proceeds
   per Files to Change above, honoring the `codev.panelContainerEmpty` contract.
3. No sibling dependency on #813 / #814 / #815. They are independent tabs in the
   same container, any order.
