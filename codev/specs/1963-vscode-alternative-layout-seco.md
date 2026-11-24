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
under the Codev button. It shows one combined left-hand panel (Workspace, Tower and Agents together)
and an editor-area split, with the `main` architect's terminal on the left and Work and Decisions on
the right. The existing Codev container and its views stay as they are. This is an **addition**, not
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

### 2. One combined left-hand panel

The container holds **one tree view** with three top-level **sections**: *Workspace*, *Tower* and
*Agents* (that order; see Open Questions). Each section is a collapsible header row, expanded by
default, whose children are exactly the rows the corresponding source view renders today:

- **Same data, same rows.** Sections read the existing providers' row-building logic over the
  existing caches (`OverviewCache`, `TowerFleetCache`, `BuilderDiffCache`, the Workspace provider's
  Tower reads). There is no second fetch path, no second SSE subscription and no copied grouping or
  ordering logic.
  - **Provider instances:** the combined panel has its **own provider instances** over the
    **shared caches**. Its rows are built by the same code as the source views' rows, so they have
    the same labels, `contextValue`s and `command`s, but they are distinct objects. Per-view state
    (accordion versioning, the group-parent map used by `reveal`, expansion) therefore stays per
    view, and a row always belongs to exactly one view.
  - **Freshness:** the combined panel takes part in the existing refresh paths, rather than adding
    new ones. While it is visible it counts toward the periodic overview refresh
    (`codev.overviewRefreshSeconds`) exactly as the Codev-container views do. So with the Codev
    container hidden and only the Cockpit visible, Workspace and Agents stay current. The Tower
    section rides `TowerFleetCache`'s existing poll and SSE.
- **Same actions.** Every click, inline action and context-menu entry a row has in its source view
  works on the same row in the combined panel with the same effect. Tree behaviours bound to the
  source view follow the view the row is in: click-expands, accordion, active-file reveal (when the
  combined panel is the visible one), agent-cycle selection and the `builder-active` hook.
- **Menu contributions are added, not edited.** The existing `view/item/context` and `view/title`
  entries for `codev.workspace`, `codev.agents` and `codev.tower` stay byte-for-byte as they are. The
  combined view gets its own entries, scoped to it, with the same commands, `viewItem` patterns,
  extra `when` terms and groups. A generated parity test fails if any source-view row entry has no
  combined-view counterpart, so the two sets cannot drift.
- **Section-level actions.** Each source view's title-bar actions (Agents: refresh, group-by cycle,
  accordion toggle, file-tree toggle; Tower: refresh) are available in the combined panel, attached
  to the section they act on. The combined view's own title bar carries *Arrange Cockpit* (below)
  and *Refresh*.
- **Section headers** show the same live summary the source view's title does (*Agents (N)*).
- **Badge.** The combined view badges the new activity-bar button with the same workspace "needs me"
  count as the Codev button (`composeActivityBadge`), under the same suppression rules. The Tower
  container keeps its machine-wide badge.
- **Empty and degraded states:**
  - an Agents section with no builders shows a single *No active builders* row, not an empty header;
  - Tower's *Connecting to Tower…* and *No workspaces registered* rows appear as they do today;
  - in a **builder-worktree window** the Agents section is absent (as `codev.agents` is today),
    Workspace shows its worktree-scoped rows, and Tower shows the fleet;
  - in a **window with no Codev workspace** the Tower section is shown, and in place of Workspace
    and Agents a single row says no Codev workspace is open, with the open-folder action.
- **Footprint.** The combined view has no `when`, so the new button appears in every window where
  the extension activates (`onStartupFinished`), including non-Codev windows. That follows from the
  no-workspace requirement, and matches today's Codev and Codev Tower containers, which also appear
  there (Agents with its welcome content, Tower with the fleet).

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
- **Single instance.** One Work panel and one Decisions panel per window. Opening either again
  reveals the existing panel and never creates a second one or reloads the first. Each can also be
  opened on its own from the Command Palette (*Codev: Open Work*, *Codev: Open Decisions*).

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
- [ ] Clicking the new button opens one tree view with Workspace, Tower and Agents sections showing
      the same rows as the three source views for the same data.
- [ ] Every row click, inline action and context-menu entry of the three source views is present
      and works on the same row in the combined panel. This is checked against a list generated from
      `package.json` menus, so none is missed.
- [ ] Builder-row click-expands, the accordion, active-file reveal and agent-cycle selection act on
      the combined panel's rows when it is the visible view.
