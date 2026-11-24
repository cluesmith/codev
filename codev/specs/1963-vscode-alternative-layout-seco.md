# Specification: VS Code alternative layout ("Codev Cockpit")

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
-->

## Problem Statement

The Codev extension (`apps/vscode`) spreads the surfaces an architect watches across three places
and two layouts:

- **This workspace's controls and agents** sit in the Codev activity-bar container as two separate
  views, Workspace (`codev.workspace`) and Agents (`codev.agents`), stacked with Backlog, Pull
  Requests, Recently Closed, Team and Status.
- **The machine-wide fleet** sits in a third view, Tower (`codev.tower`), in its own
  secondary-sidebar container (`codev-tower`), on the other side of the window, hidden until revealed.
- **Work and Decisions**, the dashboard's two summary surfaces, are not in the extension at all.
  Work is the one-screen list of builders, what needs attention, backlog and recently closed.
  Decisions is where the owner rules on the architect's pending decisions (Spec 1819). To rule on a
  decision from VS Code today the owner has to leave the editor for the browser dashboard.

The owner wants a second, alternative layout for the same extension. It opens from a new button
under the Codev button. It shows one combined left-hand panel, a single hierarchy of Tower →
workspaces → architects and Decisions → the builders each architect spawned, that brings together
what the Workspace, Agents and Tower views show today. It also shows an editor-area split, with the
`main` architect's terminal on the left and Work and Decisions on the right. The existing Codev container and its views stay as they are. This is an **addition**, not
a replacement.

Affected: the owner (and any Codev user who runs an architect from VS Code or the Codev IDE), in
both distribution channels. Those are the marketplace vsix and the same extension built into the
Codev IDE, including the IDE served by Tower at `/ide/`.

Pain points today:

1. Ruling on a decision means switching to the browser dashboard and back.
2. Seeing "what needs me in this workspace" (Agents) and "what needs me anywhere" (Tower) at once
   means having both side bars open.
3. There is no one-click way to get the architect-centred working layout. The user has to arrange
   editor groups and open each surface by hand.

## Current State

**Activity bar / containers** (`apps/vscode/package.json` → `contributes.viewsContainers`):

| Container | Location | Views |
|---|---|---|
| `codev` "Codev" (`icons/codev.svg`) | activity bar | `codev.workspace` (when `codev.hasWorkspace`), `codev.agents` (when `!codev.isBuilderWorktree`), `codev.backlog`, `codev.pullRequests`, `codev.recentlyClosed`, `codev.team`, `codev.status` |
| `codev-tower` "Codev Tower" | secondary side bar | `codev.tower` |
| `codevPanel` "Codev" | bottom panel | `codev.contextualPanel` (webview) |

**The three views to combine:**

