# PIR #920 — vscode: editor-tab webview for rich backlog search

## Plan phase (2026-05-30)

Investigated the codebase before drafting the plan. Key findings:

- **Backlog data has no `body`.** The chain is `issue-list` forge concept (`gh issue list --json number,title,url,labels,createdAt,author,assignees`) → `IssueListItem` (forge-contracts.ts) → `deriveBacklog` → `BacklogItem`/`OverviewBacklogItem`. None carry body. The issue's acceptance requires **title + body** substring search, so body must be sourced. This is the central plan-gate decision.
- **No existing `WebviewPanel` in the extension.** This is the first one. `view-issue.ts` is the closest pattern (read-only content, throttled refresh off `OverviewCache.onDidChange`).
- **Data reaches the extension only via Tower** (`OverviewCache` → `TowerClient.getOverview` → `/api/overview`). The extension never shells out to `gh`; per-issue body is available via `/api/issue` (`issue-view` concept → `getIssue`), but that's one-at-a-time, unusable for live search over 200 issues.
- **#918 (Quick Pick) has no code yet** — only its porch `status.yaml`. The command name `codev.searchBacklog` is unclaimed; I propose `codev.openBacklogSearch` for this panel to avoid colliding with #918.
- Existing pure-helper pattern: `views/backlog-filter.ts` (vscode-free, vitest-tested). Issue's skeleton says extend it for multi-filter — so **filtering runs host-side in pure helpers**, webview sends debounced criteria, host posts back rows. Matches the stated test plan.

Plan written to `codev/plans/920-vscode-editor-tab-webview-for-.md`. Central gate decisions surfaced: (1) body source — overview field+truncate vs dedicated endpoint; (2) Status dropdown in v1 (closed search is out-of-scope); (3) command name; (4) age format; (5) whether typed `area/...` filters by area.
