# Plan: VS Code alternative layout ("Codev Cockpit")

**Specification**: [codev/specs/1963-vscode-alternative-layout-seco.md](../specs/1963-vscode-alternative-layout-seco.md)

## Executive Summary

This plan implements the approved spec in its three shippable increments, in nine phases. Each
phase is one commit on `builder/spir-1963`, and all of them go into one PR.

0. **Verification harness and layout spike** (Phase 1). This is the isolated harness every rendered
   checkpoint uses (section *Verification harness*), proven safe on an empty fixture. It also runs
   the editor-layout spike the spec's Assumptions require, so its result is known before any
   increment-1 code. If the spike shows that the arrangement needs an owner decision, the owner
   gets it early.
1. **Button + hierarchy** (Phases 2–5). This uses spec approach **A1**: one tree view over the
   existing row-building code. Its single hierarchy is the owner's *"towers -> workspaces ->
   architects / decisions -> builders"*. Rows of this window's workspace act; rows of other
   workspaces navigate.
   - Other workspaces' rows come from the overviews `TowerFleetCache` already fetches. They are kept
     instead of discarded, so the hierarchy needs no new requests and no Tower change.
   - The architect-axis row building moves out of `BuildersProvider` into a reusable builder,
     scoped by workspace. The Agents view and the Cockpit both use it, so there is no second copy
     of row logic.
2. **Shared Work and Decisions** (Phases 6–8). This uses approach **B1**: a new workspace package,
   `@cluesmith/codev-workspace-views` (`packages/workspace-views`).
   - The dashboard's `WorkView`, `DecisionsView`, `useDecisions` and their sub-components move
     there. They take their I/O from a host adapter and their colours from `--codev-wv-*` tokens.
   - The dashboard keeps thin wrappers with its fetch adapter.
   - The extension hosts two editor-area webview panels whose host side relays to Tower through
     `ConnectionManager`'s client.
3. ***Arrange Cockpit*** (Phase 9). This uses approaches **C1** (first show per window, plus the
   command and `codev.cockpit.autoArrange`) and **D1** (Work stacked over Decisions). It also adds
   the one-time first-auto-arrange notice ruled at the gate. It builds on the Phase 1 spike result,
   and writes no arrange code while a spike case is unresolved.