- **Workspace** (`views/workspace.ts`, `WorkspaceProvider`): an expandable *Architects* root (one
  child per architect, `main` first; click opens that architect's terminal; a sibling has a *Remove
  Architect* context entry; the root has an inline *Add Architect*), *Open Web Interface*, *Spawn
  Builder*, *New Shell*, a single *Start Dev* / *Stop Dev* row, and one row per `worktree.devUrls`
  entry. In a builder-worktree window (#1809) the architect, spawn and shell rows are omitted.
- **Agents** (`views/builders.ts`, `BuildersProvider` over `OverviewCache`): builders grouped on a
  switchable axis (stage / area / architect, `codev.buildersGroupBy`). Each builder row expands to
  its changed files (`BuilderDiffCache`), flat or as a folder tree. Rows carry a state glyph, inline
  *Approve Gate* on blocked builders, and a context menu: open terminal, approve, view
  spec/plan/review, view diff, open worktree window/folder, run setup, run/stop dev. Behaviour is
  wired to the `codev.agents` **TreeView instance** in `extension.ts`:
  - the click handler `codev.openBuilderRow` reveals and expands the row (`codev.buildersClickExpands`);
  - the accordion collapses peers on expand (`codev.buildersAutoCollapse`);
  - active-file sync reveals the open diff file's row (#1066);
  - agent-terminal cycling selects the row (#1563);
  - selection fires the `builder-active` activity hook;
  - the title shows a live count ("Agents (3)");
  - the view's badge is the Codev activity-bar badge (blocked + idle + held + waiting architects,
    suppressed in a worktree window).

  The title bar holds refresh, group-by cycle, accordion toggle and file-tree toggle.
- **Tower** (`views/tower.ts`, `TowerProvider` over `TowerFleetCache`): every workspace Tower knows.
  Active workspaces are ordered by urgency, each expandable to its attention rows (pending gates,
  waits, architects at a prompt, held mail, queued feedback), and dormant ones sit in a collapsed
  group. Rows have inline *Open* / *Deactivate* actions. The title bar has refresh, and the view's
  badge carries the machine-wide needs-attention count.

Menus target the source views by id (`view == codev.agents && viewItem =~ …`), so a row rendered in
any other view today would lose its inline and context actions.

**What the extension knows about other workspaces.**

- `TowerFleetCache` already calls `client.getOverview(path)` for **every active workspace** on each
  fleet refresh (SSE-triggered with a 300 ms debounce, plus a 20 s fallback poll).
  - Each overview carries that workspace's live `architects` and its `builders`, each with
    `spawnedByArchitect`, state, gate and worktree path.
  - The cache keeps only the derived `AttentionSummary` and discards the overview.
  - Dormant workspaces are not fetched.
- No overview carries anything about the decisions file. Its presence is only in `/api/state`'s
  `decisionsEnabled`, and its open count is only in `/api/decisions` itself.
- The extension's *actions* are single-workspace:
  - `TerminalManager` builds terminal URLs from the window's workspace path and keys its cache by
    unqualified names (`architect:main`, `builder-<id>`);
  - `codev.openArchitectTerminal` and every builder-row command (approve, diff, artifacts, worktree,
    dev) resolve the target against `connectionManager.getWorkspacePath()`;
  - `BuilderDiffCache` is keyed by builder id alone.

**Editor-area placement** (`terminal-manager.ts`): with `codev.terminalPosition: "editor"` (the
default) the architect terminal opens in editor group 1. Builder and shell terminals open in group 2
if it exists, else group 1. With `"panel"` they open in the bottom panel. `open-architect.ts` holds
the #1497 invariant: a terminal is opened, and cached, only under its occupant's own name, and a
non-live `main` gets the warning *"Codev: No 'main' architect found — is the workspace activated?"*.
Another architect is never substituted.

**Dashboard Work and Decisions** (`apps/web`):

- `WorkView.tsx` composes `BuilderCard` (builders table with an *Open* button that selects the
  builder's dashboard tab), `NeedsAttentionList`, `BacklogList`, `RecentlyClosedList`, `TipBanner`,
  `OpenFilesShellsSection` (dashboard shell and annotation-viewer tabs) and a collapsible `FileTree`
  file browser. It has a *+ Shell* button (creates a dashboard shell tab) and *Refresh*. Data comes
  from `useOverview` (polls `/api/overview` every 2.5 s, plus SSE) and the dashboard's
  `DashboardState`.
- `DecisionsView.tsx` + `hooks/useDecisions.ts` (Spec 1819, #1938): polls `GET …/api/decisions`
  every 2 s while the tab is active and the page is visible. It renders open items with
  options/comment/Submit, Q&A threads, the current ruling, held drafts and the Ruled section, and
  posts rulings to `POST …/api/decisions/rule`. Item images that are workspace paths are fetched
  with the key from `GET …/api/decisions/image` and shown as object URLs. http(s) links and images
  open in a new tab via `window.open`.
- Both import their transport (`lib/api.ts`) directly. It uses relative URLs, the injected Tower
  key and `window`/`localStorage`. So as written they can only run inside the dashboard page.
  `DecisionsView` already uses `renderMarkdown` from `@cluesmith/codev-artifact-canvas`, which the
  extension also depends on.

**Extension webview precedent:** `esbuild.js` already bundles two React webviews: the
markdown-preview canvas (#859) and the contextual panel (#1049). Each uses a nonce CSP, a typed
host↔webview message contract with `is*Message` guards on inbound messages (`contextual-panel/
messages.ts`), and `retainContextWhenHidden`. `@cluesmith/codev-artifact-canvas` is the precedent
for a host-agnostic React package that both apps bundle, with the host supplying I/O through adapter
interfaces and themes through `--codev-canvas-*` tokens.

**Tower client:** the extension host reaches Tower only through `ConnectionManager`'s shared
`TowerClient` (`@cluesmith/codev-sdk`), which carries the key and the workspace-scoped route prefix.
The SDK has no decisions methods today. Its generic `request()` drops the response body on a non-2xx
status, so it would lose the decisions routes' structured refusal (`{ ok: false, code, message }`).

## Desired State

### 1. A second activity-bar button

A new activity-bar container, working name **"Codev Cockpit"**, registered directly after the
`codev` container so it sits under the Codev button. Its icon is a new SVG that wraps the same path
as `icons/codev.svg` in `transform="rotate(90 400 400)"` (clockwise). The shape is not redrawn. The
existing `codev`, `codev-tower` and `codevPanel` containers and every view in them are unchanged.

### 2. One combined left-hand panel: a single hierarchy

The container holds **one tree view** with **one hierarchy**. In the owner's words, at the spec
gate: *"towers -> workspaces -> architects / decisions -> builders"*. This supersedes the issue
body's reading of step 2 as three side-by-side sections (issue #1963, owner revision comment).

```
Tower                                        ← root: this machine's Tower
├─ codev            current · 1 gate         ← workspace (Tower view's set, labels, order)
│  ├─ MAIN (3)      waiting for input        ← architect (its own Spec 1595 state)
│  │  ├─ ⚠ spir-1963 [PLAN] …               ← builder spawned by MAIN
│  │  │  └─ src/views/cockpit.ts             ← changed files (this window's workspace only)
│  │  └─ ● bugfix-1970 …   2 held
│  ├─ WEB (0)                                ← architect with no builders (leaf)
│  └─ Decisions                              ← that workspace's Decisions screen
├─ marketmaker      2 waiting
│  ├─ MAIN (1)
│  │  └─ ◐ air-88 …
│  └─ Decisions
└─ Dormant (4)
   └─ old-project
```

**Levels:**

1. **Tower.** One root row for the machine's Tower, expanded by default. While there is nothing to
   list it holds Tower's existing state rows (*Connecting to Tower…*, *No workspaces registered*).
2. **Workspaces.** Exactly the Tower view's workspaces, with the same labels (so twelve workspaces'
   `MAIN`s are told apart by their parent row), urgency order, *current* marker, icons, attention
   summary in the description, inline *Open* / *Deactivate*, and the collapsed *Dormant (N)* group.
   This reuses `orderFleet` and `TowerProvider`'s row building. The window's own workspace and every
   workspace that needs attention start expanded; quiet ones start collapsed. A dormant workspace
   has no children, because it has no live session, as today.
3. **Architects + Decisions.** Under an active workspace:
   - its live architects, `main` first, then siblings alphabetically. Two or more idle siblings roll
     up into *Idle Architects*. This is the Agents view's architect-axis rendering
     (`architectGrouping`, `partitionArchitectGroups`);
   - then a **Decisions** entry for that workspace's decisions file.
4. **Builders.** Under each architect, the builders that architect spawned (`spawnedByArchitect`),
   in the Agents view's order (blocked, then waiting, then active) and with the architect axis's
   `[stage]` prefix.
   - A builder with **no recorded spawning architect** sits under `main` (architectGrouping's
     existing fold).
   - A builder whose recorded architect is **not live** gets that architect's row anyway, as the
     architect axis does today. Clicking that row gives the existing "No '<name>' architect found"
     warning.
   - An **architect with no builders** is a leaf row with no chevron.
5. **Changed files.** Under a builder of the window's own workspace, its changed files, flat or as a
   folder tree, exactly as in the Agents view.

**Data.** There are no Tower route changes, no new requests and no new poll loop:

- **The window's own workspace** reads `OverviewCache`, as the Agents view does. While visible, the
  combined view counts toward the periodic overview refresh (`codev.overviewRefreshSeconds`) the
  way the Codev-container views do. So with the Codev container hidden and only the Cockpit
  visible, this workspace's rows stay current.
- **Every other active workspace** reads the overview `TowerFleetCache` *already fetches* for it on
  each fleet refresh (`client.getOverview(path)` in its fan-out). Today the cache derives attention
  from each overview and discards it. It will keep it, last-known-good like the attention it keeps.
  These rows refresh when the Tower view's do: on SSE events (debounced) and on the existing 20 s
  fallback poll.
- **Decisions:** the overview carries nothing about the decisions file, neither presence nor an
  open count, so the Decisions entry carries **no pending count**. It is shown under every active
  workspace. Opening it for a workspace with no decisions file shows the Decisions empty state
  (section 3). A count, or hiding the entry when there is no file, would need an additive overview
  field; see Open Questions.

**Where rows act: this window's workspace vs the rest.** Every `TerminalManager` key
(`architect:<name>`, `builder-<id>`), the #1497 architect resolution, and every builder command
(approve, view diff, spec/plan/review, worktree window/folder, setup, dev) resolve against **this
window's** workspace today. So:

- **Rows of the window's own workspace act here, fully.** Every action listed below works, with the
  same commands and the same effects as in the source views. The Decisions entry opens, or reveals,
  that workspace's Decisions panel (single instance; section 3) without arranging the split.
- **Rows of any other workspace show state and navigate.** Its architects, builders and Decisions
  entry display what the overview says (glyphs, labels, descriptions). Clicking one opens that
  workspace's window, using the Tower view's existing *Open Workspace* action, where the same rows
  are fully actionable. These rows carry no other actions and do not expand to changed files.
  Acting on another workspace from this window is a separate, larger change; see Open Questions.

**Placement of everything the three source views do.** Nothing is dropped:

| Today | In the hierarchy |
|---|---|
| Workspace: *Spawn Builder*, *New Shell* | Inline and context-menu actions on this window's workspace row |
| Workspace: *Add Architect* (inline on the *Architects* root) | Inline and context-menu action on this window's workspace row |
| Workspace: *Remove Architect* (sibling context menu) | Context menu on a sibling architect row of this window's workspace |
| Workspace: architect rows (click opens the terminal) | The architect level. Click runs `codev.openArchitectTerminal(name)`, under the #1497 invariant |
| Workspace: *Open Web Interface* | Context menu on this window's workspace row |
| Workspace: *Start Dev* / *Stop Dev* | Context menu on this window's workspace row, offering whichever one the Workspace view would show (same single-slot rules) |
| Workspace: one row per `worktree.devUrls` entry | *Open Dev URL…* on this window's workspace row's context menu. It opens the only URL, or picks among several (the existing palette path of `codev.openDevUrl`). This is the one Workspace affordance that goes from one click to a menu entry |
| Agents: builder rows: click (open terminal + expand), inline *Approve Gate*, context menu (open terminal, approve, view spec/plan/review, view diff, open worktree window/folder, run setup, run/stop dev) | Builder rows of this window's workspace: identical |
| Agents: changed-files expansion (flat/tree), file click → diff | Identical, for this window's workspace |
| Agents: architect-axis headers (click opens architect), *Idle Architects* container | They are the architect level |
| Agents: stage / area grouping axes, group-by cycle | **Not in the combined panel.** The hierarchy fixes the architect axis. Stage and area grouping stay in the Agents view, and the architect axis's `[stage]` row prefix stays |
| Agents: refresh, accordion toggle, file-tree toggle (title bar) | The combined view's title bar |
| Agents: live count in the title | Each architect row's builder count. The workspace row's attention summary |
| Agents: activity badge | The combined view's badge (same count and suppression, as ruled at the gate) |
| Tower: workspace rows, *current* marker, urgency order, inline *Open* / *Deactivate*, *Dormant* group | The workspace level: identical |
| Tower: refresh (title bar) | The combined view's *Refresh*, which refreshes both caches |
| Tower attention row: pending gate | The blocked builder row (gate glyph + wait time) under its architect |
| Tower attention row: waits (needs input / idle / dead) | The builder row's state glyph and label |
| Tower attention row: architect at a prompt / agent dead (Spec 1595) | The architect row's description and glyph (the same wait text the attention row uses) |
| Tower attention row: held mail for a builder | The builder row's description (*N held*) |
| Tower attention row: held mail not attributed to a builder | The workspace row's description (*N held*, *escalated*) |
| Tower attention row: queued feedback | The builder row's description (*N queued*) |
| Tower: machine-wide badge | Stays on the Codev Tower container |

The same state rendering applies to other workspaces' rows (from their overviews), so a gate or
wait anywhere on the machine is visible on the row it concerns.

**Other requirements:**

- **Provider instances.** The combined panel has its own provider instances over the shared caches.
  Its rows are built by the same code as the source views' rows, with the same labels,
  `contextValue`s and `command`s, but they are distinct objects. Per-view state (accordion
  versioning, the parent map used by `reveal`, expansion) stays per view, and a row belongs to
  exactly one view. Tree-item ids are qualified by workspace, so two workspaces' `main` or a
  builder id that appears in two workspaces never collide.
- **Tree behaviours follow the view a row is in.** Click-expands, the accordion, active-file reveal
  (when the combined panel is the visible one), agent-cycle selection and the `builder-active` hook
  act on the combined panel's rows for this window's workspace.
- **Menu contributions are added, not edited.** The existing `view/item/context` and `view/title`
  entries for `codev.workspace`, `codev.agents` and `codev.tower` stay byte-for-byte. The combined
  view gets its own entries, scoped to it, at the placements in the table above. A generated parity
  test checks every source-view entry against its counterpart, so the two cannot drift.
- **Badge.** The combined view badges the new activity-bar button with the same workspace "needs me"
  count as the Codev button (`composeActivityBadge`), under the same suppression rules.
- **Degraded windows:**
  - In a **builder-worktree window**, the parent workspace's row is marked current but behaves like
    another workspace's row: its architects, builders and Decisions entry navigate to the parent's
    window and act on nothing here (#1809, and the gate ruling that Decisions is not offered there).
    The worktree-scoped actions the Workspace view shows in such a window (*Open Web Interface*,
    *Start* / *Stop Dev*, dev URLs) sit on that row's context menu.
  - In a **window with no Codev workspace**, every workspace's rows navigate; none acts here.
- **Footprint.** The combined view has no `when`, so the new button appears in every window where
  the extension activates (`onStartupFinished`), including non-Codev windows, as the owner ruled at
  the gate. This matches today's Codev and Codev Tower containers, which also appear there.

### 3. Work and Decisions in the extension, in a split with the `main` architect

- **Ported views.** The dashboard's Work and Decisions views render in VS Code editor-area webview
  panels, from the **same React components** the dashboard uses. The components move to a shared
  location that both `apps/web` and `apps/vscode` import. Neither app keeps its own copy.
- **Transport through the host.** The webviews never contact Tower. The extension host serves their
  data and performs their actions over webview messaging, using `ConnectionManager`'s client:
  - Work's data is pushed from the host's `OverviewCache`, the same source the sidebar uses. A
    visible Work panel counts toward the periodic overview refresh, as the sidebar views do.
  - Decisions' read, ruling and image requests go through the host to the existing Tower routes.
    Refusals keep their structured `code`/`message`, so the card shows the same text the dashboard
    shows.
  - The Tower key never enters a webview.
- **Decisions is fully functional:**
  - it polls while its panel is visible and stops while hidden;
  - drafts, held drafts and in-flight submits behave as in the dashboard (Spec 1819), and survive
    the panel being hidden or moved between groups;
  - a ruling round-trips: Submit → Tower writes the file → the card shows the written ruling, and
    Tower's ruling notice to the hub architect (#1828) is sent as it is from the dashboard;
  - workspace-path item images load through the host; http(s) images load as in the dashboard;
  - an http(s) link opens in the user's browser;
  - clicking an image shows it full size inside the panel, because a webview cannot open browser
    tabs.
- **Connection and failure states.** Both panels keep last-known-good content, as the sidebar's
  caches do:
  - before the first data arrives, each shows a loading state;
  - while Tower is unreachable or reconnecting, each keeps showing what it last had, with a notice
    that it is not connected. Decisions keeps its existing error state (the last document read stays
    on screen under the banner), and an in-flight submit that fails shows the error on its card and
    keeps the draft;
  - a response that arrives after its panel was closed is dropped silently: no toast, no error, no
    re-created panel.
- **No decisions file.** A workspace without one (no `afx decisions init`) shows an empty state:
  Tower's "There is no decisions file at …" message plus a hint to run `afx decisions init`. It is
  not an error banner. The panel keeps polling, so creating the file makes items appear.
- **Dashboard-only affordances, mapped or dropped** (no dead controls):

  | Dashboard affordance | In VS Code |
  |---|---|
  | Builders table *Open* (select builder tab) | Opens the builder's terminal via `TerminalManager`, as clicking its Agents row does |
  | *+ Shell* (dashboard shell tab) | Runs the existing *New Shell* action (a Tower shell opened by `TerminalManager`) |
  | *Refresh* | Re-reads the overview from Tower, bypassing Tower's overview cache as the dashboard's does, and updates every consumer of `OverviewCache` |
  | Needs Attention / Backlog / Recently Closed http(s) links (issues, PRs) | Open in the user's browser (as the dashboard and the Pull Requests view do) |
  | Backlog / Recently Closed *spec* / *plan* / *review* links (dashboard annotation tab) | Open that file in a VS Code editor. The host refuses the path unless its canonical (symlink-resolved) location is inside the workspace |
  | *Open Files & Shells* section (dashboard tabs) | **Dropped.** VS Code's own terminal list and editor tabs are the equivalent |
  | Collapsible *Files* panel (`FileTree`) | **Dropped.** VS Code's Explorer is the equivalent |
  | *Tip of the day* banner | **Dropped.** Its tips are CLI/dashboard tips, some of which do not apply in VS Code |
  | Decisions link / full-size image (`window.open`) | Browser for http(s) links. Full-size image shown in the panel |

  In the dashboard every one of these keeps its current behaviour. The dashboard's Work and
  Decisions look and behave exactly as before.
- **Themed by VS Code.** Both panels take their colours, fonts and focus styles from VS Code theme
  variables, so they read correctly in light, dark and high-contrast themes and follow a theme
  change live.
- **Single instance.** One Work panel and one Decisions panel per window, both for the window's own
  workspace. Opening either again reveals the existing panel and never creates a second one or
  reloads the first. Each can also be opened on its own, from the Command Palette (*Codev: Open
  Work*, *Codev: Open Decisions*). Decisions also opens from the hierarchy's Decisions entry under
  the window's own workspace.
- **Restored after reload.** An open Work or Decisions panel comes back after a window reload in the
  group it was in, using VS Code's webview restore. Decisions drafts do not survive a reload, as
  they do not survive a dashboard page reload.

**The split (*Arrange Cockpit*):**

- **Result:** the editor area becomes a left column and a right column, with the right column split
  into a top and a bottom group. Left holds the workspace's `main` architect terminal, top-right
  Work, bottom-right Decisions. Each of the three is the active tab in its group.
- **Architect resolution** uses the existing path (`openResolvedArchitect` → `TerminalManager`). The
  left side is always `main`, with no picker. A non-live `main` gets the existing warning and nothing
  is substituted. The right side is arranged and renders regardless. An architect terminal already
  open is reused, the same session moved to the left group, never closed and reopened. For this
  action the architect goes to the left editor group even when `codev.terminalPosition` is `panel`.
  Every other open path keeps honouring the setting.
- **The user's open editors are never closed, discarded or reloaded**, including dirty and untitled
  ones. They stay open with their unsaved content and may end up in a different group.
- **Triggers:**
  - the first time the Cockpit container is visible in a window session, that window is arranged.
    This includes a window restored with the container already visible, where no visibility-change
    event fires, so the check runs when the view is created as well as on change;
  - a window session ends at reload. After a reload the next first show arranges again. Because
    arranging is idempotent, an intact layout (panels restored in their groups) changes nothing
    visible. The architect terminal, which VS Code does not restore across a reload, is reopened on
    the left;
  - after the first show, showing the container again leaves the editor area alone;
  - *Arrange Cockpit* (Command Palette and the combined view's title bar) arranges on demand at any
    time, and is idempotent: running it on an already-arranged window changes nothing visible;
  - a setting, `codev.cockpit.autoArrange` (default on), turns the first-show auto-arrange off. With
    it off, only the command arranges.
- **Where it is offered:**
  - in a **builder-worktree window** the split is not offered. There is no auto-arrange and the
    title-bar action is hidden. This follows #1809: surfaces that act on the parent workspace stay
    in the parent's window. Work and Decisions likewise are not offered there;
  - in a **window with no Codev workspace** there is nothing to arrange, and there is no
    auto-arrange;
  - in both kinds of window, *Arrange Cockpit*, *Open Work* and *Open Decisions* stay invocable
    from the Command Palette. Invoking one shows a message saying why it does nothing there,
    instead of being silently absent.
- **Placement interaction (accepted, not changed here):** with the split in place, builder terminals
  and issue previews that target "group 2" land in the Work group, per today's placement rules.
  Changing those rules is #1671's scope.

## Success Criteria

- [ ] A new activity-bar button with the rotated Codev icon (same path, `rotate(90 400 400)`) appears
      directly under the Codev button on a fresh profile, in VS Code and in the Codev IDE (including
      `/ide/`).
- [ ] The existing `codev`, `codev-tower` and `codevPanel` containers, their views, view ids, menu
      entries and badges are byte-for-byte unchanged in `package.json` (additions only), and behave
      as before.
- [ ] Clicking the new button opens one tree view with one hierarchy: Tower → workspaces (the Tower
      view's set, labels, order, *current* marker, Dormant group) → each active workspace's live
      architects plus a Decisions entry → the builders each architect spawned → (this window's
      workspace only) their changed files.
- [ ] Builders with no recorded spawning architect appear under `main`. An architect with no
      builders is a leaf. Two or more idle siblings roll up into *Idle Architects*. A builder whose
      recorded architect is not live keeps that architect's row.
- [ ] Every item in the placement table (Desired State §2) is where the table says, and works there.
      Every source-view row click, inline action and context-menu entry for this window's workspace
      has its counterpart. This is checked by a test generated from `package.json` menus against
      that table, so none is missed.
- [ ] Every Tower attention signal (pending gate, wait, architect at a prompt or dead, held mail per
      builder and unattributed, queued feedback) is visible on the row it concerns, for this
      workspace and for others.
- [ ] Rows of another workspace show state and, when clicked, open that workspace's window through
      the existing *Open Workspace* action. They run no other action here and do not expand to
      changed files.
- [ ] Two workspaces with an architect named `main`, and a builder id present in two workspaces,
      render as distinct rows with no tree-id collision.
- [ ] Builder-row click-expands, the accordion, active-file reveal and agent-cycle selection act on
      the combined panel's rows for this window's workspace when it is the visible view.
- [ ] The Agents and Tower title-bar actions other than group-by (refresh, accordion toggle,
      file-tree toggle) are on the combined view's title bar. Stage and area grouping stay only in
      the Agents view, and the combined panel ignores `codev.buildersGroupBy`.
- [ ] No second poll loop, SSE subscription or new Tower route is added for the combined panel.
      Other workspaces' rows come from the overviews `TowerFleetCache` already fetches, so the Tower
      request count while the Cockpit is open equals the count with the source views open.
- [ ] With the Codev container hidden and only the Cockpit visible, the overview still refreshes on
      the `codev.overviewRefreshSeconds` cadence. With neither visible (nor the Work panel), the
      periodic refresh stops, as today.
- [ ] *Arrange Cockpit* produces `main` architect | (Work over Decisions), each active in its group,
      with live data in both panels.
- [ ] With `main` not live, *Arrange Cockpit* shows the existing warning, opens no other architect,
      and still arranges and renders Work and Decisions.
- [ ] With a dirty file, an untitled buffer and a modified file open across two or more groups,
      arranging closes none of them and loses no unsaved content.
- [ ] Re-running *Arrange Cockpit* on an arranged window creates no duplicate panel or terminal and
      reloads neither panel. A Decisions draft typed before the re-run is still there after it.
- [ ] Decisions: a pending item can be ruled from VS Code. The file on disk carries the ruling, the
      card shows it, and the hub architect receives the ruling notice, the same as from the dashboard.
- [ ] Decisions: a refused ruling (e.g. `item-changed`) shows the server's message on the card and
      keeps the draft.
- [ ] Decisions: a workspace-path image and an http(s) image both render. A missing image shows the
      "Image not loaded" note. Clicking an image shows it full size in the panel.
- [ ] Decisions: a workspace without a decisions file shows the empty state, not an error. Creating
      the file makes its items appear without reopening the panel.
- [ ] Work: builders, Needs Attention, Backlog and Recently Closed render from the overview. *Open*
      opens the builder's terminal, *+ Shell* opens a Tower shell, *Refresh* refreshes, artifact
      links open the file, and http(s) links open the browser. No dropped affordance is rendered.
- [ ] Neither webview makes a network request to Tower, and the Tower key is absent from webview
      state and messages.
- [ ] The host opens externally only `http:`/`https:` URLs from a webview, and opens a file from a
      webview only when its canonical path is inside the workspace. A symlink escape, `..`, an
      absolute path outside the workspace or another URL scheme is refused.
- [ ] With Tower unreachable and then back, both panels keep their last content with a
      not-connected notice and recover on reconnect, with no error toast. This is simulated in the
      isolated verification instance, never by stopping the owner's Tower.
- [ ] With `codev.cockpit.autoArrange` off, showing the container never arranges, and the command
      still does.
- [ ] The dashboard's Work and Decisions views look and behave as before. Existing `apps/web` tests
      (`DecisionsView*.test.tsx`, `useDecisions.test.ts`, `BuilderCard.test.tsx`,
      `NeedsAttentionList.test.tsx`, `BacklogList.test.tsx`, `App.decisions-tab.test.tsx`, …) pass
      unchanged in intent.
- [ ] No React component used by Work or Decisions exists in two copies in the repo.
- [ ] In a builder-worktree window: the button and combined panel work. The parent workspace's rows
      navigate to the parent's window, the worktree-scoped actions are on its row, and the split,
      Work and Decisions are not offered. In a no-workspace window: the button and panel work, and
      every workspace's rows navigate.
- [ ] The Decisions entry under this window's workspace opens, or reveals, the single Decisions
      panel without arranging the split. For a workspace without a decisions file it opens the empty
      state.
- [ ] Both panels render correctly in a light, a dark and a high-contrast theme and follow a live
      theme change.
- [ ] `contributes-*` tests cover the new container, view, commands, setting, menus and their
      `when` clauses. The existing `contributes-*` tests pass unmodified apart from additions. Other
      existing tests that assert on `extension.ts` source text, such as
      `worktree-window-1809.test.ts`'s badge-suppression match, may be updated to follow
      generalised wiring, provided the behaviour they guard is unchanged.
- [ ] **Verified by rendering:** the PR carries screenshots taken from a running extension (the
      Codev IDE at `/ide/` driven by Playwright, or an equivalent isolated instance). They show the
      button; the combined hierarchy with N=0, N=1 and N>1 builders and with two or more workspaces;
      the split with a pending decision; and light and dark themes.
- [ ] Lint, type-check and the full `apps/vscode`, `apps/web` and shared-package test suites pass.

## Constraints

Prescribed by the architect in the issue ("Prescribed design choices"; settled, not relitigated
here):

- **Reuse the React components; don't rewrite them.** The extension already bundles React into
  webviews (`esbuild.js`, the markdown-preview and contextual-panel webviews) and already depends on
  `@cluesmith/codev-artifact-canvas`, which `DecisionsView` uses. If the components have to move to
  be shared between `apps/web` and `apps/vscode`, move them to a shared location and have both
  import from it. A forked copy inside `apps/vscode` is not acceptable.
- **Webviews don't talk to Tower directly.** Data and actions go through the extension host's
  existing Tower connection (`connection-manager.ts`) over webview messaging. That keeps auth, the
  workspace-scoped route prefix and web-workbench (`/ide/`) mode working, and respects the
  codev-core / codev-sdk import boundary.
- **Dashboard-only affordances need an extension equivalent or get dropped, explicitly.** For each
  one the spec says what it maps to in VS Code or that it is left out. No dead buttons. (The mapping
  table above.)
- **Theme with VS Code variables**, so the ported views read correctly in light, dark and
  high-contrast themes.
- **Both channels.** The same extension ships as the marketplace vsix and inside the Codev IDE. This
  must work in both, including a builder-worktree window and a window with no Codev workspace.

From the issue body:

- Additive only: the existing Codev container and its views stay exactly as they are; nothing is
  removed or moved.
- The icon is a new SVG rotating the same path (`transform="rotate(90 400 400)"`), not a redrawn
  shape.
- One source of truth: the combined panel reuses `views/workspace.ts`, `views/builders.ts`,
  `views/tower.ts`, `overview-data.ts` and `tower-cache.ts`, with no second copy of fetch or grouping
  logic.

From the owner at the spec gate (issue #1963 comments; supersedes the issue body's "one view with
three sections"):

- *"towers -> workspaces -> architects / decisions -> builders."* The combined panel is one
  hierarchy: Tower → workspaces → architects and a Decisions entry → the builders each architect
  spawned.
- Nothing the three source views do may silently disappear. Each is placed in the hierarchy or
  deliberately left to the existing views (the placement table).
- No per-workspace poll loop is added to supply hierarchy data, and the "no Tower route changes"
  constraint is not dropped quietly. Any need for data Tower does not serve is a gate question.
- Otherwise the spec as drafted stands ("Other than that spec sounds good"): first-show trigger and
  `codev.cockpit.autoArrange`; the `terminalPosition` override; no split in worktree windows; the
  new shared package; name, rotation and badge; the button in every window; builder-terminal
  placement left to #1671.
- The architect goes through `open-architect.ts` / `TerminalManager`, and the #1497 invariant
  holds.

From the system:

- Server/client isolation (#1189): the shared component package and any new SDK methods import only
  `codev-types` (and, for the components, the environment-agnostic SDK helpers and
  `codev-artifact-canvas`). They never import `codev-core`. The SDK stays environment-agnostic with
  zero runtime deps, and boundary tests enforce this in CI.
- No Tower or decisions-route changes: the Spec 1819 / #1938 routes are consumed as they are.
- VS Code engine floor `^1.128.0`. No API newer than that.
- Webview hardening as in the existing webviews: nonce-gated scripts, a CSP that admits only what
  the panels load, and every inbound webview message validated by a type guard before it is acted
  on. A path from a webview is treated as untrusted. It is confined to the workspace by its
  canonical, symlink-resolved location, not by string prefix. A URL from a webview is opened
  externally only if its scheme is `http:` or `https:`.
- The panels' CSP `img-src` must admit host-delivered workspace images. That means `blob:` if they
  are shown as object URLs, as the dashboard does, or `data:` if they are encoded. The existing
  precedent is `img-src ${cspSource} https: data:`. It must not add `connect-src` for Tower.
- The extension stays under the existing `regCli` / `reg` command-registration guard (#791).
- UI changes are verified in a browser via Playwright before being called done
  (`codev/resources/testing-guide.md`). Verification must not replace or disturb the owner's live
  Codev IDE extension or running workspaces.

## Assumptions

- `vscode.setEditorLayout` (or an equivalent built-in layout command) can shape the editor area into
  left | (top / bottom) while moving editors from groups it removes, not closing them. This is to be
  confirmed in the plan by a spike against a running instance. If it does not hold, the arrangement
  must only add or reuse groups and never remove one.
- An existing terminal-editor tab can be moved between editor groups, and from the bottom panel into
  the editor area, without ending its session. Same spike.
- Webview `postMessage` can carry image bytes, or an equivalent encoding, efficiently enough for
  images up to Tower's 10 MB image cap.
- `OverviewData.architects` gives the Work view what the dashboard's `DashboardState` gave it
  (architect count for builder attribution), so Work needs no `/api/state` read.
- The Codev IDE at `/ide/` can be driven by Playwright with a build of this branch loaded in an
  isolated extensions dir or server instance, so verification never touches the owner's live IDE.
- A fixture workspace, with builder entries but no real agents, can produce the N=0 / N=1 / N>1
  builder states and a pending decision without spawning builders.

## Solution Approaches

### A. The combined panel

**A1 — A hierarchical composite over the existing row builders, acting only on this window's
workspace (recommended).** One `TreeDataProvider` renders the hierarchy:

- the Tower root;
- workspace rows from `TowerProvider`'s row building and `orderFleet`;
- under this window's workspace, the architect-axis rows built by `BuildersProvider` over
  `OverviewCache`, then the Decisions entry;
- under each other active workspace, the same architect-axis rows, built by the same pure functions
  (`orderForDisplay`, `architectGrouping`, `partitionArchitectGroups`, `builderRowLabel`,
  `classifyBuilderRow`) over the overview `TowerFleetCache` already fetched and now keeps. These
  rows are navigate-only.

Tower's attention signals fold onto the rows they concern, using `deriveAttention`'s summary and the
existing `describeWait` / `gateIconFor` text and glyphs. The combined view gets its own menu entries
at the placement table's positions; the existing entries are untouched. The TreeView-bound
behaviours (reveal on click, accordion, active-file reveal, agent cycle, selection hook, badge,
periodic-refresh visibility) are generalised from "the Agents view" to "the view the row is in".

- Pros: the owner's hierarchy, with no Tower change and no new requests. No copied fetch, grouping
  or row logic. Every action of this window's workspace works because the rows are built by the
  same code. The rule "act here only for this window's workspace" matches #1809, the gate ruling on
  worktree windows, and the Tower view's existing click-to-open behaviour.
- Cons:
  - `extension.ts` wiring that today closes over `buildersView` must be generalised;
  - `TowerFleetCache` keeps each overview (memory for N overviews, bounded by the number of active
    workspaces);
  - tree ids must be workspace-qualified;
  - Tower's workspace-row node type and `vscode.TreeItem` rows make the element type a union;
  - another workspace's rows navigate rather than act.
- Risk: medium.

**A2 — The same hierarchy, fully actionable for every workspace in this window.** Clicking another
workspace's architect or builder opens its terminal here, its context menu works here, and its
Decisions entry opens its Decisions panel here. This needs no Tower route changes (terminal and
decisions routes are already workspace-scoped), but it is a large extension change:

- `TerminalManager` keys and URLs qualified by workspace;
- the #1497 invariant restated over (workspace, architect name);
- the reference-injection commands, agent cycling and terminal pruning made workspace-aware;
- every builder command (approve, diff, artifacts, worktree, setup, dev) and `BuilderDiffCache`
  made workspace-aware;
- per-workspace Decisions panel instances.

Pros: one window drives the whole fleet. Cons: doubles the change's surface and reopens a
recently fixed invariant. Not recommended in this spec; offered at the gate as a follow-up.

**A3 — Keep Tower's attention rows under each workspace, beside the architects.** Pros: the
attention list stays scannable as a list. Cons: every gate and wait appears twice (once as an
attention row, once on its builder row), which is the duplication a single hierarchy is meant to
remove. Not recommended.

**A4 — A webview that renders the tree.** Re-implements every row, glyph, ordering and menu in HTML,
a second copy of row behaviour, and loses native context menus, keyboard navigation and tree
theming. Rejected.

*(The draft's three-section composite, one section per source view, is superseded by the owner's
hierarchy ruling.)*

### B. Sharing Work and Decisions

**B1 — A new shared React package with host adapters (recommended).** Move `WorkView`,
`DecisionsView`, `useDecisions` and the components they pull in (`BuilderCard`,
`NeedsAttentionList`, `BacklogList`, `RecentlyClosedList`, `issueIds`) into a new workspace package.
It is bundled by each host, not npm-published, the way `codev-artifact-canvas` is. The components
take their data and actions from a small host adapter (overview source; decisions read, rule and
image; open builder, new shell, refresh, open file, open external) instead of importing `lib/api.ts`.
A control renders only when the host provides its action. Each host maps the package's theme
tokens: the dashboard to its palette, the extension to `--vscode-*`. `apps/web` keeps thin wrappers
that supply the fetch-based adapter, so the dashboard is unchanged. Dashboard-only pieces
(`FileTree`, `OpenFilesShellsSection`, `TipBanner`) are passed in by the dashboard host as optional
slots rather than moved.

- Pros: one copy; mirrors an established repo pattern; a clean host/IO boundary that satisfies the
  "webviews don't talk to Tower" constraint by construction.
- Cons: a new package with its own build/test wiring. The existing `apps/web` tests move with the
  components or retarget the wrappers.
- Risk: medium.

**B2 — `apps/vscode` imports from `@cluesmith/codev-web`.** `apps/web` already exports `./*` source
files.

- Pros: no move.
- Cons: an app depending on an app. The components still hard-import `lib/api.ts` (relative URLs,
  `window.__CODEV_TOWER_KEY__`, `localStorage`), so they need the adapter refactor anyway, and the
  vsix bundle would trace into dashboard-only modules.
- Risk: medium, worse layering. Not recommended.

**B3 — Fold into `codev-artifact-canvas`.** That package's charter is rendering and reviewing
markdown artifacts. Work and Decisions are workspace-state surfaces. Not recommended.

### C. What triggers the split

- **C1 — First show per window, plus command (recommended).** Auto-arranges the first time the
  container is visible in a window session, including on a restore with the container visible.
  After that only *Arrange Cockpit* does it, and `codev.cockpit.autoArrange` turns the auto-arrange
  off. Predictable: re-showing the sidebar (Cmd+B, switching back from Explorer) never rearranges
  tabs the user has since changed.
- **C2 — Every show (idempotent).** Closest to "clicking the button gives you the layout". But VS
  Code cannot tell a click from a sidebar toggle, so tabs the user rearranged, or a panel they closed
  on purpose, keep coming back.
- **C3 — Command only.** Least surprising, but the button alone would not give the owner the layout
  they asked for.

### D. The right-hand arrangement

- **D1 — Two stacked editor groups, Work over Decisions (recommended; the issue's assumption).**
  Both are visible at once and resizable with VS Code's own sashes.
- **D2 — Two tabs in one group.** Simpler layout, but only one is visible at a time.
- **D3 — One webview holding both.** No group juggling, but no native resize or separation, and it
  couples two independent surfaces.

## Open Questions

**Ruled at the spec gate (owner, 2026-11-24; recorded here, not reopened):**

- **Trigger:** first show per window session, plus *Arrange Cockpit*, plus
  `codev.cockpit.autoArrange`.
- **`terminalPosition: "panel"`:** *Arrange Cockpit* puts the architect in the left editor group
  anyway. Every other open path honours the setting.
- **Builder-worktree windows:** no split, Work or Decisions.
- **Shared code:** a new `packages/` workspace package bundled by both hosts (B1). The plan names it.
- **Name, rotation, badge:** "Codev Cockpit"; clockwise; the workspace "needs me" count.
- **Footprint:** the button is present in every window.
- **Builder terminals:** placement over the Work group is left to #1671.
- **Reload persistence:** Work and Decisions panels are restored after a window reload, as specced.
- **Combined panel:** one hierarchy, Tower → workspaces → architects + Decisions → builders. Section
  order is therefore moot.

**Important (shapes scope); for the owner at the gate, nothing assumed:**

1. **Acting on other workspaces from this window.** This spec makes another workspace's rows
   navigate: clicking opens that workspace's window (A1). Making them fully actionable here (A2)
   needs no Tower route changes but is a large extension change. It requires workspace-qualified
   terminal keys, the #1497 invariant over (workspace, name), every builder command made
   workspace-aware, and per-workspace Decisions panels. **Recommendation:** A1 now, A2 as a
   follow-up if wanted.
   - A narrower middle option: opening *another workspace's Decisions screen* in this window
     (decisions routes are workspace-scoped; no terminal changes) while terminals still navigate.
     Its cost is per-workspace Decisions panels and their single-instance rule. Not specced unless
     ruled in.
2. **Decisions pending count / file presence.** The overview carries neither, so the Decisions
   entry shows no count and appears for every active workspace (opening it shows the empty state
   when there is no file).
   - Showing a count, or hiding the entry when there is no file, needs an **additive Tower change**:
     a decisions summary (present, open count) in the overview payload. The existing fleet fan-out
     would then carry it with no new requests.
   - **Recommendation:** no count in this spec; the additive field as a separate change if wanted.
     This spec keeps "no Tower route changes".

**Nice-to-know:**

3. **Ordering of this window's workspace.** It keeps its urgency slot, as in the Tower view (#1566),
   and starts expanded. Pinning it first is the alternative.
4. **Decisions entry position.** After the architects, per the owner's order ("architects /
   decisions"). First under the workspace is the alternative.
5. **Dev URLs.** They become one context-menu entry (*Open Dev URL…*) on the workspace row instead
   of one row each. Keeping them as rows under the workspace is the alternative, at the cost of
   hierarchy clutter.

## Test Scenarios

**Unit / contribution (vitest, existing harness):**

1. `contributes-*`:
   - the new container after `codev`, the rotated icon file, and the combined view with no `when`
     (always present);
   - the new commands, which stay in the palette everywhere, and the `codev.cockpit.autoArrange`
     setting;
   - the title-bar entries (*Arrange Cockpit* hidden in worktree and no-workspace windows);
   - menu parity, a generated check that every existing source-view entry has its counterpart at
     the placement table's position in the combined view, while the existing entries themselves are
     unchanged.
2. Rotated SVG: same `d` path as `codev.svg`, wrapped in `rotate(90 400 400)`.
3. Hierarchy provider:
   - Tower root, then workspaces in the Tower view's order, labels, *current* marker and Dormant
     group, for the same `TowerFleetCache` state;
   - this window's workspace: architect rows and builders equal the Agents view's architect-axis
     rows for the same `OverviewCache` state (N=0, N=1, N>1 builders; idle siblings rolled up;
     builders with no recorded architect under `main`; a non-live recorded architect; an architect
     with no builders), then the Decisions entry;
   - another workspace: the same shape from its retained fleet overview, with navigate-only commands
     and no changed-files expansion;
   - each attention signal lands on the row the placement table names;
   - `getParent` chains for reveal; id uniqueness with two workspaces that each have `main` and a
     shared builder id;
   - worktree-window and no-workspace variants;
   - `codev.buildersGroupBy` set to stage or area leaves the hierarchy unchanged.
4. `TowerFleetCache`: it keeps each active workspace's overview from the fetch it already makes,
   with no additional request, last-known-good on a failed fetch, dropped when a workspace leaves
   the list or goes dormant; the Tower view's rendering is unchanged.
5. Generalised tree behaviours: accordion, click-expands and reveal act on the view a row belongs
   to, both for the Agents view (regression) and the combined view. Periodic-refresh visibility:
   with only the combined view (or only the Work panel) visible the timer runs; with none visible it
   stops.
6. Host message contract:
   - every inbound message guard rejects malformed input;
   - file-open paths outside the workspace, `..` escapes and symlinks resolving outside are refused;
   - external-open accepts only `http:`/`https:`;
   - a response landing after its panel is disposed is dropped.
7. Auto-arrange trigger: fires once per window session, including when the view is already visible
   at creation; does not fire again on later shows; does not fire with `codev.cockpit.autoArrange`
   off, in a worktree window or in a no-workspace window. In those windows the commands explain why
   instead of acting.
8. Host decisions bridge: document, refusal (structured code/message preserved), transport error,
   image bytes / not-loaded; not-found maps to the empty state.
9. Arrange: architect resolution delegates to `openResolvedArchitect` (non-live `main` → warning, no
   substitute); single-instance panels; idempotent re-run.
10. Shared components: the existing `apps/web` tests pass against the moved components through the
   dashboard adapter. New tests run the same components with a fake host adapter, asserting that
   dropped affordances are absent and mapped actions call the adapter.

**Rendered (Playwright against a running extension, isolated from the owner's live IDE):**

11. Button: rotated icon directly below Codev; the existing Codev container unchanged.
12. Combined hierarchy with two or more active workspaces and N=0, N=1 and N>1 builders:
    - this workspace's builder row context menu shows the same entries as in Agents, and approve,
      open terminal and view diff work from it;
    - the workspace row's actions work (Spawn Builder, New Shell, Add Architect, Open Web
      Interface, Start/Stop Dev, Open Dev URL…), and the Decisions entry opens Decisions;
    - another workspace's architect or builder row opens that workspace's window;
    - a workspace row opens or deactivates as in the Tower view.
13. Arrange on a window with pre-existing editors (one dirty) → the layout appears and the dirty
    editor survives with its content. Arrange again → nothing changes, and a typed Decisions draft
    persists.
14. `main` not live → warning; Work and Decisions still render.
15. Decisions: rule a pending item → file updated, card shows the ruling, architect notified. A
    stale fingerprint gives a refusal with the draft kept. Workspace and http(s) images render;
    full-size view opens and closes.
16. No decisions file → empty state. Run `afx decisions init` → items appear.
17. Work: Open / + Shell / Refresh / artifact link / external link each do what the mapping table
    says.
18. Light, dark and high-contrast themes, and a live theme switch.
19. Window variants and degraded states:
    - builder-worktree window and no-workspace window, including the commands' explanations;
    - Codev container hidden, Cockpit visible: a builder change made in the fixture workspace
      appears under its architect in the combined hierarchy within one refresh interval.
    - Tower unreachable: both panels keep their content under a not-connected notice and recover
      when it returns. This is simulated against the isolated instance's own Tower endpoint; the
      owner's Tower is never stopped.
20. Dashboard regression: the browser dashboard's Work and Decisions tabs render and rule as before.

**Non-functional:**

21. Tower request rate with the combined panel open is unchanged from the source views alone. The
    Decisions poll stops while its panel is hidden.
22. Neither webview opens a network connection to Tower (CSP has no `connect-src` to Tower; the key
    is not present in webview state).

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| The layout command closes or discards a user editor | Low | High | Spike the layout primitive first (Assumptions). The invariant is tested with dirty, untitled and modified editors. If the primitive removes groups unsafely, only add or reuse groups |
| Generalising `buildersView`-bound wiring regresses the existing Agents view | Medium | High | Keep the existing Agents view tests as the regression net, add per-view tests for each behaviour, and render both views in verification |
| A menu entry is missed in the combined view (dead or absent action) | Medium | Medium | A generated test cross-checks every source-view `view/item/context` and `view/title` entry against its counterpart at the placement table's position |
| Users expect another workspace's rows to act here and find they navigate | Medium | Low | The rows say so (tooltip names the workspace and that clicking opens its window). Full cross-workspace action (A2) is a gate question / follow-up |
| Tree-id collisions across workspaces (two `main`s, a shared builder id) break reveal or expansion | Medium | Medium | Ids are workspace-qualified, tested with colliding names |
| Keeping every active workspace's overview grows memory | Low | Low | Bounded by active workspaces. The cache already holds their attention, and it drops an overview when its workspace goes dormant or leaves the list |
| Other workspaces' rows lag this workspace's | Medium | Low | They refresh when the Tower view does today (SSE, debounced, plus the 20 s poll); this is stated, not hidden |
| The combined panel goes stale because periodic refresh is gated on the Codev-container views' visibility | High if missed | Medium | The combined view and the Work panel count toward the existing visibility gate (a success criterion and tests) |
| Tests that match `extension.ts` source text (e.g. `worktree-window-1809.test.ts`) break when wiring is generalised, and the breakage is misread as a regression | Medium | Low | Named in Success Criteria: such tests are updated to follow the wiring, with the guarded behaviour unchanged |
| Auto-arrange or the `terminalPosition` override is unwelcome for some users | Medium | Low | `codev.cockpit.autoArrange` turns auto-arrange off; the override applies only to the arrange action |
| A webview-supplied path or URL is used to open something outside the workspace or a non-web scheme | Low | High | Canonical-path containment, including symlink resolution, and an `http:`/`https:` allowlist, both enforced and tested host-side |
| Moving components changes the dashboard's look or behaviour | Medium | Medium | Thin dashboard wrappers with the current fetch adapter, the existing `apps/web` tests unchanged in intent, and a dashboard render check in verification |
| A Decisions draft is lost by the layout or by hiding the panel | Low | High | `retainContextWhenHidden`; arrangement reuses panels and never recreates them; tested. Loss on explicit panel close or reload is parity with the dashboard and stated |
| The new button does not sit under Codev for an existing profile (VS Code persists activity-bar order) | Medium | Low | Register directly after `codev`. Verify on a fresh profile and an existing one, and note in the PR if VS Code places it elsewhere for existing profiles (the user can drag it) |
| Verification disturbs the owner's live Codev IDE or Tower workspaces | Medium | High | Run the branch build in an isolated extensions dir or server instance and a fixture workspace; no real builder spawns. Ask before anything that would touch the live IDE |
| Image bytes over `postMessage` are slow or memory-heavy | Low | Low | Tower's 10 MB cap bounds them. Fetch on demand per visible item, as the dashboard does |
| SDK boundary violation (new client methods pull Node APIs) | Low | Medium | New methods use the injected `fetchFn` only; the SDK boundary tests run in CI |

## References

- Issue #1963 (this spec's source)
- Spec 1819 — Decisions tab; #1828 ruling notice; #1938 decision images
- #1809 — builder-worktree windows attach read-only to the parent
- #1497 — architect resolution invariant (`apps/vscode/src/open-architect.ts`)
- #1566 — Codev Tower view; #1211 single-SSE lesson
- #913, #1066, #1563, #1743 — Agents accordion, active-file reveal, agent cycling, click-expands
- #1049 — contextual panel (webview precedent); #859 — markdown-preview canvas webview
- #1189 — server/client isolation
- Related, not absorbed: #1614 (secondary-sidebar container), #1671 (editor-group placement model),
  #1548 (architect-context render target)
- `packages/artifact-canvas/README.md` — host-adapter package precedent
- `codev/resources/testing-guide.md` — Playwright verification; `codev/resources/arch.md` — VS Code
  Extension, IDE prefix forward (#1668)
