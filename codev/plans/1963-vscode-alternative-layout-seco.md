# Plan: VS Code alternative layout ("Codev Cockpit")

**Specification**: [codev/specs/1963-vscode-alternative-layout-seco.md](../specs/1963-vscode-alternative-layout-seco.md)

## Executive Summary

This plan implements the approved spec in its three shippable increments, in eight phases. Each
phase is one commit on `builder/spir-1963`, and all of them go into one PR.

1. **Button + hierarchy** (Phases 1–4). This uses spec approach **A1**: one tree view over the
   existing row-building code. Its single hierarchy is the owner's *"towers -> workspaces ->
   architects / decisions -> builders"*. Rows of this window's workspace act; rows of other
   workspaces navigate.
   - Other workspaces' rows come from the overviews `TowerFleetCache` already fetches. They are kept
     instead of discarded, so the hierarchy needs no new requests and no Tower change.
   - The architect-axis row building moves out of `BuildersProvider` into a reusable builder,
     scoped by workspace. The Agents view and the Cockpit both use it, so there is no second copy
     of row logic.
2. **Shared Work and Decisions** (Phases 5–7). This uses approach **B1**: a new workspace package,
   `@cluesmith/codev-workspace-views` (`packages/workspace-views`).
   - The dashboard's `WorkView`, `DecisionsView`, `useDecisions` and their sub-components move
     there. They take their I/O from a host adapter and their colours from `--codev-wv-*` tokens.
   - The dashboard keeps thin wrappers with its fetch adapter.
   - The extension hosts two editor-area webview panels whose host side relays to Tower through
     `ConnectionManager`'s client.
3. ***Arrange Cockpit*** (Phase 8). This uses approaches **C1** (first show per window, plus the
   command and `codev.cockpit.autoArrange`) and **D1** (Work stacked over Decisions). It also adds
   the one-time first-auto-arrange notice ruled at the gate. Before any arrange code is written, the
   phase starts with the spike the spec's Assumptions require.

Rendered verification sits at the end of each increment: Phase 4, Phase 7 and Phase 8. It runs
against an isolated harness (described below), so the work can be cut after any increment with what
has shipped already verified.

## Phases (Machine Readable)

