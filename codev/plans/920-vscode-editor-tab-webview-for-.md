# PIR Plan: VSCode editor-tab webview for rich backlog search

> Issue #920 · area/vscode · supersedes #906 · complements #918 (Quick Pick) and the shipped sidebar tree (#809 + #811).

## Understanding

The Backlog sidebar tree answers "what's on my plate" but offers no real search. #918 adds a fast single-pick Quick Pick. This issue adds the **deep-dive** surface: a persistent `WebviewPanel` (full editor tab, opened from a search icon in the Backlog view's title bar) for exploratory triage — scan, filter (Area / Assignee / Author), free-text search across **title + body**, sort by columns, refine without re-opening, with a match-count footer. Single instance, theme-aware via CSS variables only, row-click opens the issue via the existing `codev.viewBacklogIssue`.

### The one architectural fact that drives the plan

**The backlog data pipeline carries no issue body today.** The chain is:

- `issue-list` forge concept — `gh issue list --json number,title,url,labels,createdAt,author,assignees` (`packages/codev/scripts/forge/github/issue-list.sh`) — **no `body`**
- → `IssueListItem` (`packages/codev/src/lib/forge-contracts.ts:32`) — no `body`
- → `deriveBacklog` (`packages/codev/src/agent-farm/servers/overview.ts:800`) → `BacklogItem` → `OverviewBacklogItem` (`packages/types/src/api.ts:210`) — no `body`
- → `/api/overview` → `TowerClient.getOverview` → `OverviewCache` (vscode) — no `body`

