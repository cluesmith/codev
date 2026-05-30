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

Plan approved.

## Implement phase (2026-05-30)

Implemented per plan:
- `views/backlog-search.ts` (vscode-free) — `orderForSearch` (full spawnable, mine-first, NO mine-only filter), `toQuickPickItems` (label `#id title`, desc `area · Nd ago [· @assignee]`, injected `now`), private `relativeAge`. `detail` omitted (no body in cache, as planned).
- `commands/search-backlog.ts` — snapshot `overviewCache`, empty-guard, `showQuickPick` (matchOnDescription/Detail), delegate open to `codev.viewBacklogIssue`.
- `extension.ts` — register `codev.searchBacklog`.
- `package.json` — command `Codev: Search Backlog...` ($search icon), no commandPalette suppressor (palette-visible), no keybinding.
- `__tests__/backlog-search.test.ts` — 7 unit tests.

Worktree had no node_modules; ran `pnpm install --frozen-lockfile` + built core/types (their `.d.ts` are required for vscode check-types). Then: check-types ✓, lint ✓, vitest 120 passed (incl. 4 new files / 7 new tests).

dev-approval approved.

## Review phase (2026-05-30)

Wrote `codev/reviews/918-vscode-quick-pick-command-for-.md` (retrospective: Summary, Files Changed, Commits, Test Results, Architecture Updates [none — self-contained, reuses OverviewCache + viewBacklogIssue], Lessons Learned [none — established conventions], Things to Look At, How to Test Locally). No arch.md / lessons-learned.md edits needed. Opened PR #938 (Fixes #918), recorded with porch. Single-pass 3-way consult: gemini=APPROVE (HIGH), codex=APPROVE (MEDIUM), claude=APPROVE (HIGH). No REQUEST_CHANGES. Claude noted a cosmetic indent nit at extension.ts:604 — verified false positive (3 tabs, correct sibling, confirmed via od -c), no change. Architect notified. `pr` gate pending — awaiting human merge + approval.
