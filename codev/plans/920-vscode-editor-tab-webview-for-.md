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

The acceptance criteria require substring search over **title AND body**. So body must be sourced through Tower (the extension never shells out to `gh` directly — it only talks to Tower's HTTP API). This is the central decision for the `plan-approval` gate — see **Design Decision 1**.

Everything else (table, dropdowns, sort, footer, singleton panel, theming) is local to a new vscode webview and well-supported by existing patterns (`view-issue.ts` for lifecycle/refresh; `backlog-filter.ts` for vitest-tested pure helpers; existing `view/title` menu wiring for the icon).

## Design Decisions (resolve at the gate)

### Decision 1 — Where does `body` come from? **(the big one)**

**Recommended — Option A: add an optional, server-truncated `body` to the existing shared backlog pipeline.**

- `issue-list` concept adds `body` to its `--json` fields (GitHub first; other forges optional — field stays `body?`).
- `IssueListItem.body?: string`, `OverviewBacklogItem.body?: string`.
- `deriveBacklog` copies `issue.body`, **truncated server-side to ~2000 chars** (substring search needs a prefix, not the whole essay — bounds payload growth).
- The overview server **already fetches the issue list once and caches it** (`fetchIssuesCached`, 30 s TTL), so this adds **zero new round-trips and zero new caches**. The sidebar tree ignores the new field; the panel filters cached data client-of-Tower-side with instant response.

Trade-off: `/api/overview` payload grows by up to ~2 KB × ≤200 issues (~400 KB worst case) and the web dashboard receives body it doesn't use. Truncation caps it; localhost transport makes it acceptable.

**Alternative — Option B: dedicated `GET /api/backlog-search` endpoint + `TowerClient` method**, returning the same open-backlog set enriched with body, fetched by the panel only while it's open (throttled off `OverviewCache.onDidChange` like `view-issue.ts`). Keeps `/api/overview` lean for the web dashboard at the cost of a second issue fetch and new route/client/core surface.

**Recommendation: Option A + truncation.** It is the most literal reading of the issue's "v1 keeps the data source the same as the sidebar tree," reuses the existing cache, and is the smallest moving-parts change. I'll implement A unless the gate prefers B's payload isolation.

### Decision 2 — Status dropdown vs. out-of-scope "open only"

The acceptance list names a `Status: Open / Closed / All` dropdown in the query row, but **"search across closed issues … is out of scope"** for v1. These conflict. **Recommendation:** render the Status dropdown for layout fidelity but **fix it to `Open` (disabled, tooltip "v1: open backlog only")** so the extension point is visible without shipping a non-functional Closed/All. Alternative: omit the dropdown entirely in v1. Gate decides.

### Decision 3 — Command name (collision with #918)

#918 (Quick Pick) has no code yet; `codev.searchBacklog` is unclaimed but is the natural name for the muscle-memory fast path. **Recommendation:** name this panel's command **`codev.openBacklogSearch`** (title "Codev: Search Backlog") and leave `codev.searchBacklog` for #918. Gate confirms.

### Decision 4 — Age column format

**Recommendation:** compact relative age derived from `createdAt` — `3d`, `2w`, `5mo`, `1y` (no "ago" suffix in a dense table; full ISO date in the cell tooltip). Sort on the underlying timestamp, not the formatted string.

### Decision 5 — Free-text semantics & a Comments column

- **Recommendation:** text query = pure case-insensitive substring over `title + body`. Scopes (Area/Assignee/Author) AND together and AND with the text query. Typing `area/vscode` in the text box matches it as a **substring** (in title/body) — it does **not** secretly drive the Area dropdown (keeps semantics one obvious thing; use the dropdown to filter by area). No fuzzy matching (that's Quick Pick's job).
- **No Comments-count column** in v1 — the backlog data carries no comment count and adding one widens the data change for marginal value. Columns: `#`, `Title`, `Area`, `Assignee`, `Age`.

## Proposed Change

### Architecture

1. **Body into the data pipeline** (per Decision 1, Option A). Optional field, GitHub-populated, server-truncated.
2. **Filtering runs host-side in pure, vitest-tested helpers** in `backlog-filter.ts` — matches the issue's stated test plan. The webview is a thin view: it renders controls + table, **debounces (~150 ms) and posts the current criteria** to the extension host, and renders the rows the host posts back. Body never ships wholesale to the webview — only matched result rows cross the boundary.
3. **Singleton `WebviewPanel`** owned by a `BacklogSearchPanel` class. `createOrShow` focuses the existing panel if open, else creates one in `ViewColumn.Beside` with `enableScripts` + a strict CSP (nonce'd inline script, `localResourceRoots` scoped). HTML/CSS/JS **inlined as a template string** (no runtime file read → no esbuild copy-asset step). CSS variables only (`--vscode-*`).
4. **Message protocol** (typed): webview→host `{type:'search', criteria}` and `{type:'open', id}`; host→webview `{type:'results', rows, footer}`. `open` runs `vscode.commands.executeCommand('codev.viewBacklogIssue', id)` — identical to a sidebar row click.
5. **Live data:** the panel subscribes to `OverviewCache.onDidChange` and re-runs the current criteria so results stay fresh while open; disposes the subscription with the panel.

### Empty-state / cap behavior

Empty query + scopes → all in-scope matches. Empty query + empty scopes → everything, **capped at 200** with a "Load more" affordance (the underlying issue-list is already `--limit 200`, so this is effectively the whole open backlog; the cap + footer note keep the contract explicit if the limit ever rises).

## Files to Change

**Data pipeline (only if Decision 1 = Option A):**
- `packages/codev/scripts/forge/github/issue-list.sh` — add `body` to `--json` fields.
- `packages/codev/src/lib/forge-contracts.ts:32` — `IssueListItem.body?: string`.
- `packages/types/src/api.ts:210` — `OverviewBacklogItem.body?: string` (+ doc comment).
- `packages/codev/src/agent-farm/servers/overview.ts:800` — `deriveBacklog` copies truncated `issue.body`.

**VSCode panel (new):**
- `packages/vscode/src/webviews/backlog-search-panel.ts` — `BacklogSearchPanel` (singleton lifecycle, CSP/nonce HTML, message routing, `OverviewCache` subscription).
- `packages/vscode/src/webviews/backlog-search.html.ts` *(or inlined in the panel)* — HTML/CSS/JS template, CSS-variables-only.

**VSCode wiring:**
- `packages/vscode/src/views/backlog-filter.ts` — add `searchBacklog(items, criteria)` + `formatAge(createdAt)` pure helpers (multi-dimension: text/area/assignee/author + sort), alongside existing `filterMine`.
- `packages/vscode/src/extension.ts` — register `codev.openBacklogSearch`; pass `OverviewCache` + `ConnectionManager` to the panel.
- `packages/vscode/package.json` — declare `codev.openBacklogSearch` (icon `$(search)`), add a `view/title` entry `when: view == codev.backlog` (group `navigation` alongside the eye/refresh icons).

**Tests:**
- `packages/vscode/src/test/` (or existing `backlog.test.ts` sibling) — vitest unit tests for `searchBacklog` (each scope, AND-composition, substring case-insensitivity, body match, sort directions, empty-query passthrough, 200 cap) and `formatAge`.

**Alternative-only (if Decision 1 = Option B):** `packages/codev/src/agent-farm/servers/tower-routes.ts` (+`overview.ts` handler) new `GET /api/backlog-search`; `packages/core/src/tower-client.ts` new method; new core type — *instead of* the four pipeline edits above.

## Risks & Alternatives Considered

- **Risk — scope creep beyond `area/vscode`.** Body-in-pipeline (Option A) touches core types + the forge concept + Tower server, not just vscode. Mitigation: optional field, GitHub-only population, server truncation; no behavior change for any existing consumer. If the gate wants to keep the change strictly vscode-local, Option B confines server work to one additive endpoint — still not vscode-only, but isolated from `/api/overview`. There is **no** fully vscode-local way to get body (the extension can't shell to `gh`).
- **Risk — overview payload bloat (Option A).** Mitigated by ~2000-char server-side truncation; revisit only if profiling shows it matters.
- **Risk — first webview in the extension → CSP/theming pitfalls.** Mitigation: strict nonce'd CSP, `localResourceRoots`, CSS variables only; manually verified across dark/light/high-contrast at the `dev-approval` gate (PR diff can't catch theme regressions — the core PIR justification).
- **Risk — `#918` command-name race.** Mitigated by Decision 3 (`codev.openBacklogSearch`).
- **Alternative rejected — webview-side filtering in JS.** Instant typing without round-trips, but duplicates/untestable logic and would need full body shipped into the webview. Host-side pure helpers (the issue's own skeleton) are testable and keep body host-side; debounce makes the round-trip imperceptible on localhost.
- **Alternative rejected — per-issue `/api/issue` body fetch for search.** 200 round-trips per query; non-starter for live search.

## Test Plan

**Unit (vitest, `pnpm --filter @cluesmith/codev build` + test):**
- `searchBacklog`: text substring (title-only, body-only, both; case-insensitive); each scope dropdown; scopes AND-composed; empty-query + scopes; empty-query + empty-scopes returns all up to cap; sort asc/desc per column (esp. Age by timestamp).
- `formatAge`: day/week/month/year thresholds; just-created.

**Manual at `dev-approval` (running worktree — reviewer exercises these):**
1. Search icon visible in Backlog title bar; click opens a **`Search Backlog`** tab to the side of the active editor.
2. Tab shows the three scope dropdowns, the query row, the sortable results table, and the match-count footer.
3. Typing filters live (~150 ms debounce); Search button also submits. Column-header clicks sort with an arrow indicator on the active column.
4. Empty query + a scope → scoped matches; empty query + no scope → all (≤200, Load-more present if applicable).
5. Click a result row → the issue opens via `codev.viewBacklogIssue` (same as a sidebar click).
6. Re-invoke the command while open → focuses the existing panel (no duplicate tab).
7. **Theme sweep:** dark, light, high-contrast all render cleanly — no hand-coded colors.
8. **No regression:** sidebar tree, mine/all toggle (#809), area grouping (#811) all still behave; Quick Pick (#918) unaffected.

**Cross-platform:** N/A (desktop VSCode extension only).
