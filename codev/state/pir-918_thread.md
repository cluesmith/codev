# pir-918 — vscode: Quick Pick command for searching the backlog

## Plan phase (2026-05-30)

Investigated the backlog view stack:
- `views/backlog.ts` — `BacklogProvider`, reads `OverviewCache`, single-click row → `codev.viewBacklogIssue`.
- `views/overview-data.ts` — shared `OverviewCache.getData()` → `OverviewData` (`.backlog`, `.currentUser`).
- `types/api.ts:210` — `OverviewBacklogItem` has id/title/url/area/createdAt/assignees; **no body field** → `detail` (issue-body sentence) can't be done without a new fetch path the issue forbids. Decided to omit `detail`.
- `views/backlog-filter.ts` — established vscode-free pure-helper pattern (unit-tested from `__tests__/`).
- `commands/view-artifact.ts:135` — relativeTime helper style to mirror.
- `package.json:242` — `commandPalette` `when:false` is what HIDES commands; new command gets none → palette-visible.

Plan written to `codev/plans/918-vscode-quick-pick-command-for-.md`. Design: new vscode-free `views/backlog-search.ts` (orderForSearch + toQuickPickItems, testable), thin `commands/search-backlog.ts` wrapper, register in extension.ts, add command to package.json, unit tests. Search is over FULL backlog (not mine-only), snapshot at invoke, mine-first ordering, delegates open to existing `codev.viewBacklogIssue`.

Awaiting `plan-approval` gate.
