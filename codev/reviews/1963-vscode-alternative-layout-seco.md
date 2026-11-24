# Review: VS Code alternative layout ("Codev Cockpit")

## Summary

The Codev extension gains a second, additive layout, built in nine plan phases across the spec's
three increments:

- **Codev Cockpit**, an activity-bar button under Codev with the rotated icon. It opens one tree:
  Tower → workspaces → architects and Decisions → builders. This window's workspace acts, and every
  other workspace navigates to its own window.
- The dashboard's **Work** and **Decisions** views, moved once into a shared package and hosted in
  VS Code as editor-area webviews. All of their I/O goes through the extension host.
- ***Arrange Cockpit***, which lays out the `main` architect | (Work over Decisions).

Every increment was verified rendered in an isolated harness: its own Tower, VS Code 1.147.0
serve-web and headless Chromium. Nothing touched the owner's Tower or IDE. The dashboard's Work and
Decisions render identically, apart from two intended fixes in the shared views.

## Spec Compliance

- [x] **Rotated button directly under Codev on a fresh profile** (Phases 4, 9). Rendered in serve-web
  (`render`, `verify arrange`). A profile that used Codev before the Cockpit existed also gets it
  directly below Codev (`profile-seed` / `profile-existing`). The harness's IDE-server mode (the
  binary behind `/ide/`) passed `start` / `check`; the scripted checks ran in serve-web, which serves
  the same workbench.
- [x] **Existing containers, views, ids, menus and badges unchanged in `package.json`** (Phase 4).
  `contributes-cockpit.test.ts` snapshots every non-Cockpit view and menu entry against the
  pre-Cockpit commit. Two existing commands gained only an `icon` property (`codev.spawnBuilder`,
  `codev.newShell`; Phase 5). **Behaviour change:** the Codev button's badge now clears during a
  Tower outage (see Deviations).
- [x] **One tree with the Tower → workspaces → architects → builders → changed files hierarchy**
  (Phases 2–4).
- [x] **Attribution, the `main` fold-in, childless leaves, *Idle Architects*, a non-live owner keeps
  its row** (Phase 3). The `ArchitectTreeBuilder` equivalence snapshot was recorded from the
  pre-refactor provider.
- [x] **Every placement-table item is placed, checked by a test generated from `package.json` menus**
  (Phase 5). The oracle is `views/cockpit-menu-map.ts`, guarded by `cockpit-menu-parity.test.ts`.
- [x] **Every Tower attention signal on the row it concerns** (Phase 4). One observation: an idle
  sibling's wait text sits inside the collapsed *Idle Architects* container, one click down, though
  the workspace row's summary shows it.
- [x] **Other workspaces' rows show state and navigate only** (Phases 3–5).
- [x] **Two `main`s and one builder id in two workspaces give distinct rows** (Phase 3, scoped ids).
- [x] **Click-expand, accordion, active-file reveal and agent-cycle selection act on Cockpit rows**
  (Phases 4–5; `reveal` rendered). The agent cycle follows architect ruling (b).
