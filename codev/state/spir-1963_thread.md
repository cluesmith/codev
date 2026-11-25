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

### Phase 6 review, iteration 1 (2026-11-24)

**Verdicts:** Codex REQUEST_CHANGES (two issues); Claude APPROVE (five notes). Responses are in
`1963-workspace_views_package-iter1-rebuttals.md`.

**Fixed:**
- **Host-owned links (Codex).** VS Code's webview script (`pre/index.html`, `handleInnerClick`)
  opens any clicked anchor with an `href` through VS Code's own opener. It listens on the window,
  in the bubble phase, and ignores `defaultPrevented`. Work's native issue/PR links would have
  bypassed the host's http(s) allowlist, and Decisions' links would have opened twice. Now:
  - `WorkViewHost.openExternal?` is new. With it, Work's four external links go to the host, with
    default prevented and propagation stopped.
  - Without it, they stay plain links, as in the dashboard, which does not pass it.
  - Decisions' link clicks stop propagation too.
- **`color: white` (Codex):** two buttons now use `--codev-wv-on-accent`. A new
  `styles-tokens.test.ts` forbids any literal colour or font outside a token.
- **`useDecisions` and `host.read` (Claude):** the view calls `host.read()` through the host (keeps
  `this`), and the hook keeps the latest `read` in a ref, so a new function per render neither
  restarts polling nor re-reads.
- The dashboard's artifact-open handler now catches and logs, like + Shell (parity bug, fixed in
  place). Two cosmetic test fixes.

**For Phase 7:** the VS Code host must pass `openExternal` to both views, with the allowlist
host-side. Pass the Decisions view a stable host object (it keys image loads on it).

### Phase 6 review, iteration 2 (2026-11-24)

**Verdicts:** Codex APPROVE (no issues); Claude APPROVE (no blocking issues).

**Carried to Phase 7/8 (Claude's forward notes):**
- The VS Code webview stylesheet must map **every** `--codev-wv-*` token. The dashboard maps 13
  and leaves the rest on defaults equal to its own values. Add a coverage test that extracts the
  token names from `styles.css` and asserts the VS Code stylesheet maps each one, the same shape as
  `styles-tokens.test.ts`.
- The webview hosts' tests must assert they provide `openExternal` (Work and Decisions) and
  `showImage` (Decisions). Omitting `openExternal` silently reintroduces the link bypass.

**Left as is:**
- The root's `work-view ` trailing space is parity with the pre-move code, and the snapshot
  compares the class string.
- `one-copy.test.ts`'s `statSync` would throw on a dangling symlink: none exist under `apps/` or
  `packages/`.

### Phase 7: decisions_panel, implementation (2026-11-24)

The Decisions panel in VS Code: the shared `DecisionsView` in an editor-area webview, with every
Tower call made by the extension host. Built:
- **SDK** (`tower-client.ts`): `getDecisions`, `ruleDecision`, `getDecisionImage`. A refusal stays
  structured as `{code, message}` and is never flattened. Image bytes come through a new
  `requestBinary`, which sets no Content-Type on the GET.
- **Host** (`apps/vscode/src/workspace-views/`):
  - `messages.ts`: the requestId contract and guards for untrusted webview messages;
  - `security.ts`: realpath + `path.relative` containment, and an http(s)-only allowlist;
  - `panel-template.ts`: nonce CSP with no `connect-src`;
  - `decisions-bridge.ts`: maps each Tower outcome to the view's result;
  - `availability.ts`;
  - `decisions-panel.ts`: single instance, serializer, and the visibility relay.
- **Webview** (`webview/`): `WebviewDecisionsHost` (postMessage, never rejects, image abort),
  `DecisionsApp` (`isActive` = the relayed visibility, full-size image overlay), and
  `vscode-theme.css` mapping all 28 `--codev-wv-*` tokens.
- **Cockpit:** a "Decisions" leaf after the architects under every active workspace. This window's
  entry runs `codev.openDecisions`; any other entry (another workspace, a worktree window, a
  no-workspace window) navigates via Open Workspace.

**Builder decisions / deviations (mine, not the architect's):**
- `@cluesmith/codev-workspace-views/host` is a new subpath export. Host-side code imports the view
  types from it, because the package index pulls in TSX, which the host tsconfig (no `jsx`) would
  then compile.
- The no-I/O rule for webview code: an ESLint `no-restricted-globals/properties` rule on
  `src/workspace-views/webview/**`, plus `workspace-views-webview-source.test.ts`, which is what CI
  runs. The shared package has no ESLint; its existing `import-boundary.test.ts` already bans
  fetch, XHR, WebSocket, EventSource and sendBeacon there.
- The panel opens in `ViewColumn.Active`.
- The "no decisions file" empty state appends the `afx decisions init` hint host-side, as plain
  text after Tower's message.
- Vitest compiles TSX with `esbuild: { jsx: 'automatic' }`. Vite reads the host tsconfig.json,
  which sets no `jsx`.
- `decisions-webview-bundle.test.ts` builds the real bundle from `esbuild.webview.cjs` and boots
  it in its own JSDOM window, from a node-environment test, because esbuild refuses to run inside
  vitest's jsdom environment (TextEncoder realm check).
- The Windows workflow's unit job gained a step that runs `workspace-views-security.test.ts` on
  Windows. Its directory links are junctions, which need no privilege; a `win32`-only describe
  covers drive-letter case and separators on real paths.

### Phase 7: rendered verification (2026-11-24)

New harness script, `verify decisions`: 15 checks, each run on its own `start` + `seed fleet`.
It adds `main-2` to alpha's file (an https image served by the browser's route, and an image
outside the workspace) and creates gamma's file.

**Two bugs found and fixed:**
1. **Reload restore closed the panel** (run 1, 14/15).
   - `deserializeWebviewPanel` asked `unavailableReason()`, which read
     `connectionManager.getWorkspacePath()`. That is null until the async `initialize()` runs, and
     a restore reaches the serializer first, so the restored panel was disposed as "no workspace".
   - **Fix:** availability now comes from the window's folders, `detectWorkspacePath()`, the same
     thing the CLI preflight already uses for the same reason.
   - A source test in `contributes-cockpit.test.ts` pins it.
2. **High contrast hid accent text.**
   - I had mapped `--codev-wv-accent` to VS Code's button background. HC Dark makes that black, and
     the accent is also text and borders on the page (item ids, links, the selected option), so the
     ids vanished on the black page.
   - **Fix:** accent → `--vscode-textLink-foreground`, on-accent → `--vscode-editor-background`.
     Contrast is symmetric, so text on an accent-filled button keeps the link's contrast. The
     shared package is unchanged.
   - The theme unit test pins the mapping. The rendered theme check now measures WCAG contrast:
     item id on the page, and Submit's text on its fill, both ≥ 4.5 in all four themes (measured
     6.3 to 9).