```json
{
  "phases": [
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

### Phase 1: Fleet cache keeps every active workspace's overview

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

### Phase 2: Reusable, workspace-scoped architect-axis row builder

**Dependencies**: None (Phase 1 is not needed; ordered here so the hierarchy phase has both)

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
      *N queued* to builder-row descriptions. The counts come from the same `deriveAttention`
      summary the Tower view uses. Builder rows show neither today, so the Agents view keeps its
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

### Phase 3: Cockpit button and the Tower → workspaces → architects → builders tree

**Dependencies**: Phase 1, Phase 2

#### Objective

Ship the new activity-bar button and its single hierarchy, with this window's builder rows
behaving as they do in Agents: click, accordion, reveal, cycle selection and activity hook. This is
the first user-visible slice. Context-menu actions arrive in Phase 4.

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
      added in Phase 4.
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
    - builder rows get their glyph, gate and held/queued (Phase 2);
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

### Phase 4: Placement-table actions on the hierarchy, parity mapping, increment-1 verification

**Dependencies**: Phase 3

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
  The Cockpit resolves it in its async `getChildren` for the Tower root, as `WorkspaceProvider`
  does in its `getChildren`, and does not cache it across renders.
- **Re-render signals.** The Cockpit re-renders on the same signals `WorkspaceProvider` subscribes
  to:
  - `terminalManager.onDidChangeDevTerminals`, so *Start Dev* / *Stop Dev* stays honest across
    every start, stop and cleanup path;
  - the `codev-config-updated` SSE envelope, for `devUrls` and dev-command edits;
  - the `architects-updated` SSE envelope, for add and remove from the CLI.

  These are in addition to the three Phase 3 signals. They need no new connection: the envelopes
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

- [ ] All placement-table entries for increment 1 (the Decisions entry is Phase 6).
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
- [ ] From the Cockpit, in the harness, these work on this window's workspace:
  - every builder context action;
  - Approve Gate inline;
  - every workspace-row action;
  - Remove Architect.
- [ ] Another workspace's architect or builder row opens that workspace's window.
- [ ] **Request count** (spec scenario 21). The isolated Tower's request log is compared for two
      cases:
      - the Cockpit alone visible;
      - the Workspace, Agents and Tower views alone visible.

      They match: the overview, the fleet fan-out, and one `getWorktreeConfig` per workspace-row
      render, the same call the Workspace view makes per render. With both sets visible at once, the
      only addition is that second view's own `getWorktreeConfig`. No poll, SSE stream or route is
      added.
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

### Phase 5: Shared Work/Decisions package; dashboard moved onto it unchanged

**Dependencies**: None (independent of Phases 1–4; ordered for the increment boundary)

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
  - `components/WorkView.tsx`, keeping its core sections. The dashboard-only pieces become optional
    slots: `FileTree`, `OpenFilesShellsSection` and `TipBanner`;
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

### Phase 6: Decisions panel in VS Code, its host bridge, and the hierarchy's Decisions entry

**Dependencies**: Phase 3 (for the Decisions entry), Phase 5

#### Objective

Let the owner rule on decisions without leaving VS Code. The panel is the shared `DecisionsView`
in an editor-area webview, with every Tower call made by the host. This phase also builds the
webview infrastructure that Phase 7 reuses.

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
  - `script-src 'nonce-…'`;
  - `style-src ${cspSource} 'unsafe-inline'`, the same as the existing webviews
    (`contextual-panel/panel-template.ts`, `markdown-preview/preview-template.ts`).
    - The shared components set React `style` attributes. For example, `BuilderCard`'s progress
      bar uses `style={{ width: … }}`. A `style-src` without `'unsafe-inline'` would silently drop
      those.
    - Scripts stay nonce-only. Inline *styles* do not run code;
  - `img-src ${cspSource} blob: http: https:`;
  - no `connect-src`;
  - `localResourceRoots` set to `dist`.
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
  - A bundle smoke test loads the built `dist/webview/decisions.js` in jsdom and asserts it mounts.
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
      Phase 7's verification focuses on Work.
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

### Phase 7: Work panel in VS Code, increment-2 verification

**Dependencies**: Phase 6 (shared webview infrastructure)

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

### Phase 8: Arrange Cockpit: split, triggers, autoArrange, first-arrange notice, increment-3 verification

**Dependencies**: Phase 3, Phase 6, Phase 7

#### Objective

The one-click layout: `main` architect | (Work over Decisions). It arranges automatically on the
first show per window session, and on demand. It never closes or discards a user's editor.

#### Files to Create / Modify

**Spike first, in the harness, recorded in the thread and the review.** It confirms:

- (a) `vscode.setEditorLayout` with
  `{ orientation: 0, groups: [{}, { groups: [{}, {}] }] }` merges editors from groups it removes
  into remaining groups. Dirty, untitled and modified editors survive, with their content;
- (b) an editor-area terminal tab moves between groups without ending its session, using
  `terminal.show()` then `workbench.action.moveEditorToFirstGroup`;
- (c) a panel terminal moves into the editor area through `workbench.action.terminal.moveToEditor`;
- (d) `WebviewPanel.reveal(viewColumn)` moves a retained panel without reloading it.

If (a) does not hold, arrange only **adds or reuses** groups and never removes one, as the spec
already allows. If (b) or (c) does not hold, the plan stops and the architect is told before
another approach is chosen.

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

## Verification harness (Phases 4, 5, 6, 7, 8)

The spec requires that verification never touches the owner's live IDE or Tower. Each rendered
checkpoint runs, and then stops, this harness:

- **Isolated Tower:** the branch's built CLI starts a Tower on a non-default port (for example
  `4199`) with `CODEV_AGENT_FARM_DIR` pointing at a fresh directory under the session scratchpad.
  It has its own `global.db`, key and registry.
- **Isolated VS Code:** `code serve-web` on its own port, with its own `--server-data-dir`,
  `--user-data-dir` and `--extensions-dir` under the scratchpad. The branch's vsix is installed
  there, and the setting `codev.towerPort` is set to the isolated Tower's port.
- **Fixture workspaces:** two or more small git repos under the scratchpad, registered only with
  the isolated Tower.
  - Each fixture's `.codev/config.json` sets `shell.architect` and `shell.builder` to a plain
    shell. So activating a workspace, or adding an architect, starts a shell session, never an AI
    agent.
  - **What makes a builder appear.** `/api/overview` lists a `.builders/` worktree only when:
    - Tower's terminal registry holds a live builder session for its role id
      (`activeBuilderRoleIds`). Directories alone render zero builders;
    - its `spawnedByArchitect` is read from the isolated `global.db` `builders` row
      (`spawned_by_architect`). `discoverBuilders` itself always emits `null`, so a builder with no
      row folds into `main`.
  - **So fixture builders are spawned for real by the branch's CLI** (`afx spawn --task "…"`, which
    needs no GitHub issue):
    - it runs with `cwd` in a fixture repo, against the isolated Tower;
    - it sets `CODEV_ARCHITECT_NAME=<architect>` per spawn, the variable Tower injects into
      architect terminals and `spawn.ts` records as `spawned_by_architect`;
    - with the fixture's `shell.builder` set to a plain shell, this creates the worktree, the
      `builders` row with its attribution, and a live builder terminal, and never starts an agent;
    - this gives N=0, N=1 and N>1 builders under `main` and under a second architect, across two
      workspaces;
    - blocked-gate and waiting states come from the fixture builders' porch state, which is
      synthetic test data in scratch repos, never a real project's;
    - the null-attribution fold, which no spawn can produce, is covered by unit tests rather than
      screenshots.
  - **Validated before any screenshot.** The first checkpoint asserts that the isolated Tower's
    `/api/overview` for each fixture returns the expected builders, **with their expected
    `spawnedByArchitect` values**, and the expected architects.
    - If spawning does not produce them, verification stops and the architect is told.
    - It does not fall back to faked data, nor to hand-written database rows.
  - **Driving the harness.** It goes through Tower's HTTP API (activation, terminals,
    add-architect), using the isolated key. Where the CLI is needed (a second architect, or creating
    the decisions file as `afx decisions init` does), the branch's built CLI runs with `cwd` in a
    fixture repo and the isolated port and `CODEV_AGENT_FARM_DIR`. It never runs from this
    worktree or against :4100.
- **Driver:** Python/Node Playwright, headless Chromium, with screenshots saved to the scratchpad
  and attached to the PR.
  - **Never `playwright install` on this machine.** It hangs at extraction and wedges the shared
    browser cache.
  - Use the Chromium already in the Playwright cache. If none is usable, install it by hand with
    `curl -L` + `unzip` + the `INSTALLATION_COMPLETE` marker, and ask first.

The harness is one extra Tower process and one VS Code web server, with no builders. The architect
is told before its first start. Anything that would touch port 4100, `~/.agent-farm` or the owner's
`/ide/` is out of bounds.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| The row-builder extraction (Phase 2) changes an Agents id or behaviour | Medium | High | An id-equivalence snapshot taken from the pre-refactor provider in the same commit, plus every existing Agents test unmodified |
| Generalised wiring regresses accordion, reveal or cycle in Agents | Medium | High | Per-view hosts with the Agents path unchanged; existing behaviour tests plus new per-view tests; rendered check of both views |
| The layout primitive closes or discards an editor | Low | High | The Phase 8 spike before any arrange code, with the add/reuse-only rule from the spec if it fails; the dirty/untitled/modified scenario rendered |
| Moving components changes the dashboard | Medium | Medium | Wrappers keep `lib/api.ts`; the moved tests are unchanged in intent; the dashboard integration tests stay; a rendered before/after comparison |
| A source-exported TSX package does not type-check under one host's config | Low | Medium | `jsx: react-jsx` added to the webview tsconfig; if a host still cannot consume it, the package gains a `tsdown` build like `codev-artifact-canvas`. That is a build-wiring change, not scope, and it is named in the PR |
| The harness accidentally touches the owner's Tower or IDE | Low | High | Non-default port, isolated `CODEV_AGENT_FARM_DIR` and VS Code data dirs, no `afx` against :4100; the architect is told before the first start |
| CSS moved out of `index.css` misses a rule, so the dashboard looks different | Medium | Low | A selector inventory before the move, and the rendered dashboard comparison |
| `prepublish-workspace-deps.test.ts` or the vsix packaging misses the new workspace dependency | Medium | Medium | Run it at Phase 6, and build the vsix in the harness from Phase 4 onward |
| Fixture builders do not appear because Tower lists only builders with a live terminal | High if missed | Medium | Each fixture builder gets a real worktree plus a registered builder terminal, and `/api/overview` is asserted before any screenshot (harness section) |
| Path containment behaves differently on Windows (case, separators, UNC, junctions) | Medium | High | `realpath` + `path.relative` (no prefix compare), `path.win32` table tests, and the on-demand Windows workflow linked in the PR |

## Documentation Updates

- `apps/vscode/README.md`: the Cockpit button and hierarchy (Phase 4), the Work and Decisions panels
  (Phase 7), *Arrange Cockpit* and `codev.cockpit.autoArrange` (Phase 8).
- `codev/resources/arch.md`, *VS Code Extension*:
  - the Cockpit container and act/navigate rule;
  - `ArchitectTreeBuilder` and fleet-overview retention (Phase 4);
  - the shared `@cluesmith/codev-workspace-views` package and host adapter (Phase 7);
  - the arrange flow (Phase 8).

  Hot-tier files are not touched unless the review step routes a fact there.
- `apps/vscode/CHANGELOG.md`: one entry per increment.
- The review (`codev/reviews/1963-…`) at the end records the spike result and the
  lessons-learned candidates.
