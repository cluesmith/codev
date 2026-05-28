# PIR Plan: VSCode shared search webview above Backlog and Builders

## Understanding

Issue #891 asks for an embedded text input in the Codev sidebar that filters the Backlog and Builders TreeViews in real-time. The TreeView API has no native text-input primitive (verified against `vscode.d.ts` post-1.105 and upstream tracking issue `microsoft/vscode#161753`), so the input must live in a webview. The minimum-impact shape is a thin webview view above the existing TreeViews — the TreeViews stay TreeViews and just consume a shared `SearchState`.

The plan-approval gate ran through the seven design decisions from the issue body plus a handful of post-rebase clarifications. Final positions are recorded in the table below.

## Proposed Change

Add a webview view `codev.search` to the existing `codev` sidebar container, rendered conditionally via a `codev.searchVisible` context key. The view shows a single `<input>` plus a summary line. A 🔍 button in the Backlog and Builders title bars toggles the context key (and persists the preference in `workspaceState`).

A new `SearchState` singleton holds only `{query: string}` and exposes an `onDidChange` event. Both `BacklogProvider` and `BuildersProvider` subscribe to it, fire their `onDidChangeTreeData` on change, and apply a `matches(item)` predicate (case-insensitive substring across all relevant fields) in their existing `orderedSpawnable` / `orderForDisplay` pipelines.

This deliberately keeps the existing TreeViews intact:
- `getChildren` continues to walk groups → rows; we just intersect the row list with the filter predicate
- Group rows are only rendered if at least one of their children matches (otherwise the empty-group row would be a stutter)
- The single-`Uncategorized` flatten branch keeps its current shape
- Accordion, file-tree expansion, context menus, area-group expansion persistence — none of it is touched

### Design decisions (final)

