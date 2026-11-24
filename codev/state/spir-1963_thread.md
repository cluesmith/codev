# spir-1963 thread — VS Code alternative layout ("Codev Cockpit")

## 2026-11-23 — Specify

No spec existed; wrote `codev/specs/1963-vscode-alternative-layout-seco.md` from the issue.
The issue has no "Baked Decisions" section, but its "Prescribed design choices" are copied into
Constraints as settled.

Findings that shaped the spec:
- Much Agents-view behaviour is bound to the `codev.agents` TreeView *instance* in `extension.ts`
  (click-expands reveal, accordion, active-file reveal, agent-cycle select, badge, title count), and
  every menu `when` names the source view id. A combined view needs that wiring generalised to "the
  view the row is in" — the main risk on the panel side.
- Work/Decisions components hard-import `apps/web/src/lib/api.ts` (relative URLs, injected key,
  localStorage). Sharing them needs a host-adapter seam; recommended a new shared package on the
  `codev-artifact-canvas` pattern.
- The SDK `TowerClient` has no decisions methods, and its `request()` drops non-2xx bodies — the
  decisions refusal `{ok:false, code, message}` needs preserving.
- `window.open` doesn't work in VS Code webviews (no allow-popups) → Decisions' links/full-size
  images need host equivalents.
- Verification must not replace the owner's live IDE extension — isolated instance + fixture
  workspace.

