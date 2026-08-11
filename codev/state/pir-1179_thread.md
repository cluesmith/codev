# Builder thread — pir-1179

## 2026-08-11 — Plan phase

Investigated issue #1179 (one-step "view issue N / view pr N" QuickPick type-ahead +
`codev.openPRById` with Cmd+K P). Key findings that shaped the plan:

- The issue's paths are stale: extension is `apps/vscode/`, not `packages/vscode/`.
- The "View Issue QuickPick" is `codev.searchBacklog` (`commands/search-backlog.ts`) —
  the only issue-navigation QuickPick in the extension.
- `client.getPR` doesn't exist anywhere in the chain: no SDK method, no Tower route.
  A `pr-view` forge concept exists but emits no `url`. Plan therefore includes a thin
  vertical slice: forge scripts (github/gitlab/gitea) + `PrViewResult.url` + `fetchPR`
  + `GET /api/pr` + `PRView` wire type + `TowerClient.getPR`.
- `codev.openBacklogIssue` can't serve the dynamic items (needs a tree item with a
  pre-known URL); routing through an extracted `openIssueInBrowser` helper instead.
- No in-editor PR preview exists → url-less/missing PR degrades to a warning, per the
  issue's own fallback clause.
- `ctrl+k p` / `cmd+k p` verified free.

Plan written to `codev/plans/1179-vscode-one-step-view-issue-n-v.md`; three commits:
plumbing → openPRById command → QuickPick type-ahead. Sitting at plan-approval gate.