- [x] **Refresh, accordion and file-tree toggles on the Cockpit title bar; no group-by** (Phase 4).
- [x] **No second poll loop, SSE subscription or Tower route** (Phase 5; `requests` 4/4 on the
  isolated Tower's request log).
- [x] **Cockpit-only freshness, and the refresh stopping when nothing is visible** (Phases 4, 8;
  rendered: a gate change shown after 56.3 s against the 60 s default).
- [x] ***Arrange Cockpit* gives `main` | (Work over Decisions), each active, with live data**
  (Phase 9).
- [x] **`main` not live: the existing warning, no substitute, panels still arranged** (Phase 9).
- [x] **Dirty, untitled and modified editors across groups survive** (Phase 9, rendered over four
  groups).
- [x] **Re-running creates no duplicate and reloads nothing; a Decisions draft survives** (Phase 9).
- [x] **Decisions ruling round-trip, including the hub architect's notice** (Phase 7). The notice
  was persisted and held, because the fixture architect is a shell, not an agent.
- [x] **A refused ruling shows the server's message and keeps the draft** (Phase 7).
- [x] **Workspace and http(s) images, "Image not loaded", full size** (Phase 7).
- [x] **No decisions file gives the empty state; creating it shows items without reopening**
  (Phase 7).
- [x] **Work sections and the mapped actions; no dropped affordance rendered** (Phase 8).
- [x] **No webview contacts Tower; no `connect-src`; the key never reaches a webview** (Phases 7–8).
  Static CSP test, an ESLint rule and a source test, a host test with a real `TowerClient`, and the
  harness's browser request audit.
- [x] **http(s)-only external opens and canonical-path containment** (Phases 7–8, including a
  Windows junction case on the Windows runner).
- [x] **Tower down then back: last content under a notice, recovery, no toast** (Phase 8, both
  panels).
- [x] **`codev.cockpit.autoArrange` off: no automatic arrange; the command still arranges**
  (Phase 9).
- [x] **The one-time first-auto-arrange notice and its *Don't arrange automatically*** (Phase 9).
- [x] **Dashboard Work and Decisions unchanged; `apps/web` tests unchanged in intent** (Phases 6,
  8). 221 elements were compared in Phase 6 and 138 + 83 in Phase 8: DOM and computed style
  identical to a run on the branch base's build. Two intended changes in the shared views also
  reach the dashboard (see Deviations).
- [x] **No React component in two copies** (Phase 6, `one-copy.test.ts`).
- [ ] **Builder-worktree and no-workspace windows** (Phases 4, 5, 7–9). *Partly met.*
  - The builder-worktree window and the Codev IDE's no-workspace window behave as specified.
  - **Deviation:** a *dormant* window shows *Not connected to Tower* and does not list the fleet.
    A dormant window is the marketplace extension in plain VS Code, in a folder with no Codev
    project. This is the architect's ruling (option A), which keeps issue #1144's
    dormant-window inertness, and the owner decides at the PR gate.
- [x] **The Decisions entry opens or reveals the single panel without arranging; empty state with no
  file** (Phase 7).
- [x] **Light, dark and high-contrast themes, with a live theme switch** (Phases 7, 8). Every visible
  text was measured in four themes. Two Light Modern texts sit at 4.3:1, above the 3:1 floor and
  below 4.5:1; they are named in the PR.
- [x] **`contributes-*` tests cover the additions; existing ones pass unmodified apart from
  additions** (Phases 4, 5, 7–9). `worktree-window-1809.test.ts` and `cockpit-wiring.test.ts`
  follow the generalised wiring, as the criterion allows.
- [x] **Verified by rendering, with screenshots in the PR** (Phases 5, 7, 8, 9). Evidence is
  committed under `codev/projects/1963-vscode-alternative-layout-seco/verification-*`, and the PR
  embeds the button, the hierarchy and the split.
- [x] **Lint, type-check and the full suites pass** (every phase).
  - apps/vscode: 133 files, 1818 tests, 1 Windows-only skip.
  - packages/workspace-views: 197 tests. packages/sdk: 227 tests.
  - apps/web: 37 files, 459 tests. Locally this needs `NODE_OPTIONS=--no-experimental-webstorage`,
    because Node 26's `localStorage` shadows jsdom's; CI runs Node 20.
  - Lint shows only the 2 existing `curly` warnings.
  - The `vscode-test` Electron suite (`src/test/`) is type-checked, but no workflow runs it, and it
    was not run locally.

## Deviations from Plan

**Plan, before approval.** The harness became Phase 1 after the architect found that `afx spawn`
cannot reach a non-default Tower. The layout spike ran before plan approval (all four cases held on
1.147.0). Both changes were made in the plan itself; they are not deviations from the approved plan.

**Phase 1, `verification_harness`:**
- A scratch HOME for every harness child.
- A short `/tmp/cckp-*` symlink for the socket dir, because macOS caps a socket path at 104 bytes.
  Both were accepted by the architect.
- An explicit `COCKPIT_VSCODE=ide-server` mode, added at review.
- Fixtures name a no-op custom harness, so a `bash` architect gets no claude arguments.

**Phase 2, `fleet_overviews`.** Two test files outside the plan's list changed: their `FleetEntry`
literals needed the new field.

**Phase 3, `architect_tree_builder`:**
- The stage/area root branches moved into `ArchitectTreeBuilder.rootRows()` too, because all three
  depend on the parent-map reset it owns.
- Navigate options take no `grouping`, and the navigate target is a function read on each render.

**Phase 4, `cockpit_hierarchy`:**
- The dormant-window ruling (option A, above).
- The badge now follows connection-state changes, which also changes the existing Codev button.
- `codev.autoConnect: false` gives *Not connected* with *Reconnect*, not *Connecting…*.
- Follow-reveals land in every visible host.
- A navigate target is never `isCurrent`.

**Phase 5, `cockpit_actions`:**
- Three commits, not two.
- The command-argument helpers moved to `commands/command-args.ts`.
- `codev.spawnBuilder` and `codev.newShell` got icons.
- `openDevUrl` opens directly only for a non-empty string argument.
- Approve Gate is verified as the relay to the spawning architect (`POST /api/send`, since #1494)
  rather than the plan's `porch approve`. The architect confirmed this.
- Harness fixtures moved under the real per-user temp dir, because Tower's `GET /api/workspaces`
  drops temp-dir workspaces. They are deleted only after realpath, parent, name and marker checks.
- **Adjacent bug fixed in place:** *Spawn Builder* ran `afx spawn` with no `cwd`, so in the Codev
  IDE it could spawn into Tower's project. It now runs in this window's workspace. The bug is live
  on `main` until this merges.

**Phase 6, `workspace_views_package`:**
- Two host interfaces (`WorkViewHost`, `DecisionsViewHost`), not one `WorkspaceViewsHost`.
- `overview` is a value, not a subscription.
- `openBuilder(builder)` and `showImage({src, alt})`.
- The dashboard passes its `/api/state` architect count.
- `openExternal` was added at review, so VS Code's webview opener cannot bypass the host allowlist.

**Phase 7, `decisions_panel`:**
- A new `/host` subpath export, so the host tsconfig never compiles TSX.
- Webview no-I/O enforced by both an ESLint rule and a source test.
- Availability is read from the window's folders: a reload's serializer runs before the connection
  manager initialises.
- The accent maps to the link colour, because high contrast makes the button background black.
- `.vscodeignore` drops `**/tsconfig.*.json`.
- The Windows workflow gained a containment step.
- **Shared-view change that reaches the dashboard:** a refused remote image shows "Image not loaded"
  instead of a broken image. This is the spec's stated behaviour.

**Phase 8, `work_panel`:**
- `single-panel.ts` became the shared base for both panels (a builder decision).
- VS Code-only container queries for the half-width group, and a two-line row under 600 px
  (architect, 14:00Z).
- `--codev-wv-font-size-*` tokens, whose defaults are the dashboard's sizes.
- A `decisions-notice--no-file` modifier.
- **Shared-view change that reaches the dashboard:** with an error and no overview yet, each section
  shows *Loading…* instead of claiming an empty workspace.

**Phase 9, `arrange_cockpit`:**
- Arrange keeps a panel that `reveal(column)` left as a preview tab.
- The restored-tab duplicate in `single-panel.ts` (Phase 7/8 code) is fixed: after a reload, a
  second panel no longer opens beside a restored tab.
- The availability wording.
- `readArchitectRoster` is shared, with a `quiet` mode for the automatic arrange.
- The parity oracle's fifth record kind.
- The harness's `COCKPIT_PRE_COCKPIT` mode.
- The namesake-terminal refusal, and the wait for a namesake that is closing.
- `keepLeftColumn` counts tabs.
- **In the review phase,** at the architect's direction, `verify arrange` gained three rendered
  checks for branches that were unit-tested only before:
  - the namesake refusal, and arranging once that terminal is closed;
  - a reload with Tower down and the Cockpit showing: the automatic arrange runs with no error toast;
  - a reload that leaves only Work and Decisions in one group, one restored and never shown:
    *Arrange Cockpit* keeps an empty left column.

  The second and third shared one check at first. That merged check failed three times, because
  VS Code reopens its Welcome page on a reload. Splitting them let the third close it first.
- **A screenshot privacy fix (review phase).** VS Code opens a local shell in the panel by itself,
  and the harness HOME had no bash profile. macOS's `/etc/bashrc` prompt, `host:dir user$`, showed
  in 12 committed shots. The architect ruled option B:
  - `start` now writes `PS1='$ '` into the harness HOME.
  - Every `verify` run ends with a check that OCRs its shots and fails on such a prompt. Over the
    110 committed shots, the detector flagged exactly those 12.
  - The ten in `verification-increment1/` (`actions-*`, `reconnect-*`) were replaced by runs on
    the final code, with the two scripts' JSON. The folder's README says which files those are.
  - The two in `verification-phase9/` were replaced with the rest of that folder.
  - History was not rewritten. The old shots stay in the branch history, and the architect has
    told the owner.

  **The evidence run** was on 2026-11-24, 16:11–16:30Z, on the final extension code. Each count
  includes the new prompt check.
  - The increment-1 sequence on one `start`: `render` 6/6, `reveal` 2/2, `windows` 4/4,
    `requests` 5/5, `actions` 28/28, `reconnect` 4/4.
  - Then `verify arrange` 19/19 on its own `start`.

  The evidence is in `verification-phase9/`, and in `verification-increment1/` for `actions` and
  `reconnect`. As the architect directed, `verify arrange` runs again on the final head after the
  last commit, with the one Windows dispatch, and the gate message reports both.

## Consultation Feedback

Each round had two reviewers: Codex (GPT-5.6 Sol) and Claude. There was no Gemini lane, because
`.codev/config.json` sets porch's consultation models to `codex` and `claude` only.

### Specify Phase (Iteration 1)

*Responses: `1963-specify-iter1-rebuttals.md`; spec changes in `aca1e16b1`.*

#### Codex (GPT-5.6 Sol) — COMMENT
- **Concern**: "First show per window" is undefined across a reload and for restored panels → **Addressed**: a window session ends at reload; arranging is idempotent, and the architect (not restored by VS Code) reopens on the left.
- **Concern**: Work/Decisions behaviour is unspecified on first connect, with Tower down, on transport failure, and when a panel closes with requests in flight → **Addressed**: new *Connection and failure states* bullet (loading; last-known-good under a not-connected notice; late responses dropped), with a criterion and a rendered scenario.
- **Concern**: Webview-supplied artifact paths need symlink-resolved containment, and external opens need a host-side http(s)-only check → **Addressed**: added to Constraints, the Work mapping table, a criterion, unit scenario 5 and a risk row.
- **Concern**: Arrange must stay invocable in builder-worktree and no-workspace windows so it can explain itself → **Addressed**: *Arrange Cockpit*, *Open Work* and *Open Decisions* stay in the palette and say why they do nothing; only the title-bar action is hidden.

#### Claude — REQUEST_CHANGES
- **Concern**: "Existing menus byte-for-byte unchanged" contradicts A1's widened `when` clauses, which break `contributes-tower.test.ts:47` → **Addressed**: chose mirrored combined-view entries; existing entries untouched, guarded by a generated parity test.
- **Concern**: The combined view is not in `setupPeriodicOverviewRefresh`'s visibility gate, so the Cockpit goes stale while the Codev container is hidden → **Addressed**: the combined view and Work panel join the existing gate ("no *second* poll loop"); new criterion, unit scenario 4, rendered scenario 18 and a risk row.
- **Concern**: A1 is ambiguous between shared provider instances and shared caches → **Addressed**: the spec commits to separate provider instances over shared caches, so accordion and expansion state stay per view.
- **Concern**: `worktree-window-1809.test.ts` asserts on `extension.ts` source text and will need editing → **Addressed**: named in Success Criteria and Risks as a test that may follow the generalised wiring.
- **Concern**: No way to turn off auto-arrange → **Addressed**: added `codev.cockpit.autoArrange` (default on), with a criterion, unit scenario 6, the contributes test and a risk row.
- **Concern**: A combined view with no `when` puts the button in every VS Code window → **Addressed**: a *Footprint* bullet states it.
- **Concern**: A restored window may never fire `onDidChangeVisibility` → **Addressed**: the trigger also checks when the view is created; unit scenario 6.
- **Concern**: CSP `img-src` needs `blob:` for object-URL images → **Addressed**: Constraints add `blob:` (or `data:` if encoded) and no `connect-src` for Tower.

### Specify Phase (Hierarchy revision, round 1)

*Re-consultation on `76e1dc498`, the owner's single-hierarchy revision. Responses:
`1963-specify-revision1-rebuttals.md`; changes in `f18ec4f88`.*

#### Codex (GPT-5.6 Sol) — REQUEST_CHANGES
- **Concern**: The Decisions image rules conflict with the CSP (`img-src` lacks `http:`) and with "no Tower network request" → **Addressed**: remote images are direct `<img>` loads; `img-src ${cspSource} blob: http: https:` with no `connect-src`; the criterion and scenario 22 now read "no fetch/XHR/WebSocket to Tower".
- **Concern**: Keeping the source rows' `contextValue`s contradicts navigate-only rows for other workspaces → **Addressed**: source values apply to this window's rows only; other workspaces get distinct navigate-only values, and the parity test fails if one matches a builder or architect `viewItem`.
- **Concern**: Menu parity has no machine-checkable oracle (group-by omitted, entries relocated) → **Addressed**: a checked-in mapping with one record per source entry (same, relocated or excluded with a reason); only the three `codev.agentsCycleGroupFrom*` entries are excluded.
- **Concern**: The recorded gate date (2026-11-24) is in the future → **Addressed**: labelled as UTC, as relayed by the architect (relay timestamped 2026-11-24T01:38Z).

#### Claude — COMMENT
- **Concern**: Three independently shippable subsystems with no stated increments → **Addressed**: new *Increments* subsection (button + hierarchy → shared package + panels → Arrange Cockpit).
- **Concern**: The workspace level is not "identical" to the Tower view: a quiet active workspace changes from click-to-open to expandable → **Addressed**: active rows click to expand and *Open* moves to the inline/context action; dormant rows keep click-to-open; tested in scenario 5.
- **Concern**: The accordion and file-tree toggles write global settings, so they are not per view → **Addressed**: the spec says `codev.buildersAutoCollapse` and `codev.buildersFileViewAsTree` are shared and global; only row ids, the reveal map and expansion are per view.
- **Concern**: `architectCount` from `OverviewData.architects` (live only) differs from the dashboard's registered count → **Addressed**: stated as an accepted divergence (VS Code counts live architects).
- **Concern**: A no-workspace or Tower-down window shows "Connecting to Tower…" forever → **Addressed**: *Connecting…* only during the first attempt, then a clickable *Not connected to Tower* that runs `codev.reconnect` (a state row, not `viewsWelcome`).
- **Concern**: What this window's workspace row shows before its overview arrives is unspecified → **Addressed**: a single *Loading…* child until it arrives.
- **Concern**: Auto-arrange has no undo; suggests a one-time notice with *Don't arrange automatically* → **Addressed** (owner ruling): first offered as Open Question 6, not specced; at spec approval the owner ruled to add it (`95029fd66`).
- **Concern**: Test gaps: no badge parity/suppression scenario, and `localResourceRoots` not narrowed → **Addressed**: badge checks added to scenario 5; `localResourceRoots` = `dist` added to Constraints.
- **Concern**: The hierarchy overrides a prescribed design choice on an owner comment the reviewer could not verify → **N/A**: addressed to the architect, who relayed the ruling and checked the revision against the owner's words before the go.
- **Concern**: Factual: `requestPreservingBody` already exists; `apps/web` exports only `./src/*.ts` → **Addressed**: named as the precedent; B2's rejection notes the `.ts`-only export.

### Plan Phase (Iteration 1)

*Responses: `1963-plan-iter1-rebuttals.md`; plan changes in `08699b0b2`.*

#### Codex (GPT-5.6 Sol) — REQUEST_CHANGES
- **Concern**: Decision images can't use `requestPreservingBody`, which reads text and parses JSON → **Addressed**: Phase 6 adds a private `requestBinary` (bytes + content type on 2xx, JSON body on non-2xx, never rejects).
- **Concern**: Fixture `.builders/` directories alone render zero builders, because `/api/overview` lists only live builder terminals → **Addressed**: each fixture builder is a real worktree plus a terminal registered via `POST /api/terminals`; the harness asserts `/api/overview` before any screenshot.
- **Concern**: Path containment is platform code: Windows cases and the `windows.yml` dispatch are missing → **Addressed**: `realpath` + `path.relative`; `path.win32` table tests (drive case, separators, other drive, UNC, prefix siblings); a junction case on the Windows runner; the run linked in the PR.

#### Claude — COMMENT
- **Concern**: `codev.removeArchitect` falls back to the row label (`WEB (0)`) on a Cockpit architect row → **Addressed**: resolves a `BuilderGroupTreeItem` to its `groupName`, with a unit test.
- **Concern**: The Workspace view's architects (terminals) and the Cockpit's (overview) can differ → **Addressed**: the plan states the difference as accepted.
- **Concern**: Decisions poll ownership is contradictory, and `document.visibilityState` stays `visible` in a hidden retained webview → **Addressed**: `useDecisions` stays the only poller; the host relays `onDidChangeViewState` as `isActive`; a test asserts no read while hidden.
- **Concern**: Build wiring: the host `tsconfig.json` `exclude` and esbuild's JSX mode → **Addressed**: `src/workspace-views/webview` is excluded; new entries use `jsx: 'automatic'` with `tsconfig.webview.json`; a jsdom smoke test mounts the bundle.
- **Concern**: The Cockpit's `getParent` chain and workspace-row ids are unspecified → **Addressed**: stable ids for the root, workspace and Dormant rows; `getParent` bridges to the root; tests walk the chain and a `reveal`.
- **Concern**: The file-tree and accordion config listeners refresh only `buildersProvider` → **Addressed**: both providers are refreshed or re-gated, with tests.
- **Concern**: "13 Agents row entries" should be 12 → **Addressed**: corrected.
- **Concern**: The theme/live-switch scenario was scheduled only for Work → **Addressed**: also runs for Decisions, in Phase 6.
- **Concern**: Don't run `playwright install` on this machine → **Addressed**: the harness uses the installed Chromium; the manual path only after asking.
- **Concern**: `refreshOverview()` is machine-global → **Addressed**: noted in the plan.

### Plan Phase (Iteration 2)

*Responses: `1963-plan-iter2-rebuttals.md`; plan changes in `5e74a52be`.*

#### Codex (GPT-5.6 Sol) — COMMENT
- **Concern**: `BuilderCard`'s inline `style={{ width }}` is blocked by `style-src ${cspSource}` → **Addressed**: CSP is `style-src ${cspSource} 'unsafe-inline'`, as in both existing webviews; scripts stay nonce-only; Phase 7 checks the progress width under the real CSP.

#### Claude — COMMENT
- **Concern**: The harness cannot produce `spawnedByArchitect`, which comes only from `global.db`'s `builders` table → **Addressed**, later superseded: first via `afx spawn --task` with `CODEV_ARCHITECT_NAME`; the harness revision below replaced that with in-process `upsertBuilder`, since `afx spawn` cannot reach a non-default Tower. The gate asserts attribution.
- **Concern**: The Cockpit's workspace row misses `onDidChangeDevTerminals`, `codev-config-updated` and `architects-updated`, and the async worktree config → **Addressed**: the Cockpit resolves the config in its root `getChildren` and subscribes to all three; tests include the *Stop Dev* swap.
- **Concern**: Acting architect rows have no main/sibling `contextValue`, so *Remove Architect* would attach to `main` → **Addressed**: `cockpit-architect-main` / `-sibling`; the entry targets siblings only; the parity test fails if it matches main.
- **Concern**: "Existing Agents tests unmodified" needs `builders.ts` re-exports → **Addressed**: `builders.ts` re-exports every moved symbol.
- **Concern**: The host adapter's `image(path)` drops the `AbortSignal` → **Addressed**: `image(path, signal?)`; the VS Code adapter ignores replies to aborted requests, with a test.
- **Concern**: Request-count parity must account for the per-render `getWorktreeConfig` → **Addressed**: measured on the isolated Tower's request log, with that call accounted for.

### Plan Phase (Harness revision, round 1)

*Re-consultation on the harness rewrite the architect requested because `afx spawn` cannot target a
non-default Tower. Responses: `1963-plan-harness-rebuttals.md`; changes in `1e0378b1e`, spike in
`27a955e1e`.*

#### Codex (GPT-5.6 Sol) — REQUEST_CHANGES
- **Concern**: The layout spike must run before plan approval, or the plan needs a validated fallback → **Addressed**: first moved into Phase 1 with explicit outcomes; the architect then took the strict reading, and the spike ran before approval (VS Code 1.147.0, all four cases held; evidence in `layout-spike/`).
- **Concern**: The bundle smoke test needs `dist`, which CI never builds → **Addressed**: the test builds its own entry in `beforeAll` through esbuild's API, with options shared from `esbuild.webview.cjs`.
- **Concern**: The new package must declare its own test devDependencies and update `pnpm-lock.yaml` → **Addressed**: React, types, Testing Library, jsdom, vitest and typescript at `apps/web`'s versions; lockfile in the same commit.

#### Claude — COMMENT
- **Concern**: An uncached per-render `getWorktreeConfig` breaks request-count parity, since the Cockpit re-renders on fleet ticks → **Addressed**: the Cockpit holds the config and drops it on `codev-config-updated`, a state change or a workspace change; tests show no fetch per tick and one per config event.
- **Concern**: Driver and Tower can use different db files under `NODE_ENV=test` → **Addressed**: env pinned the same for both and the driver never runs under vitest; pre-flight 3 checks `getGlobalDbPath()` against the `.db` the Tower holds open (`lsof`).
- **Concern**: Name an alternative host in case `code serve-web` is unavailable → **Addressed**: `serve-web` primary; the IDE server binary launched directly as the alternative, never via `/api/ide`.
- **Concern**: WorkView's `state: DashboardState | null` cannot be supplied by the VS Code host → **Addressed**: `state` leaves the shared props; loading keys on the overview, `architectCount` comes from `OverviewData.architects`, builders open via the host's `openBuilder`.
- **Concern**: The file-panel slot must be the whole `work-file-panel` wrapper, not `FileTree` → **Addressed**: the slot is the wrapper plus the root class, with a test.
- **Concern**: This window's held/queued counts should come from `OverviewCache`, not the fleet summary → **Addressed**: `deriveAttention(overviewCache.getData())` for this window; the fleet's retained overview for others.
- **Concern**: Test each relocated command with a Cockpit tree-node argument → **Addressed**: a unit test calls each handler with the Cockpit node its entry is attached to.
- **Concern**: artifact-canvas is a built package, so the source-exported package's risk lands in `apps/web`'s `tsc -b` → **Addressed**: risk row corrected; Phase 6 runs both type-checks before moving anything.
- **Concern**: Promote the harness to its own phase → **Addressed**: the harness is Phase 1 with its own acceptance (green on an empty fixture, every gate refuses, tripwire fires at a throwaway listener); phases renumbered 1–9.

### Plan Phase (Harness revision, round 2)

*Confirmation round, recorded in `1963-plan-harness-rebuttals.md`; changes in `d8c38734f` and
`922aee1eb`.*

#### Codex (GPT-5.6 Sol) — REQUEST_CHANGES
- **Concern**: The CSP omits `default-src 'none'`, so leaving out `connect-src` restricts nothing → **Addressed**: added, with a static CSP test.
- **Concern**: Scenario 22 (no Tower traffic from the webviews) has no decisive test → **Addressed**: ESLint ban on fetch/XHR/WebSocket/EventSource/`sendBeacon`; a unit test that no posted message carries the key or Tower URL; a Playwright request audit in the harness.

#### Claude — COMMENT
- **Concern**: Moving `CANONICAL_KEY_SOURCE` makes `packages/codev`'s `issue-id-parity.test.ts` throw, and its `WorkView.tsx` guard watches the wrong file → **Addressed**: both repointed in Phase 6; `packages/codev`'s suite added to Phase 6 acceptance.
- **Concern**: No import-boundary test for `packages/workspace-views` → **Addressed**: canvas's `import-boundary.test.ts` copied and extended to forbid fetch, XHR, WebSocket, EventSource and `sendBeacon`.
- **Concern**: CommonJS `esbuild.js` cannot `require` an `esbuild.webview.mjs` → **Addressed**: renamed `esbuild.webview.cjs` and added to `.vscodeignore`.
- **Concern**: Phase 5 is oversized → **Addressed**: it lands as two commits, 5a and 5b.
- **Concern**: `--status-*` is a second token family missing from the inventory → **Addressed**: named as `--codev-wv-status-*`.
- **Concern**: The Cockpit's `reveal` chain is two levels deeper, which a fake-TreeView test cannot prove → **Addressed**: the rendered check covers active-file reveal with the rows collapsed.
- **Concern**: `codev.agents`' `viewsWelcome` entries are missing from the parity oracle → **Addressed**: recorded in the oracle.
- **Concern**: "CI's existing workspace test step" does not exist → **Addressed**: the package gets its own `test.yml` step.
- **Concern**: Confirm `vscode:prepublish` tolerates a package with no `build` script → **Addressed**: every harness `build-vsix` since Phase 7 is a real `vsce package` run. Its `vscode:prepublish` (`pnpm --filter 'codev-vscode^...' build`) takes the four dependencies in scope and skips the build-less package, and the packaged vsix loads both panels in every rendered run.

### verification_harness Phase (Iteration 1)

*Responses: `1963-verification_harness-iter1-rebuttals.md`; changes in `fa800353e`.*

#### Codex (GPT-5.6 Sol) — REQUEST_CHANGES
- **Concern**: The plan's IDE-server alternative to `serve-web` is missing → **Addressed**: explicit `COCKPIT_VSCODE=ide-server` mode launches the VS Code Server binary directly with `ide-server.ts`'s flags, all under the scratchpad; chosen explicitly rather than as an automatic fallback (fail-fast rule); start/check/stop verified.

#### Claude — APPROVE
- **Concern**: The tripwire and CLI pid enrolment start after the Tower launch and the first gate-3 probe → **Addressed**: both now start before the Tower launch; the self-test asserts it.
- **Concern**: README should say the 1 s tripwire is a detector, not the enforcement → **Addressed**: README says so and lists the enforcing layers.
- **Concern**: The IDE-server alternative is unimplemented; suggests noting the omission rather than building dead code → **Addressed**: built anyway, following the approved plan and Codex.
- **Concern**: README should say seeding is once per `start` → **Addressed**: README *Scenarios* says so, with both reasons.
- **Concern**: Unused `realpathLoose` import in `harness.mjs` → **Addressed**: removed.
- **Concern**: The Playwright browsers path is hardcoded → **Addressed**: honours `PLAYWRIGHT_BROWSERS_PATH`, with the cache as default.
- **Concern**: Gate 1 self-test lacks the unset-port and web-port-equals-Tower-port cases → **Addressed**: both added (17 cases).

### verification_harness Phase (Iteration 2)

*No rebuttal file; dispositions from the thread and `4d9cd601a`.*

#### Codex (GPT-5.6 Sol) — APPROVE
- No concerns raised.

#### Claude — APPROVE
- **Concern**: `vsixIsCurrent` calls a freshly built vsix stale whenever inputs are uncommitted, and misses untracked files → **Addressed**: `build-vsix` records a content digest of tracked and untracked inputs, and `check` compares it.
- **Concern**: The per-second `ps` + machine-wide `lsof -U` sampling adds machine load → **Addressed**: samples every 2 s, with `lsof -U` on every 5th sample.
- **Concern**: The socket-path prefix match lacks a trailing separator → **Addressed**: the match now needs a trailing `/`.
- **Concern**: `selftest` requires `COCKPIT_WEB_PORT` though it serves no web → **Addressed**: README explains why (its refusal cases run a real `start`).
- **Concern**: `workbench.mjs`'s `--owner-port` filter sees only browser-side requests → **N/A**: non-blocking note; no change (the reviewer asked for none).

### fleet_overviews Phase (Iteration 1)

*No rebuttal file; dispositions from the thread and `147c8fa1d`.*

#### Codex (GPT-5.6 Sol) — APPROVE
- No concerns raised.

#### Claude — APPROVE
- **Concern**: `getOverview()` hands out the cached object by reference → **Addressed**: the doc comments on `FleetEntry.overview` and `getOverview` say it is read-only.
- **Concern**: Two test files outside the plan's list changed, forced by the required `overview` field → **Addressed**: the divergence is recorded in the thread's Phase 2 entry.
- **Concern**: This window's overview is held twice; the Cockpit must keep reading `OverviewCache` for it → **N/A**: carried to cockpit_hierarchy, where this window's workspace reads `OverviewCache`.
- **Concern**: The fleet cache keys by Tower's path spelling, which may differ from the window's → **N/A**: carried to cockpit_hierarchy, which matches with `isSameWorkspacePath` and tests a drive-letter-case mismatch.

### architect_tree_builder Phase (Iteration 1)

*No rebuttal file; dispositions from the thread and `d1714a740`.*

#### Codex (GPT-5.6 Sol) — APPROVE
- No concerns raised.

#### Claude — APPROVE
- **Concern**: `agentCycleOrder()` lacks the `mode !== 'act'` guard, so another workspace's builders could enter the agent cycle → **Addressed**: returns `[]` in navigate mode.
- **Concern**: No test that two builders' accordion versioning is independent → **Addressed**: test added.
- **Concern**: `getChildren` falls through to the root rows for an unrecognised row → **Addressed**: `getChildren` and `getParent` now throw on a foreign-scope or unrecognised row (fail loudly, rather than the suggested `[]`).
- **Concern**: The `builderHasReviewFile` disk probe will run more often once the Cockpit re-renders on fleet ticks → **N/A**: carried to cockpit_hierarchy, which accepted the cost (a handful of small local reads).
- **Concern**: `architect-tree.ts` imports `views/tower.ts` for one constant and one interface → **Rebutted**: no cycle and no load-time `vscode` access; cosmetic, left as is.
- **Concern**: The claim that the snapshot was recorded before the refactor can't be verified from a read-only session → **Rebutted**: the thread records the order (snapshot written against the untouched provider, then the refactor), and mutation runs show the snapshot is not self-confirming.

### cockpit_hierarchy Phase (Iteration 1)

*Responses: `1963-cockpit_hierarchy-iter1-rebuttals.md`; changes in `8ceac87ed`.*

#### Codex (GPT-5.6 Sol) — REQUEST_CHANGES
- **Concern**: Dormant (non-Codev) windows never connect, so the Cockpit shows "Not connected" instead of navigate-only workspace rows → **N/A** (architect ruling, option A): dormant windows stay inert, as the rule from issue #1144 (no Tower connection from a dormant window) requires; the row gains the reason and *Open Folder*; `cockpit-dormant-1144.test.ts`; the spec deviation goes to the PR gate.
- **Concern**: The activity badge is not cleared when Tower disconnects → **Addressed**: the badge repaints on connection-state changes, with tests; this also changes the existing Codev button (its badge clears during an outage), disclosed in the PR.
- **Concern**: `codev.autoConnect: false` leaves "Connecting to Tower…" forever → **Addressed**: connection mode `auto | manual | none`; `manual` shows *Not connected* with *Reconnect*; tests and six mutation checks.

#### Claude — APPROVE
- **Concern**: An active workspace with no architects or builders expands to an empty list → **N/A**: moot once decisions_panel adds a Decisions entry under every active workspace; recorded in the thread.
- **Concern**: The dormant-window behaviour departs from the spec's literal no-workspace criterion and should be recorded → **Addressed**: recorded under the architect's ruling (above), for the PR description and the review.
- **Concern**: `navigateTarget`'s `trees.get(scope)!` non-null assertion → **Addressed**: throws a named error instead (no fallback, per the fail-fast rule).
- **Concern**: `entryOfRow` throws for unscoped rows; suggests returning `[]` → **Rebutted**: unscoped rows are placeholder leaves VS Code never expands or reveals, so `[]` would only hide a routing bug (the builder's own Phase 3 decision).
- **Concern**: A workspace node carries a snapshot of its fleet entry → **N/A**: impact negligible, since each `getChildren` reads live caches; recorded as an observation for the cockpit_actions rendered run.
- **Concern**: Tests were reviewed by reading, not run → **N/A**: a caveat on the review method; the iteration-2 `porch done` ran the full local suite green.

### cockpit_hierarchy Phase (Iteration 2)

*No rebuttal file; dispositions from the thread and `43946ed6c` (first cockpit_actions commit).*

#### Codex (GPT-5.6 Sol) — APPROVE
- No concerns raised.

#### Claude — APPROVE
- **Concern**: The agent-cycle roster follows the Agents view's grouping, so a Cockpit-only window never cycles to architects → **Addressed** (architect ruling (b)): with only the Cockpit visible, the cycle follows the Cockpit's order for this window's workspace; otherwise the Agents order is unchanged.
- **Concern**: The parity test's `shape()` compares `iconPath`, which the Cockpit overrides for a waiting architect → **Addressed**: the architect-row icon is excluded from the comparison, with a comment.
- **Concern**: `pruneTrees` runs only from `towerChildren()` → **Addressed**: its doc comment explains the bounded, harmless lingering.
- **Concern**: `navigateTarget` can carry a workspace name one render stale → **N/A**: non-blocking note; no change.
- **Concern**: `entryOfRow`'s throw for scopeless rows → **N/A**: non-blocking note; no change (the reviewer concluded none was wanted).
- **Concern**: `cockpitConnectionMode` snapshots `codev.autoConnect` at activation → **N/A**: non-blocking note; no change (the reviewer called it correct as built).

### cockpit_actions Phase (Iteration 1)

*Responses: `1963-cockpit_actions-iter1-rebuttals.md`; changes in `4c1373a1b`.*

#### Codex (GPT-5.6 Sol) — APPROVE
- No concerns raised.

#### Claude — APPROVE
- **Concern**: The parity guard's source-view filter is anchored to the start of the `when` clause → **Addressed**: it matches anywhere at a word boundary; a new test pins it; counts unchanged (18 row, 9 title-bar).
- **Concern**: The hidden palette entry for `codev.cockpit.openWebInterface` has no test → **Addressed**: a test asserts the command and its only `commandPalette` entry (`when: "false"`).
- **Concern**: The whole Tower-root listing waits for the worktree-config fetch → **Rebutted**: the plan prescribes it; the fetch never rejects (10 s timeout), and fetching off the render path would make the dev row flicker. A failed fetch holding `null` is recorded for the review.
- **Concern**: *Remove Architect* can appear on a row kept only as a builder's dead owner → **Rebutted**: the plan accepts that divergence; invoking it fails visibly and destroys nothing. A separate context value is recorded as a candidate refinement.
- **Concern**: `entryOfRow`'s throw and the placeholder rows (for information) → **N/A**: agreed; no change.

### workspace_views_package Phase (Iteration 1)

*Responses: `1963-workspace_views_package-iter1-rebuttals.md`; changes in `c092b7f0a`.*

#### Codex (GPT-5.6 Sol) — REQUEST_CHANGES
- **Concern**: Work's issue and PR links stay native `<a href>`, bypassing the host's http(s) allowlist → **Addressed**: optional `WorkViewHost.openExternal`; with it, the four links go to the host with default prevented and propagation stopped (VS Code's webview opener ignores `defaultPrevented`); Decisions links stop propagation too; tests and mutation checks.
- **Concern**: `styles.css` hard-codes `color: white` → **Addressed**: `--codev-wv-on-accent` token; a new `styles-tokens.test.ts` fails on any literal colour or font outside a token.

#### Claude — APPROVE
- **Concern**: `DecisionsView` passes `host.read` detached, and polling restarts whenever `read`'s identity changes → **Addressed**: the view calls `() => host.read()`; the hook keeps the latest `read` in a ref; tests cover `this` and no extra reads while typing.
- **Concern**: The dashboard's `handleOpenArtifact` has no catch → **Addressed**: catches and logs (a pre-move bug, fixed in place).
- **Concern**: Cosmetic: a POSIX-only path check in `one-copy.test.ts`, and a test pinning a `className` trailing space → **Addressed**: paths normalised; the test checks the class list.
- **Concern**: Styles are imported from `main.tsx`, not `index.css` → **N/A**: deliberate, matching the artifact-canvas precedent; no change.
- **Concern**: `image(path, signal)` makes the signal required → **N/A**: the stricter contract is kept; the Phase 7 adapter takes it as required.

### workspace_views_package Phase (Iteration 2)

*No rebuttal file; dispositions from the thread.*

#### Codex (GPT-5.6 Sol) — APPROVE
- No concerns raised.

#### Claude — APPROVE
- **Concern**: The VS Code stylesheet must map all 28 `--codev-wv-*` tokens; add a coverage test → **N/A**: carried to decisions_panel, where `vscode-theme.css` maps all 28 and `workspace-views-theme.test.ts` asserts it.
- **Concern**: `WorkViewHost.openExternal` is optional and unenforced → **N/A**: carried to decisions_panel and work_panel, whose webview host tests assert `openExternal` (both panels) and `showImage` (Decisions).
- **Concern**: The root `className` emits a trailing space → **Rebutted**: parity with the pre-move code, which the snapshot compares.
- **Concern**: `useDecisions` updates the `read` ref in an effect, so a tick between commit and effect uses the previous `read` → **N/A**: non-blocking note; no change.
- **Concern**: `one-copy.test.ts`'s `statSync` would throw on a dangling symlink → **Rebutted**: none exist under `apps/` or `packages/`; left as is.

### decisions_panel Phase (Iteration 1)

*Responses: `1963-decisions_panel-iter1-rebuttals.md`; changes in `b758f8ffb`.*

#### Codex (GPT-5.6 Sol) — REQUEST_CHANGES
- **Concern**: A direct http(s) image that fails stays a broken `<img>` instead of "Image not loaded" → **Addressed**: an error listener on every direct remote image (removed through the effect's abort signal); package tests and a harness 404 image. The dashboard now shows the note too.

#### Claude — APPROVE
- **Concern**: The option words look faint in Light High Contrast → **Addressed**: they were invisible (VS Code colours every `code`); `.decisions-option-word` sets `color: inherit`. The theme check now measures all 62 visible texts in four themes and found three more wrong mappings (muted, error, waiting), all fixed.
- **Concern**: `word`/`comment` are unbounded in the ruling guard while `path`/`url` are bounded → **Rebutted**: intentional, since Tower caps the body and refuses with a reason the panel shows, while a host cap would drop silently; now documented in the guard's comment.
- **Concern**: An aborted image leaves a never-settling inner promise → **Rebutted**: not a leak, since nothing references it once the resolver leaves `pending`; a comment says so.
- **Concern**: The Windows run must be dispatched and linked in the PR → **Addressed**: dispatched; the first run's four test-side failures (8.3 short names, `/etc/hosts`) fixed; the re-run linked.

### decisions_panel Phase (Iteration 2)

*No rebuttal file; dispositions from the thread and the PR description.*

#### Codex (GPT-5.6 Sol) — APPROVE
- No concerns raised.

#### Claude — APPROVE
- **Concern**: The Light Modern *Recommended* badge measures 4.1:1 at 10 px → **N/A**: the suggestion depended on work_panel touching badge styling, which it did not; 4.1:1 is recorded in the evidence and the PR description.
- **Concern**: `resolveWorkspaceFile` has no caller yet → **N/A**: as planned; work_panel is its first caller.

### work_panel Phase (Iteration 1)

*Responses: `1963-work_panel-iter1-rebuttals.md`; changes in `695870167`.*

#### Codex (GPT-5.6 Sol) — REQUEST_CHANGES
- **Concern**: Disconnected before any overview, Work shows empty sections that imply an empty workspace → **Addressed**: with an error and no overview, Builders, Needs Attention and Backlog show *Loading...* under the notice; the same fix covers the dashboard's failed-first-read case (named in the PR).

#### Claude — APPROVE
- **Concern**: `PanelSession` dispatches `onMessage` without a catch, and `vscode.open` can reject → **Addressed**: rejections are caught and logged for both panels, with a test.
- **Concern**: `openArtifact`'s refusal toast can fire after the panel closed → **Addressed**: it checks the session's `closed` flag after the `realpath` calls and logs instead of toasting; test.
- **Concern**: The notice reads "Failed to load overview: Not connected to Tower." → **N/A**: the dashboard's template, kept for parity; rewording is the owner's call, noted in the PR description.
- **Concern**: Two Light Modern texts measure 4.3:1 → **N/A**: above the 3:1 floor, and their meaning is carried elsewhere; named in the PR description.

### work_panel Phase (Iteration 2)

*No rebuttal file; dispositions from the thread and `abeff3c7e`.*

#### Codex (GPT-5.6 Sol) — APPROVE
- No concerns raised.

#### Claude — APPROVE
- **Concern**: The `work-section-loading` class has no CSS rule → **Addressed**: class dropped.
- **Concern**: "Failed to load overview:" reads oddly before any load → **N/A**: the owner's call; in the PR description.
- **Concern**: Two Light Modern texts at 4.3:1 → **N/A**: already disclosed in the PR description.

### arrange_cockpit Phase (Iteration 1)

*Responses: `1963-arrange_cockpit-iter1-rebuttals.md`; changes in `3c5289f5f`.*

#### Codex (GPT-5.6 Sol) — REQUEST_CHANGES
- **Concern**: The architect's tab is found by terminal name, which isn't unique, so arrange can move the wrong terminal → **Addressed**: arrange refuses, before moving any editor, when another terminal has the architect's name. The suggested activation tracking cannot cover a panel terminal (the tab API gives terminal tabs no identity). Duplicate-name test.

#### Claude — APPROVE
- **Concern**: The automatic arrange with Tower down shows an unsolicited "Not connected to Tower" toast → **Addressed**: the automatic path reads the roster quietly and logs; the command keeps its toast; tests.
- **Concern**: The `keepLeftColumn` empty-left-group branch is tested on the fake only → **N/A**: disclosed in the PR as unit-tested only (the reviewer's second option). In the review phase, at the architect's direction, it became a rendered check in `verify arrange`.
- **Concern**: `isTerminalTab` matches the architect's tab by label → **Addressed**: covered by the namesake guard above, and documented in the module comment.
- **Concern**: `settle` busy-polls at 25 ms → **Rebutted**: at most about eight bounded waits per arrange, and some conditions have no single event to wait on; kept.

### arrange_cockpit Phase (Iteration 2)

*Responses: `1963-arrange_cockpit-iter2-rebuttals.md`. Claude's two findings were fixed in
`d9ec45b95` after both reviewers had approved. No consultation has re-reviewed that commit; the PR
review is the first to see it.*

#### Codex (GPT-5.6 Sol) — APPROVE
- No concerns raised.

#### Claude — APPROVE
- **Concern**: The namesake check can fire on a terminal VS Code is still closing after a stale-session re-open → **Addressed** (`d9ec45b95`, not re-reviewed): a namesake gets the 5 s settle bound to leave before arrange refuses; the new test fails on the previous `arrange.ts`.
- **Concern**: `keepLeftColumn` counts live panels, not panel tabs, so a restored, unrevived tab can let group 1 close → **Addressed** (`d9ec45b95`, not re-reviewed): it counts the Cockpit's tabs, live or restored; the new test fails on the previous file with the predicted timeout.
- **Concern**: The test fake opens every intermediate group, while VS Code falls back to `SIDE_GROUP` → **Rebutted**: VS Code 1.147.0's bundle adds every missing group up to the column (below 9); the fake matches, and the rendered runs exercised it.
- **Concern**: `arrangeCockpit`'s catch toasts on the automatic trigger too → **Rebutted**: deliberate; an arrange that stops part-way has moved editors, and the user needs to know why.
- **Concern**: The unit-only `keepLeftColumn` branch is adequately disclosed → **N/A** at the time: the reviewer agreed with the iteration-1 PR disclosure. In the review phase it became a rendered check, a restored, never-shown panel tab included.

## Lessons Learned

### What Went Well

- **Running the layout spike before plan approval** turned the riskiest unknown into recorded
  facts: the merge target, idempotence, and terminal and webview moves keeping their sessions.
  Phase 9 was then built on those facts. The same spike surfaced two harness traps early: web
  auto-save and the trust modal.
- **The isolated harness paid for itself many times over.** It found bugs no unit test could
  have:
  - the *Spawn Builder* `cwd` bug, live on `main` (from the recording stubs);
  - the panel closed on reload restore;
  - accent text lost in high contrast;
  - invisible option words in Light High Contrast;
  - three wrong colour mappings;
  - the half-width Work layout;
  - preview-tab panels;
  - a duplicate panel after a reload.
- **Snapshot before refactor.** The `ArchitectTreeBuilder` equivalence snapshot was recorded from the
  untouched provider before any source change. Mutation runs showed it was not self-confirming.
- **Before/after DOM and computed-style comparison of the dashboard** made "unchanged" a measured
  claim (221 elements, then 138 + 83) rather than an eyeballed one.

### Challenges Encountered

- **CLI paths that default to Tower's port.** `afx spawn`, porch's `refreshOverview` and several
  extension shell-outs all assume the default port (4100), with no port override. The harness
  therefore creates all state over HTTP to an explicit port or in-process, stubs the CLIs, and runs
  a tripwire on :4100.
- **Tower's temp-dir filters.** `GET /api/workspaces` drops workspaces under temp roots, and startup
  reconciliation kills their sessions. Fixtures in the scratchpad vanished from the fleet.
- **VS Code web measurement traps:**
  - A closed window's extension host keeps polling through its reconnection grace period, which
    inflated request counts about fourfold.
  - A context-menu click within ~500 ms of the menu opening is dropped.
  - A `.catch(() => {})` around palette helpers hid commands that did not exist.

  Each one cost a rerun. The fixes: a fresh server per measured layout, asserting the on-screen
  layout before measuring, and fail-fast helpers.
- **Theme coverage is not contrast.** Mapping every token passed its tests while five mappings were
  wrong for text. Measuring every visible text against its composited background, in four themes,
  is what found them.
- **Several porch `done` runs met load spikes.** The architect's rule (load under 6, no other vitest
  running) kept the local suite trustworthy. One Phase 4 run failed without naming a test and was
  settled through CI.

### What Would Be Done Differently

- Write the harness's checks for a review fix in the same commit as the fix. The Phase 9 iteration-2
  fixes went untested by the harness until the review phase.
- Put the contrast scan into the first rendered theme check, instead of adding it after a reviewer
  saw faint text.

### Methodology Improvements

- **Commit evidence.** Rendered-evidence directories committed per phase, with their JSON results,
  made each phase's claims checkable by reviewers and the architect. The pattern is worth making the
  default for UI specs.
- **Refresh boundaries.** Porch recorded the `arrange_cockpit` refresh boundary as acknowledged when
  `porch next` was called a second time, before the refresh had actually run (noted in the thread).
  A boundary should not count as acknowledged until the refresh has been done.

## Architecture Updates

- Routed: **cold**, `codev/resources/arch.md`. The additions landed with the phases that documented
  them (Phases 5, 8 and 9, and the Phase 9 fixes):
  - the `packages/workspace-views` row in the package table;
  - *VS Code Extension* entries for the Cockpit hierarchy (`CockpitProvider`,
    `ArchitectTreeBuilder`, fleet-overview retention, the act/navigate rule, the held worktree
    config, the parity oracle);
  - the shared Work/Decisions views and their two hosts (the host adapter, a webview that never
    contacts Tower, single-instance retained panels, restored-tab handling, path containment);
  - the *Arrange Cockpit* layout (the spike's facts, column-order placement, preview-tab keep, the
    namesake guard, the quiet automatic read).
- No hot-tier change. Each fact is subsystem detail for the VS Code extension. `arch-critical.md` is
  at its 10-fact cap, and nothing here is cross-cutting enough to displace an entry.

## Lessons Learned Updates

- Routed: **cold**, *Testing*: an isolated harness against Tower must not run any Tower-contacting
  CLI (they default to :4100 with no override). Create state over HTTP to an explicit port or
  in-process. Fixtures must not live under a temp root, because Tower drops those workspaces from
  `/api/workspaces`.
- Routed: **cold**, *Testing*: measuring request counts or menus in VS Code for the Web has three
  traps:
  - a closed window's extension host keeps polling;
  - a context-menu click that lands too soon is dropped;
  - a swallowed palette error leaves the layout silently wrong.

  Restart the server per measurement, assert the layout on screen first, and fail fast in helpers.
- Routed: **cold**, *UI/UX*: theme-token coverage is not contrast. Measure every rendered text
  against its composited background in Dark, Light, HC Dark and HC Light. VS Code's webview
  stylesheet colours every `code` element, and its button background is black in high contrast.
- Routed: **cold**, *UI/UX*: VS Code editor-area webview traps (1.147.0):
  - `reveal(column)` into another group lands as a preview tab;
  - a restored webview is revived only when its tab is shown;
  - moving a group's only editor closes the group and renumbers the rest;
  - a hidden retained webview still reports `visible`.
- Routed: **cold**, *Security*: VS Code's webview script opens any clicked anchor with an `href`
  through VS Code's own opener. It listens on the window and ignores `defaultPrevented`, so a host
  allowlist needs the click stopped before it bubbles.
- Routed: **cold**, *Testing*: screenshots bound for a public repo need a neutral shell prompt in
  the harness HOME and an OCR gate that fails the run. A one-off fix of the noticed shot left 11
  more.
- No hot-tier change. `lessons-critical.md` is at its 10-lesson cap, and these are subsystem or
  harness lessons. "Verify the real user path" already covers the cross-cutting part.

## Flaky Tests

Both are pre-existing, Windows Node 24 only, and in code this branch does not touch. They are
tracked in issue #1973 (pre-existing Windows test flakes) and were left running.

- `packages/codev/src/agent-farm/__tests__/ide-server-stub.windows.test.ts` > `'npm-style shim':
  spawns, forwards a native ?folder path, and stops with nothing left running`. Failed in attempt 1
  of Windows run 45397300019 with "IDE server on port … was not stopped: the port query failed";
  passed in attempt 2.
- `packages/codev/src/agent-farm/__tests__/pir-1233-session-launch-loop.test.ts` > `resumes the
  spawn-pinned session after an unnatural exit, with the nudge, instead of replaying the prompt`.
  Passed in attempt 1 and failed in attempt 2 ("Command failed: … start.sh"). The same file also
  failed on another branch's Windows run (45311869550).

## Follow-up Items

- Issue #1969: act on other workspaces' rows from the current window (terminals, builder actions,
  Decisions). The owner chose navigate-only for now.
- Issue #1970: a decisions summary in Tower's overview, so the Cockpit's Decisions entry can show a
  pending count.
- Issue #1973: the two Windows flakes above.
- **For the owner, at the PR gate:**
  - the dormant-window deviation (connect read-only, connect on a click, or stay inert as built);
  - the "Failed to load overview: Not connected to Tower." wording in VS Code;
  - the two Light Modern texts at 4.3:1.
- **Candidate refinements**, not filed:
  - a separate context value, without *Remove Architect*, for a row kept only as a builder's
    non-live owner;
  - a worktree-config fetch that fails while connected holds `null` until the next drop signal.
- **Untested ranges:**
  - The layout behaviour rests on VS Code 1.147.0, while the engine floor is 1.128. Nothing between
    them was run.
  - The waited-out *closing* namesake stays unit-tested: it is a race inside the extension host,
    which the UI cannot time.
