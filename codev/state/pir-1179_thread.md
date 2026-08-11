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

## 2026-08-11 — Implement phase

Plan approved as written (reviewer asked one clarifying question about typing id+title
together; no plan change needed). Implemented in the three planned commits:

1. `5545122` PR-fetch plumbing: `pr-view` scripts emit `url` (github --json field;
   gitlab/gitea jq mappings mirroring issue-view), `PrViewResult.url`, `fetchPR`,
   Tower `GET /api/pr` (mirror of handleIssueView), `PRView` wire type,
   `TowerClient.getPR` + sdk tests.
2. `0689c82` `codev.openPRById` + Cmd+K P: extracted `openIssueInBrowser` from
   `openIssueById` (behavior unchanged, tests pass unmodified), new
   `open-pr-by-id.ts` with `openPRInBrowser`, manifest command + keybinding.
3. `5608aa1` QuickPick type-ahead: `parseSearchDynamicQuery` grammar +
   `toDynamicQuickPickItems` (alwaysShow rows) in vscode-free `backlog-search.ts`;
   `search-backlog.ts` moved to `createQuickPick` with dynamic rows and accept
   routing (dynamic → browser helpers, static → in-editor preview unchanged).

## 2026-08-11 — Review phase / pr gate

Dev-approval feedback caught a real tsc error my piped `pnpm compile | tail` had masked
(lesson #1150 struck again): `DynamicQuickPickItem.kind` collided with VS Code's reserved
`QuickPickItem.kind`; renamed to `target` (2a747cb5). PR #1399 opened; retrospective +
COLD lesson (QuickPickItem reserves `kind`; alwaysShow for injected rows) committed.
Consultation: gemini APPROVE, codex APPROVE, claude REQUEST_CHANGES — confirmed finding:
Cmd+K P shadows the built-in Copy Path of Active File (issue's "free slot" premise only
covered our own map). Key kept as issue-specified; collision escalated to the human at
the pr gate via review "Things to Look At" + rebuttal file. Sitting at pr gate.

Notes for reviewers: fresh-worktree builds need `pnpm -C packages/types build`,
`packages/core build`, `packages/sdk build`, `packages/artifact-canvas build` before
type-checking codev/vscode (dist-based workspace resolution; not caused by this change).
Verified the real forge path: `CODEV_PR_NUMBER=1398 sh .../github/pr-view.sh` returns
title/url/state. vscode vitest 777/777 green.
