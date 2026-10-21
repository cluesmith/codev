# PIR Review: Never activate Codev inside a builder worktree; hide the Agents view there

Refs #1809

## Summary

Opening a builder worktree (`<root>/.builders/<id>`) as a VS Code folder used to make Codev treat the worktree as a workspace of its own. Tower registered it, spawned a stray `main` architect rooted in it, and left rows behind. About 300 `known_workspaces` and 30 `architect` rows had accumulated under `.builders/`. This PR enforces the owner's ruling on both sides:
- **Tower** refuses to activate any builder-worktree path, and prunes the stale rows at boot without ever killing a live session.
- **The extension** never activates a worktree window. It attaches read-only to the parent workspace, renders no Agents view, and keeps every parent-scoped surface off.

One sdk predicate decides "is this a builder worktree?" for both sides.

## Files Changed

- `apps/vscode/package.json` (+1 / -1): the `codev.agents` `when` clause only; no version change
- `apps/vscode/src/__tests__/connection-manager-worktree.test.ts` (+152 / -0)
- `apps/vscode/src/__tests__/contextual-panel-pin.test.ts` (+29 / -0)
- `apps/vscode/src/__tests__/contextual-panel-provider.test.ts` (+75 / -1)
- `apps/vscode/src/__tests__/contributes-view-gating.test.ts` (+6 / -2)
- `apps/vscode/src/__tests__/workspace-detector.test.ts` (+44 / -1)
- `apps/vscode/src/__tests__/workspace.test.ts` (+17 / -0)
- `apps/vscode/src/__tests__/worktree-window-1809.test.ts` (+88 / -0)
- `apps/vscode/src/activity-hooks.ts` (+13 / -1)
- `apps/vscode/src/commands/dev-shared.ts` (+12 / -13)
- `apps/vscode/src/commands/run-workspace-dev.ts` (+10 / -6)
- `apps/vscode/src/connection-manager.ts` (+38 / -5)
- `apps/vscode/src/contextual-panel/messages.ts` (+3 / -0)
- `apps/vscode/src/contextual-panel/panel-provider.ts` (+19 / -5)
- `apps/vscode/src/contextual-panel/pin.ts` (+34 / -0)
- `apps/vscode/src/contextual-panel/webview/main.ts` (+9 / -2)
- `apps/vscode/src/extension.ts` (+38 / -11)
- `apps/vscode/src/terminal-resolve.ts` (+13 / -9)
- `apps/vscode/src/views/workspace.ts` (+52 / -31)
- `apps/vscode/src/workspace-detector.ts` (+59 / -10)
- `codev/plans/1809-never-activate-codev-inside-a-.md` (+366 / -0)
- `codev/reviews/1809-never-activate-codev-inside-a-.md` (new; this file)
- `codev/resources/arch.md`, `codev/resources/lessons-learned.md` (see below)
- `codev/state/pir-1809_thread.md` (+19 / -0)
- `packages/codev/src/agent-farm/__tests__/pir-1809-builder-worktree.test.ts` (+278 / -0)
- `packages/codev/src/agent-farm/__tests__/tower-routes.test.ts` (+35 / -0)
- `packages/codev/src/agent-farm/servers/tower-instances.ts` (+44 / -2)
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (+4 / -1)
- `packages/codev/src/agent-farm/servers/tower-server.ts` (+7 / -0)
- `packages/codev/src/agent-farm/servers/tower-terminals.ts` (+112 / -0)
- `packages/sdk/package.json` (+4 / -0)
- `packages/sdk/src/__tests__/builder-worktree.test.ts` (+65 / -0)
- `packages/sdk/src/builder-worktree.ts` (+61 / -0)

## Commits