Rendered verification sits at the end of each increment: Phase 5, Phase 8 and Phase 9. It also
runs at Phase 6 (the dashboard comparison) and Phase 7 (Decisions). It uses the isolated harness
built in Phase 1, so the work can be cut after any increment with what has shipped already
verified.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "verification_harness", "title": "Isolated verification harness and editor-layout spike"},
    {"id": "fleet_overviews", "title": "Fleet cache keeps every active workspace's overview"},
    {"id": "architect_tree_builder", "title": "Reusable, workspace-scoped architect-axis row builder"},
    {"id": "cockpit_hierarchy", "title": "Cockpit button and the Tower → workspaces → architects → builders tree"},
    {"id": "cockpit_actions", "title": "Placement-table actions on the hierarchy, parity mapping, increment-1 verification"},
    {"id": "workspace_views_package", "title": "Shared Work/Decisions package; dashboard moved onto it unchanged"},
    {"id": "decisions_panel", "title": "Decisions panel in VS Code, its host bridge, and the hierarchy's Decisions entry"},
    {"id": "work_panel", "title": "Work panel in VS Code, increment-2 verification"},
    {"id": "arrange_cockpit", "title": "Arrange Cockpit: split, triggers, autoArrange, first-arrange notice, increment-3 verification"}
  ]
}
```

## Phase Breakdown

### Phase 1: Isolated verification harness and editor-layout spike

**Dependencies**: None

#### Objective

Build, once, the isolated environment every rendered checkpoint runs in, and prove it cannot reach
the owner's Tower or IDE before it is used for anything. Then use it to run the editor-layout spike,
so the arrangement's feasibility is known before increment-1 code is written.

#### Files to Create / Modify

**New `apps/vscode/scripts/cockpit-harness/`.** It is dev-only: it is excluded from the vsix through
`.vscodeignore` and is not run in CI. It holds:

- `harness.mjs`: start, seed, check and stop, per the *Verification harness* section;
- `preflight.mjs`;
- `tripwire.mjs`;
- `fixtures.mjs`, the fixture driver: in-process `upsertBuilder` and porch state, plus explicit-port
  HTTP calls;
- `stubs/` holding `afx`, `porch` and `codev`;
- `README.md`.

Scripts load the branch's built `packages/codev/dist`. They never use a globally installed CLI.

**The spike is not committed.** It is a throwaway extension in the session scratchpad, loaded into
the harness's isolated VS Code. Its result is recorded in the thread, and later in the review, with
screenshots. It checks:

- (a) `vscode.setEditorLayout` with `{ orientation: 0, groups: [{}, { groups: [{}, {}] }] }`, run
  over three or more existing groups, merges the editors of the groups it removes into the remaining
  groups. Dirty, untitled and modified editors survive with their content;
- (b) an editor-area terminal tab moves between groups without ending its session. The method is
  `terminal.show()`, then `workbench.action.moveEditorToFirstGroup`, then a check that the PTY still
  echoes;
- (c) a panel terminal moves into the editor area through `workbench.action.terminal.moveToEditor`,
  with the session intact;
- (d) `WebviewPanel.reveal(viewColumn)` moves a retained panel to another group without reloading it
  (a counter in the webview survives the move).

**Outcomes:**

- **(a) fails:** arrange only adds or reuses groups and never removes one. The spec already
  provides this, so no decision is needed.
- **(b), (c) or (d) fails:** the spec does not provide a fallback, and every candidate fallback
  changes ruled behaviour. Examples: leaving the architect where it is, or not honouring the
  `terminalPosition` override.
  - **The result goes to the architect at once, with the options**, and Phase 9 waits for the
    owner's ruling.
  - Phases 2–8 do not depend on it and continue.

#### Deliverables

- [ ] The harness scripts, stubs and README.
- [ ] The spike run, with its result recorded in the thread.
- [ ] Harness self-tests.

#### Acceptance Criteria

- [ ] On an empty fixture, `harness.mjs check` passes:
  - every pre-flight gate;
  - the isolated Tower is up on `$PORT`, owned by the harness PID;
  - the isolated VS Code is serving the branch vsix;
  - the stubs resolve.

  `harness.mjs stop` leaves no process of its own behind (checked by PID).
- [ ] **Each pre-flight gate is shown to refuse:**
  - `PORT=4100`;
  - an `AGENT_FARM_DIR` or socket dir outside the scratchpad;
  - a mismatched db path (a `NODE_ENV=test` driver against a production-mode Tower);
  - a listener PID that is not the harness's.

  Each refuses before any state is created.
- [ ] **The tripwire is shown to fire**, without touching `:4100`. Its port is a parameter, and the
      self-test points it at a throwaway local listener the test opens, connects to it from a
      harness child process, and expects a failure.
- [ ] The spike result is recorded, and the architect is told if (b), (c) or (d) failed.

#### Test Plan

- `harness.mjs selftest`: the refusals and the tripwire above.
- A seeded fixture (one workspace, one builder) appears in the isolated Tower's `/api/overview`
  with its `spawnedByArchitect`.
- The spike, as above.

### Phase 2: Fleet cache keeps every active workspace's overview

**Dependencies**: None

#### Objective

Make every active workspace's architects and builders available to the extension, with no new
request. `TowerFleetCache.fetchFleet()` already calls `client.getOverview(path)` for each active
workspace and throws the result away after `deriveAttention`; this phase keeps it.

#### Files to Create / Modify

- `apps/vscode/src/views/tower-cache.ts`:
  - `FleetEntry` gains `overview: OverviewData | null`;
  - a `lastOverview` map gives last-known-good per path, alongside the existing `lastAttention`;
  - a `getOverview(path)` accessor.
- `apps/vscode/src/__tests__/tower-cache.test.ts`: extended.

#### Deliverables

- [ ] On a successful fetch, each active entry carries its overview.
- [ ] On a failed fetch (`null`), the entry keeps its previous overview, as it keeps its attention.
- [ ] A dormant workspace's entry has `overview: null`, and its retained overview is dropped. A
      workspace that leaves the list has its overview dropped.
- [ ] Attention derivation, ordering, the sequence guard and request counts are unchanged.

#### Acceptance Criteria

- [ ] The Tower view renders exactly as before. The existing `tower-cache.test.ts`,
      `tower-provider.test.ts` and `fleet-current-workspace.test.ts` pass.
- [ ] Per refresh, the number of `getOverview` calls equals the number of active workspaces, as
      today.
- [ ] `pnpm --filter codev-vscode check-types`, `lint` and `test:unit` pass.

#### Test Plan

Unit tests with a fake client:

- the overview is retained on success;
- last-known-good is kept on `null`;
- it is dropped when a workspace goes dormant or is removed;
- a stale (out-of-sequence) fan-out does not overwrite a newer overview;
- the call count is unchanged.

### Phase 3: Reusable, workspace-scoped architect-axis row builder

**Dependencies**: None (Phase 2 is not needed; ordered here so the hierarchy phase has both)

#### Objective

Move the row building that `BuildersProvider` does privately into a reusable class. The Cockpit
needs one instance per workspace, so it must be able to build the same rows with ids that cannot
collide, and to build *navigate-only* rows for other workspaces. This is a pure refactor for the
Agents view: same rows, same ids, same behaviour.

#### Files to Create / Modify

- **New `apps/vscode/src/views/architect-tree.ts`:** `ArchitectTreeBuilder`. It receives:
  - `getData(): OverviewData | null`;
  - `grouping(): BuilderGrouping`. The Agents view passes its active axis; the Cockpit always
    passes `architectGrouping()`;
  - `scope: string`, an id prefix. It is `''` for the Agents view, so every existing id is
    unchanged;
  - `mode: 'act' | 'navigate'`;
  - for `navigate`, the `WorkspaceTarget` to open;
  - for `act`, the `BuilderDiffCache`.

  It owns what today lives in `BuildersProvider`:
  - row-id versioning (`AccordionRowIds`) and the group-parent map;
  - `makeGroupRow`, `makeBuilderRow`, the architect-root partition, the *Idle Architects* rows and
    rows-for-group;
  - changed-file children and their parent reconstruction;
  - `findFileItem`, `revealTargetForAgent` and `agentCycleOrder`.

  Architect rows in `act` mode carry the Agents view's `group-builder` contextValue when the scope
  is `''`, so the Agents view is unchanged. A scoped (Cockpit) builder gives them
  `cockpit-architect-main` or `cockpit-architect-sibling`, so a menu entry can tell `main` from a
  sibling.

  In `navigate` mode:
  - builder rows are leaves (no changed files);
  - architect rows still expand to their builders;
  - every row's `command` is `codev.tower.openWorkspace` with the workspace target;
  - `contextValue`s are `cockpit-remote-architect` and `cockpit-remote-builder`;
  - the tooltip names the workspace and says a click opens its window.
- `apps/vscode/src/views/builders.ts`: `BuildersProvider` delegates to one
  `ArchitectTreeBuilder` (scope `''`, mode `act`). Stage/area rendering and the lone-Uncategorized
  flatten stay where they are. They already use the same `makeGroupRow`/`makeBuilderRow`, now
  reached through the builder.
  - `builders.ts` keeps exporting every symbol that moves: `partitionArchitectGroups`,
    `agentTargetIsFocused`, `agentCycleAttemptOrder`, `AgentTarget`, `AccordionRowIds`,
    `AccordionGate`, `findParentNode`, `runBuilderRowClick` and `orderForDisplay`, re-exported from
    their new home where they move.
  - So existing tests importing from `../views/builders.js` (for example
    `agent-cycle-order.test.ts`) need no edit.
- `apps/vscode/src/views/builder-tree-item.ts` and the group, idle-container, folder and file
  item classes:
  - each takes an optional `scope` that prefixes its id;
  - each carries `scope` as a property, so command handlers can tell which view and workspace a
    row belongs to;
  - with `scope = ''`, ids are byte-identical to today's.
- **New tests:** `apps/vscode/src/__tests__/architect-tree.test.ts`.

#### Deliverables

- [ ] `ArchitectTreeBuilder` with `act` and `navigate` modes and scoped ids.
- [ ] `BuildersProvider` rebuilt on it, with no behaviour change.
- [ ] A builder option, `attentionCounts`, which is off for the Agents view, appends *N held* and
      *N queued* to builder-row descriptions. The counts come from `deriveAttention`:
      - for this window's workspace, run over `overviewCache.getData()`, so they never lag that
        workspace's own rows;
      - for other workspaces, run over the fleet cache's retained overview, the summary the Tower
        view uses. Builder rows show neither today, so the Agents view keeps its
      labels byte-for-byte and only the Cockpit turns the option on (the placement table's held
      and queued rows).

#### Acceptance Criteria

- [ ] All existing Agents tests pass unmodified:
  - `builders.test.ts`, `builders-accordion.test.ts`, `builders-autoreveal.test.ts`;
  - `builders-click-expands.test.ts`, `builders-idle-architects-group.test.ts`;
  - `builders-childless-architect-header.test.ts`, `builders-architect-header-command.test.ts`;
  - `agent-cycle-order.test.ts`, `area-grouping.test.ts`, `builder-file-tree-item.test.ts`.
- [ ] With scope `''`, every id the builder produces equals the id produced before the refactor
      (asserted over N=0/1/>1 builders, on all three axes, in flat and tree file modes).
- [ ] Two builders with scopes `A` and `B` over data where both have `main` and a builder `x`
      produce disjoint id sets.
- [ ] Navigate-mode rows:
  - have no changed-files children;
  - carry only `cockpit-remote-*` context values, none of which matches any existing `viewItem`
    pattern in `package.json`;
  - click to `codev.tower.openWorkspace`.
- [ ] Type-check, lint and unit tests pass.

#### Test Plan

Unit tests on `ArchitectTreeBuilder`:

- id equivalence against a snapshot taken from the pre-refactor provider in the same commit;
- scope disjointness;
- navigate-mode shape;
- the fold of null `spawnedByArchitect` into `main`;
- the childless-architect leaf;
- the idle roll-up;
- a non-live recorded architect;
- `getParent` chains for builder, idle-sibling header, folder and file rows.

### Phase 4: Cockpit button and the Tower → workspaces → architects → builders tree

**Dependencies**: Phase 2, Phase 3

#### Objective

Ship the new activity-bar button and its single hierarchy, with this window's builder rows
behaving as they do in Agents: click, accordion, reveal, cycle selection and activity hook. This is
the first user-visible slice. Context-menu actions arrive in Phase 5.

#### Files to Create / Modify

- **New `apps/vscode/icons/codev-cockpit.svg`:** `codev.svg`'s `<path>` wrapped in
  `<g transform="rotate(90 400 400)">`. Same `d`, same viewBox.
- **`apps/vscode/package.json`** (additions only):
  - the container `codev-cockpit` ("Codev Cockpit", the icon above), placed directly after
    `codev`;
  - the view `codev.cockpit`, a tree with no `when`;
  - the command `codev.cockpit.refresh`, with its `view/title` entry.
- **New `apps/vscode/src/views/cockpit.ts`:** `CockpitProvider`. Its node union is:
  `tower-root` | `message` | `workspace` | `dormant-group` | `loading` | rows from an
  `ArchitectTreeBuilder`.
  - **Root:** one *Tower* row, expanded. Its state rows follow `ConnectionManager` and
    `TowerFleetCache`:
    - *Connecting to Tower…* only before the first attempt fails;
    - *Not connected to Tower* once an attempt has failed (`disconnected` / `reconnecting`). Its
      command is `codev.reconnect`;
    - *No workspaces registered* when the fleet list is empty.
  - **Workspaces:** `orderFleet` order, labels and *current* marker; a *Dormant (N)* group.
    - Row construction is shared with `TowerProvider` through a function extracted from
      `TowerProvider.workspaceItem`, with a `hasChildren` option. `TowerProvider` keeps its exact
      output.
    - In the Cockpit, every active workspace is collapsible and has no click command; *Open* is
      added in Phase 5.
    - Dormant rows keep click-to-open.
    - Initial expansion: this window's workspace and any with non-empty attention start
      `Expanded`; the rest start `Collapsed`.
  - **Architects → builders:** one `ArchitectTreeBuilder` per active workspace, cached by path and
    pruned when a workspace leaves.
    - This window's workspace: mode `act`, data from `OverviewCache.getData()`, scope
      `ws:<path>|`.
    - Every other workspace: mode `navigate`, data from `towerCache.getOverview(path)`.
    - In a builder-worktree window or a no-workspace window, every workspace is `navigate` (the
      spec's degraded windows).
  - **Loading:** an active workspace whose overview is not yet available shows one *Loading…*
    child.
  - **Attention on rows:**
    - architect rows get `describeWait` text and glyph from the workspace's
      `AttentionSummary.architects`;
    - builder rows get their glyph, gate and held/queued (Phase 3);
    - the workspace row's description keeps `describeAttention`, which already covers
      unattributed held mail and escalation.
  - **Re-render:** on `overviewCache.onDidChange`, `towerCache.onDidChange` and
    `connectionManager.onStateChange`.
  - **Ids:** the Tower root, workspace rows and the Dormant group get explicit stable ids:
    `cockpit-tower`, `cockpit-ws:<path>` and `cockpit-dormant`. `TowerProvider` sets none today,
    but a Cockpit row must keep its expansion across refreshes and be matchable by `reveal`.
  - **`getParent` across the whole chain**, over the union element type:
    file → folder(s) → builder → architect → (*Idle Architects*) → workspace → Tower root. The
    builder answers up to its architect row. The Cockpit bridges each scoped architect row (and
    the *Idle Architects* container) to its workspace node, and each workspace node to the root
    or the Dormant group. Active-file reveal and agent-cycle selection depend on this.
- **`apps/vscode/src/extension.ts`:**
  - create `cockpitView`;
  - generalise the `buildersView`-bound wiring into a small registry, `AgentTreeHosts`
    (`apps/vscode/src/views/agent-tree-hosts.ts`), that maps a row's `scope` to its
    `{ view, builder }`:
    - `codev.openBuilderRow` reveals in the row's own view;
    - each view gets its own `onDidExpandElement` accordion with its own `AccordionGate`;
    - active-file reveal and agent-cycle selection reveal in every visible host that holds the
      row;
    - selection in either view fires `builder-active`;
  - the activity-badge value is computed once and assigned to both `buildersView` and
    `cockpitView`, with the same suppression;
  - `cockpitView.visible` joins `anyVisible()` and its visibility event joins `reconcile` in
    `setupPeriodicOverviewRefresh`;
  - the config listeners serve both views. The `codev.buildersFileViewAsTree` listener refreshes
    the Cockpit provider as well as `buildersProvider`. The `codev.buildersAutoCollapse` listener
    updates both views' `AccordionGate`s, and sets the context key that both title bars read;
  - `codev.cockpit.refresh` refreshes `overviewCache` and `towerCache`.
- **Tests:**
  - new `apps/vscode/src/__tests__/cockpit-provider.test.ts`;
  - new `apps/vscode/src/__tests__/cockpit-wiring.test.ts`;
  - `apps/vscode/src/__tests__/contributes-cockpit.test.ts`;
  - `apps/vscode/src/__tests__/cockpit-icon.test.ts`.

#### Deliverables

- [ ] Container, view, icon and refresh command.
- [ ] `CockpitProvider` with every level, state row and fold rule in spec §2.
- [ ] Generalised tree behaviours, the badge on both views, and periodic refresh with the Cockpit
      counted.
- [ ] Stable ids for the Cockpit's own nodes, and a `getParent` chain that reaches the Tower root
      from every row.
- [ ] Config listeners that redraw and re-gate both views.
- [ ] Tests listed below.

#### Acceptance Criteria

- [ ] The spec's success criteria for structure, folds, attention on rows, navigate-only rows, id
      distinctness, tree behaviours and the refresh gate hold in unit tests.
- [ ] `contributes-*`: the new container sits after `codev`, the view has no `when`, and the icon
      path exists. The existing `codev`, `codev-tower` and `codevPanel` entries are byte-identical
      (a snapshot of those keys).
- [ ] Existing tests that assert on `extension.ts` source text (`worktree-window-1809.test.ts`)
      either pass or are updated only to follow the generalised wiring, with the guarded behaviour
      (badge suppressed in a worktree window) asserted on both views.
- [ ] Type-check, lint and unit tests pass.

#### Test Plan

- **`cockpit-provider.test.ts`**, with fake caches:
  - root state rows, including *Not connected* → `codev.reconnect`;
  - workspace order, labels, *current* and the Dormant group, compared with `TowerProvider` over
    the same fleet;
  - expansion defaults;
  - click: an active workspace has no command, a dormant one opens;
  - *Loading…*;
  - own workspace rows equal the Agents architect-axis rows for the same `OverviewCache` state
    (N=0/1/>1, idle roll-up, null owner → `main`, non-live owner, childless leaf);
  - other workspaces navigate-only;
  - worktree and no-workspace variants;
  - colliding names across two workspaces;
  - `codev.buildersGroupBy = stage|area` leaves the tree unchanged;
  - every attention kind lands on its row;
  - `getParent` from a file row of this window's workspace (flat and tree modes), from a builder,
    from an idle-sibling architect and from an architect row returns the chain to `cockpit-tower`.
    `reveal` then succeeds on a fake TreeView that walks `getParent`.
- **`cockpit-wiring.test.ts`:**
  - `openBuilderRow` reveals in the owning view;
  - accordion per view;
  - the visibility gate runs with only the Cockpit visible and stops with nothing visible;
  - the badge is equal on both views and suppressed when disconnected and in a worktree window;
  - toggling `codev.buildersFileViewAsTree` refreshes both providers, and toggling
    `codev.buildersAutoCollapse` re-gates both accordions.
- **`cockpit-icon.test.ts`:** same `d` attribute as `codev.svg`, wrapped in `rotate(90 400 400)`.

### Phase 5: Placement-table actions on the hierarchy, parity mapping, increment-1 verification

**Dependencies**: Phase 4

#### Objective

Make every row of this window's workspace act exactly as it does in the source views, put every
source-view affordance where the spec's placement table says, and prove that nothing was missed
with a test generated from `package.json`. This phase closes increment 1, including its rendered
verification and docs.

#### Files to Create / Modify

**`apps/vscode/package.json`** (additions only):

- `view/item/context` entries for `view == codev.cockpit`:
  - builder rows of this window's workspace: the same commands, groups and `viewItem` patterns as
    the 12 Agents `view/item/context` entries;
  - architect rows: *Remove Architect* on `viewItem == cockpit-architect-sibling` only, never on
    `cockpit-architect-main`;
  - workspace rows:
    - *Open* / *Deactivate* inline, as in Tower;
    - on the current row, inline *Spawn Builder*, *New Shell* and *Add Architect*;
    - on the current row's context menu, those three plus *Open Web Interface*, *Start Dev* or
      *Stop Dev*, and *Open Dev URL…*.
- `view/title` entries for `view == codev.cockpit`:
  - *Refresh* (`codev.cockpit.refresh`);
  - the accordion toggles and file-tree toggles, reusing the existing commands, keyed on the same
    global context keys.
- **New command `codev.cockpit.openWebInterface`.** The Workspace view's *Open Web Interface* is a
  row whose command is `vscode.open` with no command id of its own. It opens the same URL via the
  shared `buildDashboardUrl`, extracted from `WorkspaceProvider`.

**Context values on the current workspace row** encode what the Workspace view decides for this
window. The data behind them follows the Workspace view's own sources:

- **Worktree config.** It is async: `loadWorktreeConfig` awaits `client.getWorktreeConfig(...)`.
  - The Cockpit re-renders far more often than the Workspace view does: on every fleet and overview
    change, including the fleet's 20 s fallback poll. So it **holds the resolved config** instead of
    fetching per render.
  - It resolves the config once, in its async root `getChildren`, and drops it on:
    - the `codev-config-updated` envelope, the signal that exists for exactly this;
    - a connection-state change;
    - a workspace change.

    The next render then fetches it again.
  - A test asserts that N fleet and overview changes cause no `getWorktreeConfig` call, and that
    one `codev-config-updated` causes exactly one.
- **Re-render signals.** The Cockpit re-renders on the same signals `WorkspaceProvider` subscribes
  to:
  - `terminalManager.onDidChangeDevTerminals`, so *Start Dev* / *Stop Dev* stays honest across
    every start, stop and cleanup path;
  - the `codev-config-updated` SSE envelope, for `devUrls` and dev-command edits;
  - the `architects-updated` SSE envelope, for add and remove from the CLI.

  These are in addition to the three Phase 4 signals. They need no new connection: the envelopes
  come from `connectionManager.onSSEEvent`.

The values themselves:

- `cockpit-workspace-current` plus a dev-slot suffix: `-dev-start`, `-dev-stop` or
  `-dev-stop-other`. It is computed by a function extracted from `WorkspaceProvider`'s dev-row
  logic, so the two cannot disagree;
- a `-devurls` suffix when `worktree.devUrls` is non-empty.

**Builder-worktree window:**

- the parent's row is `cockpit-workspace-parent`;
- it carries *Open Web Interface*, the worktree *Start Dev* / *Stop Dev* and *Open Dev URL…* (the
  worktree-scoped actions the Workspace view shows there);
- it carries no spawn, shell or architect actions.

**Other files:**

- `apps/vscode/src/views/workspace.ts`: the extracted `buildDashboardUrl` and dev-slot functions,
  used by both providers. The Workspace view's output is unchanged.
- **New `apps/vscode/src/views/cockpit-menu-map.ts`:** the checked-in mapping oracle. It has one
  record per existing `view/item/context` and `view/title` entry for `codev.workspace`,
  `codev.agents` and `codev.tower` (27 today), each one of:
  - `{ same: <cockpit viewItem pattern> }`;
  - `{ relocated: <cockpit entry> }`;
  - `{ excluded: <reason> }`. Only the three `codev.agentsCycleGroupFrom*` title entries are
    excluded.

  It also has one record per Workspace-view row click: Open Web Interface, Spawn Builder, New
  Shell, Start/Stop Dev, dev URLs and architect rows.
- **New `apps/vscode/src/__tests__/cockpit-menu-parity.test.ts`.**
- **Docs:**
  - the `apps/vscode/README.md` Cockpit section;
  - `codev/resources/arch.md`, *VS Code Extension*: the Cockpit container, `ArchitectTreeBuilder`,
    fleet-overview retention and the act/navigate rule;
  - `CHANGELOG` entry for `apps/vscode`.

**`codev.removeArchitect` handler (`extension.ts`).** It resolves the name from an id starting
`workspace-architect-`, else from `arg.label`. A Cockpit architect row is a group row whose label
is display text (`WEB (0)`), so the menu entry alone would call `removeArchitect(ws, 'WEB (0)')`.

- **Change:** a `BuilderGroupTreeItem` argument resolves to its `groupName`. The Workspace-view and
  string paths are unchanged.
- **Accepted difference:** the Cockpit's architect rows come from the overview's `architects`, as
  the Agents architect axis does. The Workspace view lists architects from the workspace status's
  terminals. Any difference between the two sets is accepted, as it is today between Workspace and
  Agents.

#### Deliverables

- [ ] All placement-table entries for increment 1 (the Decisions entry is Phase 7).
- [ ] The `removeArchitect` argument resolution for Cockpit architect rows, with a unit test.
- [ ] The mapping oracle and the parity test.
- [ ] Rendered verification of increment 1 and docs.

#### Acceptance Criteria

- [ ] The parity test fails if any of these holds:
  - a source entry has no record;
  - a mapped Cockpit entry is missing from `package.json`;
  - a `cockpit-remote-*` or `cockpit-workspace-parent` value matches a builder or architect
    entry's `viewItem`;
  - *Remove Architect*'s `when` matches `cockpit-architect-main`;
  - an existing source entry differs from its snapshot.
- [ ] **Each relocated command handles a Cockpit tree element as its argument**, because VS Code
      passes the clicked element to every menu entry. A unit test invokes each handler with the
      Cockpit node its entry is attached to and asserts it acts on that node's target:
      - *Remove Architect* resolves the name from the Cockpit row, not from `arg.label`;
      - *Open Dev URL…* falls through to its QuickPick;
      - *Spawn Builder*'s `extractIssueId` yields no id from a workspace node;
      - *Add Architect*, *Start Dev* and *Stop Dev* ignore the argument.

      A future handler change then fails the test instead of regressing silently.
- [ ] From the Cockpit, in the harness, these work on this window's workspace:
  - every builder context action;
  - Approve Gate inline;
  - every workspace-row action;
  - Remove Architect.

      The actions that shell out to the CLI (*Spawn Builder* → `afx spawn`, *Approve Gate* →
      `porch approve`) are verified through the harness's recording stubs. The check is that the
      extension invoked the right command line, in the right cwd, from the Cockpit row, the same
      as from the Agents and Workspace rows. A real CLI run would reach `:4100`. Every other action
      runs for real against the isolated Tower.
- [ ] Another workspace's architect or builder row opens that workspace's window.
- [ ] **Request count** (spec scenario 21). The isolated Tower's request log is compared for two
      cases:
      - the Cockpit alone visible;
      - the Workspace, Agents and Tower views alone visible.

      Each case is measured over the same idle window plus one scripted burst: a builder state
      change and one `codev-config-updated`. They match: the overview, the fleet fan-out, and
      `getWorktreeConfig` only on load and on `codev-config-updated`, never per fleet tick. With
      both sets visible at once, the only addition is the Workspace view's own `getWorktreeConfig`
      on its own renders. No poll, SSE stream or route is added.
- [ ] **Rendered** (see the harness below), with screenshots:
  - the button under Codev;
  - the hierarchy with N=0, N=1 and N>1 builders and two or more workspaces;
  - the Dormant group;
  - *Not connected* → reconnect;
  - light and dark themes.
- [ ] Type-check, lint and unit tests pass. The existing `contributes-*` tests are unmodified
      apart from additions.

#### Test Plan

- Unit:
  - the parity test;
  - the dev-slot function (shared cases with `workspace.test.ts`);
  - context values on the current, parent and remote workspace rows;
  - main versus sibling architect context values;
  - the Cockpit re-renders on a dev-terminal change and on `codev-config-updated` and
    `architects-updated` envelopes;
  - *Stop Dev* replaces *Start Dev* after a dev starts from a builder's menu;
  - `removeArchitect` given a Cockpit sibling row removes that architect by `groupName`.
- Rendered: spec scenarios 11, 12 (hierarchy part) and 19 (worktree and no-workspace windows;
  Cockpit-only freshness).

### Phase 6: Shared Work/Decisions package; dashboard moved onto it unchanged

**Dependencies**: None (independent of Phases 2–5; ordered for the increment boundary)

#### Objective

Create the one shared home for the Work and Decisions React code, and move the dashboard onto it
with no visible change. After this phase the components exist once, behind a host adapter that a
second host can implement.

#### Files to Create / Modify

**New package `packages/workspace-views` (`@cluesmith/codev-workspace-views`, private, not
npm-published):**

- **Source-exported:** `exports: { ".": "./src/index.ts", "./styles.css": "./src/styles.css" }`.
  Each host's bundler compiles it: Vite in `apps/web`, esbuild in `apps/vscode`. There is no build
  step, so CI build ordering is unchanged.
- **Own files:** `tsconfig.json` (`jsx: react-jsx`), `vitest.config.ts` (jsdom), and `test` and
  `check-types` scripts.
- **Dependencies:** `@cluesmith/codev-types`, `@cluesmith/codev-sdk` (the environment-agnostic
  `builder-helpers` only), `@cluesmith/codev-artifact-canvas`, and React as a peer dependency.
- **Its own devDependencies**, declared here rather than borrowed from `apps/web` under pnpm's strict
  layout, at the versions `apps/web` uses:
  - `react` and `react-dom`;
  - `@types/react` and `@types/react-dom`;
  - `@testing-library/react` and `@testing-library/jest-dom`;
  - `jsdom`, `vitest` and `typescript`.

  `pnpm-lock.yaml` is updated in the same commit. The package's `test` runs in CI's existing
  workspace test step, and Phase 6 checks that it does.
- **`src/host.ts`:** the `WorkspaceViewsHost` adapter. Its members are optional unless stated:
  - `overview` (required): a subscribe/refresh source;
  - `decisions`: `read()`, `rule(req)`, `image(path, signal?)`.
    - `DecisionsView` keeps its per-image `AbortController`. The dashboard adapter passes the
      signal to `fetch`, as today.
    - The VS Code adapter tags each image request with an id. On abort it ignores the reply for
      that id; the host's fetch may still finish and is discarded. A test covers an aborted image
      whose reply arrives late;
  - `openBuilder(id)`;
  - `newShell()`;
  - `refresh()`;
  - `openArtifact(path)`;
  - `openExternal(url)`;
  - `showImage(src)`.

  A control renders only when its action is provided.
- **Moved here from `apps/web/src`:**
  - `components/WorkView.tsx`, keeping its core sections.
    - **Its `state: DashboardState | null` prop is removed from the shared surface.** `state` feeds
      three things today: the loading gate, `architectCount` from `state.architects`, and
      `findBuilderTab`'s builder list. In the package:
      - the loading gate keys on the overview;
      - `architectCount` comes from `OverviewData.architects`, as the spec's Assumptions rule;
      - builder opening goes through the host's `openBuilder(id)`. The dashboard wrapper maps it
        to `findBuilderTab(builder, state.builders)` and `onSelectTab`, as today.

      The dashboard wrapper keeps reading `/api/state` for its own pieces.
    - The dashboard-only pieces become optional slots: the **whole file panel**,
      `OpenFilesShellsSection` and `TipBanner`.
      - The file panel slot is the `work-file-panel` wrapper (toggle, label, search input and
        `FileTree`), together with the root's `file-panel-open` class, not `FileTree` alone. With
        the slot absent nothing of it renders, so there is no empty strip and no dead search box.
      - A test asserts this in the VS Code host;
  - `components/DecisionsView.tsx`, `hooks/useDecisions.ts`;
  - `components/BuilderCard.tsx`, `NeedsAttentionList.tsx`, `BacklogList.tsx`,
    `RecentlyClosedList.tsx`;
  - the `issueRef` part of `lib/issueIds.ts`. `findBuilderTab` stays in the dashboard; it is
    dashboard tab logic.
- **`src/styles.css`:** the Work and Decisions CSS rules moved from `apps/web/src/index.css`
  (`.work-*`, `.backlog-*`, the builder-card, needs-attention, recently-closed and `.decisions-*`
  rules). They are rewritten against `--codev-wv-*` tokens, each with a default equal to today's
  dashboard value.
- **Tests:** the existing `apps/web` tests for these components, moved into the package, with
  their assertions unchanged in intent:
  - `BuilderCard.test.tsx`, `NeedsAttentionList.test.tsx`, `BacklogList.test.tsx`;
  - `DecisionsView*.test.tsx`, `useDecisions.test.ts`, `issueIds.test.ts` (the `issueRef` part).

  Where a test mocked `lib/api.ts`, it now passes a fake host.

**`apps/web`:**

- thin wrappers `src/components/WorkView.tsx` and `src/components/DecisionsView.tsx` build a
  fetch-based host from `lib/api.ts` (unchanged) and pass the dashboard slots;
- `index.css` maps `--codev-wv-*` to its palette and imports the package styles;
- the package is added to `package.json`;
- tests that exercise the dashboard integration stay in `apps/web`: `App.decisions-tab.test.tsx`,
  `App.workview-scroll.test.tsx`, `fetchDecisions.test.ts`, `useTabs.decisions.test.ts` and
  `useOverview.stability.test.ts`.

**Repo wiring:**

- `pnpm-workspace.yaml` already globs `packages/*`;
- `.github/workflows/test.yml` gains a step that runs the package's tests and type-check;
- `scripts/bump-all.sh` is left alone, because the package is private and versionless like
  `apps/web`.

#### Deliverables

- [ ] The package, its adapter, its styles and the moved tests.
- [ ] The dashboard on the package, through wrappers.
- [ ] No component used by Work or Decisions left in `apps/web`. A repo check proves there is
      one copy.

#### Acceptance Criteria

- [ ] `apps/web` `test`, `check-types` and `build` pass. `App.decisions-tab` and
      `App.workview-scroll` pass unchanged.
- [ ] The package's `test` and `check-types` pass.
- [ ] **Rendered:** in the harness's Tower dashboard, Work and Decisions look and behave as before
      (spec scenario 20, compared with screenshots taken on `main` beforehand). A ruling round-trips.
- [ ] A grep check in the package tests asserts that the moved component files exist only in
      `packages/workspace-views/src`.

#### Test Plan

- The moved unit tests.
- New fake-host tests:
  - an absent `openBuilder` hides the *Open* button;
  - an absent `newShell` hides *+ Shell*;
  - slots render only when passed;
  - `rule()` refusals render the server message.
- Dashboard render comparison in the harness.

### Phase 7: Decisions panel in VS Code, its host bridge, and the hierarchy's Decisions entry

**Dependencies**: Phase 4 (for the Decisions entry), Phase 6

#### Objective

Let the owner rule on decisions without leaving VS Code. The panel is the shared `DecisionsView`
in an editor-area webview, with every Tower call made by the host. This phase also builds the
webview infrastructure that Phase 8 reuses.

#### Files to Create / Modify

**`packages/sdk/src/tower-client.ts`:**

- `getDecisions(workspacePath)` and `ruleDecision(workspacePath, req)` use the existing private
  `requestPreservingBody`, so `{ ok:false, code, message }` survives a non-2xx.
- `getDecisionImage(workspacePath, path)` cannot use it: that helper reads `response.text()` and
  JSON-parses the body, which destroys binary bytes and drops `Content-Type`. It uses a new private
  `requestBinary(path)` instead:
  - an authenticated `fetchFn` call (same key header, base URL and timeout);
  - it returns `{ status, bytes: Uint8Array, contentType }` on 2xx;
  - on a non-2xx it returns `{ status, body }`, the JSON-parsed body, so a refusal keeps its code
    and message;
  - like every method on this client, it never rejects. A transport failure comes back as
    `status: 0`.

Tests go in `packages/sdk/src/__tests__/tower-client.decisions.test.ts`, and the SDK boundary tests
stay green.

**New `apps/vscode/src/workspace-views/` (host side):**

- `messages.ts`: the host↔webview contract, with an `is*Message` guard for every inbound message;
- `security.ts`:
  - canonical, symlink-resolved workspace containment. Both sides go through `fs.realpath`, then
    `path.relative(root, target)` is taken. The target is inside only if the result is not
    absolute, is not `..`, and does not start with `..` followed by a separator. There is no
    string-prefix check, so on Windows drive-letter case and `\` / `/` are normalised by the
    same calls;
  - an `http:`/`https:` allowlist for external opens.
- `panel-template.ts`: the nonce CSP.
  - `default-src 'none'` first, as both existing webviews have it (`panel-template.ts:22`,
    `preview-template.ts:47`). Without it, leaving out `connect-src` restricts nothing: `fetch`,
    XHR, WebSocket and EventSource fall back to `default-src`, so `'none'` is what blocks them;
  - `script-src 'nonce-…'`;
  - `style-src ${cspSource} 'unsafe-inline'`, the same as the existing webviews
    (`contextual-panel/panel-template.ts`, `markdown-preview/preview-template.ts`).
    - The shared components set React `style` attributes. For example, `BuilderCard`'s progress
      bar uses `style={{ width: … }}`. A `style-src` without `'unsafe-inline'` would silently drop
      those.
    - Scripts stay nonce-only. Inline *styles* do not run code;
  - `img-src ${cspSource} blob: http: https:`;
  - no `connect-src`, so connections fall back to `default-src 'none'`;
  - `localResourceRoots` set to `dist`.
  - **A static CSP test** (`panel-template.test.ts`) parses the generated policy and asserts:
    - `default-src 'none'` is present;
    - there is no `connect-src`;
    - `script-src` is exactly the nonce, with no `'unsafe-inline'` or `'unsafe-eval'`;
    - `img-src` and `style-src` are exactly as listed.
- **Spec scenario 22** (no webview contact with Tower) is tested at three levels:
  - **Source:** an ESLint `no-restricted-globals` / `no-restricted-properties` rule bans `fetch`,
    `XMLHttpRequest`, `WebSocket`, `EventSource` and `navigator.sendBeacon` in
    `packages/workspace-views/src` and `apps/vscode/src/workspace-views/webview`. All I/O goes
    through the host adapter. The dashboard's fetch adapter lives in `apps/web`, outside the rule.
  - **State:** a unit test asserts that no message the host posts to a webview carries the Tower
    key, a Tower URL or a port. It checks each message type's payload against the key and the
    configured base URL.
  - **Rendered:** in the harness, Playwright records every request from the webview frames.
    - The run passes only if each request is a `vscode-resource`/`cspSource` asset, a `blob:` URL,
      or a remote `http(s)` item image from the fixture's decisions file.
    - No request may go to the isolated Tower's port, and none may carry the key header.
- `decisions-panel.ts`, a single-instance `WebviewPanel` (`retainContextWhenHidden`):
  - **Polling has one owner:** the shared `useDecisions` hook, with its existing 2 s cadence. Each
    tick calls the host adapter's `read()`, and the host makes one Tower request per call. The host
    runs no timer of its own.
    - Hidden means the *panel* is hidden. A retained, hidden webview's iframe still reports
      `document.visibilityState === 'visible'`, so the hook's page-visibility gate never fires
      there.
    - So the host relays `onDidChangeViewState` as a `{ type: 'visibility', visible }` message,
      and the webview passes it as the hook's existing `isActive` input. Polling stops while the
      panel is hidden and resumes when it is shown;
  - drops responses for a disposed panel;
  - supports not-connected, last-known-good and empty states;
  - workspace images are sent as bytes and shown as object URLs;
  - http(s) links open externally through the allowlist;
  - the full-size image is shown in the panel;
  - it registers a `WebviewPanelSerializer` for reload restore.

**New `apps/vscode/src/workspace-views/webview/decisions-main.tsx`:** mounts the shared
`DecisionsView` with a postMessage-backed host, plus `webview/vscode-theme.css`, which maps
`--codev-wv-*` to `--vscode-*`.

**Build:**

- `apps/vscode/esbuild.js`: a new entry, `dist/webview/decisions.{js,css}`.
  - It sets `jsx: 'automatic'` explicitly, with `tsconfig: 'tsconfig.webview.json'`. The existing
    webview entries are `.ts` (their JSX lives in canvas's prebuilt `dist`), and esbuild otherwise
    reads the nearest `tsconfig.json`, which sets no `jsx`. These are the first TSX sources
    compiled under `apps/vscode`.
  - A bundle smoke test asserts the bundle mounts in jsdom. It does not depend on a prior `dist`:
    - CI's `apps/vscode` step runs `check-types` then `test:unit`, and no esbuild run;
    - so the test builds the entry itself in `beforeAll`, through esbuild's API into a temp dir,
      using the same options object `esbuild.js` uses. That object is exported from a small
      `esbuild.webview.mjs` both import.

    It therefore runs under `pnpm test:unit`, locally and in CI, on a clean tree.
- `tsconfig.webview.json`: adds `jsx: react-jsx` and the new `src/workspace-views/webview`
  directory;
- `apps/vscode/tsconfig.json`: adds `src/workspace-views/webview` to `exclude`, alongside the two
  existing webview directories, so the host `tsc --noEmit` never compiles browser TSX;
- `apps/vscode/package.json`: the dependency on `@cluesmith/codev-workspace-views` (and
  `prepublish-workspace-deps.test.ts` updated if it enumerates workspace dependencies).

**Commands and entry:**

- `codev.openDecisions` (*Codev: Open Decisions*), via `regCli`;
- in builder-worktree and no-workspace windows it shows the explanation instead of acting;
- `CockpitProvider` gains the **Decisions** entry after the architects of every active workspace:
  - under this window's workspace it opens or reveals the panel, without arranging;
  - elsewhere it navigates, as the other rows do;
- the mapping oracle and parity test are updated for the new entry.

#### Deliverables

- [ ] SDK methods; the host bridge; the security helpers; the Decisions panel; the command; the
      Decisions entry.
- [ ] Unit tests for each.

#### Acceptance Criteria

- [ ] Spec scenarios 6 (host message contract), 8 (decisions bridge), 15, 16 and 22 pass. The
      rendered ones (15, 16) are run in the harness at this phase's end, with screenshots, because
      Phase 8's verification focuses on Work.
- [ ] The Tower key never appears in any message sent to the webview (asserted on the message log
      in a host test).
- [ ] Type-check (host and webview configs), lint, unit tests and the SDK boundary tests pass.
- [ ] **Windows.** This phase adds path code: canonical-path containment that resolves symlinks.
      The on-demand Windows workflow is dispatched on the branch and its run is linked in the PR:
      `gh workflow run windows.yml --ref builder/spir-1963 -f purpose='Spec 1963: webview path
      containment (realpath/relative, junctions)' -f suites=true`.

#### Test Plan

- **Host unit tests:**
  - the guard rejects malformed messages;
  - containment refuses `..`, absolute-outside and symlink escapes (a real temporary directory
    with a symlink);
  - **Windows path cases.** These run as `path.win32` table tests on every OS, and for real in the
    Windows workflow:
    - drive-letter case (`c:\ws` vs `C:\ws`);
    - mixed separators;
    - a different drive;
    - a UNC root (`\\server\share`) against a local root;
    - a prefix sibling (`C:\ws-other` vs `C:\ws`);
    - on the Windows runner, a directory junction pointing outside the workspace;
  - the allowlist refuses `javascript:`, `file:` and `vscode:`;
  - a refusal passes through with its code and message;
  - transport errors are handled;
  - not-found maps to the empty state;
  - polling stops when hidden: after a `visibility: false` message, no `read` request reaches
    the host until `visibility: true`;
  - a late response after dispose is dropped;
  - single instance.
- **Webview unit tests** (jsdom): mounting with a fake bridge renders items, and Submit posts the
  right message.
- **Rendered:**
  - rule an item, and check the file and the hub notice;
  - a stale fingerprint is refused and the draft kept;
  - images: a workspace image, an https image, a refused image, and the full-size view;
  - with no file, the empty state, then `afx decisions init` in the fixture makes items appear;
  - the Decisions entry from the hierarchy;
  - spec scenario 18 for Decisions: light, dark and high-contrast themes, and a live switch.

### Phase 8: Work panel in VS Code, increment-2 verification

**Dependencies**: Phase 7 (shared webview infrastructure)

#### Objective

Put the dashboard's Work view in VS Code, fed from the same `OverviewCache` as the sidebar, with
every kept affordance mapped to a VS Code action and every dropped one absent.

#### Files to Create / Modify

- **New `apps/vscode/src/workspace-views/work-panel.ts`:** a single-instance `WebviewPanel`
  (`retainContextWhenHidden`).
  - It pushes `OverviewCache` data and connection state to the webview.
  - Its visibility counts toward `setupPeriodicOverviewRefresh`. The gate is extended from
    TreeViews to "TreeViews or the Work panel".
  - It maps the dashboard actions as follows:
    - *Open* → `terminalManager.openBuilderByRoleOrId`;
    - *+ Shell* → `codev.newShell`;
    - *Refresh* → `client.refreshOverview()` (the SDK's existing `POST /api/overview/refresh`),
      then `overviewCache.refresh()`. That route is machine-global, with no workspace argument,
      unlike every other Work action. It is the same call the dashboard's *Refresh* makes;
    - artifact links → `openArtifact`, checked by containment;
    - external links → the allowlist.
  - It registers a serializer for reload restore.
- **New `apps/vscode/src/workspace-views/webview/work-main.tsx`:** mounts the shared `WorkView`
  with no dashboard slots.
- `apps/vscode/esbuild.js`: a `dist/webview/work.{js,css}` entry.
- `codev.openWork` (*Codev: Open Work*), with the same window rules as `codev.openDecisions`.
- **Docs:** the README Work/Decisions section; `arch.md` (the shared package and the host-adapter
  pattern, extending the canvas precedent); the CHANGELOG.

#### Deliverables

- [ ] The Work panel, the command, the refresh-gate extension, tests and docs.
- [ ] Rendered verification of increment 2.

#### Acceptance Criteria

- [ ] The spec's Work criteria hold:
  - builders, Needs Attention, Backlog and Recently Closed render;
  - each mapped action does what the table says;
  - no dropped affordance renders.
- [ ] Periodic refresh runs with only the Work panel visible.
- [ ] **Rendered:**
  - spec scenarios 17 (Work actions, including a builder's progress bar rendering at its width
    under the real webview CSP; jsdom does not enforce CSP), 18 (light, dark and high-contrast
    themes, and a live switch)
    and 19 (the Tower-unreachable part, simulated by stopping the *harness's* Tower);
  - screenshots.
- [ ] Type-check, lint and all unit suites pass.

#### Test Plan

- **Unit:** the action mapping; the refresh gate with only the Work panel visible; a refused
  artifact path; an external URL scheme refused; dropped slots absent.
- **Rendered:** as above.

### Phase 9: Arrange Cockpit: split, triggers, autoArrange, first-arrange notice, increment-3 verification

**Dependencies**: Phase 1 (the spike result), Phase 4, Phase 7, Phase 8

#### Objective

The one-click layout: `main` architect | (Work over Decisions). It arranges automatically on the
first show per window session, and on demand. It never closes or discards a user's editor.

#### Files to Create / Modify

**The Phase 1 spike result decides the mechanics.** If (a) failed, arrange only adds or reuses
groups. If (b), (c) or (d) failed, this phase starts only after the owner's ruling on the options
the architect was given.

**New `apps/vscode/src/cockpit/arrange.ts`, `arrangeCockpit()`:**

- shapes the layout, preserving editors per the spike;
- resolves `main` through `openResolvedArchitect`. A non-live `main` gets the existing warning and
  no substitute;
- reuses an open architect terminal and moves it to group 1, even with `terminalPosition: panel`
  (this path only);
- opens or reveals the Work panel in the top-right group and Decisions in the bottom-right;
- makes each of the three the active tab in its group;
- is idempotent.

**New `apps/vscode/src/cockpit/auto-arrange.ts`:**

- runs the first-show check on view creation and on visibility change, once per window session;
- respects `codev.cockpit.autoArrange`;
- does nothing in builder-worktree and no-workspace windows;
- **the one-time notice:**
  - when `globalState['codev.cockpit.autoArrangeNoticeShown']` is unset on an auto-arrange, it is
    set and an information message is shown with *Don't arrange automatically*;
  - choosing that action writes `codev.cockpit.autoArrange = false` at
    `ConfigurationTarget.Global`;
  - a manual arrange never shows the notice.

**`apps/vscode/package.json`:**

- the command `codev.cockpit.arrange` (*Codev: Arrange Cockpit*);
- a title-bar entry, hidden when `codev.isBuilderWorktree || !codev.hasWorkspace`;
- the setting `codev.cockpit.autoArrange` (boolean, default `true`).

The command stays in the palette everywhere and explains itself where it does nothing.

**Also in this phase:**

- `apps/vscode/src/extension.ts`: wiring;
- tests: `cockpit-arrange.test.ts`, `cockpit-auto-arrange.test.ts`, and
  `contributes-cockpit.test.ts` extended;
- docs: the README *Arrange Cockpit* section, the setting, and that builder placement follows
  #1671; `arch.md`; the CHANGELOG.

#### Deliverables

- [ ] The spike result recorded; arrange; triggers; the setting; the notice; the explanations;
      tests; docs.
- [ ] Rendered verification of increment 3 and the PR's screenshot set.

#### Acceptance Criteria

- [ ] Spec scenarios 7 (trigger and notice), 9 (arrange), 13 (dirty, untitled and modified
      editors survive; re-run changes nothing; the Decisions draft persists) and 14 (`main` not
      live) pass.
- [ ] The notice criterion holds: it appears once per profile, its action turns the setting off
      globally, dismissing changes nothing, and it never appears on a manual arrange.
- [ ] **Rendered:** the split with a pending decision, in light and dark themes, on a fresh profile
      and on an existing profile (activity-bar order noted in the PR if VS Code places the button
      elsewhere).
- [ ] Type-check, lint, all unit suites, the `apps/web` tests and the package tests pass.

#### Test Plan

- **Unit**, with mocked `vscode` commands, `tabGroups` and `globalState`:
  - the trigger once per session, including when visible at creation;
  - the setting off;
  - worktree and no-workspace windows;
  - the notice set and shown once, the action writes Global, dismiss leaves it unchanged, manual
    arrange shows nothing;
  - arrange delegates to `openResolvedArchitect`;
  - panels reused;
  - idempotent.
- **Rendered:** as above.

## Verification harness (Phases 1, 5, 6, 7, 8, 9)

The spec requires that verification never touches the owner's live IDE or Tower. Every step that
creates state is listed below with **how it reaches the isolated Tower**, as checked against the
code. Nothing here relies on a default port.

### Why not `afx spawn` (or any Tower-contacting CLI command)

The CLI has no way to target a non-default Tower for spawning:

- `spawn.ts:110` and `spawn-worktree.ts:738` call `getTowerClient()` with no port;
- the CLI client falls back to `DEFAULT_TOWER_PORT`, a literal `4100` (`packages/sdk/src/constants.ts`);
- there is no env override (`CODEV_TOWER_PORT` is read only by the lifecycle reporter), and
  `afx spawn` has no `--port`.

`getTowerClient(port)` does cache a non-default client, so an in-process driver could pre-seed it.
That still leaks:

- spawn shells out to `porch init` (`spawn-worktree.ts:490`);
- porch's CLI dispatcher then posts `refreshOverview` through `new TowerClient()`, which has no port
  and so goes to `:4100` (`commands/porch/index.ts:1505`, `init` is in `MUTATING_COMMANDS`);
- and the `porch` it runs is whatever is first on `PATH`.

The same default-port `getTowerClient()` / `new TowerClient()` is used by
`workspace-add-architect.ts:51`, `start.ts:31` and `notifications.ts:82`. So **the harness runs no
`afx` / `porch` CLI command that talks to Tower.** It uses only:

- explicit HTTP calls to the isolated port;
- the product's own in-process state writers;
- one file-only CLI command.

This needs no product change.

### Isolated Tower

Started directly, the way the isolation e2e test does (`bugfix-1515-tower-isolation.e2e.test.ts:87`):

```
node packages/codev/dist/agent-farm/servers/tower-server.js -p $PORT
```

It runs with this environment:

- `CODEV_AGENT_FARM_DIR=<scratch>/af`: its own `global.db`, `local-key` (`core/src/auth.ts:6`) and
  registry;
- `SHELLPER_SOCKET_DIR=<scratch>/run`: the default is the owner's `~/.codev/run`
  (`tower-server.ts:599`), so it must be overridden.

It is not started with `afx tower start`, because `start.ts` checks through the default-port client.

### Fixtures, and how each is created

| What | How | Reaches the isolated Tower by |
|---|---|---|
| Workspace activation (starts `main`) | `POST http://127.0.0.1:$PORT/api/workspaces/<enc>/activate` (`tower-routes.ts:955`) with the isolated key | explicit port |
| A second architect | `POST …:$PORT/api/workspaces/<enc>/architects` `{ name }` (`tower-routes.ts:791`), not `afx workspace add-architect` | explicit port |
| A builder's worktree | `git worktree add` in the fixture repo | no Tower contact |
| A builder's porch state (phase, a pending gate for the blocked state) | porch's in-process `createInitialState` / `writeState` (`commands/porch/state.ts:229,159`), not the porch CLI, whose dispatcher posts to `:4100` | no Tower contact |
| A builder's `builders` row, with `spawned_by_architect` | the product's in-process `upsertBuilder` (`agent-farm/state.ts:193`), the call `spawn` itself makes, in a driver process whose `CODEV_AGENT_FARM_DIR` is the isolated dir (`db/index.ts` resolves `global.db` from it at import). No hand-written SQL | isolated `global.db` |
| A builder's live terminal | `POST …:$PORT/api/terminals` `{ type: 'builder', roleId: 'builder-<id>', workspacePath, cwd, command }` with a plain shell command (`tower-routes.ts:1032-1093`, which registers `entry.builders`) | explicit port |
| A decisions file | `node packages/codev/bin/afx.js decisions init`, with `cwd` in the fixture. `decisions.ts` imports only fs, path, config and the template, and the decisions e2e does the same (`decisions-tab.test.ts:390`) | no Tower contact |

Each fixture's `.codev/config.json` sets `shell.architect` and `shell.builder` to a plain shell, so
every session is a shell, never an agent.

This yields N=0, N=1 and N>1 builders under `main` and under a second architect, across two
workspaces, plus a blocked and a waiting builder. The null-attribution fold, which only a legacy row
can produce, is unit-tested.

### Isolated VS Code

`code serve-web` (`/usr/local/bin/code` on this machine) runs on its own port, with
`--server-data-dir`, `--user-data-dir` and `--extensions-dir` all under the scratchpad, and the
branch's vsix installed there.

- **Fallback:** if `serve-web` cannot run, the harness launches the IDE server binary that Tower's
  IDE support uses (`ide-server.ts`). It is launched **directly**, with the same flags
  `ide-server.ts` passes (`--host 127.0.0.1`, `--port`, `--server-base-path`, `--extensions-dir`),
  all pointed at scratch dirs and its own port.
- It never goes through any Tower's `/api/ide`, and never through the owner's `/ide/`.

- **Settings** in that profile:
  - `codev.towerPort = $PORT`;
  - `codev.autoStartTower = false`. Auto-start runs `afx tower start`, which would target `:4100`.
- **Environment** of the serve-web process:
  - `CODEV_TOWER_KEY=<isolated key>`. Without it the extension reads `~/.agent-farm/local-key`
    (`sdk/src/node/local-key.ts:20,34`);
  - `PATH` prefixed with a stub directory holding **recording stubs** for `afx`, `porch` and
    `codev`. The extension shells out to these via `PATH` (`resolveSpawnable` in
    `cli-process.ts`), for `afx spawn` (`commands/spawn.ts:46`), `porch approve`
    (`commands/approve.ts:357`), `afx cleanup` (`commands/cleanup.ts:48`), Tower auto-start, and
    preflight's `codev --version` (`preflight/preflight-core.ts:50`).
  - Each stub appends its argv and cwd to a log and exits 0. `codev --version` prints the branch's
    version, so preflight passes.
- **Everything else the extension does** goes through `ConnectionManager`'s client, which follows
  `codev.towerPort`: overview, fleet, terminals, dev, architects, decisions and activation.

So in the harness, *Spawn Builder*, *Approve Gate* and *Cleanup* are verified as "the extension
invoked the CLI with the right arguments and cwd", from the stub log. The CLI is not changed by this
project.

### Pre-flight (run before anything creates state; any failure stops the run)

1. `$PORT` is set, numeric and **not 4100**, and nothing is listening on it before the start.
2. `CODEV_AGENT_FARM_DIR` and `SHELLPER_SOCKET_DIR` are set, resolve under the session scratchpad,
   and are not `~/.agent-farm` or `~/.codev/run`.
3. **The driver and the Tower agree on the database file.**
   - `getGlobalDbPath()` resolves under `AGENT_FARM_DIR`, but switches to `AF_TEST_DB`, or
     `test.db`, when `NODE_ENV=test` (`db/index.ts:123`).
   - So the harness pins `NODE_ENV` and `AF_TEST_DB` to the same values for the Tower and for the
     driver. It runs neither under vitest.
   - The driver imports `AGENT_FARM_DIR` and `getGlobalDbPath` from the branch's built
     `packages/codev/dist`, and asserts two things:
     - `AGENT_FARM_DIR` equals the isolated dir;
     - `getGlobalDbPath()` equals the file the isolated Tower opened. The Tower logs its dir when
       it claims ownership (`tower-server.ts:578`), and the harness checks `lsof -p <tower pid>`
       for the `.db` path.

   This proves the in-process `upsertBuilder` writes land where the isolated Tower reads.
4. After the start, the listener on `$PORT` (`lsof`) is the PID the harness spawned, and
   `GET http://127.0.0.1:$PORT/api/version` answers with the isolated key.
5. The serve-web profile's `settings.json` holds `codev.towerPort = $PORT` and
   `codev.autoStartTower = false`, and in the serve-web environment `afx`, `porch` and `codev`
   resolve to the stubs.
6. Before any screenshot, the isolated Tower's `/api/overview` for each fixture returns the
   expected builders, **with their expected `spawnedByArchitect` values**, and the expected
   architects. If not, verification stops and the architect is told. There is no fallback to faked
   data.

### During and after

- **Tripwire.** Throughout the run, the harness samples established TCP connections to `:4100`
  (`lsof -nP -iTCP:4100 -sTCP:ESTABLISHED`). It fails the run if any belongs to its own process
  tree: the driver, the isolated Tower and its shellpers, serve-web and its extension host.
  - The owner's `:4100` is never probed or requested.
  - The watched port is a parameter, so the Phase 1 self-test proves the tripwire fires by aiming it
    at a throwaway listener, not at `:4100`.
- **"Tower unreachable" scenario.** It stops the *harness's* Tower by the PID the harness started.
  Auto-start is off and stubbed, so nothing restarts a Tower.
- **Teardown.** It kills only:
  - the isolated Tower PID;
  - the shellper PIDs that the isolated Tower lists at `GET :$PORT/api/terminals`, whose sockets
    are in the isolated socket dir;
  - the serve-web PID.

  Nothing is killed by name pattern. The scratch dirs are removed afterwards.
- **Driver.** Python/Node Playwright drives headless Chromium. Screenshots go to the scratchpad and
  are attached to the PR.
  - **Never `playwright install` on this machine.** It hangs at extraction and wedges the shared
    browser cache.
  - Use the Chromium already in the Playwright cache. If none is usable, install it by hand with
    `curl -L` + `unzip` + the `INSTALLATION_COMPLETE` marker, and ask first.

The harness is one extra Tower process and one VS Code web server, with no agents. The architect is
told before its first start.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| The row-builder extraction (Phase 3) changes an Agents id or behaviour | Medium | High | An id-equivalence snapshot taken from the pre-refactor provider in the same commit, plus every existing Agents test unmodified |
| Generalised wiring regresses accordion, reveal or cycle in Agents | Medium | High | Per-view hosts with the Agents path unchanged; existing behaviour tests plus new per-view tests; rendered check of both views |
| The layout primitive closes or discards an editor | Low | High | The Phase 1 spike, run before any increment code. If it fails, the spec's add/reuse-only rule applies. The dirty/untitled/modified scenario is rendered |
| A terminal or retained-webview move fails in the spike (cases b–d) | Low | Medium | The spec gives no fallback, so the result goes to the architect from Phase 1 with the options. Phase 9 waits for the owner, and Phases 2–8 continue |
| Moving components changes the dashboard | Medium | Medium | Wrappers keep `lib/api.ts`; the moved tests are unchanged in intent; the dashboard integration tests stay; a rendered before/after comparison |
| A source-exported TSX package does not type-check under one host's config | Medium | Medium | `codev-artifact-canvas` is a *built* package (`tsdown` → `dist`), so the closer precedent is `apps/web`'s own source exports. The risk sits in `apps/web`'s `tsc -b`, which type-checks the package's `.tsx` under the dashboard's config, and in the extension's webview tsconfig (`jsx: react-jsx` added). Phase 6 runs both type-checks before moving anything. If a host still cannot consume the source, the package gains a `tsdown` build like canvas. That is a build-wiring change, not scope, and it is named in the PR |
| The harness accidentally touches the owner's Tower or IDE | Medium (several CLI paths default to `:4100`) | High | No Tower-contacting CLI commands. Every state-creating step names its route to the isolated port (harness table). Extension shell-outs are recording stubs, and auto-start is off. `CODEV_TOWER_KEY` is set, as are isolated state, socket and VS Code dirs. A pre-flight refuses 4100 and checks the listener PID, and a `:4100` connection tripwire runs throughout. The architect is told before the first start |
| CSS moved out of `index.css` misses a rule, so the dashboard looks different | Medium | Low | A selector inventory before the move, and the rendered dashboard comparison |
| `prepublish-workspace-deps.test.ts` or the vsix packaging misses the new workspace dependency | Medium | Medium | Run it at Phase 7, and build the vsix in the harness from Phase 1 onward |
| Fixture builders do not appear, or appear without attribution | High if missed | Medium | Each fixture builder gets a real worktree, porch state, a `builders` row through the product's `upsertBuilder`, and a registered builder terminal. `/api/overview` is asserted, attribution included, before any screenshot |
| Path containment behaves differently on Windows (case, separators, UNC, junctions) | Medium | High | `realpath` + `path.relative` (no prefix compare), `path.win32` table tests, and the on-demand Windows workflow linked in the PR |

## Documentation Updates

- `apps/vscode/README.md`: the Cockpit button and hierarchy (Phase 5), the Work and Decisions panels
  (Phase 8), *Arrange Cockpit* and `codev.cockpit.autoArrange` (Phase 9).
- `codev/resources/arch.md`, *VS Code Extension*:
  - the Cockpit container and act/navigate rule;
  - `ArchitectTreeBuilder` and fleet-overview retention (Phase 5);
  - the shared `@cluesmith/codev-workspace-views` package and host adapter (Phase 8);
  - the arrange flow (Phase 9).

  Hot-tier files are not touched unless the review step routes a fact there.
- `apps/vscode/CHANGELOG.md`: one entry per increment.
- The review (`codev/reviews/1963-…`) at the end records the spike result and the
  lessons-learned candidates.