The acceptance criteria require substring search over **title AND body**. So body must be sourced through Tower (the extension never shells out to `gh` directly — it only talks to Tower's HTTP API). **Resolved (Decision 1): a dedicated `GET /api/backlog-search` endpoint supplies body on a fresh fetch, leaving `/api/overview` untouched.**

Everything else (table, dropdowns, sort, footer, singleton panel, theming) is local to a new vscode webview and well-supported by existing patterns (`view-issue.ts` for lifecycle/refresh; `backlog-filter.ts` for vitest-tested pure helpers; existing `view/title` menu wiring for the icon).

## Design Decisions

### Decision 1 — Where does `body` come from? **(DECIDED: Option B — dedicated search API)**

A **dedicated `GET /api/backlog-search` Tower endpoint** supplies the searchable dataset. It does a **fresh fetch each time it's hit** (no 30 s overview cache reuse) and returns the open backlog **with full, un-truncated `body`**. `/api/overview` and `OverviewBacklogItem` are left **completely unchanged** — the web dashboard and sidebar tree see no payload growth, and there are no Option-A truncation/cache hacks.

Concretely:
- `issue-list` forge concept gains `body` in its `--json` fields (`packages/codev/scripts/forge/github/issue-list.sh`); `IssueListItem.body?: string` (`forge-contracts.ts`). Optional field — GitHub-populated; other forges degrade to title-only.
- The new endpoint runs its **own** issue fetch (bypassing the shared 30 s `issueCache`, so it's always fresh) and projects the open backlog via the existing `deriveBacklog` logic plus `body`.
- A new response type (`BacklogSearchItem` = the searchable record incl. `body`) + `TowerClient.searchBacklog(...)` method. **`OverviewBacklogItem` does NOT gain `body`** — body lives only on the search path.

**Filtering runs host-side, not per-keystroke server-side.** The endpoint is hit **once when the panel opens** (and on manual refresh / `OverviewCache.onDidChange`), returning the in-scope dataset (with body); the actual substring + scope + sort filtering happens in the extension host via pure vitest-tested helpers, so live typing is instant with no network per keystroke. (A fresh `gh` fetch on every debounced keystroke would add ~1 s latency — unacceptable for live search.) Body crosses to the host but **never to the webview** — the host posts back only display rows (`#`, title, area, assignee, age).

### Decision 2 — Status: Open / Closed / All  **(DECIDED: functional)**

The query row carries a **functional `Status: Open / Closed / All` dropdown**, defaulting to **Open**. The `/api/backlog-search` endpoint takes a `state` param (`open` | `closed` | `all`) that maps to `gh issue list --state <state>`. Notes:
- **Open** (default) reproduces the sidebar's set: open issues with no active PR. **Closed / All** lift that PR-exclusion filter (a closed issue typically *has* a merged PR — excluding them would make Closed near-empty), so for `closed`/`all` the endpoint returns the raw issue set for that state, projected the same way (minus the `prLinkedIssues`/builder exclusions that only make sense for "available work").
- Changing Status re-hits the endpoint (it's the one criterion that changes the server-side fetch, vs. the host-side text/scope/sort filters). The other controls stay host-side and instant.

### Decision 3 — Command name (collision with #918)

#918 (Quick Pick) has no code yet; `codev.searchBacklog` is unclaimed but is the natural name for the muscle-memory fast path. **Recommendation:** name this panel's command **`codev.openBacklogSearch`** (title "Codev: Search Backlog") and leave `codev.searchBacklog` for #918. Gate confirms.

### Decision 4 — Age column format

**Recommendation:** compact relative age derived from `createdAt` — `3d`, `2w`, `5mo`, `1y` (no "ago" suffix in a dense table; full ISO date in the cell tooltip). Sort on the underlying timestamp, not the formatted string.

### Decision 5 — Free-text semantics & a Comments column

- **Recommendation:** text query = pure case-insensitive substring over `title + body`. Scopes (Area/Assignee/Author) AND together and AND with the text query. Typing `area/vscode` in the text box matches it as a **substring** (in title/body) — it does **not** secretly drive the Area dropdown (keeps semantics one obvious thing; use the dropdown to filter by area). No fuzzy matching (that's Quick Pick's job).
- **No Comments-count column** in v1 — the backlog data carries no comment count and adding one widens the data change for marginal value. Columns: `#`, `Title`, `Area`, `Assignee`, `Age`.

## Proposed Change

### Architecture

1. **Dedicated search endpoint supplies body** (per Decision 1, Option B). `GET /api/backlog-search` does its own fresh issue fetch (with `body`, bypassing the 30 s overview cache), projects the open backlog via `deriveBacklog` + `body`, returns `BacklogSearchItem[]`. `/api/overview` and `OverviewBacklogItem` are untouched. The panel calls it via `TowerClient.searchBacklog(...)`.
2. **Filtering runs host-side in pure, vitest-tested helpers** in `backlog-filter.ts` — matches the issue's stated test plan. The endpoint is hit to fetch the body-enriched dataset on panel open, on refresh / `OverviewCache.onDidChange`, **and whenever the Status dropdown changes** (`state` is the one criterion the server resolves — see Decision 2). The host then filters/sorts the fetched dataset in-memory per the text/Area/Assignee/Author/sort criteria. The webview is a thin view: it renders controls + table, **debounces (~150 ms) and posts the current criteria** to the extension host, and renders the rows the host posts back. Body never ships to the webview — only matched display rows cross the boundary.
3. **Singleton `WebviewPanel`** owned by a `BacklogSearchPanel` class. `createOrShow` focuses the existing panel if open, else creates one in `ViewColumn.Beside` with `enableScripts` + a strict CSP (nonce'd inline script, `localResourceRoots` scoped). HTML/CSS/JS **inlined as a template string** (no runtime file read → no esbuild copy-asset step). CSS variables only (`--vscode-*`).
4. **Message protocol** (typed): webview→host `{type:'search', criteria}` and `{type:'open', id}`; host→webview `{type:'results', rows, footer}`. `open` runs `vscode.commands.executeCommand('codev.viewBacklogIssue', id)` — identical to a sidebar row click.
5. **Live data:** the panel subscribes to `OverviewCache.onDidChange` and re-runs the current criteria so results stay fresh while open; disposes the subscription with the panel.

### Empty-state / cap behavior

Empty query + scopes → all in-scope matches. Empty query + empty scopes → everything, **capped at 200** with a "Load more" affordance (the underlying issue-list is already `--limit 200`, so this is effectively the whole open backlog; the cap + footer note keep the contract explicit if the limit ever rises).

## Files to Change

**Search endpoint + body source (server):**
- `packages/codev/scripts/forge/github/issue-list.sh` — add `body` to `--json` fields (optional; GitHub-populated).
- `packages/codev/src/lib/forge-contracts.ts:32` — `IssueListItem.body?: string`.
- `packages/types/src/api.ts` — new `BacklogSearchItem` (open-backlog record incl. `body`) and the `/api/backlog-search` response type. **`OverviewBacklogItem` unchanged.**
- `packages/codev/src/agent-farm/servers/overview.ts` — a body-enriched projection (reuse `deriveBacklog`; carry `body`) and a **fresh** issue fetch that bypasses the 30 s `issueCache`.
- `packages/codev/src/agent-farm/servers/tower-routes.ts:152` — register `GET /api/backlog-search` (`handleBacklogSearch`), takes `workspace` (+ `state` param iff Decision 2 = functional Status).
- `packages/core/src/tower-client.ts:314` — new `searchBacklog(workspacePath, …)` method (sibling of `getOverview`).

**VSCode panel (new):**
- `packages/vscode/src/webviews/backlog-search-panel.ts` — `BacklogSearchPanel` (singleton lifecycle, CSP/nonce HTML, message routing, fetch-on-open + `OverviewCache.onDidChange` refresh subscription).
- `packages/vscode/src/webviews/backlog-search.html.ts` *(or inlined in the panel)* — HTML/CSS/JS template, CSS-variables-only.

**VSCode wiring:**
- `packages/vscode/src/views/backlog-filter.ts` — add `searchBacklog(items, criteria)` + `formatAge(createdAt)` pure helpers (multi-dimension: text/area/assignee/author + sort), alongside existing `filterMine`.
- `packages/vscode/src/extension.ts` — register `codev.openBacklogSearch`; pass `OverviewCache` + `ConnectionManager` to the panel.
- `packages/vscode/package.json` — declare `codev.openBacklogSearch` (icon `$(search)`), add a `view/title` entry `when: view == codev.backlog` (group `navigation` alongside the eye/refresh icons).

**Tests:**
- `packages/vscode/src/test/` (or existing `backlog.test.ts` sibling) — vitest unit tests for `searchBacklog` (each scope, AND-composition, substring case-insensitivity, body match, sort directions, empty-query passthrough, 200 cap) and `formatAge`.

## Risks & Alternatives Considered

- **Risk — change spans more than `area/vscode`.** The dedicated endpoint (Option B) touches the forge concept, a core type, the Tower server, and `TowerClient` — not just vscode. This is unavoidable: the extension can't shell to `gh`, so body must come through Tower. Mitigation: all additive (a new endpoint + optional field), `/api/overview` and every existing consumer untouched, web-dashboard payload unchanged.
- **Risk — stale data while the panel is open.** The endpoint fetches fresh on open but the host filters a snapshot. Mitigation: re-fetch on `OverviewCache.onDidChange` (throttled, like `view-issue.ts`) and on the explicit Search button, so an open panel tracks backlog changes.
- **Risk — first webview in the extension → CSP/theming pitfalls.** Mitigation: strict nonce'd CSP, `localResourceRoots`, CSS variables only; manually verified across dark/light/high-contrast at the `dev-approval` gate (PR diff can't catch theme regressions — the core PIR justification).
- **Risk — `#918` command-name race.** Mitigated by Decision 3 (`codev.openBacklogSearch`).
- **Alternative rejected — Option A (body on the shared `/api/overview`).** Smaller surface but bloats the always-on overview payload for the web dashboard and forces truncation/cache compromises. Rejected in favor of isolating body on a dedicated, on-demand search path.
- **Alternative rejected — server-side filtering per keystroke.** A fresh `gh` fetch (~1 s) on every debounced keystroke makes live search unusable. The endpoint supplies the dataset once; the host filters in-memory.
- **Alternative rejected — webview-side filtering in JS.** Would need full body shipped into the webview and duplicates/untestable logic. Host-side pure helpers (the issue's own skeleton) keep body off the webview and stay vitest-testable.
- **Alternative rejected — per-issue `/api/issue` body fetch for search.** 200 round-trips per query; non-starter.

## Test Plan

**Unit (vitest, `pnpm --filter @cluesmith/codev build` + test):**
- `searchBacklog`: text substring (title-only, body-only, both; case-insensitive); each scope dropdown; scopes AND-composed; empty-query + scopes; empty-query + empty-scopes returns all up to cap; sort asc/desc per column (esp. Age by timestamp).
- `formatAge`: day/week/month/year thresholds; just-created.

**Manual at `dev-approval` (running worktree — reviewer exercises these):**
1. Search icon visible in Backlog title bar; click opens a **`Search Backlog`** tab to the side of the active editor.
2. Tab shows the three scope dropdowns, the query row, the sortable results table, and the match-count footer.
3. Typing filters live (~150 ms debounce); Search button also submits. Column-header clicks sort with an arrow indicator on the active column.
4. Empty query + a scope → scoped matches; empty query + no scope → all (≤200, Load-more present if applicable). Switching **Status** Open→Closed→All re-fetches and the result set changes accordingly.
5. Click a result row → the issue opens via `codev.viewBacklogIssue` (same as a sidebar click).
6. Re-invoke the command while open → focuses the existing panel (no duplicate tab).
7. **Theme sweep:** dark, light, high-contrast all render cleanly — no hand-coded colors.
8. **No regression:** sidebar tree, mine/all toggle (#809), area grouping (#811) all still behave; Quick Pick (#918) unaffected.

**Cross-platform:** N/A (desktop VSCode extension only).
