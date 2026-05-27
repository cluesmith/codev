# pir-891 thread

## 2026-05-28 — plan drafted

Plan committed at `codev/plans/891-vscode-shared-search-webview-a.md`. Sitting at the `plan-approval` gate.

Key design positions worth flagging to anyone who looks in:

- Accepted issue's recommendations on all 7 design questions, with one substantive deviation: **match scope adjustment**. The issue body said "title + areas + labels + assignees" but `OverviewBacklogItem` only exposes a single resolved `area` (no `labels[]`) and `OverviewBuilder` has no `assignees` at all. Plan filters on the fields that actually exist (backlog: id/title/area/assignees/author; builders: issueId/issueTitle/area/spawnedByArchitect). Adding a real `labels[]` to the overview types is offered as an in-PR addendum if the reviewer wants it.
- "Hide empty groups" branch only fires when filter is active — empty-filter render is byte-identical to today.
- Webview HTML is split into a pure renderer in `search-view-html.ts` so it's unit-testable without `vscode` mocking.
- First webview in the extension — establishes CSP/nonce/theme-var scaffold that #807 (Reader View), #861, #862, #863 can copy.
- Known risk flagged for dev-approval: VSCode has no public `WebviewView.hide()` API, so the 🔍-toggle-collapse half is a slightly awkward focus-shift workaround. The dev-approval gate is the right place to feel out whether it's acceptable.

Estimated scope: ~290 production LOC + ~210 test LOC (issue's 150+50 estimate was light — gap is the webview HTML scaffold + per-provider hide-empty-groups handling).