**Final run (cycle 3, the committed build): 15/15.**
Evidence: `codev/projects/1963-…/verification-phase7/`.
- Entries: a Decisions entry under alpha, beta and gamma (beta and gamma have no file), none under
  dormant delta. Beta's entry opens beta's window.
- Alpha's entry opens one panel; a second click reveals the same panel.
- Images:
  - the workspace SVG renders from a `blob:` URL, so **Uint8Array bytes survive
    `webview.postMessage` in serve-web**;
  - the https image renders;
  - the outside image shows "Image not loaded", with Tower's reason.
- The full-size view opens; Escape and Close each close it.
- The link opens after VS Code's own "open external website?" prompt.
- Ruling `main-1`: the file is updated, the card shows the ruling, and Tower logs `Decisions notice
  held (no-profile) → main @ alpha`. The notice is persisted to main's mailbox and held, because
  the fixture architect is a bash shell, not an agent; the Codev panel shows "1 held".
- A stale fingerprint is refused ("Item main-2 changed since it was shown…"), with the draft and
  word kept.
- Polling: 3 reads in 6 s while shown, 0 in 8 s while hidden, and reads resume when shown again.
- Four themes switched live: the webview never reloaded and the draft was kept.
- The panel is restored after a reload.
- Explanations show in a worktree window and a no-workspace window, and the worktree window's
  entry navigates to the parent.
- Gamma: the empty state, then the real `afx decisions init` (it only writes the template; I
  checked the CLI path: no Tower call), "0 open", then an added item appears.
- The audit: 205 browser requests, none to the Tower port, none carrying the key. Webview frames
  loaded only extension resources and the remote item image.

**Not run:** the `/ide/` (ide-server) mode. It serves the same VS Code web workbench and webview
code as serve-web.

**Adjacent:** `.vscodeignore` now drops `**/tsconfig.*.json`. The vsix had been shipping
`tsconfig.webview.json` since the markdown preview added it.

### Phase 7: review, iteration 1 (2026-11-24)

`porch done` passed (build 17.6 s, tests 49.6 s, no skip). The 2-way review followed: Codex
REQUEST_CHANGES and Claude APPROVE, each with points that held up.

