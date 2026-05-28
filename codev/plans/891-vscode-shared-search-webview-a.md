# PIR Plan: VSCode shared search webview above Backlog and Builders

## Understanding

Issue #891 asks for an embedded text input in the Codev sidebar that filters the Backlog and Builders TreeViews in real-time. The TreeView API has no native text-input primitive (verified against `vscode.d.ts` post-1.105 and upstream tracking issue `microsoft/vscode#161753`), so the input must live in a webview. The minimum-impact shape is a thin webview view above the existing TreeViews — the TreeViews stay TreeViews and just consume a shared `SearchState`.

The issue body already enumerates the seven design decisions and proposes recommended answers. The plan-approval gate exists to lock those in. This plan accepts each recommendation except where there is a concrete reason to deviate (one place — see "Match scope adjustment" below), and pins the implementation shape concretely enough that the reviewer can spot disagreements before any code is written.

## Proposed Change

Add a webview view `codev.search` at the top of the existing `codev` sidebar container, render an `<input>` plus three mode toggles (Aa / ab / .*), and post filter events to the extension host. A new `SearchState` singleton holds `{query, caseSensitive, wholeWord, regex}` and exposes an `onDidChange` event. Both `BacklogProvider` and `BuildersProvider` subscribe to it, fire their `onDidChangeTreeData` on change, and apply a `matches(query, item)` predicate in their existing `orderedSpawnable` / `orderForDisplay` pipelines.

This deliberately keeps the existing TreeViews intact:
- `getChildren` continues to walk groups → rows; we just intersect the row list with the filter predicate
- Group rows are only rendered if at least one of their children matches (otherwise the empty-group row would be a stutter)
- The single-`Uncategorized` flatten branch keeps its current shape
- Accordion, file-tree expansion, context menus, area-group expansion persistence — none of it is touched

### Design decisions (locked here for plan-approval review)

The issue lists seven decisions with recommendations. I'm taking these positions:

