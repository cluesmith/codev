# PIR #911 — vscode backlog title-count

Issue: vscode Backlog tree title-count should reflect the active view mode, not the total spawnable set. Surfaced as a CMAP-2 nit on #910 / PIR #809.

## Plan phase

Wrote `codev/plans/911-vscode-backlog-tree-title-coun.md`. Picked option 2 (`Backlog (3 of 47)` mine-only / `Backlog (47)` show-all) per the architect's mild preference. Two pure helpers go into `backlog-filter.ts`:
- `visibleBacklogCount(data, showAll)` — mirrors `BacklogProvider.orderedSpawnable`'s filter chain (`spawnableBacklog` → conditionally `filterMine`) but only counts.
- `formatBacklogTitle(visible, total)` — returns `Backlog` / `Backlog (N)` / `Backlog (V of T)`.

Two coupled bugs being closed at once: (1) the count itself was unfiltered; (2) `updateListViewTitles` is wired only to the overview-data listener, so even a correct count would stay stale until the next overview tick when the user flipped showAll. Plan addresses both — the showAll-config-change listener at `extension.ts:361-367` will also call `updateListViewTitles()`.

Awaiting plan-approval gate.