| # | Decision | Position |
|---|----------|----------|
| 1 | Shared filter across both views vs per-view | **Shared.** One input → one mental model. |
| 2 | Match modes (Aa / ab / .*) | **Dropped for v1.** Plain case-insensitive substring only. Simpler webview, simpler tests, less surface area. v2 can add modes back if a real need surfaces. |
| 3 | Query persistence | **Transient — cleared on workspace reload.** Persisted-empty-backlog is a classic footgun. |
| 4 | Match scope per-view | **Includes `labels[]`** — extends `OverviewBacklogItem` and `OverviewBuilder` with a new `labels: string[]` field; details below. |
| 5 | Empty-state UX | TreeView `.message` banner reading `"No matches in <View>. Clear filter to see all items."` plus title suffix `(N of M)`. No inline button — `.message` doesn't support buttons; the 🔍 toggle is the clear affordance. |
| 6 | Sticky filter when search view is hidden via 🔍 toggle | **Clear filter on hide.** Implicit in the conditional-render approach — when the view goes hidden the query input goes with it, so clearing the state is the only consistent behaviour. |
| 7 | Theme matching via `--vscode-input-*` CSS variables | **Yes**, plus CSP + nonce setup as a reusable shape for later webviews (#807, #861, #862, #863). |
| 8 | `retainContextWhenHidden` | **Yes** — preserves the typed query when the user clicks another sidebar pane and back; the search webview only loses its query when the user explicitly toggles it off. Negligible memory. |
| 9 | Toggle implementation | **Conditional view rendering** via `when: "codev.searchVisible"` on the view contribution. Toggling the context key adds/removes the view from the sidebar entirely. No `WebviewView.hide()` API gymnastics, no focus-shift workaround. |
| 10 | 🔍-toggle preference persistence | **Persisted in `workspaceState`** (the show/hide preference is a stable preference, unlike the query). Default: visible. |

### Match scope

- **Backlog rows:** `id` (issue number) + `title` + `area` (raw + `formatAreaForDisplay(area)`) + `labels[]` + `assignees[]` + `author`
- **Builder rows:** `issueId` + `issueTitle` + `area` (raw + formatted) + `labels[]` + `spawnedByArchitect` (architect attribution doubles as a useful filter for multi-architect workspaces — search "ob-refine" to see only that architect's builders)

**Labels (decision 4 implementation):** add `labels: string[]` to `OverviewBacklogItem` and `OverviewBuilder` in `packages/types/src/api.ts`, and populate them in `packages/codev/src/agent-farm/servers/overview.ts`:
- Backlog: directly from `issue.labels.map(l => l.name)` at the existing `BacklogItem` construction site (`overview.ts:821`).
- Builder: built from a new `issueLabelsMap` parallel to the existing `issueAreaMap` (`overview.ts:949`) — keyed by issue number, looked up when constructing the builder row. Soft-mode builders with no resolvable issue get `labels: []`.

This is a small wire-format extension. Both `area/*` labels and any other namespaced labels (`type:bug`, `priority:high`, etc.) become searchable.

**Raw + formatted area:** since #885 merged, group labels are rendered via `formatAreaForDisplay` ("vscode" → "Vscode", "agent-farm" → "Agent Farm") while the raw lowercase value is kept for matchers. The filter searches against *both*. Less relevant now that modes are dropped (lowercased substring sees both naturally), but cheap to keep correct in case modes come back.

**No `area/` prefix concern.** Users type "vscode", not "area/vscode" — the raw `area` field has the prefix stripped on the server. But because we now also search `labels[]` directly, typing "area/vscode" *will* match (labels are full-name "area/vscode" strings). Both shapes work.

### Match algorithm

```
function matches(query: string, fields: string[]): boolean
  if !query.trim(): return true
  const needle = query.toLowerCase()
  return fields.some(f => f.toLowerCase().includes(needle))
```

Pure substring, case-folded. No regex, no whole-word, no compile-error handling — those went out with decision 2.

## Files to Change

### Wire format (new field on overview types)
- `packages/types/src/api.ts`
  - Add `labels: string[]` to `OverviewBacklogItem` (required-with-default; never `undefined`).
  - Add `labels: string[]` to `OverviewBuilder` (same shape).

- `packages/codev/src/agent-farm/servers/overview.ts`
  - At line ~821 backlog construction: set `labels: (issue.labels ?? []).map(l => l.name)`.
  - Build a parallel `issueLabelsMap` alongside `issueAreaMap` (~line 949) and set `labels` on each builder. Soft-mode fallback path (~line 762): `labels: []`.

### New files (production)
- `packages/vscode/src/views/search-state.ts` (~30 LOC) — `SearchState` class.
  - State: `query: string`.
  - `setQuery(q: string)` — fires `onDidChange` if the value actually changed.
  - `clear()` — convenience for `setQuery('')`.
  - `matches(fields: Array<string | undefined>): boolean` — the algorithm above. Pure function, trivially unit-testable.

- `packages/vscode/src/views/search-view.ts` (~80 LOC) — `CodevSearchViewProvider implements vscode.WebviewViewProvider`.
  - `resolveWebviewView`: sets `webview.options = { enableScripts: true }`, sets the HTML, wires `onDidReceiveMessage` for `{type:'query', value}` and `{type:'ready'}`.
  - Listens to provider `onDidChangeTreeData` events to push `{type:'summary', text}` back into the webview (e.g. `"3 of 32 backlog · 1 of 5 builders"` or `""` when no filter is active).
  - Holds the `vscode.WebviewView` reference once resolved, for the summary-push path.

- `packages/vscode/src/views/search-view-html.ts` (~50 LOC) — pure function `renderSearchHtml(webview, nonce): string` returning the full HTML doc with CSP, theme-variable CSS, and the inline script. Separate file so it's unit-testable without touching VSCode.
  - CSP: `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-<n>';`
  - Inline `<script nonce="...">` posts `{type:'query'}` on `input` (debounced 150ms via `setTimeout`/`clearTimeout`); listens for `{type:'summary', text}` from the extension and updates the summary line. No mode handlers — just the input + summary.

### Existing files modified
- `packages/vscode/src/views/backlog.ts`
  - Constructor: take `SearchState`, subscribe to `onDidChange` → `this.changeEmitter.fire()`.
  - `orderedSpawnable` (line 123-132): wrap result in `.filter(item => searchState.matches([item.id, item.title, item.area, formatAreaForDisplay(item.area), ...item.labels, ...(item.assignees ?? []), item.author]))` before returning.
  - `rootChildren` / `rowsForGroup`: when filter is active, hide groups with zero matching children, and set the view's `.message` banner when *both* groups end up empty (handler lives in extension.ts since `.message` is on the TreeView, not the provider).
  - Add a public `getCounts(): {total, shown}` so the search webview can render the summary line.

- `packages/vscode/src/views/builders.ts`
  - Same pattern: take `SearchState`, filter at `orderForDisplay` boundary, hide empty groups, expose `getCounts()`.
  - Filter scope: `[b.issueId, b.issueTitle, b.area, formatAreaForDisplay(b.area), ...b.labels, b.spawnedByArchitect]` (undefined-tolerant).

- `packages/vscode/src/extension.ts`
  - Construct `SearchState()` early (no Memento — query is transient).
  - Pass it into `BacklogProvider` and `BuildersProvider` constructors.
  - Construct `CodevSearchViewProvider(searchState, () => backlogProvider.getCounts(), () => buildersProvider.getCounts())`.
  - Register: `vscode.window.registerWebviewViewProvider('codev.search', searchViewProvider, { webviewOptions: { retainContextWhenHidden: true } })`.
  - Update `updateListViewTitles()` to suffix counts with `(N of M)` when a filter is active.
  - On `backlogProvider`/`buildersProvider` data change: set `backlogView.message` / `buildersView.message` to the "No matches" banner when zero rows match and a filter is active; clear it otherwise.
  - Register `codev.toggleSearchView` command: flips `codev.searchVisible` context key + persists in `workspaceState['codev.searchVisible']`. If hiding while a filter is active, also calls `searchState.clear()` (decision 6).
  - On activation: read `workspaceState['codev.searchVisible']` (default true) and seed the context key.

- `packages/vscode/package.json`
  - Add `{ "id": "codev.search", "name": "Search", "type": "webview", "when": "codev.searchVisible" }` to `contributes.views.codev` as the **first** entry so it sits at the top of the container.
  - Add `codev.toggleSearchView` command with `$(search)` icon, title "Codev: Toggle Search".
  - Add `view/title` menu entries: on `codev.backlog` and `codev.builders` views, `navigation` group, the `codev.toggleSearchView` command.
  - No new dependencies.

### New tests (unit, `src/__tests__/`)
- `search-state.test.ts` (~30 LOC) — pure unit tests for `SearchState.matches()`:
  - empty / whitespace query → true (matches everything)
  - case-insensitive substring across fields
  - undefined fields don't crash
  - `setQuery` fires `onDidChange` only when the value actually changed (no spurious refresh fires)

- `search-view-html.test.ts` (~30 LOC) — sentinel tests against the HTML string:
  - contains CSP meta with `nonce-<n>` substituted
  - uses `--vscode-input-background`, `--vscode-input-foreground`, `--vscode-input-border`
  - debounce constant present (150ms)
  - message-type handlers for `query` and `summary` present
  - no `<button>` elements (sanity guard that the mode toggles haven't been silently re-added)

- `backlog-search.test.ts` (~40 LOC) — feed a `BacklogProvider` with mocked overview data + a `SearchState`, assert `getChildren()` output changes when `state.setQuery('...')` is called. Hide-empty-groups behaviour verified here. Includes a case proving `labels[]` matches work (e.g. type "area/vscode" → matches only issues with that label).

- `builders-search.test.ts` (~40 LOC) — same pattern for `BuildersProvider`.

Total estimated diff: ~180 production LOC (down from ~290 in the modes-on draft) + ~140 test LOC + ~25 LOC of wire-format changes across `packages/types` and `packages/codev`.

## Risks & Alternatives Considered

### Risks

1. **CSP failures silently kill the webview.** If the CSP is too tight (missing the nonce or wrong directive), the inline script doesn't run and the textbox does nothing. Mitigation: the `search-view-html.test.ts` sentinel asserts the CSP shape; at the dev-approval gate the human types into the box and confirms filtering happens.

2. **Conditional view rendering may flicker on toggle.** When `when: "codev.searchVisible"` flips, VSCode re-renders the container — adding/removing the view. Expect a brief reflow of Backlog/Builders. Acceptable; same mechanism the existing `codev.team` view uses (`when: "codev.teamEnabled"`).

3. **Hide-empty-groups changes Backlog/Builders behaviour even when no filter is active** — but guarded by `if (searchState.query.trim() === '') { render groups today's way }`, so only the filtered branch hides empties.

4. **Wire format change ripples to dashboard.** `packages/dashboard` consumes `OverviewBacklogItem` / `OverviewBuilder` too. Adding an optional-with-default field is backward-compatible (new field is just unused in the dashboard until/unless it adopts label search) — but I'll spot-check the dashboard imports to confirm no TypeScript compilation breakage.

5. **`retainContextWhenHidden` costs memory.** Single text input = negligible.

### Alternatives considered

- **Native VSCode TreeView filter (Cmd+F):** the issue rules this out — the built-in filter can only see visible label text, not `area`, `assignees`, `labels`, or `spawnedByArchitect`.

- **Per-view filter (separate inputs in Backlog and Builders title bars):** rejected per design decision 1.

- **Use the Comments-view-style header (no webview, just text in the view title):** VSCode title bar accepts buttons but not inputs.

- **Webview-replace the TreeViews:** loses every TreeView freebie (context menus, expansion persistence, keyboard nav, accessibility). Explicitly out of scope per the issue.

- **`WebviewView.show(true)` + focus-shift workaround for the toggle (earlier draft):** replaced by `when:` clause + context key, which is cleaner and uses VSCode's intended mechanism for conditional view contribution.

## Test Plan

### Unit tests (run during `implement` phase via `pnpm test:unit`)
- All four new test files pass.
- Existing tests still pass.

### Build & lint
- `pnpm --filter @cluesmith/codev-vscode package` (esbuild bundle clean).
- `pnpm check-types` clean (covers the new `labels: string[]` field threading through `packages/types` → `packages/codev` → `packages/vscode` and any dashboard consumers).
- `pnpm lint` clean.

### Manual testing at the `dev-approval` gate

The reviewer spins up the worktree (`afx dev pir-891` or VSCode → Run Dev Server on this builder) and exercises the following from a VSCode window connected to the rebuilt extension:

**Search view rendering**
- Search view is the first entry in the Codev sidebar, above Backlog.
- Input renders with VSCode-native styling (matches the find input in the editor visually).
- Placeholder reads `"Search backlog and builders..."`.
- No mode-toggle buttons visible.

**Filter behaviour**
- Typing "terminal" filters both views in ~150ms.
- Backlog and Builders title bars show `(N of M)` suffix when a filter is active.
- Search webview's summary line reads e.g. `"4 of 32 backlog · 1 of 5 builders"`.
- Clearing the input restores full content; suffix and summary clear.
- Empty-state: type "asdfasdf" → both views show `"No matches in <View>. Clear filter to see all items."` banner; group headers hidden.
- Searching `area/vscode` (a label) matches issues with that label. Searching `vscode` (raw area) matches the same set. Searching `Vscode` (formatted area) matches too.
- Searching an assignee login (e.g. `amrmelsayed`) filters backlog to that assignee's issues only.
- Searching an architect name (e.g. `main`) filters builders to that architect's builders only.

**Title-bar 🔍 toggle**
- Click 🔍 on Backlog title bar: search view disappears from the sidebar entirely, current filter is cleared.
- Click again: search view reappears at the top.
- Same behaviour from Builders title bar.
- Reload VSCode: visibility state is preserved (was off → still off; was on → still on).

**Persistence**
- Type "foo" in input, reload window → input is empty (query NOT persisted, decision 3).
- Hide search view, reload window → still hidden (visibility IS persisted, decision 10).

**No regression**
- With empty filter: Backlog renders identically to main (same groups, same row order, same icons).
- With empty filter: Builders renders identically (auto-collapse accordion still works, file tree still expands).
- Right-click context menus on backlog/builder rows still appear and work.
- Spawn Builder from a backlog row (right-click → Spawn) still works.

### Cross-platform
- Desktop VSCode only. The extension's CI runs on Linux; webview rendering is mostly platform-uniform. No iOS/Android concerns.

### Out-of-band verification (post-merge, not required for `pr` gate)
- Try the extension in a workspace with `area/*` labels used vs not used (the latter falls into the flatten branch) — both should behave identically with empty filter.