- [ ] Source-view title-bar actions are reachable from the combined panel on their sections.
- [ ] No second poll loop or SSE subscription is added for the combined panel. It takes part in the
      existing ones, so the Tower request count while it is open equals the count with the source
      views open.
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
- [ ] In a builder-worktree window: the button and combined panel work (no Agents section), and the
      split, Work and Decisions are not offered. In a no-workspace window: the button and panel work,
      with Tower plus the no-workspace row.
- [ ] Both panels render correctly in a light, a dark and a high-contrast theme and follow a live
      theme change.
- [ ] `contributes-*` tests cover the new container, view, commands, setting, menus and their
      `when` clauses. The existing `contributes-*` tests pass unmodified apart from additions. Other
      existing tests that assert on `extension.ts` source text, such as
      `worktree-window-1809.test.ts`'s badge-suppression match, may be updated to follow
      generalised wiring, provided the behaviour they guard is unchanged.
- [ ] **Verified by rendering:** the PR carries screenshots taken from a running extension (the
      Codev IDE at `/ide/` driven by Playwright, or an equivalent isolated instance). They show the
      button; the combined panel with N=0, N=1 and N>1 builders; the split with a pending decision;
      and light and dark themes.
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
- "A single panel" is one view with three sections, not three stacked views sharing a container.
- One source of truth: the combined panel reuses `views/workspace.ts`, `views/builders.ts`,
  `views/tower.ts`, `overview-data.ts` and `tower-cache.ts`, with no second copy of fetch or grouping
  logic.
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

**A1 — Composite tree over the existing providers (recommended).** One `TreeDataProvider` whose
roots are the three section headers. Each section's children, `getTreeItem` and `getParent`
delegate to the combined panel's own Workspace / Tower / Builders provider instances, which read the
same shared caches as the source views. The rows are built by the same code, with the same
`contextValue`s and `command`s. The combined view gets its own menu entries, mirroring the source
views' entries; the existing entries are left as they are. The TreeView-bound behaviours (reveal on
click, accordion, active-file reveal, agent cycle, selection hook, badge, count, periodic-refresh
visibility) are generalised from "the Agents view" to "the view the row is in".

- Pros: zero copied row logic; every action works because it is the same row; native tree
  affordances (keyboard nav, context menus, theming) for free.
- Cons: `extension.ts` wiring that today closes over `buildersView` must be generalised. Element ids
  must stay unique across sections. Tower's non-`TreeItem` node type means the composite element is
  a union.
- Risk: medium. The generalisation touches well-tested behaviour, and existing tests guard the
  source views.

**A2 — A webview that renders all three sections.** One React webview drawing the rows as HTML.

- Pros: full layout freedom.
- Cons: re-implements every row, glyph, ordering and menu in HTML: a second copy of row behaviour,
  which the issue forbids. Native context menus, keyboard navigation and tree theming are lost.
- Risk: high. Rejected.

**A3 — Three views in one container.** Register Workspace, Tower and Agents views again under the
new container.

- Pros: least code.
- Cons: the issue explicitly reads "a single panel" as one view with three sections. Rejected.

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

**Critical (blocks progress):** none. The issue's five working assumptions are adopted below, for
confirmation at this gate.

**Important (shapes design), recommendation given; confirm at the gate:**

1. **Trigger semantics.** The issue assumes "showing the new container arranges the split". This
   spec narrows that to *the first show per window*, plus the command (C1 over C2). Confirm.
2. **`codev.terminalPosition: "panel"`.** This spec has *Arrange Cockpit* put the architect in the
   left editor group regardless of the setting (moving an already-open panel terminal into the
   editor), because the user explicitly asked for the layout. The alternative is to honour the
   setting and leave the left column without the architect. Confirm.
3. **Builder-worktree window.** This spec does not offer the split, Work or Decisions there,
   following #1809's "parent-acting surfaces stay in the parent's window". The combined panel still
   works (Workspace worktree rows + Tower). The alternative is to show the parent's Work and
   Decisions there too. Confirm.
4. **Shared package location/name.** Recommendation: a new `packages/` workspace package bundled by
   both hosts (B1). The plan names it.

**Nice-to-know:**