**Codex: a refused http(s) image was a broken image, not "Image not loaded".**
- The spec requires the note for an http(s) image the browser refuses (mixed content, a Tower
  URL's 401). The shared view only handled failures of host-loaded images, and my harness only
  tested Tower's refusal.
- **Fix (in the shared package):** an error listener on every direct http(s) image, removed on
  cleanup through the effect's abort signal. Package tests cover the refusal, and that a late
  error on a detached image does nothing; that test fails without the signal.
- The harness now adds a remote image the route answers 404 for, and checks that its note is
  rendered.
- **This changes the dashboard too:** a refused remote image there now shows the note instead of
  a broken image, as the spec describes. No fixture of Phase 6's dashboard snapshot has a remote
  image, so that comparison is unaffected.

**Claude: the option words looked faint in Light High Contrast. They were invisible.**
- **Cause:** VS Code's webview stylesheet colours every `code` with its preformat foreground.
  `.decisions-option-word` is a `code` that paints its own background but set no colour, so in
  HC Light it drew near-white text on a light background.
- **Fix (in the package):** that rule sets `color: inherit`. It is a no-op in a browser, so the
  dashboard is unchanged.
- **Wider check:** following Claude's "coverage is not contrast", the theme check now measures
  every visible text element in the panel (62) in all four themes, against its composited
  background. It fails below 3:1, requires 4.5:1 for the item id, Submit and the option word,
  and lists every text under 4.5:1 in the evidence. That found three more mappings of mine that
  were wrong for text:
  - `fg-muted` → `disabledForeground`, a disabled-control colour that Light Modern draws at half
    alpha: section labels measured 2.1:1. It is now `input.placeholderForeground`, VS Code's
    readable muted grey.
  - The error colour: VS Code's `errorForeground` is `#F85149` in Light Modern, and the refusal
    measured 2.8:1.
  - The waiting colour: `charts.yellow`, "Image not loaded" measured 2.9:1.

  The error and waiting colours now take `list.errorForeground` / `list.warningForeground`,
  VS Code's colours for text. High-contrast themes leave those unset, so the fallbacks apply.
  The tints follow the same colours.
- **Result:** every text is at least 4.1:1 in all four themes. Under 4.5:1, only in Light
  Modern: the section labels at 4.3 (VS Code's own placeholder grey) and the Recommended badge
  at 4.1 (`charts.green`), left as they are and recorded.
- **Not yet measured:** the Work view's status colours (implementing orange, the tags). That
  panel is Phase 8, whose rendered check should run the same scan.

**Claude's minor notes:**
- The ruling guard's `word`/`comment` are unbounded on purpose: Tower caps the body and refuses
  an over-long comment with a reason the panel shows, whereas a host cap would drop it silently.
  This is now said in the guard's comment.
- The "leak" on an aborted image is not one: once the resolver leaves `pending`, nothing
  references the inner promise and it is collected. A comment now says so.
- The Windows run: dispatched and linked in the PR (run 45394199925).

**Final harness run (cycle 7): 15/15.** Evidence in `verification-phase7/` is replaced by that
run.

**Windows run on `36f7c4acd`:** the new path-containment step failed 4 of 39, all on the test side.
- **Three:** the test canonicalized its temp dir with the JS `realpathSync`, which on Windows keeps
  the runner's 8.3 short name (`RUNNER~1`). The code uses `fs.promises.realpath`, the native one,
  which gives the long name. The test now uses `realpathSync.native`.
- **One:** the "absolute path outside" case used `/etc/hosts`, which does not exist on Windows, so
  `not-found` was correct. It now names the fixture's own outside file.
- The code under test is unchanged, and `resolveWorkspaceFile` has no production caller yet.
- The other suites, CLI tests, probes and install verification passed. The run is re-dispatched
  after this commit.

### Phase 7: review, iteration 2: approved (2026-11-24)

- `porch done` (iteration 2) passed: build 15.4 s and tests 47.8 s, no skip, run once the load
  was back under 6 (it spiked to 14.9).
- **Codex APPROVE:** both iteration-1 issues are addressed.
- **Claude APPROVE.** Two non-blocking notes, carried to Phase 8:
  - the Light Modern Recommended badge is 4.1:1 at 10 px; give it a small bump if Phase 8
    touches badge styling;
  - `resolveWorkspaceFile` gets its first caller in Phase 8.
- **Windows on `b758f8ffb`:** the containment step passes on Node 22 and 24, 39/39. Node 22
  passed everything.
- **Node 24 failed one test outside this branch's code:** `ide-server-stub.windows.test.ts` >
  'npm-style shim': "IDE server on port … was not stopped: the port query failed".
  - This branch changes nothing in packages/codev except `issue-id-parity.test.ts`. The test
    passed on Node 22 in the same run, and on main's run that morning.
  - I re-ran only the failed job (attempt 2) to tell a flake from a failure.
- **Carried to Phase 8 (Work panel):**
  - run the full-panel contrast scan on the Work view: implementing orange and the tag colours
    are unmeasured;
  - `resolveWorkspaceFile` gets its caller there.
- **Windows attempt 2 (Node 24):** `ide-server-stub` 'npm-style shim' passed. A different test
  failed: `pir-1233-session-launch-loop.test.ts` > "resumes the spawn-pinned session after an
  unnatural exit…" (start.sh command failed). It passed in attempt 1, and the same file failed on
  spir-1940's Windows run.
  - Both are pre-existing flakes in code this branch does not touch. They are left running, named
    under "Flaky tests" in PR #1971, and reported to the architect.
  - **The review file's `## Flaky Tests` section must carry both.**

### Phase 8: Work panel (2026-11-24)

- **Feature commit `d96d9c00b`.** `WorkPanels` (`workspace-views/work-panel.ts`): one retained
  editor-area panel per window, restored after reload, pushing `OverviewCache` data and the
  connection state. `workOverviewState` gives loading until the first overview, then the last
  overview under "Not connected to Tower." while not connected. The mapped actions:
  - Open → `openBuilderByRoleOrId(id, true)`, only for a builder the overview shows;
  - + Shell → `codev.newShell`;
  - Refresh → `client.refreshOverview()` (machine-wide POST) then `overviewCache.refresh()`;
  - spec/plan/review → `resolveWorkspaceFile` (its first production caller) → `vscode.open`;
    a refusal or a missing file warns the user, since they clicked;
  - issue/PR links → `openExternal`, http(s) only.

  No dashboard slots are passed, so the dropped affordances are absent.
- **A builder decision, not a plan instruction:** `single-panel.ts` now holds what Work and
  Decisions share (single instance, serializer, reveal, observable visibility, the session's
  post-after-dispose drop and the http(s) gate). `DecisionsPanels` moved onto it. Its 13 tests
  pass unchanged apart from an `EventEmitter` in the `vscode` mock. Phase 9's arrange needs
  both panels to take a view column, so one place to add it.
- **Refresh gate:** `workPanels` is a `GatedView`. An existing source-text test
  (`cockpit-wiring.test.ts`) pinned the gate's view list and was updated to include it (the
  spec allows that for wiring tests when the guarded behaviour is unchanged).
- **Verified:** apps/vscode 130 files / 1764 tests, `tsc` host + webview clean, lint only the 2
  existing `curly` warnings.
- **Harness:** a `verify work` script (scenarios 17, 18, 19 Tower-down part, 22, reload
  restore, the unavailable windows, and an increment-2 shot of the Cockpit's Decisions entries
  beside both panels). Implementing orange (only `.attention-kind--dev`, a PIR gate the fixture
  has no builder for) and the spike tag are measured by drawing a probe element in the real
  webview; project and bug tags are in the fixture's rows.
- **What rendering found (fixed in `f03eade1b`).** The first `verify work` run passed 12 of 14:
  - Light Modern's chart orange (implementing, a PIR dev-approval row) measured 2.9:1 as
    text. `--codev-wv-status-implementing` is now mixed 50/50 from the error and waiting text
    colours (VS Code's list colours, made to be read): it stays between red and yellow, as the
    dashboard's gate progression has it, and measured 6.7:1 on Dark Modern.
  - The Tower-down check expected the fixture's 3 builders back after the restart. A restarted
    Tower does not keep fixture sessions (harness README), so the check now compares with
    the restarted Tower's own overview.
  - The increment-2 shot showed Work broken in a half-width group (~470 px): every *Open* cut
    off, backlog reviewer/assignee labels over the spec/plan links. VS Code-only container
    queries in `vscode-theme.css` now drop Elapsed and the labels under 760 px, and Progress
    under 600 px; row labels clip. The dashboard's layout is untouched. The side-by-side check
    now fails on sideways scroll, a cut *Open*, or a label over its links.
  - Scenario 19 says *both* panels keep their content under a not-connected notice; the check
    covered only Work. It now also holds Decisions to its cards under "Not connected to Tower.
    Showing the last version read." and to the notice clearing on recovery. It passed first time.
- **A test race of my own:** the four real-filesystem containment tests in `work-panel.test.ts`
  waited one `setTimeout(0)` for `fs.promises.realpath`; two failed under the loaded full suite
  (harness running alongside) and passed alone. They now `vi.waitFor` the outcome. Not a
  pre-existing flake, so not named as one.
- **One more from looking at the shots (`b9e5af0f6`):** in Light Modern the progress bar's
  track vanished (its tertiary background is the row's own colour there), so a bar read as a
  dash. VS Code's stylesheet now draws the track as an 18% mix of the text colour, and the
  theme check fails if a track does not show on its row (≥ 1.2:1), reporting the fill's
  contrast on it.
- **Architect review of the increment-2 shots (13:47Z), all taken (`b3aa8873b`):**
  1. *(change)* Decisions' no-file state was the amber `.decisions-notice` — a warning look
     for an empty state. The shared view now gives it a `decisions-notice--no-file` modifier;
     VS Code draws it in `descriptionForeground` on no fill. The dashboard has no rule for the
     modifier, so it keeps the amber. Scenario 16 now measures it (rgb(59,59,59), the
     description colour, on no fill, in Light Modern).
  2. Work's State wrapped to three lines in the half-width group: under 600 px the state now
     stays on one line and the title gives way (it ellipsizes); only under 400 px does the state
     wrap. The half-width check holds each state to one line.
  3. Panel text read larger than the workbench: every `font-size` in the shared stylesheet is now
     a `--codev-wv-font-size-{xxl..xxs}` token whose default is the dashboard's px size; VS Code
     maps xl/lg to `--vscode-font-size` and the smaller steps 1–3px below it, headings +4px.
     Both headings share one size. `styles-tokens.test.ts` fails on a literal px font size.
  4. A "More Actions…" tooltip covered work-09/10: `R.shot` now parks the pointer on the title
     bar and waits for hover tooltips to close, for every script's shots.
  Re-rendered at b3aa8873: verify work 14/14, verify decisions 15/15.
- **apps/web locally:** 10 terminal/toolbar test files fail on this machine with `localStorage`
  undefined in `getWebKey` (Node 26's global `localStorage` shadows jsdom's); CI runs Node 20.
  None of them touch the shared views; the 27 other files, including the dashboard's Work and
  Decisions, pass. An environment issue, not a flake.
- **The dashboard keeps its look (scenario 20, proven):** `verify dashboard` on the pre-change
  build (b9e5af0f's apps/web) kept a snapshot; after rebuilding `packages/codev` with the type
  scale, `verify dashboard` with `COCKPIT_BASELINE` found all 138 Work and 83 Decisions elements
  identical in computed style and DOM. Evidence in `verification-phase8/dashboard/`.
- **Review round, iteration 1 (`695870167`).** Codex REQUEST_CHANGES, claude APPROVE; responses in
  `1963-work_panel-iter1-rebuttals.md`.
  - *Codex:* before any overview, the not-connected notice sat over "No active builders" etc.,
    claiming an empty workspace. With an error and no overview, `WorkView` now shows *Loading...*
    in each section. This also fixes the dashboard's failed-first-read case (same misleading
    empty sections; adjacent bug, named in the PR). A first read in flight keeps the
    dashboard's empty sections as before.
  - *Claude (nits taken):* a rejected `onMessage` is logged at the dispatch site, for both
    panels. An artifact refusal that lands after close shows no toast.
  - *Architect (14:00Z), correcting suggestion 2:* one-line state had cut titles to four
    characters at half width. Under 600 px a builder row is now a two-line grid: issue, title
    and Open, then the state under the title. The check requires 20+ characters of a typical
    44-character title; it shows 42 at 473 px.
  - Rendered at 69587016: work 14/14, decisions 15/15, dashboard 6/6 (138 + 83 elements identical
    to the pre-change snapshot).
- **Iteration 2: codex APPROVE, claude APPROVE.** I took claude's one actionable nit: the
  `work-section-loading` class had no rule anywhere, so it is dropped (no rendering change). It
  left two notes for the owner: the "Failed to load overview:" wording before any load (the
  dashboard's template), and the two Light Modern texts at 4.3:1. Both go in the PR body.
- **Phase 8 closed (`abeff3c7e`); porch advanced to `arrange_cockpit`.** The PR #1971 body has a
  Phase 8 section, including the adjacent dashboard fix and the owner notes. apps/web passes 37/459
  with `NODE_OPTIONS=--no-experimental-webstorage`, the known Node 26 workaround already in the PR
  body, so the earlier local failures were only that.
- **Process note:** porch's `arrange_cockpit` refresh boundary was recorded as acknowledged when I
  called `porch next` a second time, before I had refreshed. I am running the builder-refresh
  procedure now, at that boundary, before starting Phase 9.

## Phase 9: arrange_cockpit (2026-11-24)

- **What it is.** *Codev: Arrange Cockpit* (`codev.cockpit.arrange`, palette and the Cockpit's
  title bar) arranges the editor area as `main` | (Work over Decisions). The first Cockpit show in a
  window does it automatically (`codev.cockpit.autoArrange`, default on). The first automatic one
  shows a one-time notice whose *Don't arrange automatically* turns the setting off at the user
  level. Not offered in builder-worktree or no-workspace windows (the command says why, and the
  title-bar entry is hidden).
- **How (`cockpit/arrange.ts`).** On the layout spike: place the architect in group 1, Work in 2,
  Decisions in 3 *before* `vscode.setEditorLayout`. Moving a group's only editor closes the group
  and renumbers the rest, so this order matters. With no architect and only the panels in group 1,
  an empty left group is opened first. Every move is awaited against the tab model with a 5 s bound;
  a move that does not happen stops the arrange with an error naming it. The architect resolves
  through `openResolvedArchitect` (main only, #1497 warning). `terminalPosition: panel` is
  overridden for this path only (a `position` argument to `openArchitect`).
- **Auto-arrange (`cockpit/auto-arrange.ts`)** waits for the window's first connection attempt
  (`ready()` in `initialize()`'s `finally`), so a reload with the Cockpit showing can resolve the
  architect.
- **What rendering found, fixed here:**
  1. *Preview tabs.* `WebviewPanel.reveal(column)` into another group lands the panel there as a
     **preview** tab (1.147.0's `revealWebview` does not pin; `createWebviewPanel` does). The next
     file opened in that group would replace it, closing the panel and its draft. Arrange now keeps
     a panel left as a preview (`workbench.action.keepEditor`, the panel focused and confirmed
     first), before the architect takes focus.
  2. *A second Work panel after a reload.* VS Code revives a restored webview only when its tab is
     shown, so `show()` with no live panel created a second one beside the restored tab. That was
     Phase 7/8 code; arrange made it routine. `show()` now opens the live panel in the restored
     tab's group (or the placement) and closes the restored tab after it.
     `TabInputWebview.viewType` carries the internal `mainThreadWebview-` prefix.
- **Adjacent changes:** the availability text says "Use it from the parent workspace's window"
  (it read wrong for a command); `readArchitectRoster` is shared by *Open Architect* and arrange;
  the menu-parity oracle has a fifth record kind for the Cockpit's own entries.
- **Harness:** `verify arrange` (scenarios 7, 9, 13, 14, 19). `profile-seed` / `profile-existing`
  cover the spec's existing-profile risk: `COCKPIT_PRE_COCKPIT=1 vscode-restart` strips the Cockpit
  container from the install (checked against origin/main's package.json), a new browser profile
  uses Codev on it, then the branch's install loads that profile.
- **Rendered (isolated harness, VS Code 1.147.0 serve-web):** `verify arrange` 15/15,
  `profile-seed` 1/1, `profile-existing` 1/1; evidence in `verification-phase9/`. Work at the
  split's width is 473 px; a typical 44-character title shows 42 characters (architect's 14:00Z
  ruling: 20+). On a profile that used Codev before the Cockpit existed, VS Code places the Cockpit
  button directly below Codev, as on a fresh profile, so the PR needs no activity-bar caveat.
- **Harness findings on 1.147.0** (verify script only, not product): `settings.json` opens in a
  modal editor that takes clicks and F1; a tab's aria-label keeps ", preview" after the tab is
  kept, so preview is read from the italic label; a terminal takes focus a moment after its tab is
  clicked and would swallow the palette's typing; a reload right after a layout command can
  restore the previous layout.
- **Phase 9 review, iteration 1:** codex REQUEST_CHANGES, claude APPROVE.
  - Codex: the architect's tab is found by label, and names are not unique. Accepted. The tab API
    gives a terminal tab no identity, and showing a panel terminal leaves the active editor tab as
    it was, so activation tracking (codex's suggestion) cannot cover the panel case.
    `Terminal.name` does follow renames (1.147.0's `$acceptTerminalTitleChange` sets it), so arrange
    now refuses, before moving an editor, when another terminal has the architect's name.
  - Claude note 1: the automatic arrange with Tower down showed an error toast nobody asked for. It
    now reads the roster quietly and logs. Note 2: the empty-left-group branch is named in the PR
    as unit-tested only. Note 4 (25 ms polling): kept.
- **Phase 9 review, iteration 2:** codex APPROVE, claude APPROVE with two non-blocking findings.
  Both were real and are fixed in place after the approvals, so the PR review is the first to see
  them. Each new test fails on the previous `arrange.ts`.
  - A namesake terminal still being closed (the stale-session path disposes and reopens under the
    same name; 1.147.0 drops it from `window.terminals` only on `$acceptTerminalClosed`) is now
    waited out within the settle bound before arrange refuses.
  - `keepLeftColumn` counts the Cockpit's *tabs* (live or restored), not live panels. A restored,
    unrevived Work tab alone in group 1 used to let group 1 close and time the arrange out.
  - Disputed, with the 1.147.0 bundle as evidence: a column beyond the last group opens every
    missing group up to it (under 9), so the fake's `groupAt()` is right.

## 2026-11-24, review phase (after the context refresh)

- **Architect (15:35Z):** re-run `verify arrange` on the final head before the PR gate; the PR
  should not say "unit-tested only" for arrange fixes the harness can render. There is a standing OK
  for runs of the same harness.
- **New rendered checks in `verify arrange`:**
  - the namesake refusal, and arranging once that terminal is closed;
  - a reload with Tower down and the Cockpit showing: automatic arrange, no error toast;
  - a restored, never-shown panel tab: *Arrange Cockpit* keeps an empty left column.

  The last two began as one check. It failed three runs, because VS Code 1.147.0 reopens its
  Welcome page on a reload even with "show on startup" unticked. I read the bundle: it comes from
  the startup editor and from walkthroughs. Split in two, the restored-tab check closes the Welcome
  page and then runs the command, with the Cockpit hidden so nothing arranges first.

  A scenario 13 setup flake (keys typed before the editor took focus) now waits for the tab to turn
  dirty.
- **Screenshot privacy:**
  - **Found:** the panel shell's prompt `host:dir user$` showed in 12 committed shots. It is
    macOS's `/etc/bashrc` prompt; the harness HOME had no profile.
  - **Ruled (architect, 16:09Z):** option B. `start` writes `PS1='$ '` into the harness HOME, and
    every `verify` run ends with an OCR check (`tesseract`) that fails on such a prompt. It flagged
    exactly those 12 of the 110 committed shots.
  - **Replaced:** the ten `verification-increment1` actions/reconnect shots, by final-code runs.
  - **Not done:** no history rewrite. That is the owner's call, and the architect has told them.
- **PR consultation, iteration 1:** codex REQUEST_CHANGES, claude APPROVE.
  - The architect's rulings (16:39Z):
    - **Electron suite = A.** It is pre-existing and untouched, no workflow runs it, and #1765
      says it cannot launch recent VS Code on macOS. The vitest suite meets the criterion.
    - **Merge main:** a merge commit, no rebase.
    - **Claude's three code points:** fixed in place.
    - **Dormant rebuttal:** agreed.
    - **Evidence out of the tree.**
  - Fixed in `69aa91e3d`:
    - the Decisions bridge no longer forwards a raw transport error, which can name Tower's port;
    - arrange throws when there is no terminal manager;
    - `SingleWebviewPanel.dispose()` drops the panel's listeners.
  - Merge commit `f331978a7`: main at 3.3.8. CHANGELOG and lessons-learned conflicts kept both
    sides.
  - After the merge, apps/vscode has 1820 tests passing, with 1 skip. The one failure was a
    wiring source test that pinned the old optional call; it was updated in `98a7c2c17`.
- **Evidence branch:**
  - `evidence/spir-1963` is an orphan commit `1d5cc1e40`, built with plumbing from HEAD's blobs
    (temp index, `commit-tree`; no checkout or worktree) and pushed.
  - The PR branch drops the five `verification-*/` folders and the six spike PNGs. It gains
    `verification.md`, generated from the results JSON: 127/127 checks, with SHA permalinks.
  - From here, no evidence binaries go to `builder/spir-1963`. The final `verify arrange` goes
    only to the evidence branch.
- **Integration review (16:58Z): asks 2-4 and the confirmations**, at `20d2ce91f`:
  - the `isPanelTab` canary;
  - the CHANGELOG badge line;
  - the WorkView dashboard-host test;
  - the CI syntax check of the harness;
  - the review's Owner Decisions section.
- **Tripwire incident (ask 1, 1.138.0 via ide-server mode):**
  - **What happened.** The harness wrote `codev.towerPort` under `--user-data-dir`. A VS Code
    server ignores that flag and reads `<server-data-dir>/data/Machine/settings.json`, so the
    extension host used port 4100, the owner's Tower.
  - **What the owner's Tower log shows** (read by the architect, not me):
    - requests from 16:56:19Z to 17:21:05Z, 25 minutes, about 9,100 in all, every one a 401;
    - GET `/api/overview`, `/api/events`, `/api/worktree-config`, `/api/activity-hooks` and
      `/workspace/<enc>/api/state`, plus about 1,500 POST `/api/workspace/<enc>/activate`;
    - nothing read or changed, no fixture workspace registered, and the same 12 active workspaces.
  - **Why it lasted 25 minutes.** The tripwire detected the connection at 16:56:20Z, wrote its marker
    and exited. The run went on until the verify script finished, and only then did teardown kill
    the extension host. My first report implied it had stopped at detection; it had not.
  - **Ruled (architect, 17:24Z):**
    - no ide-server run, 1.138 or 1.128, until the owner says so;
    - fix the harness now (the tripwire stops the run, the settings path, a prevention layer);
    - serve-web resumes only after the tripwire fix and its self-test.
  - **Fixed:**
    - **The tripwire stops the run.** On a hit it writes its marker, then freezes and kills the
      whole harness tree, then reports. It trusts a pid file only while that pid's command still
      carries the file's markers.
    - **Gate 5 confirms the server's settings path from its bundle** (`out/server-main.js`) and
      refuses a server where that fails. The two real servers were checked read-only.
    - **ide-server runs inside a `sandbox-exec` profile** that denies outbound TCP to :4100. A
      launch canary on a throwaway port proves the profile applies.
  - **Self-tests:** `selftest tripwire settings sandbox` passed 17/17, with no Tower and no IDE
    server. The tripwire killed a stand-in tree, including a detached grandchild, in 463 ms.
- **Final head before the owner (17:45Z):** `c79b1c7e1`.
  - `verify arrange` passed 19/19 on 1.147.0 serve-web.
  - Windows run 45450646100 succeeded, and CI's 8 checks passed.
  - **Evidence slip.** My glob put 11 stale `arrange-*` shots, five of them showing the host
    prompt, into evidence commit `af31122e6`. Corrective commit: `871ed5a5e`. Evidence files are
    now picked by the names in the run's JSON.
- **Owner rulings at the PR gate (relayed 18:19Z; the gate is NOT approved):**
  - **Accepted as built:** the dormant window, the "Failed to load overview" wording, and the
    Light Modern 4.3:1 texts. The spec's no-workspace criterion and its footprint lines now state
    the dormant behaviour.
  - **History scrub approved by the owner.** It follows the architect's procedure:
    - the evidence branch is rewound to `a749cdd67`, with one clean commit on top;
    - a backup bundle of both tips is kept, local only;
    - `builder/spir-1963` is rewritten in a fresh clone, removing only the evidence paths;
    - every check passes before `--force-with-lease`;
    - the worktree moves onto the new history with `reset --soft`.
- **Test-then-merge (owner ruling ide-2, relayed 20:51Z; the pr gate is NOT approved):** one
  fenced ide-server run on 1.138.0, then one on 1.128. Merge only if both pass and checks are
  green.
  - Waited for PR #1957 (named architects), which merged at 21:18Z. Merged `origin/main`
    (`707e0e904`) as `b164e4898`. The one conflict, the codev-types import in
    `packages/sdk/src/tower-client.ts`, was resolved as the union. The types and sdk build clean.
  - `porch done` (plain, main-39) at 21:20Z, load 13.6: passed. At the review phase it runs
    `pr_exists` and the two review-section checks, and `e2e_tests` is skipped by the repo config.
    There is no tests check in this phase, so no local suite ran.
  - The isolated Tower (`packages/codev` dist) and the vsix were rebuilt from `b164e4898`.
  - Each version runs `verify arrange`, `work` and `decisions`, each on its own `start` and
    `seed fleet`. Every start has the sandbox, its canary and the tripwire, and the run stops at
    the first failure or trip.
  - **1.138.0, 21:21Z: FAILED, and stopped as ordered.** `arrange` passed 14/19. All 5 failures
    are the Work and Decisions webviews staying blank; every layout behaviour passed.
    - The server reported commit `50cad256`, and the tripwire stayed clean.
    - Load: 14.9 at the start, 11.5 at the failure, 32.1 at the end (the Tower rebuild).
    - `work`, `decisions` and 1.128 were not run.
  - **Cause (read-only diagnosis): a webview-protocol mismatch in Codev IDE 1.138's
    `product.json`.** Its `webviewContentExternalBaseUrlTemplate` is pinned to an older insider
    build's host page (`ef65ac1b`), instead of `{{quality}}/{{commit}}`.
    - The 1.138 workbench sends webview resources as a transferred stream, or as chunk messages.
    - That host page and its service worker read only `data.data`.
    - So the panel HTML arrives (the host page fetched `fake.html`), but its scripts never do.
    - The same blank panels appeared in the 16:56Z incident run, before the sandbox and before
      the merge.
    - Reported to the architect by 21:30Z. No new launch without their word.
  - **Diagnostic, authorised 21:31Z.** `verify webviews` (harness-only commit `8cad56b2d`).
    - 1.147 serve-web baseline: 6/6. The built-in Markdown preview, the Codev contextual panel, the
      Codev Markdown preview and Work all render.
    - 1.138.0: all four are blank, VS Code's own Markdown preview included. Every webview
      resource stays pending.
    - All 28 page errors are `DataCloneError: ... A ReadableStream could not be cloned because it
      was not transferred`, thrown at line 447 of the CDN host page (`ef65ac1b`).
    - So the defect is product-wide, in the Codev IDE 1.138 packaging, not in this PR.
  - **1.128.0, 21:42Z: `arrange` 16/19, stopped as ordered.** Webviews render on 1.128, and
    every Cockpit step on the first profile passed.
    - The 3 failures are on the extra fresh browser profiles. 1.128 opens its Workspace Trust
      editor as a modal (`workbench.editor.useModal` defaults to `some`), and the harness does not
      close it, so it intercepts the Cockpit click.
    - Load was 13.4 at the start, 23.1 at the first failure and 17.7 at the end. The tripwire
      stayed clean.
    - Reported 21:48Z. A harness-only fix and a 1.128 rerun await the architect's word.
  - **1.128 rerun with the trust fix (`10f4d9cce`), pre-change build: `arrange` 19/19, `work` 15/15,
    `decisions` 8/16.**
    - The `decisions` failures are the harness's: `activeEditorTab()` read the first `.tab.active` in
      the page. Since Phase 9 the window is arranged into three groups (`codev.cockpit.autoArrange`
      defaults to true), so that tab was the left group's.
    - The panel rendered. The `decisions` script had not run since Phase 8 on any version: my gap.
    - The architect approved the helper fix (the active group's active tab), and widened step d:
      every verify script, on the final head, on 1.147 serve-web.
  - **Owner ruling ide-3 (21:54Z), "workaround".** Work and Decisions carry their bundle inline, on
    every version. The ruling's order:
    - merge main;
    - make the change and run the unit tests;
    - push, and send the architect the commit range;
    - only after the architect's word: 1.147 baseline (every script), fenced 1.138, fenced 1.128.
  - **What I found while building it:**
    - The panel style policy was `${cspSource} 'unsafe-inline'`, not nonce-only as the ruling
      assumed. I built nonce-only as ordered.
    - Measured in Chromium:
      - React `style` props still apply, through the CSSOM;
      - a `style` attribute parsed from markup is refused, so a decision item's aligned table
        columns and raw-HTML inline styles lose those styles;
      - VS Code's default styles and API script sit before our CSP meta, so the policy does not
        apply to them.
    - The bundles fetch nothing else: no `url()`, `@import`, fonts, dynamic `import()` or
      workers. Dev source maps are now inline.
    - Both bundles hold `<!--` (DOMPurify and markdown-it regexes), so the escaping is exercised
      for real: `\x3C`, valid in strings and regexes, `u` flag included.
  - **Panel style policy, reconsidered (`6cf6b5b57`).** I flagged that the old policy had not been
    nonce-only; the architect ruled (22:09Z) that `style-src` become `'unsafe-inline'` alone: no
    nonce, since a nonce in `style-src` disables
    `'unsafe-inline'` and refuses sanitized Markdown's style attributes; and no `cspSource`, since
    the panels load nothing by URL. `script-src` stays nonce-only. The bundle tests now run on the
    production build.
  - **The escape, tested with a parser (`4ab7ed1d4`).** A test parses each production bundle with
    TypeScript's scanner and fails if a `</script`, `<!--` or `</style` rewrite lands anywhere but a
    string, regex, untagged template or comment.
  - **`reveal` (`35334efbf`):** it pressed Enter 300 ms after typing into the file search; it now
    opens README with `quickOpenFile`, which waits for the result.
- **Step d, every verify script on the final head (architect 22:09Z), on `35334efbf`:**
  - **1.147 serve-web, shared session and dashboard:** render 6/6, reveal 2/2, windows 4/4,
    requests 5/5, actions 28/28, reconnect 4/4 (22:21–22:35Z, load 15.1 to 6.0); dashboard 6/6
    (load 6.0 to 4.4).
  - **Stopped at 1.147 `decisions`, 3/16 (22:37Z).** serve-web's own update check had errored
    ("Could not check for update") in the server log during that session, and the workbench went
    with it. Reported; the architect ruled (22:45Z) to resume from `decisions` on the same head,
    with a standing rule: a failure caused by that exact error may be re-run once without asking,
    and noted. Any other failure stops.
  - **Resumed, all passed:** decisions 16/16, work 15/15, arrange 19/19, profile-seed 2/2,
    profile-existing 2/2, webviews 6/6 (22:46–22:55Z, load 7.7 to 9.9).
  - **Fenced 1.138.0:** webviews 3/6 (only the three known blanks: VS Code's own Markdown
    preview, the contextual panel, the Codev Markdown preview; Work rendered), arrange 19/19,
    work 15/15, then **decisions 15/16, stopped.** Scenario 18's contrast check measured 1 for the
    file path in High Contrast Light: white on white.
  - **Cause (read-only diagnosis).** 1.138 serves insider ef65ac1b's webview host page
    (codev-ide#67). Its default styles give `code` the theme's preformatted foreground (white in
    High Contrast Light) without the dark blue background 1.128 and 1.147 pair with it, and they
    are unlayered, where 1.128's and 1.147's sit in `@layer vscode-default`. Reported with
    options; the architect chose (A), fix in place, and widened it: diff the old page's defaults
    against 1.147's and 1.128's and cover every differing rule the panels render.
- **(A), `7cdc24716`.** The diff of the three pages' default-styles blocks, rule by rule:
  - every differing rule targets an element the panels can render, so each is stated in
    `vscode-theme.css` with 1.147's value: the body's `overscroll-behavior-x`, `video` sizing,
    `code` (font, colour, background, padding, radius), `a code`, `pre code`, `p > a`, and `kbd`
    with the old page's `.vscode-light kbd`. Did not apply: none.
  - `a code` and `:root kbd` tie the old page's (0,0,2) and (0,1,1) selectors and come after them.
  - Measured in headless Chromium with the production stylesheets under each page's defaults, light
    and dark, every element type the panels render: before, the old page differed from 1.147 in 34
    computed properties on Decisions; after, 0 on the old page and 0 on 1.128, and 1.147 is
    unchanged. 1.128's one change: code inside a Markdown link is now underlined, as on 1.147.
  - One theme test per rule, plus specificity and the option word's colours. Unit: 134 files,
    1981 passed, 1 skipped.
  - The vsix inputs between `35334efbf` and `7cdc24716`: only `vscode-theme.css` and
    `workspace-views-theme.test.ts`. The architect scoped the re-run to the panel scripts; the nine
    that render no panel stand from `35334efbf`.
- **Re-run on `7cdc24716`, stopped at fenced 1.138 `work`, 14/15 (23:35Z).**
  - Before the stop: 1.147 decisions 16/16, work 15/15, arrange 19/19, webviews 6/6; 1.138
    webviews 3/6 (the known blanks only), arrange 19/19.
  - Scenario 19 (Tower unreachable) read "decision cards: 0 before, 2 while down, 2 after". A
    harness race: after the reload Decisions is restored in a background tab, and the automatic
    arrange brings it on screen only once the first connection attempt ends; the check counted
    cards as soon as the frame existed. The product kept and recovered both cards.
  - **`d31df3a84`** (harness only): the check waits, bounded, for Decisions' cards, re-finding the
    frame on each try. All 11 panel runs restarted on it (23:37Z, load 3.7), so every panel run is
    on one head; the vsix built at `7cdc24716` still holds.
- **Re-run on `d31df3a84`: all passed (23:37Z–00:05Z).**
  - 1.147 serve-web: decisions 16/16, work 15/15, arrange 19/19, webviews 6/6 (load 3.7 to 9.1).
  - Fenced 1.138.0: webviews 3/6 (the three known blanks only; Work rendered), arrange 19/19,
    work 15/15 (scenario 19 now reads 2 cards before, while down and after), decisions 16/16 (High
    Contrast Light: nothing under 4.5) (load 9.1 to 7.9; 12.8 at its highest).
  - Fenced 1.128.0: arrange 19/19, work 15/15, decisions 16/16 (load 7.9 to 10.0; 15.9 at its
    highest).
  - No update-check re-run was needed. Fence: every start passed its canary; every session's
    tripwire section reads only "no connection on :4100"; the servers reported `50cad256` and
    `fc3def67` before and after each session; no browser request reached the owner's port.
  - **Totals:** 1.147.0 115/115 (the nine standing scripts on `35334efbf`, the four panel scripts
    on `d31df3a84`), 1.138.0 53/56, 1.128.0 50/50.
- **Evidence `8b7def1ed`**, pushed to `evidence/spir-1963` as a fast-forward of `51e2bbf17`: 34
  folders, 200 screenshots, each file picked by its run's JSON; the per-phase folders removed;
  `layout-spike/` kept. The prompt check OCR'd 206 images (200 unique): 0 prompts.
  `verification.md` regenerated against it: 227 permalinks, none broken.
- **Unit, on `d31df3a84`:** apps/vscode 134 files, 1981 passed, 1 skipped; workspace-views 197;
  sdk 431; apps/web 38 files, 462 passed, 1 skipped.
- **Step e, completed.** Final head `a5295bc8b`: all 8 GitHub checks passed; Windows run
  45516686696 succeeded (unit, CLI, install verification, both probes). PR body updated: the
  1.138/1.128 results and the codev-ide#67 account replace "unverified", shots from the final
  evidence, the Decisions-poll row in the requests table.
- **`pr` gate approved (owner's rulings ide-2 and ide-3, relayed 00:23:50Z).** The conditions were
  fenced tests passing and GitHub green on the head being merged; the architect verified them on
  `a5295bc8b`.
  - `porch approve` committed and pushed its own gate record, `014a166cd` (status.yaml only), so
    the PR head moved past `a5295bc8b`, the only head I had been told to merge. I stopped and
    reported. The architect ruled that the instruction had not allowed for porch's record: merge
    `014a166cd` once its 8 checks pass and main is unmoved. They did, and it was.
  - `gh pr merge --merge --match-head-commit 014a166cd` was refused by main's branch protection: 1
    approving review required, and the PR's author is the account that would review it. I
    stopped again. The architect authorised `--admin` for the review requirement only, as the
    repo's standing practice once the owner has approved; I checked their precedent first (#1957,
    #1965, #1964, #1954, #1939, all merged that way with no review).
  - **Merged at 00:32:51Z: `84553614f`**, a merge commit with parents `88bc5e9d1` (main) and
    `014a166cd`. Issue #1963 closed (completed) at 00:32:53Z.
- **Verify.** `porch done --merged` first failed ("No PR history found"): I had never recorded the
  PR. Recorded it with `--pr 1971 --branch builder/spir-1963`, then the merge, then `porch done`,
  which requested `verify-approval`. Checking the change in the target environment meant the
  owner's own Codev IDE, which the harness rules keep me away from, so that check was the owner's.
  - The architect installed main (with the Cockpit) on this machine at the owner's word, and Tower
    and the IDE server restarted on codev 3.3.8.
  - **`verify-approval` approved (owner, hub decision ide-4, 00:46Z)**, after the owner tried the
    installed build in their own Codev IDE. Porch: protocol complete.
- **Records PR:** porch's post-merge records and this entry, following PR #1979's precedent. No
  cleanup; the worktree and the backup bundle stay until the architect says.
