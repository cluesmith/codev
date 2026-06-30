# PIR #1096 — vscode: codev.openIssueByNumber + Cmd+K I

## Plan phase (2026-06-30)

Investigated the VSCode extension. Key findings:

- `codev.viewBacklogIssue` (`src/commands/view-issue.ts`) is the canonical open-preview path; `viewBacklogIssue()` fetches via `client.getIssue(id, workspacePath)` and renders a read-only `codev-issue:` markdown preview with deterministic column placement (`pickIssuePreviewColumn`). It already handles the connection check and the null-issue case (shows `Could not load issue #N (forge unavailable?)`).
- `codev.searchBacklog` (`src/commands/search-backlog.ts`) is the existing Quick Pick; on selection it delegates to `codev.viewBacklogIssue`. New command should follow the same delegation pattern.
- `client.getIssue` (`packages/core/src/tower-client.ts:347`) returns `IssueView | null` — null for BOTH not-found and transport failure. Cannot distinguish a 404 from a forge-down, so an assertive "not found in this repository" message would over-claim.
- Codev K-prefix keybindings: `cmd+k a` openArchitectTerminal, `cmd+k d` sendMessage, `cmd+k g` approveGate, `cmd+k b` forwardSelectionToBuilder. `cmd+k i` is free. (Issue text mislabels `cmd+k a` as addArchitect — actually openArchitectTerminal; immaterial.)
- Unit tests: pure-logic units live in `src/__tests__/**/*.test.ts` (vitest, `vi.mock('vscode')` pattern, see command-relay.test.ts). `src/test/` is the Electron vscode-test suite.
- This is product code (single source) — no codev-skeleton mirror needed.

Plan written to `codev/plans/1096-vscode-codev-openissuebynumber.md`. Awaiting plan-approval gate.

Key plan-gate recommendation: delegate the open path entirely to `codev.viewBacklogIssue` (DRY, identical placement) and keep its existing null message rather than asserting "not found" we can't verify. PRs (decision #4): recommend NO for v1 (issues only).

### Plan revisions during plan-approval review

- Architect chose to **fold in** a palette-clarity fix: rename `codev.openBacklogSearch`'s title "Codev: Search Backlog" → "Codev: Open Backlog Search Panel" (title-only, no command-id rename) to disambiguate from the `codev.searchBacklog` Quick Pick ("Codev: Search Backlog...").
- Architect direction: command is **`codev.openIssueById`** / "Codev: Open Issue by **ID**...", NOT `openIssueByNumber` as the issue text proposes. Parser `parseIssueId`, file `open-issue-by-id.ts`. Porch project slug + plan filename stay `…openissuebynumber` (porch-managed, derived from issue title; plan_exists check is pinned to that path).

## Implement phase (2026-06-30)

Implemented per approved plan:
- New `packages/vscode/src/commands/open-issue-by-id.ts` — pure `parseIssueId(input)` (trim, strip one optional leading `#`, all-digits) + `openIssueById()` (showInputBox with live validation, delegates to `codev.viewBacklogIssue`).
- `extension.ts` — import + `reg('codev.openIssueById', ...)`.
- `package.json` — command contribution `Codev: Open Issue by ID...`, keybinding `cmd+k i`/`ctrl+k i` (no when-clause, global), and folded-in title rename of `codev.openBacklogSearch` → "Codev: Open Backlog Search Panel" (title-only).
- New unit test `src/__tests__/open-issue-by-id.test.ts` — 8 cases for parseIssueId.

Validation (run from worktree, after building types/core/artifact-canvas deps): check-types ✓, lint ✓, vitest 524/524 ✓. Porch checks: build ✓ (7.9s), tests ✓ (20.6s). Committed 2a423a6e, pushed.

Note: the 11 initially-"failed" test files + check-types errors were pre-existing module-resolution failures from unbuilt workspace deps (codev-core/codev-artifact-canvas), not my diff — resolved by building those deps first. None of my touched files were implicated.

Awaiting dev-approval gate.

## Implement phase — design pivot to browser-open (2026-06-30)

Architect direction during dev-approval review: `openIssueById` should open the issue in the **browser** (differentiator vs the backlog/View-Issue in-editor preview family).

Found "Open Issue in Browser" (`codev.openBacklogIssue`) is NOT directly reusable: it only takes a backlog tree item with a pre-built `issueUrl`, and the by-id fetch (`IssueView`) carried no url. So threaded an optional `url` through the fetch contract:
- `packages/types/src/api.ts` `IssueView.url?`
- `packages/codev/src/lib/forge-contracts.ts` `IssueViewResult.url?`
- `packages/codev/scripts/forge/github/issue-view.sh` — added `url` to `gh issue view --json`
- Tower `handleIssueView` passes the whole object through unchanged → url flows to client automatically.
- `open-issue-by-id.ts` rewritten: fetch via `client.getIssue` → `issue.url` ? `openExternal` : fallback to `codev.viewBacklogIssue` (in-editor); `null` → warning; not-connected → error. Handler now takes `connectionManager`.

`url` is OPTIONAL (forge-neutral): gitlab/gitea/linear scripts don't emit it yet → those degrade to in-editor preview. Clean follow-up to populate them.

Validation: types+core rebuilt; check-types ✓, lint ✓, vitest 530/530 ✓. Porch checks: build ✓, tests ✓. Plan file updated to reflect the pivot.

## Implement phase — extend url to all forge issue-view scripts (2026-06-30)

Architect direction: extend `issue-view` scripts for gitlab/gitea/linear to emit `url` too (not GitHub-only).

Per-forge mapping (field names verified vs each forge's API docs):
- github: `gh issue view --json …,url` (done earlier; gh `url` = web url).
- gitlab: `glab issue view … | jq '. + {url: .web_url}'` — maps GitLab web_url, non-destructive.
- gitea: `tea issues view … | jq '.url = (.html_url // .url)'` — Gitea's raw `url` is the API endpoint; prefer html_url (browser), fall back if absent.
- linear: added `url` to the GraphQL selection + jq output map (Linear Issue.url = web url).

Testability: only github is runtime-testable here. The gitlab/gitea/linear jq transforms were validated against representative sample payloads (correct url extracted, other fields preserved, gitea fallback works) but NOT against live glab/tea/Linear. Flagged for the human at dev-approval / a forge-equipped reviewer.

Exec bits preserved (755, no git mode change). Porch checks: build ✓, tests ✓.