5. **Container name.** "Codev Cockpit" (working title) unless the owner prefers another.
6. **Rotation direction.** Clockwise (`rotate(90 …)`), as assumed.
7. **Section order.** Workspace, Tower, Agents (the owner's spoken order). Workspace, Agents, Tower
   is the alternative.
8. **Badge source.** The workspace "needs me" count (same as the Codev button) rather than Tower's
   machine-wide count.
9. **Reload persistence.** Whether Work and Decisions panels are restored after a window reload
   (webview serializer) or re-created by the next arrange. Recommendation: restore them. Decisions
   drafts are lost on reload either way, as they are on a dashboard page reload.

## Test Scenarios

**Unit / contribution (vitest, existing harness):**

1. `contributes-*`:
   - the new container after `codev`, the rotated icon file, and the combined view with no `when`
     (always present);
   - the new commands, which stay in the palette everywhere, and the `codev.cockpit.autoArrange`
     setting;
   - the title-bar entries (*Arrange Cockpit* hidden in worktree and no-workspace windows);
   - menu parity, a generated check that every existing source-view row entry has a combined-view
     counterpart while the existing entries themselves are unchanged.
2. Rotated SVG: same `d` path as `codev.svg`, wrapped in `rotate(90 400 400)`.
3. Composite provider:
   - section roots and order;
   - children equal the source providers' children for the same cache state (N=0, N=1, N>1
     builders; each group-by axis);
   - `getParent` chains for reveal;
   - id uniqueness across sections;
   - worktree-window and no-workspace variants.
4. Generalised tree behaviours: accordion, click-expands and reveal act on the view a row belongs
   to, both for the Agents view (regression) and the combined view. Periodic-refresh visibility:
   with only the combined view (or only the Work panel) visible the timer runs; with none visible it
   stops.
5. Host message contract:
   - every inbound message guard rejects malformed input;
   - file-open paths outside the workspace, `..` escapes and symlinks resolving outside are refused;
   - external-open accepts only `http:`/`https:`;
   - a response landing after its panel is disposed is dropped.
6. Auto-arrange trigger: fires once per window session, including when the view is already visible
   at creation; does not fire again on later shows; does not fire with `codev.cockpit.autoArrange`
   off, in a worktree window or in a no-workspace window. In those windows the commands explain why
   instead of acting.
7. Host decisions bridge: document, refusal (structured code/message preserved), transport error,
   image bytes / not-loaded; not-found maps to the empty state.
8. Arrange: architect resolution delegates to `openResolvedArchitect` (non-live `main` → warning, no
   substitute); single-instance panels; idempotent re-run.
9. Shared components: the existing `apps/web` tests pass against the moved components through the
   dashboard adapter. New tests run the same components with a fake host adapter, asserting that
   dropped affordances are absent and mapped actions call the adapter.

**Rendered (Playwright against a running extension, isolated from the owner's live IDE):**

10. Button: rotated icon directly below Codev; the existing Codev container unchanged.
11. Combined panel with N=0, N=1 and N>1 builders. A builder row's context menu shows the same
    entries as in Agents. Approve, open terminal and view diff work from it. A Tower row opens or
    deactivates a workspace.
12. Arrange on a window with pre-existing editors (one dirty) → the layout appears and the dirty
    editor survives with its content. Arrange again → nothing changes, and a typed Decisions draft
    persists.
13. `main` not live → warning; Work and Decisions still render.
14. Decisions: rule a pending item → file updated, card shows the ruling, architect notified. A
    stale fingerprint gives a refusal with the draft kept. Workspace and http(s) images render;
    full-size view opens and closes.
15. No decisions file → empty state. Run `afx decisions init` → items appear.
16. Work: Open / + Shell / Refresh / artifact link / external link each do what the mapping table
    says.
17. Light, dark and high-contrast themes, and a live theme switch.
18. Window variants and degraded states:
    - builder-worktree window and no-workspace window, including the commands' explanations;
    - Codev container hidden, Cockpit visible: a builder change made in the fixture workspace
      appears in the Agents section within one refresh interval.
    - Tower unreachable: both panels keep their content under a not-connected notice and recover
      when it returns. This is simulated against the isolated instance's own Tower endpoint; the
      owner's Tower is never stopped.
19. Dashboard regression: the browser dashboard's Work and Decisions tabs render and rule as before.

**Non-functional:**

20. Tower request rate with the combined panel open is unchanged from the source views alone. The
    Decisions poll stops while its panel is hidden.
21. Neither webview opens a network connection to Tower (CSP has no `connect-src` to Tower; the key
    is not present in webview state).

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| The layout command closes or discards a user editor | Low | High | Spike the layout primitive first (Assumptions). The invariant is tested with dirty, untitled and modified editors. If the primitive removes groups unsafely, only add or reuse groups |
| Generalising `buildersView`-bound wiring regresses the existing Agents view | Medium | High | Keep the existing Agents view tests as the regression net, add per-view tests for each behaviour, and render both views in verification |
| A menu entry is missed in the combined view (dead or absent action) | Medium | Medium | A generated test cross-checks every source-view `view/item/context` and `view/title` entry against a combined-view counterpart |
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