- `f1cdd0749` [PIR #1809] Extension: pin the contextual panel to the worktree's own builder
- `6a5e8b2a0` [PIR #1809] Extension: no parent gate/mailbox toasts, counts or badge in a worktree window
- `f94bf4048` [PIR #1809] Test: prune a lone known_workspaces row whose worktree is gone
- `11ed8fce1` [PIR #1809] Thread log: implement phase
- `7fb91ef56` [PIR #1809] Extension: worktree window attaches read-only to parent, hides Agents view, suppresses hooks
- `90dc80d15` [PIR #1809] Tower: refuse builder-worktree activation, keep deactivate reachable, prune stale rows at boot
- `1c4415053` [PIR #1809] sdk: shared builder-worktree path predicate
- `c681cd66f` [PIR #1809] Plan revised: fold main's B/C conditions (deactivate reach, boot order, INFO line, #1803 ordering)
- `769704c75` [PIR #1809] Thread log: plan phase
- `00bf71bc7` [PIR #1809] Plan draft
- Plus one merge of `origin/main` (no conflicts) and porch bookkeeping commits.

## Test Results

- `pnpm build`: ✓ pass.
- `packages/sdk`: ✓ 156 tests (9 new for the predicate).
- `packages/codev`: ✓ 6540 tests pass, 48 skipped (14 new: refusal, accessors, prune, deactivate route).
- `apps/vscode`: ✓ 1215 tests, plus `check-types` and `lint` clean. New tests cover:
  - the connection manager in worktree mode;
  - detector classification;
  - the contextual-panel pin (unit + provider);
  - source-level wiring checks for the parent-scoped surfaces.
- Porch `npm test` check: ✓, run under `umask 022`. See Lessons Learned: `cloud-config.test.ts` fails deterministically under the sandbox's `umask 077` and is unrelated to this change.
- **Manual verification.** The owner verified this in the **development extension host** (F5 debug, which runs the worktree's own build) at head `f1cdd0749`. It was not tested from an installed VSIX, so the VSIX naming confusion during the lane was never part of the verification path. Covered:
  - the worktree-window activation behaviour: no Agents view; trimmed Workspace view;
  - the toast / status-bar-count / activity-badge suppression;
  - the contextual-panel pin.

  The architect confirmed the dev-host bundle carried the pin: `pinSurfaceToBuilder` is in `dist/extension.js`, and the "This window is pinned to" string is in the webview bundle, both built in the same minute as `f1cdd0749`.

## What was built

- **sdk:** `@cluesmith/codev-sdk/builder-worktree`, containing `parseBuilderWorktreePath` and `isBuilderWorktreePath`.
  - Pure string logic, environment-agnostic, with zero dependencies.
  - The last `.builders/<id>` segment wins, matching `deriveWorkspaceFromWorktree`; both separators are accepted.
- **Tower:**
  - `launchInstance` refuses a worktree path, checking both the raw path and the realpath, before adopt, registration or spawn. The error names the parent to activate instead, and `afx workspace start` prints it verbatim.
  - `registerKnownWorkspace` is a no-op for worktrees. Without that, boot reconcile re-registered a live stray it reattached.
  - `getKnownWorkspacePaths()` excludes worktrees, so the listing, cron and activation never see them. The new unfiltered `getAllKnownWorkspacePaths()` is used **only** by `/deactivate`, so `afx workspace stop` still reaches a live stray. This was main's condition on section B.
  - `pruneBuilderWorktreeWorkspaces()` runs at boot, between reconcile and the #341 orphan sweep:
    - Liveness is decided only from the in-memory terminal map and live `terminal_sessions` pids. It never reads `architect.pid`.
    - Rows of non-live worktree paths are deleted.
    - Live ones are kept and WARN-reported with the `afx workspace stop` remedy.
    - It logs one INFO count line per boot.
- **Extension:**
  - `detectWorkspace()` returns a tagged result: a workspace root, or a builder worktree with its parent root and builder id.
  - In a worktree window, `ConnectionManager` uses the parent root for Tower calls, never sends `activate`, and never auto-starts Tower.
  - `codev.isBuilderWorktree` gates `codev.agents` with `when: !codev.isBuilderWorktree`, so the view is absent rather than empty. Non-worktree windows are unchanged, including the empty-window onboarding welcome.
  - Adopted defaults in a worktree window:
    - activity hooks are suppressed;
    - the Workspace view shows only the dashboard, dev and dev-URL rows.
  - The dev target comes from the window root.
  - Added after the owner's dev-gate testing, on the same rule (approved directly by the owner):
    - **No parent-scoped surfaces.** Gate toasts, mailbox-escalation toasts, status-bar builder counts and the activity-bar badge are not activated in a worktree window.
    - **Contextual panel pinned to the window's own builder (option A).** There is no Attention body. Code Review and Builder Inspector only show that builder: diffs are compared by id, terminals are tail-matched via `resolveAgentName`. The existing `builderId === shown` gating still applies on top.

## Architecture Updates

COLD `codev/resources/arch.md`:
- **Invariant 3 (Worktree Integrity):** extended with "a builder worktree is never a workspace". It states what Tower refuses, how a worktree window behaves, and that classification goes only through the sdk predicate.
- **Tower Startup Sequence:** added step 5a, `pruneBuilderWorktreeWorkspaces()`. It runs after reconcile and before the orphan sweep, never signals a process, and relies on the deactivate route keeping its unfiltered list.

No HOT change: the existing hot fact ("Worktrees in .builders/ are Agent-Farm-managed") still holds, the hot file is at its cap, and this detail is reference material.

## Lessons Learned Updates

COLD `codev/resources/lessons-learned.md`:
- **Architecture:** re-pointing a window's data source re-points every consumer of it. The read-only attach made the shared `overviewCache` the parent's, and the owner found the leak at the dev gate as a burst of sibling-lane gate toasts with Approve buttons. The same leak reached the status-bar counts, the badge and the panel's Attention list. When re-pointing a cache or connection, enumerate its subscribers and decide each one.
- **Testing:** `umask 077` makes `cloud-config.test.ts` fail deterministically. Run under `umask 022` rather than skipping or editing the test.

## Accepted deviation (owner-ruled)

The owner's original words were "codev should never activate inside a builder worktree, nor vs code extension agents view render at all". One bounded deviation stands **by decision**: in a worktree window the Agents view may paint briefly before activation, then disappear.
- **Why it happens:** the `codev.isBuilderWorktree` context key is set inside `activate()`, and `when: "!codev.isBuilderWorktree"` is true until then.
- **Why it stands:** a positive-polarity key would also hide the view's pre-activation "Loading Codev…" welcome in every window.
- **Ruling:** the owner ruled "accept the flash" on 2026-10-21. No code change will be made.
- **Detail:** reviewer findings and reasoning are in `codev/projects/1809-never-activate-codev-inside-a-/1809-review-iter1-rebuttals.md`.

## Things to Look At During PR Review

- **Prune location deviation.** The plan put `pruneBuilderWorktreeWorkspaces` in `tower-instances.ts`, but it lives in `tower-terminals.ts`. `tower-terminals` already imports `tower-instances`, and the prune needs `processExists` and the in-memory terminal map, which both live in `tower-terminals`. Putting it in `tower-instances` would have created an import cycle. Only the location changed.
- **Three artifacts, three decay paths.** The architect's pir-1802 teardown evidence showed that a worktree's leftovers decay independently:
  - the `architect` phantom row (shape: `main`, `pid 0`) went away with `afx cleanup`;
  - the `known_workspaces` row survived pointing at a deleted path;
  - two node-pty `spawn-helper` processes (ppid 1, cwd deleted) survived cleanup, worktree removal and branch deletion.

  How this PR handles each:
  - The prune collects candidates from each table **independently**, and liveness is its only test. A lone `known_workspaces` row is pruned whether or not its path still exists or has an architect row, and a test covers exactly that shape.
  - The orphan sweep runs **after** the prune, so liveness is decided before anything is killed.
  - Those `spawn-helper` processes are not shellpers, so neither the prune nor `killOrphanedShellpers` would reap them, and `Unregistered Shellpers: 0` is not evidence of a clean worktree. That gap is outside this lane.
- **Phantom row vs live stray.** These are two different artifacts of the same cause. A pid-0 architect row with no live terminal is pruned. A live stray architect session whose cwd is a worktree is never killed: it is kept, reported, and reachable via `/deactivate`. `afx status` does not list such a session under the parent workspace.
- **`contributes-view-gating.test.ts` was changed.** It pinned "`codev.agents` stays ungated", which is exactly the invariant the owner's ruling reverses.
- **`mainCheckoutRoot` keeps leaf-only semantics,** which an existing test pins, while now going through the shared predicate.
- **#1803 ordering.** #1803 plans a startup re-adopt pass for unregistered shellpers, and it has not landed. When it does, it must run **before** the prune, so a re-adopted worktree architect counts as live. Whichever change lands second rebases.
- **`codev.tower` was traced and left as is.** In a worktree window it renders the whole fleet, the same as every other window, and its Deactivate action is fleet-wide by design. It is not a regression from this change; it was routed out to #1845.

## 3-Way Consultation (single pass)

Verdicts: Gemini **APPROVE**, Codex **REQUEST_CHANGES**, Claude **REQUEST_CHANGES**. Each finding was checked against the source.

**Fixed, with regression tests:**
- **Codex: the WARN remedy failed for an unattached live stray.** A persisted session can have a live pid even though reconcile could not reattach it. `stopInstance` only kills what the in-memory map holds, so `afx workspace stop` did nothing for such a stray, and it was kept forever. The prune now splits live sessions into two groups:
  - **attached**: the WARN gives `afx workspace stop`, which works through the unfiltered deactivate route;
  - **unattached**: the WARN names the id and pid, says `afx workspace stop` cannot reach it, and tells the operator to stop it by pid after confirming the cwd.

  Tower still never signals anything itself. Tests assert both message shapes. This satisfies main's condition that the WARN must name a remedy that works.
- **Claude: `BuilderSpawnHandler` was a missed parent-scoped surface.** In a worktree window its scope check compared the spawn payload with the parent root, so a sibling lane's spawn produced a toast (`notify`) or auto-opened that sibling's live, writable terminal (`auto`). It is not wired in a worktree window now. This is the same rule as the gate and mailbox toasts the owner already approved suppressing. A source-level test covers it.
- **Claude: path spelling in prune liveness.** The in-memory map is keyed by `normalizeWorkspacePath`, and the lookup now tries both spellings. A test covers a DB row spelled differently from its live in-memory entry.
- **Gemini (non-blocking): `resolveDevTargetById`'s local fast path.** It used the parent root. It now uses the window root, so a worktree window resolves its own builder without a Tower round-trip.

**Not changed:**
- **Claude (also raised by Codex): the Agents view can flash before activation.** Accepted by owner ruling; see "Accepted deviation" below.
- **Claude: `terminal_sessions.pid` also counts as liveness.** This errs on the safe side; the only cost is that a reused pid keeps a WARN.

## How to Test Locally

- **View diff:** VSCode sidebar → right-click builder pir-1809 → **Review Diff**.
- **Run the extension:** F5 in `apps/vscode` (development extension host) from this worktree.
- **Run Tower from this build:** `afx tower stop`, then `node .builders/pir-1809/packages/codev/bin/afx.js tower start` from the main checkout. This restarts Tower.
- **What to verify:**
  - **Known, expected behaviour, not a bug:** in a worktree window the Agents view may paint for a moment before disappearing. This is by owner decision; see "Accepted deviation".
  - Tower log: one `Builder-worktree prune:` INFO line, plus a WARN for any live stray. Stale `.builders` rows are gone from `known_workspaces`.
  - Open a builder worktree folder:
    - no Agents view;
    - the Workspace view shows only Open Web Interface, dev and dev-URL rows;
    - no gate toasts, no badge, no builder counts in the status bar;
    - no activate in the Tower log;
    - no new architect in `afx status`.
  - The contextual panel shows the pinned notice; Code Review appears only for this builder's diff.
  - In that window, add, edit and delete review comments in the Markdown Preview of a plan: markers are written to the file.
  - The main window is unchanged: Agents view present, toasts and counts present.
  - From inside a worktree, `node packages/codev/bin/afx.js workspace start` prints the refusal. Don't run this against an old Tower, which would activate the worktree.