| # | Decision | Position | Rationale |
|---|----------|----------|-----------|
| 1 | Shared filter across both views vs per-view | **Shared** (as recommended) | One input → one mental model. Scope selector adds chrome for a use case that doesn't exist yet. |
| 2 | Mode-toggle defaults | **All off** (as recommended) | Matches VSCode Search panel. |
| 3 | Query persistence | **Transient — cleared on workspace reload** (as recommended) | Persisted-empty-backlog is a classic footgun. |
| 4 | Match scope per-view | **Adjusted** — see below | The issue's "title + areas + labels + assignees" wording assumes a labels list that the overview types don't actually expose today. |
| 5 | Empty-state UX | **TreeView `.message`** banner reading `"No matches in <View>. Clear filter to see all items."` plus title suffix `(0 matches of N)`. No "Clear filter" inline link — `.message` doesn't support buttons; the toggle 🔍 in the title bar already clears the filter via decision 6 below. | As recommended; clarified to fit the `.message` API constraint. |
| 6 | Sticky filter when search view is collapsed via 🔍 toggle | **Clear filter** on collapse (as recommended) | Hidden filter = confused empty trees. |
| 7 | Theme matching via `--vscode-input-*` CSS variables | **Yes, plus CSP + nonce + `<base>` setup as a reusable shape** | This is the first webview in the extension; later webviews (#807, #861, #862, #863) will copy this scaffold. |

**Match scope adjustment (decision 4):** the issue's wording lists "title + issue number + `area/*` labels + label list + assignees". The actual `OverviewBacklogItem` type (`packages/types/src/api.ts:208-230`) exposes `id, title, area, assignees, author` — there is no separate `labels: string[]` field, only the single resolved `area`. `OverviewBuilder` has `id, issueId, issueTitle, area, spawnedByArchitect` and no assignees at all. So the filter scope I'll implement is:

- **Backlog rows:** `id` (issue number) + `title` + `area` (raw + `formatAreaForDisplay(area)`) + `assignees[]` + `author`
- **Builder rows:** `issueId` + `issueTitle` + `area` (raw + formatted) + `spawnedByArchitect` (architect attribution doubles as a useful filter for multi-architect workspaces — search "ob-refine" to see only that architect's builders)

**Raw + formatted area:** since #885 merged, group labels are rendered via `formatAreaForDisplay` ("vscode" → "Vscode", "agent-farm" → "Agent Farm") while the raw lowercase value is kept for matchers. The filter searches against *both* so an Aa-ON search for "Vscode" (what the user sees) still matches raw "vscode" (what the data is). Without this, the case-sensitive path silently misses what the user typed.

**No `area/` prefix.** Users type "vscode", not "area/vscode" — the raw `area` field has the prefix stripped on the server (see `parseArea`). Typing "area/vscode" yields zero matches and an empty-state banner; we don't need explicit handling.

If the reviewer wants the literal labels list (the issue's "label list" phrase), that requires adding `labels: string[]` to `OverviewBacklogItem` and threading it through `OverviewData` collection in `packages/core` / `packages/codev` — a small but separate change. I'll do that *inside this PR if approved at the plan-approval gate*, but won't do it as a default since it touches three packages and isn't strictly required for the use cases described.

### Match algorithm

```
function matches(query: string, modes: {aa, ab, re}, fields: string[]): boolean
  if !query.trim(): return true
  for each field in fields:
    haystack = modes.aa ? field : field.toLowerCase()
    needle   = modes.aa ? query : query.toLowerCase()
    if modes.re: return regex(needle, modes.aa ? '' : 'i').test(field)
    if modes.ab: return wholeWordRegex(needle).test(haystack)
    return haystack.includes(needle)
```

Regex-compile errors → silently treat as "no matches" + show `"Invalid regex"` in the summary line (no toast — typing-in-progress would spam). Last-good regex isn't cached; user fixes the input.

## Files to Change

### New files (production)
- `packages/vscode/src/views/search-state.ts` (~60 LOC) — `SearchState` class.
  - State: `query: string`, `caseSensitive/wholeWord/regex: boolean`.
  - Reads mode toggles from `workspaceState` key `codev.searchModes` on construction.
  - `update(partial)` — merges, persists mode flags (not query), fires `onDidChange`.
  - `clear()` — resets query (used by the 🔍-collapse path).
  - `matches(fields: string[]): boolean` — the algorithm above. Pure function for unit testing.
  - `summary(): string` — returns `"Invalid regex"` if regex mode and input doesn't compile, `""` otherwise.

- `packages/vscode/src/views/search-view.ts` (~150 LOC) — `CodevSearchViewProvider implements vscode.WebviewViewProvider`.
  - `resolveWebviewView`: sets `webview.options = { enableScripts: true }`, computes the HTML once (cached on first call), wires `onDidReceiveMessage`.
  - `onDidReceiveMessage` handles `{type:'query', value}`, `{type:'mode', mode, on}`, `{type:'ready'}` (initial state push).
  - Listens to `SearchState.onDidChange` to push `{type:'summary', text, counts}` back into the webview (counts come from the providers — see wiring below).
  - Exposes `setVisible(v: boolean)` so the toggle command can collapse/expand programmatically via `view.show(true)` / via a `setContext` key the webview itself reads.

- `packages/vscode/src/views/search-view-html.ts` (~80 LOC) — pure function `renderSearchHtml(webview, nonce): string` returning the full HTML doc with CSP, theme-variable CSS, and the inline script. Separate file so it's unit-testable without touching VSCode (assert: CSP present, nonce-substituted, `--vscode-input-*` variables used, expected message-type handlers).
  - CSP: `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-<n>';`
  - Inline `<script nonce="...">` posts `{type:'query'}` on `input` (debounced 150ms via `setTimeout`/`clearTimeout`), `{type:'mode'}` on toggle clicks, listens for `{type:'summary', text, counts}` from the extension and updates the summary line.

### Existing files modified
- `packages/vscode/src/views/backlog.ts`
  - Constructor: take `SearchState`, subscribe to `onDidChange` → `this.changeEmitter.fire()`.
  - `orderedSpawnable` (line 123-132): wrap result in `.filter(item => searchState.matches([item.id, item.title, item.area, ...item.assignees ?? [], item.author ?? '']))` before returning.
  - `rootChildren` / `rowsForGroup`: hide groups with zero matching children when a filter is active. (Today's behaviour: render all groups regardless — there's no notion of "empty group".)
  - Add a new public `getCounts(): {total, shown}` for the search webview's summary line.

- `packages/vscode/src/views/builders.ts`
  - Same pattern: take `SearchState`, filter at `orderForDisplay` boundary, hide empty groups, expose `getCounts()`.
  - Filter scope: `[b.issueId ?? '', b.issueTitle ?? '', b.area, b.spawnedByArchitect ?? '']`.

- `packages/vscode/src/extension.ts`
  - Construct `SearchState(context.workspaceState)` early (alongside `OverviewCache`).
  - Pass it into `BacklogProvider` and `BuildersProvider` constructors.
  - Construct `CodevSearchViewProvider(searchState, backlogProvider.getCounts, buildersProvider.getCounts)`.
  - Register: `vscode.window.registerWebviewViewProvider('codev.search', searchViewProvider, { webviewOptions: { retainContextWhenHidden: true } })`. `retainContextWhenHidden` because losing the typed query when the user clicks away and back is jarring (cheap — single text input + 3 toggles).
  - Update `updateListViewTitles()` to suffix counts with `(N matches of M)` when a filter is active.
  - Wire onDidChangeVisibility on the search view: when it becomes hidden via user collapse, call `searchState.clear()` (decision 6).
  - Register `codev.toggleSearchView` command that calls `vscode.commands.executeCommand('codev.search.focus')` to expand+focus the webview, or collapses it via the same focus toggle if already focused. (VSCode's TreeView `.show(true)` reveals; collapse is via setting an internal context key tied to visibility — see "Risks" below.)

- `packages/vscode/package.json`
  - Add `{ "id": "codev.search", "name": "Search", "type": "webview" }` to `contributes.views.codev` as the **first** entry so it sits at the top of the container.
  - Add `codev.toggleSearchView` command with `$(search)` icon.
  - Add `view/title` menu entries: on `codev.backlog` and `codev.builders` views, `navigation` group, the `codev.toggleSearchView` command.
  - No new dependencies.

### New tests (unit, `src/__tests__/`)
- `search-state.test.ts` (~70 LOC) — pure unit tests for `SearchState.matches()`:
  - empty query → true
  - case-insensitive substring (default)
  - case-sensitive when `caseSensitive` on
  - whole-word boundary
  - regex compile failure → false + summary text
  - mode persistence: construct with mocked Memento, mutate, assert Memento was written
  - query NOT persisted: assert Memento writes never include `query`

- `search-view-html.test.ts` (~40 LOC) — sentinel tests against the HTML string:
  - contains CSP meta with `nonce-<n>` substitution
  - uses `--vscode-input-background`, `--vscode-input-foreground`, `--vscode-input-border`
  - debounce constant present (150ms)
  - message-type handlers for `query`, `mode`, `summary` present

- `backlog-search.test.ts` (~50 LOC) — feed a `BacklogProvider` with mocked overview data + a `SearchState`, assert `getChildren()` output changes when `state.update({query: '...'})` is called. Hide-empty-groups behaviour verified here.

- `builders-search.test.ts` (~50 LOC) — same pattern for `BuildersProvider`.

Total estimated diff: ~290 production LOC + ~210 test LOC. The issue's estimate (~150 + 50) is on the low side; the gap is the webview HTML scaffold (`search-view-html.ts`) and the per-provider hide-empty-groups handling, both of which fall out naturally from doing this right the first time.

## Risks & Alternatives Considered

### Risks

1. **VSCode webview "collapse" is not a public API.** `WebviewView` has `.show(preserveFocus)` which expands and focuses, but no symmetric `.hide()`. The "collapse" half of the 🔍 toggle relies on VSCode's built-in container-level "collapse all" or per-view header-click. Practical workaround: the 🔍 button toggles between two states by tracking visibility via `webviewView.onDidChangeVisibility`, and when "collapsed" is requested the command focuses a different view (the Backlog) instead — VSCode collapses the previously-visible webview as a side effect, which is the same UX as a manual click. If this proves janky in the worktree, fallback is: keep only one direction (the icon expands the search view when collapsed, but you collapse it the normal way via the chevron). The 🔍 icon then just becomes "show search". The dev-approval gate is the right place to settle this — easier to feel out in the running extension than to argue about in prose.

2. **CSP failures silently kill the webview.** If the CSP is too tight (missing the nonce or wrong directive), the inline script doesn't run and the textbox does nothing. Mitigation: the `search-view-html.test.ts` sentinel asserts the CSP shape, and at the dev-approval gate the human can type into the box and confirm filtering works.

3. **`retainContextWhenHidden` costs memory.** Single text input + three toggle buttons = negligible. Accepting this.

4. **Filter scope doesn't include the "label list".** Per "Match scope adjustment" above, this is intentional and surfaced at plan-approval. If reviewer wants the label list included, it's an in-PR addendum (extend `OverviewBacklogItem`); if not, the plan ships as-is.

5. **Hide-empty-groups changes Backlog/Builders behaviour even when no filter is active.** Mitigation: the predicate is `if (searchState.query.trim() === '') { render groups today's way }` — only the filtered branch hides empties.

### Alternatives considered

- **Native VSCode TreeView filter (Cmd+F):** the issue rules this out — the built-in filter can only see visible label text, not `area`, `assignees`, or `spawnedByArchitect`. Confirmed.

- **Per-view filter (separate inputs in Backlog and Builders title bars):** rejected per design decision 1.

- **Use the Comments-view-style header (no webview, just text in the view title):** VSCode title bar accepts buttons but not inputs. Same fundamental constraint as the TreeView limitation.

- **Webview-replace the TreeViews:** maximally flexible but loses every TreeView freebie (context menus, expansion persistence, keyboard nav, accessibility, theme integration). Explicitly out of scope per the issue.

## Test Plan

### Unit tests (run during `implement` phase via `pnpm test:unit`)
- All four new test files (above) pass.
- Existing tests still pass — particularly `extension-architect-commands.test.ts` if it sentinel-matches `extension.ts` line shapes that this PR touches.

### Build (`pnpm --filter codev-vscode package`)
- esbuild bundles the webview HTML helper successfully.
- `pnpm check-types` clean (no `any`, no missing imports).
- `pnpm lint` clean.

### Manual testing at the `dev-approval` gate

The reviewer should spin up the worktree with `afx dev pir-891` (or VSCode → Run Dev Server on this builder), then exercise the following from a VSCode window connected to the worktree-rebuilt extension:

**Search view rendering**
- Search view is the first entry in the Codev sidebar, above Backlog.
- Input renders with VSCode-native styling (matches the find input in the editor visually).
- Three toggle buttons render with `$(case-sensitive)` / `$(whole-word)` / `$(regex)` codicon equivalents.
- Placeholder reads `"Search backlog and builders..."`.

**Filter behaviour**
- Typing "terminal" filters both views in ~150ms.
- Backlog and Builders title bars show `(N matches of M)` suffix when a filter is active.
- Clearing the input restores full content; suffix removes.
- Empty-state: type "asdfasdf" → both views show `"No matches in Backlog. Clear filter to see all items."` banner; group headers hidden.

**Mode toggles**
- Aa: type "Terminal" with toggle off → matches "terminal cleanup"; toggle on → no match.
- ab: type "term" with toggle off → matches "terminal"; toggle on → no match (whole word).
- .*: type "term.*cleanup" with toggle on → matches "terminal cleanup regression".
- Invalid regex (`[`): summary shows `"Invalid regex"`, no toast spam while typing.

**Persistence**
- Toggle Aa on, reload VSCode window → Aa is still on (mode persisted).
- Type "foo" in input, reload window → input is empty (query NOT persisted).

**Title-bar 🔍 toggle**
- Click 🔍 on Backlog title bar: search view collapses, current filter is cleared.
- Click again: search view re-expands and focuses the input.
- Same behaviour from Builders title bar.

**No regression**
- With empty filter: Backlog renders identically to main (same groups, same row order, same icons).
- With empty filter: Builders renders identically (auto-collapse accordion still works, file tree still expands).
- Right-click context menus on backlog/builder rows still appear and work.
- Spawn Builder from a backlog row (right-click → Spawn) still works.

### Cross-platform
- macOS only at v1 — the extension's tests already run on Linux CI but webview rendering is mostly the same across platforms. No iOS/Android concerns; this is a desktop extension.

### Out-of-band verification (post-merge, not required for `pr` gate)
- Try the extension in a workspace with `area/*` labels used vs not used (the latter falls into the flatten branch) — both should behave identically with empty filter.