Open points resolved with recommendations, for confirmation at spec-approval: trigger = first show
per window + command; `terminalPosition: panel` overridden for the arrange action; no split/Work/
Decisions in a builder-worktree window (#1809).

## 2026-11-23 — Spec consultation (iter 1) → spec-approval

Codex COMMENT, Claude REQUEST_CHANGES — all points accepted, none disputed (rebuttal in
`codev/projects/1963-*/1963-specify-iter1-rebuttals.md`). Main changes:
- Menus: existing source-view entries left byte-for-byte; the combined view gets mirrored entries
  guarded by a generated parity test (widening `when`s would have broken `contributes-tower.test.ts`).
- Freshness: the combined view and the Work panel count toward the existing periodic-overview
  visibility gate — otherwise the Cockpit freezes whenever the Codev container is hidden.
- Own provider instances over shared caches (per-view accordion/reveal state).
- Added `codev.cockpit.autoArrange` (default on); defined "window session" (ends at reload);
  connection/failure states; canonical-path + http(s)-only host checks; commands stay in the
  palette in worktree/no-workspace windows and explain themselves.

Stopped at spec-approval.

## 2026-11-24 — Owner revision at the gate: one hierarchy

Owner: combined panel is ONE hierarchy — "towers -> workspaces -> architects / decisions ->
builders" — not three sections. Spec otherwise approved as drafted ("Other than that spec sounds
good"); porch approve is waiting on the architect's go after checking the revision.

What the data check found:
- TowerFleetCache already fetches getOverview(path) for every active workspace and discards it
  after deriving attention — retaining it gives every workspace's architects + builders
  (spawnedByArchitect) with no new requests or routes.
- Overview has nothing about the decisions file → no pending count without an additive Tower field.
- All actions (TerminalManager keys/URLs, #1497 resolution, every builder command, diff cache) are
  scoped to the window's own workspace → spec makes other workspaces' rows navigate (open that
  workspace's window); fully cross-workspace action is offered as a gate question / follow-up.
- Attention rows fold onto the rows they concern; stage/area grouping stays in the Agents view;
  dev URLs move to an "Open Dev URL…" context entry on the workspace row.

Revision committed; re-consult (codex + claude, manual — porch is at the gate) running.

## 2026-11-24 — Hierarchy revision re-consult

Codex REQUEST_CHANGES, Claude COMMENT on 76e1dc498; all accepted (rebuttal:
`1963-specify-revision1-rebuttals.md`). Main changes: remote item images are direct `<img>` loads
(CSP img-src gains `http:`; no connect-src), other workspaces' rows get navigate-only
contextValues, the parity test has a checked-in mapping oracle, an Increments subsection (button +
hierarchy → shared package + panels → arrange), active workspace rows click-expand (Open moves to
the inline action), Tower root shows "Not connected to Tower" + Reconnect after the first failed
attempt (ConnectionManager retries forever, never gives up), Loading… child before an overview.
New owner question offered, not specced: a one-time notice on the first auto-arrange.

## 2026-11-24 — Spec approved → plan

Owner approved the spec ("go with your recommendation" on all four): other workspaces navigate-only
(acting in place → #1969), no Decisions pending count (→ #1970), dev URLs as "Open Dev URL…", and
ADD the one-time first-auto-arrange notice. Rulings recorded in the spec (95029fd66); ran
`porch approve 1963 spec-approval` on the architect's relay.

Plan gate is pre-approved by the owner for a plan that implements the approved spec; I still wait
for the architect's go (after their check) before `porch approve 1963 plan-approval`.

Plan (9475ca950): 8 phases on the spec's 3 increments —
1 fleet-cache overview retention · 2 `ArchitectTreeBuilder` extracted from BuildersProvider
(scoped ids, act/navigate modes; Agents ids byte-identical) · 3 Cockpit container + hierarchy +
generalised tree wiring · 4 placement-table menus + parity mapping oracle + rendered check ·
5 `@cluesmith/codev-workspace-views` (source-exported, host adapter, `--codev-wv-*` tokens),
dashboard on wrappers · 6 SDK decisions methods + Decisions panel + Decisions entry · 7 Work panel ·
8 spike then Arrange Cockpit + triggers + notice.
Verification harness: isolated Tower (non-default port, own CODEV_AGENT_FARM_DIR) + `code serve-web`
with isolated data/extension dirs + fixture repos — never :4100 or the owner's /ide/.
Finding while planning: builder rows show no held/queued today, so those counts are Cockpit-only
(an `attentionCounts` option) to keep Agents byte-for-byte.

## 2026-11-24 — Plan consultation → plan-approval

Iter 1: Codex REQUEST_CHANGES, Claude COMMENT. Iter 2: both COMMENT. All points accepted (rebuttals
`1963-plan-iter{1,2}-rebuttals.md`). Things the reviews caught that the code confirmed:
- `requestPreservingBody` reads text → decision images need a binary request path.
- `/api/overview` lists only builders with a LIVE builder terminal, and `spawnedByArchitect` comes
  only from global.db's `builders` row → the harness spawns fixture builders for real
  (`afx spawn --task`, `CODEV_ARCHITECT_NAME`, plain-shell `shell.builder`) against an isolated
  Tower; gate asserts attribution before screenshots.
- `removeArchitect` falls back to the display label (`WEB (0)`); Cockpit architect rows need
  main/sibling context values.
- Hidden retained webviews still report `visibilityState === 'visible'` → host relays panel
  visibility into `useDecisions`' `isActive`.
- Existing webviews use `style-src 'unsafe-inline'`; BuilderCard needs it.
- Windows path cases + windows.yml dispatch for the containment code.

At plan-approval. Owner pre-approved the plan; waiting on the architect's check and go.

## 2026-11-24 — Harness revision (architect: "no go yet")

The architect caught that the plan's `afx spawn --task` "against the isolated Tower" could not have
worked, and the code confirms it:
- `spawn.ts:110` and `spawn-worktree.ts:738` use `getTowerClient()` with no port, so they go to the
  literal 4100;
- there is no env override and no `--port`.

Seeding a ported client in-process doesn't save it either:
- spawn shells out to `porch init` (`spawn-worktree.ts:490`);
- porch's dispatcher then posts `refreshOverview` via `new TowerClient()` to :4100 (`porch/index.ts:1505`).

Other default-port paths:
- `afx tower start`, `workspace add-architect` and notifications;
- the extension, which shells out to `afx` and `porch` (spawn, approve, cleanup, auto-start);
- the extension reads `~/.agent-farm/local-key` unless `CODEV_TOWER_KEY` is set.

**Chosen mechanism: harness-only, no product change.** The harness runs no Tower-contacting CLI
command:
- **Tower:** `tower-server.js -p $PORT` directly, with `CODEV_AGENT_FARM_DIR` and
  `SHELLPER_SOCKET_DIR` (the default socket dir is the owner's `~/.codev/run`).
- **Fixtures:**
  - activation and add-architect over HTTP to the explicit port;
  - porch state and `upsertBuilder` in-process, with the db path pinned and checked;
  - builder terminals via `POST :$PORT/api/terminals`;
  - `afx decisions init`, which is file-only.
- **VS Code:**
  - `CODEV_TOWER_KEY`, `codev.towerPort` and `autoStartTower=false`;
  - recording PATH stubs for `afx`, `porch` and `codev`, so CLI-shelling actions are verified by
    their recorded argv.
- **Safety checks:** a pre-flight that refuses 4100 and checks the listener PID, plus a :4100
  connection tripwire.

**Re-review:** Codex REQUEST_CHANGES, Claude COMMENT. Changes taken:
- the harness became **Phase 1**, with self-tests proving every refusal and the tripwire;
- the layout spike moved into Phase 1 (Codex wanted it before plan approval; offered to the
  architect). b/c/d failures go to the owner, and Phase 9 waits;
- the Cockpit holds the worktree config off `codev-config-updated`, so the request count matches;
- WorkView's `DashboardState` prop leaves the shared surface, and the file-panel slot is the whole
  wrapper;
- the package declares its own test devDependencies and the lockfile changes with them;
- the smoke test builds its own bundle, since CI never builds `dist`.

Phases are now 1–9. Rebuttals are in `1963-plan-harness-rebuttals.md`.

## 2026-11-24 — Layout spike, run before plan approval (architect: strict reading)

Setup: an isolated `code serve-web` on :18763, VS Code 1.147.0. The CLI, server, user and
extensions dirs were all in the scratchpad. A throwaway extension was driven by headless Chromium
from the existing Playwright cache, with no install. There was no Tower, and the serve-web tree had
no :4100 connection. All processes were stopped by PID.

**All four cases held:**
- **(a)** `setEditorLayout` over 5 groups gave 3 (left | top/bottom). Nothing closed, all text was
  intact and dirty stayed dirty. It is idempotent.
- **(b)** An editor terminal moved from group 3 to group 1 with the same PID and shell.
- **(c)** A panel terminal went to the editor area (`moveToEditor`) and then to group 1, intact.
- **(d)** A retained webview moved while visible and while hidden, with no reload (same load id).

**Design fact:** removed groups merge into the LAST group (bottom-right = Decisions). So arrange
reveals Decisions after the layout call.

**Harness lessons from the first run:**
- web defaults `files.autoSave` to afterDelay, which silently saved the "modified" fixtures;
- Restricted Mode raises a trust modal on terminal creation, which hung case b.

Both are now in the harness section. A side gotcha: zsh doesn't word-split `$PIDS`, so a
`kill $PIDS` silently did nothing. I killed per PID instead.

The evidence is in `codev/projects/1963-…/layout-spike/`.

## 2026-11-24 — Phase 1 (verification_harness): harness built, self-test green

I told the architect before the first isolated Tower start. Their OK came at 07:02Z, and they
accepted two deviations:
- **Scratch HOME** for every harness child (Tower, driver, serve-web, browser). This is an extra
  layer beyond the plan.
- **The socket dir is a short `/tmp/cckp-<random>` symlink** to `<scratch>/cockpit-harness/run`.
  macOS caps a Unix-socket path at 104 bytes, and the scratchpad path alone is 135, so a socket dir
  literally under the scratchpad cannot work.
  - Gate 2 checks the realpath, and also checks the socket-path length.
  - Teardown removes the link even after a failed start (the architect's condition).
  - Standing order: if pre-flight or the tripwire fires in a real run, stop and tell the
    architect before retrying.

Findings that shaped the code:
- **Plain-shell fixtures.** A `bash` architect auto-detects the **claude** harness and would be
  handed claude's session and role args. So each fixture's `.codev/config.json` names a no-op custom
  harness (`roleArgs: []`, `roleScriptFragment: ""`).
- **No adopt.** `launchInstance` runs `npx codev adopt` when `codev/` is missing, so fixtures always
  carry `codev/`. The driver fails if activation reports `adopted`.
- **Builder terminals.** `POST /api/terminals` only registers a builder (shellper-backed) with
  `persistent: true`, which the plan table omitted. The driver requires `persistent === true` in
  the response.
- **Machine settings.** User settings in serve-web live in the browser, so the harness writes
  `<user-data-dir>/Machine/settings.json`. Restricted Mode ignores the `codev.tower*` settings only
  from *workspace* settings, so Machine settings still apply.
- **Allowlisted environments.** Child environments are built from an allowlist, so no `CLAUDE_CODE_*`,
  `VSCODE_*`, `CODEV_*`, `NODE_ENV` or token variables leak in.

`harness.mjs selftest` passes all 14 cases:
- gate 1: port 4100, a non-numeric port, and a port that already has a listener;
- gate 2: `~/.agent-farm`, an agent-farm dir outside the scratchpad, `~/.codev/run`, a socket dir
  outside the scratchpad, and an over-long socket dir. Each refuses with nothing created;
- gate 3: a `NODE_ENV=test` driver against a real production-mode isolated Tower refuses, and no
  `test.db` or fixture is created;
- gate 4: a foreign listener refuses;
- teardown by PID, with the link removed;
- the tripwire ignores a connection from outside the tree, and fires (exit 3) on one from a harness
  child.

**Acceptance run from the committed tree (541d60aa0).** I rebuilt the vsix, then ran selftest
(14/14), start, check (10/10), `seed one-builder` (gate 6 shows `builder-spir-101` spawned by
`main`), check again (10/10), and stop (15 PIDs killed, none left, link removed, no listeners). The
workbench renders Agents (1) → SPECIFY → #101 fixture-one from the isolated Tower.

Two things the first live checks caught:
- The trust banner and status item render after the Codev activity-bar item, so trust is now
  detected by `#status.workspaceTrust` once the Codev status item has appeared.
- In 1.147 the Workspace Trust editor is a *modal* editor that blocks clicks, so it is closed with
  Escape.

Separately, the extension activates `alpha` on the isolated Tower by itself when it loads, so
`main` exists before any seed. That is expected and harmless.

### Phase 1 review, iteration 1 (2026-11-24)

- Checks: `porch done` ran the full suite once (build 17.1s, tests 54.0s), and it passed.
- Codex asked for changes. The plan's IDE-server alternative to serve-web was missing. I added
  `COCKPIT_VSCODE=ide-server` with `COCKPIT_IDE_SERVER_BIN`. It launches the VS Code Server
  binary directly with `ide-server.ts`'s flags, all under the scratchpad. The mode is explicit,
  never an automatic fallback, per the fail-fast rule. Verified `start`, `check` 10/10 and
  `stop` (10 PIDs, none left) in that mode.
- Claude approved, with non-blocking notes, and I took them all:
  - the tripwire now starts before the Tower launch;
  - the README now says the tripwire is a detector, not the enforcement;
  - the README now says seeding is once per `start`;
  - removed an unused import;
  - honour `PLAYWRIGHT_BROWSERS_PATH`;
  - two new gate-1 self-test cases.
- Re-verified in serve-web mode. Self-test 17/17, `start`, `check` 10/10, `seed one-builder`
  (gate 6: `builder-spir-101` spawned by `main`), `check` 10/10, `stop` (15 PIDs, none left).

### Phase 1 review, iteration 2 (2026-11-24)

- Both reviewers approved (Codex with no issues). I took Claude's non-blocking notes before
  advancing, because one would have broken later phases:
  - **vsix freshness.** `check` called any uncommitted input edit stale and missed untracked
    files. So every edit, `build-vsix`, `check` cycle in Phases 5, 8 and 9 would have shown a
    spurious FAIL. `build-vsix` now records a content digest of every tracked or untracked input
    file, and `check` compares it. Verified all four cases: clean build passes; a file added after
    the build fails only the vsix item; a change built in passes; removing it fails again.
  - **Tripwire cost.** One sample is about 0.3 s of `ps` plus two `lsof` calls, so sampling at
    1 s kept about a third of a core busy. Now it samples every 2 s and runs the machine-wide
    `lsof -U` every 5th sample. Shellpers stay covered between scans as descendants of the live
    Tower.
  - The socket-prefix match now needs a trailing `/`.
  - The README now explains why `selftest` needs the web port (its refusal cases run real `start`).
- Full suite: the architect's standing rule (decision ide-1, 07:27Z) allows `porch done`'s suite
  without asking when the 1-minute load is under 6 and no other vitest is running, checked right
  before.
  - Iteration-1 rebuttal run: load 2.55, passed.
  - Iteration-2 run: I waited out a load of 8.18; at 4.85 it passed.

### Phase 2 (`fleet_overviews`), iteration 1 (2026-11-24)

- `TowerFleetCache` now keeps the overview it already fetched for each active workspace, instead
  of discarding it after `deriveAttention`.
  - `FleetEntry` gains `overview: OverviewData | null`.
  - A new `lastOverview` map holds the last-known-good overview, next to `lastAttention`.
  - A new `getOverview(path)` accessor returns it.
- Behaviour:
  - A failed (`null`) fetch keeps the previous overview.
  - A dormant workspace gets `null` and drops what it had. A reactivated workspace whose first
    fetch fails does not get its pre-dormancy overview back.
  - A workspace that leaves the list is dropped.
  - A transiently empty list keeps everything, as before.
- No new requests: per refresh there is still one `getOverview` call per active workspace.
- I changed two files outside the plan's list, `tower-provider.test.ts` and
  `switch-workspace.test.ts`. Their `entry()` helpers build `FleetEntry` literals, and `tsc`
  type-checks the tests, so the helpers needed the new required field. It was a one-line change
  in each.
- The stale-fan-out test calls the private `fetchFleet` directly. `refresh()` serialises
  fan-outs, so through the public API the sequence guard is only a backstop and the race cannot
  be reached.
- Mutation-checked: removing the sequence guard, the map rebuild, or the retain-on-null each makes
  its matching test fail.
- `check-types` and `lint` are clean, apart from the two pre-existing `curly` warnings.
  `test:unit` passed 1293/1293.
- `porch done` checks passed: build 15.6 s, tests 56.4 s, at a 1-minute load of 3.44 with no other
  vitest running.
- Review: Codex and Claude both approved with high confidence, and neither raised a blocking issue.
  - Taken now: Claude's note that the accessor hands out the cached object by reference. The doc
    comments on `FleetEntry.overview` and `getOverview` now say it is read-only.
  - Carried into Phase 4, not changed here:
    - The window's own workspace is retained twice, in `OverviewCache` and in the fleet cache. The
      Cockpit must keep reading `OverviewCache` for it, as the spec says. Reading the fleet copy
      would lag.
    - The fleet cache keys by Tower's path spelling. Phase 4's current-workspace match must use
      the existing `isSameWorkspacePath` (`fleet-order.ts`), as `orderFleet` does, and a test should
      assert it.

### Phase 3 (`architect_tree_builder`), iteration 1 (2026-11-24): row building moved into `ArchitectTreeBuilder`

- New `apps/vscode/src/views/architect-tree.ts`. `ArchitectTreeBuilder` now owns what
  `BuildersProvider` did privately:
  - row-id versioning (`AccordionRowIds`, now with a scope prefix) and the builder → group parent
    map;
  - group, builder, *Idle Architects* and changed-file rows, and their `getParent` reconstruction;
  - `findFileItem`, `revealTargetForAgent` and `agentCycleOrder`.
- `BuildersProvider` is a thin provider over one builder with scope `''`, mode `act` and its
  active axis. `builders.ts` re-exports every symbol that moved (`orderForDisplay`,
  `partitionArchitectGroups`, `findParentNode`, `AccordionRowIds`, `AgentTarget`), so no importer
  changed. `agentTargetIsFocused`, `agentCycleAttemptOrder`, `AccordionGate` and
  `runBuilderRowClick` stay in `builders.ts`: they are view wiring, not row building.
- The five row classes take an optional trailing `scope` that prefixes their id and is kept as a
  property. With `''` every id is the one it was.
- Modes:
  - `act` + scope `''` (Agents): unchanged.
  - `act` + a scope (this window in the Cockpit): architect rows get `cockpit-architect-main` or
    `cockpit-architect-sibling`. Builder, file and folder rows keep the Agents contextValues and
    commands.
  - `navigate`: builder rows are leaves; architect rows still expand. Every architect and builder
    row clicks to `codev.tower.openWorkspace` with the target, and its tooltip names the workspace.
    contextValues are `REMOTE_CONTEXT` (`cockpit-remote-architect`, `-builder`,
    `-idle-architects`). `findFileItem` and `revealTargetForAgent` answer `undefined`, because the
    agent cycle and the active-file reveal are about this window's agents only.
  - `attentionCounts`: appends `N held · N queued` to builder-row descriptions, from
    `deriveAttention` over the builder's own `getData()`, recomputed when the overview object
    changes. It is off for the Agents view.
- Deviations from the plan's wording, behaviour unchanged:
  - The stage/area root branch and the lone-`Uncategorized` flatten moved into
    `ArchitectTreeBuilder.rootRows()` with the architect branch. The plan said they would stay in
    the provider. All three branches depend on the parent-map reset the builder owns, and the
    builder already receives the active axis. Leaving them in the provider would have meant a
    "reset, then call back in" protocol across two classes. The snapshot covers all three axes.
  - Navigate options take no `grouping`: navigate mode is always the architect axis, so the type
    rules out the other axes.
  - Navigate `target` is a function, read on every render, so a workspace whose label changes
    (disambiguation) never shows a stale name or target.
  - The *Idle Architects* container in navigate mode has no click command, as in the Agents view:
    clicking it toggles it. It carries `cockpit-remote-idle-architects`.
- Three of the tests the plan names live in the Electron suite (`src/test/`), not `__tests__/`:
  `builders.test.ts`, `area-grouping.test.ts` and `builder-file-tree-item.test.ts`. `check-types`
  compiles them, and their imports and constructor calls are unchanged. They were not run, because
  they need the vscode-test Electron harness.
- Tests: `apps/vscode/src/__tests__/architect-tree.test.ts`, 33 tests.
  - Equivalence: the walk covers N=0/1/>1 builders × 3 axes × flat/tree file modes (18 cases). It
    records every row's id, label, description, contextValue, collapsible state, icon, command and
    tooltip, its `getParent` answer, and the agent-cycle roster. The snapshot
    (`__snapshots__/architect-tree.test.ts.snap`) was recorded from the **pre-refactor** provider
    before any source change, and it matches after.
  - Builder tests: scoped ids and disjointness, including two acting scopes and one navigating
    scope over shared `main` and builder ids, in both file modes. Also: accordion re-versioning
    under a scope, main/sibling contextValues, the null-owner fold, the non-live architect, the idle
    roll-up, a childless leaf, `getParent` chains (file → folder → folder → builder → architect,
    and idle sibling → container), and agent-cycle targets.
  - Navigate tests: leaf shape, the click command, tooltips, labels and glyphs equal to the acting
    rows, a target read on every render, and attention counts in both modes. Every `viewItem`
    pattern in `package.json` is parsed, and none of them matches a `REMOTE_CONTEXT` value.
  - Mutation-checked: unscoping each id kind, a non-leaf navigate builder, a remote contextValue
    that a builder menu matches, dropping the cockpit-architect contextValues, a stale counts cache,
    and the folder's default scope each fail a test. Giving the Agents view the cockpit contextValue
    or an empty description fails the snapshot.
- `check-types` is clean. `lint` shows only the two pre-existing `curly` warnings. `test:unit`
  passed 1326/1326 (1293 + 33). `esbuild` bundles.
- Review, iteration 1: Codex and Claude both approved with HIGH confidence, and neither raised a
  blocking issue.
  - Taken now, from Claude's non-blocking notes:
    - `agentCycleOrder()` returns `[]` in navigate mode, as `findFileItem` and
      `revealTargetForAgent` already did. The cycle opens terminals through this window's
      `TerminalManager`, so another workspace's agents must never enter it.
    - `getChildren` and `getParent` throw on a row whose `scope` is another builder's.
      `getChildren` also throws on an unrecognised row, where it used to fall through and render
      the root again. A Phase 4 routing mistake now fails loudly instead of duplicating rows.
    - A new test asserts that two builders' accordion versioning is independent.
    - Each of the three was mutation-checked. `test:unit` passed 1329/1329.
  - Carried into Phase 4, not changed here:
    - Rendering this window's builder rows probes the disk for a review file
      (`builderHasReviewFile`). The Cockpit will render on fleet ticks as well as overview changes,
      which roughly doubles those probes. Keep that in mind when Phase 4 chooses its re-render
      signals. Navigate rows do no fs work.
    - `architect-tree.ts` imports `views/tower.ts` for `OPEN_WORKSPACE_COMMAND` and
      `WorkspaceTarget`. There is no cycle and nothing touches `vscode` at load time. The import is
      cosmetic and stays as it is.
  - Snapshot provenance: Claude could not confirm from git that the snapshot predates the refactor,
    because both landed in one commit. The order was: test written, snapshot recorded
    (`Snapshots 18 written`) against the untouched `BuildersProvider`, then the source changes,
    after which the snapshot matched unchanged. The mutation runs also show the snapshot is not
    self-confirming: giving the Agents view a cockpit contextValue or a description fails it.

### Phase 4 (`cockpit_hierarchy`), iteration 1 (2026-11-24): the Cockpit button and its tree

- The button: `codev-cockpit` sits directly after `codev` in the activity bar, with
  `icons/codev-cockpit.svg` (`codev.svg`'s path wrapped in `rotate(90 400 400)`). It holds one
  view, `codev.cockpit`, with no `when`, and a title-bar *Refresh* (`codev.cockpit.refresh`, which
  refreshes the overview and the fleet). Checked: the whole `contributes` block minus these
  additions is byte-identical to the Phase 3 commit's.
- `views/cockpit.ts`, `CockpitProvider`. Tower root → state rows (*Connecting…* until an attempt
  fails, then *Not connected* → `codev.reconnect`; *No workspaces registered*) or the workspaces
  in the Tower view's order, labels, *current* marker and *Dormant (N)* group. Then one
  `ArchitectTreeBuilder` per active workspace, cached by scope `ws:<path>|` and pruned on leave:
  this window's workspace acts on `OverviewCache`; every other one navigates on the fleet's
  retained overview. *Loading…* until a workspace's overview lands. `getParent` reaches the Tower
  root from every row.
- Shared row code: `workspaceRow(ws, 'none' | 'collapsed' | 'expanded')` and `dormantGroupRow`
  are extracted from `TowerProvider`, whose output is unchanged (its tests pass unmodified).
- `views/agent-tree-hosts.ts`, `AgentTreeHosts`: the Agents view and the Cockpit are two hosts.
  The row click, the per-view accordion (one `AccordionGate` each), the follow-reveals, the
  `builder-active` selection hook and the badge act on whichever view a row belongs to, matched by
  its `scope`. Another workspace's rows never act.
- `views/overview-refresh-gate.ts`, `OverviewRefreshGate`: the periodic overview refresh, lifted
  out of `extension.ts` unchanged, with the Cockpit added to its view list. It is a new module so
  the visibility gate is unit-testable; Phase 8 adds the Work panel to the same list.
- `mailbox-indicators.ts`, `workspaceActivityBadge`: the badge computation, lifted out of
  `extension.ts` as a pure function. It is assigned to both views.
- Decisions taken here, each small (raise any at review):
  - Follow-reveals (active file, agent cycle) land in every *visible* host. When none is visible
    they land in the Agents view, exactly as before. Revealing in a hidden view opens its
    container, so revealing in both would flip the sidebar between them.
  - A navigate row's target always has `isCurrent: false`. In a builder-worktree window the
    parent is marked current, and `openOrActivateWorkspace` returns early on `isCurrent`, so the
    click would do nothing. Its window is not this one.
  - A dormant window (guest mode, no Codev workspace) never connects, so the root says *Not
    connected to Tower* with no Reconnect command (the command is a no-op there) instead of
    *Connecting…* forever.
  - Once the fleet has loaded, a dropped connection keeps listing the last-known workspaces. The
    spec puts the state row on the root only "while there is nothing to list".
  - The architect rows' attention (Spec 1595 wait text and glyph) lives in `ArchitectTreeBuilder`
    behind the Phase 3 option, renamed `attentionCounts` → `attention`. It is off for Agents, so the
    Phase 3 snapshot still matches.
  - `ArchitectTreeBuilder.getParent` builds the root rows when it does not yet know a builder's
    group. The Cockpit asks before its workspace node was ever expanded (the active-file reveal
    with collapsed ancestors), and the old answer, "root", broke the chain. The Agents view is
    unchanged: its root always renders first.
- Re-render cost, as carried from the Phase 3 review: the Cockpit redraws on every fleet tick as
  well as every overview change, so this window's builder rows run `builderHasReviewFile` (one
  `readdirSync` each) about twice as often as the Agents view, and an expanded builder row may
  re-read its 15 s-TTL diff on a fleet tick. Accepted: it is a handful of small local reads.
- Observation, not changed: an idle sibling at a prompt is folded inside the collapsed *Idle
  Architects* container, so its wait text is one click down. The workspace row's summary still
  shows it.
- Tests:
  - `cockpit-provider.test.ts` (40);
  - `cockpit-wiring.test.ts` (21);
  - `contributes-cockpit.test.ts` (8), with snapshots of the `codev` views and every non-Cockpit
    menu entry, checked against the Phase 3 commit;
  - `cockpit-icon.test.ts` (3);
  - `worktree-window-1809.test.ts`: its badge match now follows the generalised wiring and asserts
    both views, plus a behavioural check on `workspaceActivityBadge`.
  - Mutation-checked, 45 mutations across the provider, the hosts, the gate, the badge, the tower
    extraction and the `extension.ts` wiring; every one is killed. Three survivors on the first pass
    (connected-before-load, pruning, `restart()`) got stronger tests.

### Phase 4: `porch done` tests check failed (2026-11-24)

- Ran when load was 5.90 with no vitest running. `build` passed; `tests` (`packages/codev`, 68.5 s)
  failed. porch printed only npm warnings as the tail and kept no log, so the failing test names
  are unknown.
- Standing order 6: no re-run. Pushed `43f34f0f4` and opened draft PR #1971. Told the architect,
  with options: CI names the failures and I run those files alone; one re-run with a reporter;
  or a CI-stands-in ruling.
- The branch changes nothing under `packages/`. Every change so far is in `apps/vscode`.

### Phase 4 review, iteration 1 (2026-11-24)

- Codex: REQUEST_CHANGES (3). Claude: APPROVE with 5 notes. Answers in
  `1963-cockpit_hierarchy-iter1-rebuttals.md`.
- Architect ruling (option A) on dormant windows (guest mode, no Codev workspace). They keep #1144
  inertness: the Cockpit shows *Not connected to Tower* with the reason and *Open Folder*, and never
  initialises the connection. This is a deviation from the spec's no-workspace criterion for that one
  window type. The architect recorded it on #1963 and will raise it with the owner at the PR gate.
  The spec is not edited. **The PR description and the review must state it.** New test:
  `cockpit-dormant-1144.test.ts`, with no client, SSE, auto-start or fetch while the Cockpit is shown.
- Fixed in place:
  - The badge now follows connection-state changes. **This also changes the existing Codev
    button**: during an outage its badge clears instead of keeping the stale count. The PR must say
    so ("existing views behave as before" is a criterion).
  - `codev.autoConnect: false` no longer shows *Connecting…* forever. The Cockpit's connection mode
    is now `auto`, `manual` or `none`.
- Claude's notes:
  - `navigateTarget` throws a named error instead of a bare `!`.
  - `entryOfRow` keeps its throw. That is my own Phase 3 decision, not an architect ruling; the
    architect agrees (fail fast, no silent `[]`).
  - An active workspace with an empty roster shows an empty chevron until Phase 7 adds the Decisions
    entry. Leave it; don't fix it twice.
- The Phase 4 `porch done` before this used the architect's one-time main-32 tests skip (GitHub
  green on `43f34f0f`; `bugfix-1267-launch-loop.test.ts` passed alone, 7/7). The skip was removed
  straight afterwards and is noted on PR #1971.

### Phase 4 review, iteration 2 (2026-11-24): both APPROVE

- Before the reviews, the iteration-2 `porch done` passed build (15.2 s) and the full local tests
  (49.5 s) with no skip, starting at load 3.26.
- Codex APPROVE, no issues. Claude APPROVE. It verified the iteration-1 fixes against
  `connection-manager.ts` and `ide-mode.ts` itself, and left non-blocking notes, carried into Phase 5:
  1. **Agent cycle in a Cockpit-only window (decide in Phase 5).** The cycle roster comes from
     `buildersProvider.agentCycleOrder()`, which follows `codev.buildersGroupBy`. With the default
     `stage` it holds builders only, so Cmd-cycling never lands on an architect, and its order is not
     the Cockpit's top-to-bottom order. No Phase 4 criterion is broken: selection does act on Cockpit
     rows. Raised with the architect.
  2. **Polish, at the start of Phase 5.** In `cockpit-provider.test.ts`, the parity `shape()`
     compares `iconPath`, but the Cockpit deliberately overrides a waiting architect's icon
     (`applyArchitectAttention`). Exclude `icon` for `BuilderGroupTreeItem`, as `description` already
     is, or comment the fixture, so a future waiting-architect fixture doesn't read as a regression.
  3. **Polish, at the start of Phase 5.** `pruneTrees` runs only from `towerChildren()`, so departed
     workspaces' builders survive while the Tower root is collapsed. That is bounded and harmless;
     say so in its doc comment.

### Architect ruling for Phase 5: agent cycle (2026-11-24T08:59Z)

- **Option (b).** The approved spec already says "tree behaviours follow the view a row is in", so
  this needs no owner ruling.
- **Cockpit visible, Agents view not:** the agent cycle runs in the Cockpit's own visible order,
  architects and their builders. The roster is **this window's workspace only**; other workspaces'
  rows never enter the cycle.
- **Agents view visible, or neither visible:** the existing order from
  `buildersProvider.agentCycleOrder()` applies **unchanged**. Not (c): existing behaviour must not
  move.
- **To do in Phase 5:**
  - tests for all three cases (Cockpit-only visible, Agents visible, neither visible);
  - one line in the PR #1971 description.
- Also opening Phase 5, from Claude's iteration-2 notes (see above):
  - the parity `shape()` icon boundary;
  - the `pruneTrees` doc comment.

### Phase 5 (`cockpit_actions`), 2026-11-24

**Commits.** Three, not the plan's two:
- 5a `43946ed6c`: menus, workspace-row context values, held worktree config, agent cycle;
- 5b-1 `aaefbfd0f`: the menu-parity oracle, the parity test and the handler-argument test;
- 5b-2: the Spawn Builder cwd fix, the harness's rendered verification, docs and evidence.

**Builder decisions (mine, not the architect's):**
- **Agent cycle, ruling (b).** `agentCycleRoster` follows the Cockpit only while the Cockpit is
  visible, Agents is not, *and the Cockpit has acting rows*. The last condition is my reading of
  "this window's workspace only". A Cockpit with no acting rows, in a builder-worktree window or
  before Tower lists this workspace, falls back to the Agents order, so existing behaviour does not
  move there either.
- **Command-argument helpers moved** from `extension.ts` to `commands/command-args.ts`, so the
  handler-argument test can import them: `extractBuilderId`, `extractIssueId`, `extractIssueTitle`,
  plus the new `architectNameFromArg`. `extractIssueId` now also checks that the id is a string.
- **Icons** added to `codev.spawnBuilder` (`$(rocket)`) and `codev.newShell` (`$(terminal-new)`),
  because inline actions need one. Titles are unchanged.
- **`openDevUrl(urlArg?: unknown)`.** Only a non-empty string opens directly. Anything else, such
  as the Cockpit row VS Code passes, falls through to the QuickPick.
- **Mutation checks:** 9 mutations of the parity test and 4 of the handler-args test, all caught.

**Adjacent bug, fixed in place: Spawn Builder's cwd.**
- **How it was found.** The harness's `afx` stub recorded the Cockpit's Spawn Builder running
  `afx spawn` in the harness's home directory. `spawnBuilder` passed no `cwd`, and `afx spawn`
  resolves its workspace from its cwd. Every entry point was affected: the Workspace view, the
  palette, the Backlog row and the Cockpit.
- **The impact.** In the Codev IDE the extension host's cwd is Tower's (`ide-server.ts` spawns the
  server with `process.cwd()`), so a window could spawn into another project.
- **The fix.** It now runs in `detectWorkspacePath()`, this window's Tower workspace (the parent
  workspace in a builder-worktree window), as Run Worktree Setup and Approve Gate already do.
  Without a workspace it errors before prompting. Unit-tested.

**Plan vs behaviour: Approve Gate.**
- The plan says it is verified as `porch approve` through the stubs.
- Since #1494 it relays to the spawning architect through `POST /api/send`. It runs `porch approve`
  itself only when no architect is live.
- The harness asserts the relay: one `/api/send`, no porch call, the "sent … to main" note.

**Harness: two temp-dir filters in Tower, both by design.**
1. `GET /api/workspaces` drops workspaces under `/tmp`, `/private/tmp` or Tower's `os.tmpdir()`
   (`isTempDirectory`). The fixtures lived in the scratchpad under `/private/tmp`, so the fleet
   rendered *No workspaces registered*.
   - **Fix:** the fixtures now live in a `mkdtemp` `cockpit-fixtures-*` dir under the real
     per-user temp dir, and the isolated Tower gets its own `TMPDIR` in the scratchpad. Gate 6
     also asserts the fleet listing.
   - The architect accepted this on one condition, implemented with 7 self-test cases: `stop`
     deletes that dir only after the realpath, parent, name and per-run marker-token checks pass.
2. Startup reconciliation skips and kills sessions of workspaces under `POSIX_TEMP_ROOTS`, which
   include `/var/folders`. So fixture sessions do not survive a restart of the isolated Tower.
   `reconnect` runs last, and checks the Cockpit's states and recovery, not session survival.

**Harness lessons (each one cost a rerun):**
- **VS Code keeps a closed window's extension host alive** for its reconnection grace period, and
  those hosts kept polling the isolated Tower. They inflated the first request counts about
  fourfold. `vscode-restart` gives each measured layout a fresh server.
- **The first "alone" layouts were not alone.** The close commands' palette titles did not exist
  in this VS Code, and `.catch(() => {})` hid it, so the Tower side bar and the Codev panel stayed
  open. Now `runCommand` matches exact labels and throws, parts are toggled only when needed, and
  every layout asserts the side bar, secondary side bar and panel before measuring.
- **VS Code drops a context-menu click that lands just after the menu opens.** Measured: at once,
  dropped; after 500 ms, it runs. That one dropped click left a menu open that blocked every later
  check. `contextAction` now waits and asserts the menu closed. A failed check presses Escape so
  it cannot cascade.
- **A burst window that holds a fleet poll tick** counts one fan-out more or less, depending on the
  poll's phase. The burst now starts 2 s after a tick and lasts 15 s.

**Rendered results (isolated harness, VS Code 1.147.0 serve-web, fresh `fleet` seed):**
- `render` 5/5: the button directly below Codev; the Codev container unchanged against
  `origin/main`; the hierarchy with N=2/1/0 builders across three workspaces; Dormant (1); dark,
  then a live switch to light.
- `reveal` 1/1: the diff of #101's `alpha.ts` reveals its row, with the workspace and architect
  rows collapsed beforehand.
- `windows` 3/3:
  - the worktree window's parent row offers only Open Web Interface, Start Dev (this workspace) and
    Open Dev URL;
  - the no-workspace tooltip;
  - Cockpit-only freshness: #102's gate shown after 56.3 s, against the 60 s default.
- `requests` 4/4, spec scenario 21:
  - over a 60 s idle window, the three layouts make identical fleet and overview counts;
  - Cockpit alone ⊆ source views alone;
  - both at once add only `getWorktreeConfig` (3 vs 2 in the burst);
  - none while idle;
  - one event stream per window.
- `reconnect` 3/3: content kept with Tower down; a fresh window reads *Not connected to Tower*;
  Reconnect restores it.
- `actions` 27/27:
  - every builder context action, with the Agents/Cockpit menu parity;
  - Approve Gate inline only on the blocked row, relayed to `main`;
  - every workspace-row action, including Spawn Builder in alpha's cwd and Open Dev URL picking
    Admin;
  - Remove Architect:
    - offered on siblings only;
    - a childless sibling's row goes;
    - WEB keeps its header as #103's owner (the Agents rule, "no builder is ever dropped");
  - other workspaces navigate to their windows;
  - Open and Deactivate.
- **Totals: 43 checks, 0 failed.** `actions` ran on a fresh seed after the five others, which share one
  seed. Each needs its own seed because it mutates state: it removes architects and deactivates gamma.

Evidence: `codev/projects/1963-vscode-alternative-layout-seco/verification-increment1/`.

### Architect on Phase 5 (2026-11-24T11:01Z)

All four points were accepted:
1. **The Spawn Builder cwd fix stays in this PR.** The architect confirmed that main's
   `runAfxCommand` passes no cwd, and will flag to the owner that the bug is live on main until
   this merges.
2. **The agent-cycle reading is right,** including the worktree window keeping the Agents order.
3. **Asserting the #1494 relay over the plan's `porch approve` wording is right.** Say so in the
   review.
4. **The render screenshots read well** in light and dark.

**Carried to Phase 7:** the increment-2 screenshots must show the Decisions entry under every
active workspace, including one with no decisions file.

### Phase 5 review, iteration 1 (2026-11-24)

**Verdicts:** Codex APPROVE (no issues); Claude APPROVE (four non-blocking notes). Responses are in
`1963-cockpit_actions-iter1-rebuttals.md`.

**Fixed:**
- The parity guard's source-view filter is no longer anchored to the start of the `when` clause.
- New test: the hidden palette entry for `codev.cockpit.openWebInterface`.

**Kept, as planned:**
- The root listing awaits the held worktree config. The fetch cannot reject: the SDK returns
  `null`, with a 10 s timeout.
- *Remove Architect* stays on an owner-only row (the plan's accepted divergence; invoking it fails
  visibly).

**Candidate refinements for the review doc:**
- A row whose architect is not in the overview roster gets its own context value, with no *Remove
  Architect*.
- A config fetch that fails while connected holds `null` until the next drop signal.

### Phase 6: workspace_views_package (2026-11-24)

**Shape:** new private package `@cluesmith/codev-workspace-views` (`packages/workspace-views`),
source-exported (`.` → `src/index.ts`, `./styles.css`), no build step. It holds the Work view (with
BuilderCard, NeedsAttention, Backlog, RecentlyClosed), the Decisions view, `useDecisions` and the
issue-key grammar. The dashboard keeps thin wrappers with the same names and props, so `App.tsx` is
unchanged.

**Host contract (`host.ts`), builder decisions:**
- `WorkViewHost.overview` is a value (`OverviewState | null`), not a subscription: each host owns
  its own polling. `null` is the loading gate, so the dashboard passes `null` until `useOverview`
  has state, exactly as before.
- Every Work action is optional, and its control renders only when the host provides it (Open,
  + Shell, Refresh, the spec/plan/review links). `openBuilder` takes the `OverviewBuilder`, not an
  id, because the dashboard's tab lookup (`findBuilderTab`) needs `roleId` and `issueId`.
- The dashboard-only pieces are slots: `tip` (TipBanner), `openFilesShells`, and `filePanel` (a
  render function given `{open, setOpen}`, so the root's `file-panel-open` class stays with Work).
- An optional `architectCount` prop keeps the dashboard counting registered architects for the
  attribution badge. Without it the view counts the overview's live architects.
- Decisions: `read`, `rule`, `image(path, signal)` are required; `openExternal` and `showImage`
  are optional. Without them a link or image click does nothing (it never navigates the page).
  Work's own http(s) anchors stay native `<a href>`, as before.
- The decisions result types moved into the package (they are its contract); `apps/web/lib/api.ts`
  re-exports them.

**Deviations from the plan's host sketch (interface detail; the plan's intent holds):**
- Two host interfaces, `WorkViewHost` and `DecisionsViewHost`, not one `WorkspaceViewsHost` with
  a nested `decisions`: each view takes only what it uses.
- `overview` is a value, not a subscribe/refresh source (above). `refresh` is still an action.
- `openBuilder(builder)`, not `openBuilder(id)`; `showImage({src, alt})`, not `showImage(src)`:
  the dashboard's full-size page carries the image's alt, as before.
- `architectCount`: the plan says it comes from `OverviewData.architects`. The view does that by
  default. The spec's Assumptions accept the live-architect count for **VS Code**, and scenario 20
  requires the dashboard unchanged, so the dashboard wrapper passes its `/api/state` count.

**CSS:** the moved rules live in the package's `styles.css`, each colour and font a
`var(--codev-wv-*, <the dashboard's value>)` token. The dashboard maps the chrome tokens to its own
vars in `:root`. The tip banner, file panel and PR-row rules stay in `apps/web/src/index.css`.

**Tests:** the eight moved test files run in the package against fake hosts (same case counts;
the fetch- and `window.open`-level cases moved to a dashboard integration test,
`apps/web/__tests__/DecisionsView.dashboard-host.test.tsx`, which renders the real wrapper, host
and hook with only `fetch` and `window.open` faked). New package tests: import boundary, one
copy of each component, and the Work view against fake hosts (absent actions hide controls, slots
render only when passed). The package's `check-types` covers its tests, which flagged three old
fixtures missing required fields (`area`, `reviewRequests`, `isDraft`); fixed.

**Environment note:** locally (Node 26) the apps/web suite fails 10 Terminal/VirtualKeyboard/toolbar
files with `localStorage ... getItem`, because Node's experimental `localStorage` global shadows
jsdom's. With `NODE_OPTIONS=--no-experimental-webstorage` all 37 files pass. CI runs Node 20. Not
caused by this branch: `getWebKey` is untouched.

**Rendered proof (scenario 20):** the harness `dashboard` script, baseline run on the branch base's
build, then on this build with `COCKPIT_BASELINE`. Evidence in
`codev/projects/1963-vscode-alternative-layout-seco/verification-phase6/`.
