# PIR Plan: VSCode Quick Pick command for searching the backlog

## Understanding

The Backlog tree (`packages/vscode/src/views/backlog.ts`) has no in-sidebar
free-text search. Today a user can narrow by `area/*` grouping or the mine-only
toggle, or rely on VSCode's prefix-match-on-visible-label — none of which help
find an issue by recall ("the one about webview…") or topic ("anything
mentioning telemetry"). The sidebar-embedded `<input>` path is impossible
(VSCode's TreeView API has no input primitive — closed in pir-891); the
full-webview Backlog is tracked separately (#906).

Issue #918 asks for a **Quick Pick command** — `vscode.window.showQuickPick`,
the same overlay that powers `Cmd+P` — populated from the current backlog,
with built-in fuzzy match, that opens the selected issue via the existing
`codev.viewBacklogIssue` flow. ~60–100 LOC of command registration; no
architectural decisions, no new data path.

Key facts confirmed in the codebase:

- The backlog snapshot lives in the shared `OverviewCache`
  (`packages/vscode/src/views/overview-data.ts`); `getData()` returns
  `OverviewData | null`, with `.backlog: OverviewBacklogItem[]` and
  `.currentUser?: string`. `BacklogProvider` reads from exactly this source.
- `OverviewBacklogItem` (`packages/types/src/api.ts:210`) has
  `id, title, url, area, hasBuilder, createdAt, assignees?` — and **no body
  field**. So the issue's optional `detail` = "first sentence of the body" is
  not available without a new fetch path, which the issue explicitly forbids
  ("snapshot from `overviewCache` … no new data path"). → `detail` is omitted.
- `item.area` is the projected area **slug** (e.g. `vscode`, or
  `Uncategorized`), via `parseArea` (`packages/codev/src/lib/github.ts:526`).
- The Backlog tree's display order (`BacklogProvider.orderedSpawnable`,
  `backlog.ts:146`) is: `spawnableBacklog` (drop items with an active builder),
  then **mine-first, then rest**, preserving Tower's order within each segment.
  The mine-only *filter* is applied there too — but search must NOT apply it
  (decision #1).
- `codev.viewBacklogIssue` (`extension.ts:601`, impl
  `commands/view-issue.ts:140`) takes an issue-id string and opens the
  read-only markdown preview. This is the exact single-click row action
  (`backlog.ts:128-129`).
- Commands appear in the palette unless given a `commandPalette` →
  `"when": "false"` entry (`package.json:242`). The new command WANTS palette
  visibility, so it gets a `contributes.commands` entry and **no** suppressing
  `commandPalette` entry.
- The pure-helper-in-a-vscode-free-file pattern is established by
  `backlog-filter.ts` (unit-tested from `__tests__/`, no `vscode` import).

## Proposed Change

Register a new command **`codev.searchBacklog`** (palette title
`Codev: Search Backlog...`) that:

1. Snapshots `overviewCache.getData()` at invoke time (decision #2: snapshot,
   not live).
2. Builds the candidate list over the **full** spawnable backlog — NOT
   mine-only (decision #1) — ordered mine-first then Tower order (decision #3).
3. Maps each item to a `QuickPickItem`:
   - `label`: `#<id> <title>`
   - `description`: `<area> · <N>d ago` (+ ` · @<assignee>` when the first
     assignee is present)
   - `detail`: omitted (no body in the cache snapshot — see Understanding).
4. Calls `showQuickPick(items, { placeHolder: 'Search backlog by id, title,
   area, assignee...', matchOnDescription: true, matchOnDetail: true })`
   (decision #5: `alwaysShow` left default-false).
5. On selection, invokes `codev.viewBacklogIssue` with the chosen item's id —
   identical to the single-click row action.
6. Empty/disconnected snapshot (`getData()` null or no spawnable items): show a
   friendly `showInformationMessage` and return (no empty picker).

To keep the mapping/ordering unit-testable, the pure logic goes in a new
**vscode-free** file `views/backlog-search.ts`, mirroring `backlog-filter.ts`.
The thin command wrapper (which touches `vscode.window`) lives in
`commands/search-backlog.ts`.

### Why this approach

- Reuses the existing `OverviewCache` + `spawnableBacklog` primitives — no new
  data path, matches `BacklogProvider`'s source exactly.
- Splitting pure (ordering + item mapping) from impure (showQuickPick) follows
  the codebase's established testability pattern and lets the ordering/label
  logic be covered by fast vitest unit tests without the Electron harness.
- Delegating the open action to `codev.viewBacklogIssue` via
  `executeCommand` (rather than re-implementing) guarantees behavioural parity
  with the sidebar row and needs no `connectionManager` plumbing in the new
  handler.

## Files to Change

- `packages/vscode/src/views/backlog-search.ts` — **new, vscode-free.**
  - `interface BacklogQuickPickItem { label: string; description: string; issueId: string; }`
    (structurally assignable to `vscode.QuickPickItem`).
  - `orderForSearch(data): OverviewBacklogItem[]` — `spawnableBacklog` →
    mine-first/rest split preserving Tower order (no mine-only filter). Factors
    the segment-split currently inline in `BacklogProvider.orderedSpawnable`.
  - `toQuickPickItems(items, currentUser, now): BacklogQuickPickItem[]` — label
    `#id title`, description `area · Nd ago[· @assignee]`. `now` injected for
    deterministic tests.
  - small private `relativeAge(createdAt, now)` helper (ISO → `Nd ago` etc.,
    same style as `view-artifact.ts:135`).
- `packages/vscode/src/commands/search-backlog.ts` — **new.** `searchBacklog(overviewCache)`:
  snapshot → empty-guard → `orderForSearch` → `toQuickPickItems` →
  `showQuickPick` → `executeCommand('codev.viewBacklogIssue', picked.issueId)`.
- `packages/vscode/src/extension.ts` — import `searchBacklog`; register
  `vscode.commands.registerCommand('codev.searchBacklog', () =>
  searchBacklog(overviewCache))` alongside the other backlog commands (~line
  601). `overviewCache` is already a local in `activate()` (declared line 135).
- `packages/vscode/package.json` — add `{ "command": "codev.searchBacklog",
  "title": "Codev: Search Backlog...", "icon": "$(search)" }` to
  `contributes.commands`. **No** `commandPalette` `when:false` entry (we want it
  visible), **no** keybinding (decision: leave to user).
- `packages/vscode/src/__tests__/backlog-search.test.ts` — **new.** Unit tests
  for `orderForSearch` (spawnable filter, mine-first, no mine-only filtering)
  and `toQuickPickItems` (label/description format, assignee suffix, age) with
  an injected `now`.

## Risks & Alternatives Considered

- **Risk:** `detail` (issue-body first sentence) is in the issue's "nice to
  have" list, but the cache has no body. Fetching it would add the data path
  the issue forbids. *Mitigation:* omit `detail`; fuzzy match still covers id,
  title, area, assignee (the four acceptance-criteria fields). Documented as a
  deliberate decision, not an oversight.
- **Risk:** Reusing `BacklogProvider.orderedSpawnable` directly would import the
  mine-only filter (wrong for search) and pull `vscode` into the test path.
  *Mitigation:* factor a filter-free `orderForSearch` into the vscode-free file
  instead. `BacklogProvider` is left unchanged (could later delegate its
  segment-split to the shared helper, but that's out of scope).
- **Risk:** `currentUser` unavailable (gh not authenticated) → no mine-first
  segment. *Mitigation:* `orderForSearch` degrades to plain Tower order, same
  as the tree's behaviour in that state.
- **Alternative:** custom `QuickPick` object (`createQuickPick`) with per-row
  buttons. Rejected — buttons are explicitly out of scope for v1;
  `showQuickPick` is simpler and matches the issue.

## Test Plan

- **Unit (vitest, `__tests__/backlog-search.test.ts`):**
  - `orderForSearch` drops items with `hasBuilder: true`.
  - `orderForSearch` puts current-user-assigned items first, preserving input
    order within each segment; full set retained (no mine-only drop).
  - `orderForSearch` with null `currentUser` → plain Tower order.
  - `toQuickPickItems` label = `#<id> <title>`; description = `<area> · <N>d ago`
    and appends ` · @<assignee>` when assignee present; uses injected `now`.
- **Build/typecheck:** `pnpm --filter @cluesmith/codev-vscode build` (or repo's
  vscode build) and `pnpm --filter ... test` green.
- **Manual (dev-approval gate — Extension Development Host, F5):**
  - `Codev: Search Backlog...` appears in the Command Palette.
  - Invoking opens a Quick Pick listing every open spawnable backlog issue.
  - Typing an id / title fragment / area / assignee fuzzy-filters the list.
  - Selecting a row opens the same markdown preview a single sidebar click does.
  - Esc / click-away dismisses with no side effect.
  - Works with the Backlog sidebar view collapsed or hidden.
  - Note: this is a VSCode extension surface — tested via the Extension
    Development Host, not `afx dev` (which runs Tower/dashboard, a different
    surface).
