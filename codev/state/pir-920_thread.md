# PIR #920 — vscode: editor-tab webview for rich backlog search

## Plan phase (2026-05-30)

Investigated the codebase before drafting the plan. Key findings:

- **Backlog data has no `body`.** The chain is `issue-list` forge concept (`gh issue list --json number,title,url,labels,createdAt,author,assignees`) → `IssueListItem` (forge-contracts.ts) → `deriveBacklog` → `BacklogItem`/`OverviewBacklogItem`. None carry body. The issue's acceptance requires **title + body** substring search, so body must be sourced. This is the central plan-gate decision.
- **No existing `WebviewPanel` in the extension.** This is the first one. `view-issue.ts` is the closest pattern (read-only content, throttled refresh off `OverviewCache.onDidChange`).
- **Data reaches the extension only via Tower** (`OverviewCache` → `TowerClient.getOverview` → `/api/overview`). The extension never shells out to `gh`; per-issue body is available via `/api/issue` (`issue-view` concept → `getIssue`), but that's one-at-a-time, unusable for live search over 200 issues.
- **#918 (Quick Pick) has no code yet** — only its porch `status.yaml`. The command name `codev.searchBacklog` is unclaimed; I propose `codev.openBacklogSearch` for this panel to avoid colliding with #918.
- Existing pure-helper pattern: `views/backlog-filter.ts` (vscode-free, vitest-tested). Issue's skeleton says extend it for multi-filter — so **filtering runs host-side in pure helpers**, webview sends debounced criteria, host posts back rows. Matches the stated test plan.

Plan written to `codev/plans/920-vscode-editor-tab-webview-for-.md`. Central gate decisions surfaced: (1) body source — overview field+truncate vs dedicated endpoint; (2) Status dropdown in v1 (closed search is out-of-scope); (3) command name; (4) age format; (5) whether typed `area/...` filters by area.

### Gate feedback round 1 (2026-05-30)
Reviewer chose **Option B** for body source — a dedicated `GET /api/backlog-search` endpoint (fresh fetch, full body, no overview caching/truncation). `/api/overview` + `OverviewBacklogItem` untouched; filtering still host-side (endpoint hit once on open/refresh, not per keystroke). Decisions 3/4/5 confirmed as-recommended. Plan revised accordingly. **Decision 2 (Status: functional Open/Closed/All vs Open-only) still open** — Option B makes a functional Status dropdown cheap; awaiting reviewer's a/b pick. Gate still pending.

### Gate feedback round 2 (2026-05-30)
Reviewer chose **(a)**: functional Status dropdown (Open/Closed/All), default Open. `/api/backlog-search` takes a `state` param → `gh issue list --state`. Note: Closed/All lift the PR-exclusion filter (closed issues usually have a merged PR). Status is the one criterion that re-hits the endpoint; all other filters stay host-side/instant. All five decisions now resolved. Plan finalized.

### Plan approved → implement phase (2026-05-30)
Gate `plan-approval` approved. Advanced to `implement`. Building server endpoint + vscode webview panel.

### Implement complete → dev-approval gate (2026-05-30)
Implemented across server + vscode:
- **Server data path**: `issue-list` github concept parameterized (`CODEV_ISSUE_STATE`, `CODEV_ISSUE_FIELDS`) — defaults unchanged so `/api/overview` stays lean; `IssueListItem.body?`; `fetchIssueList(..., {state, includeBody})`; new `GET /api/backlog-search` (`handleBacklogSearch`) — fresh fetch w/ body, open→PR-excluded set, closed/all→raw set; `BacklogSearchItem`/`BacklogSearchResponse` wire types; `TowerClient.searchBacklog`.
- **VSCode**: pure `searchBacklog`/`formatAge` helpers in `backlog-filter.ts` (host-side filter/sort, sentinels for me/unassigned); new `webviews/backlog-search-panel.ts` (singleton WebviewPanel, CSP+nonce, CSS-vars-only theme, debounced criteria, refetch on Status change / OverviewCache heartbeat / open; body never crosses to webview); `codev.openBacklogSearch` command + `$(search)` title-bar icon in package.json + extension.ts.
- **Tests**: 20+ new vitest cases for searchBacklog (text/scopes/AND/sort/no-mutate) + formatAge thresholds.

Green: types+core+codev build ✓, vscode check-types ✓ / lint ✓ / esbuild bundle ✓, vscode unit 135 ✓, codev github/overview/tower-routes 296 ✓. issue-list.sh exec bit preserved. Awaiting `dev-approval` — reviewer runs the worktree to verify the panel across themes/result-sizes/filter combos.

### dev-approval feedback rounds (2026-05-31)
Reviewer iterated on the implementation at the gate; addressed each:
1. **Template extraction** — moved the ~200-line inline HTML/CSS/JS out of `backlog-search-panel.ts` into `webviews/backlog-search.template.ts` (`renderBacklogSearchHtml`, `/* html */` + `/* css */` tags). Panel is now lifecycle/messaging/host-filtering only. No build change.
2. **Inline row action** — replicated the sidebar's hover "reference in architect" inline action: per-row `↪` button → posts `{id,title}` → reuses the existing `codev.referenceIssueInArchitect` command (opens architect terminal, injects `#id "title" ` unsubmitted). Widened shared `extractIssueId`/`extractIssueTitle` to accept an `{issueId, issueTitle}` object so the webview can carry the title.
3. **Dropped the hacky `issue-list` parameterization** — reviewer flagged the `CODEV_ISSUE_STATE`/`CODEV_ISSUE_FIELDS` env-var bolt-ons on the shared concept (+ the non-github silent-state-ignore). Replaced with a **dedicated `issue-search` forge concept** (registered in `KNOWN_CONCEPTS`): 4 scripts — github verified empirically here; gitlab/gitea/linear mirrored from their `issue-list.sh` siblings + body + state, flagged `⚠️ UNVERIFIED` (no glab/tea/Linear creds in this env) for forge-owner smoke-test. `issue-list.sh` + `fetchIssueList` reverted to original; new `searchIssues(cwd, state)` routes to `issue-search`; `tower-routes` uses it. Forge w/o the script → null → panel shows "search unavailable" (honest degrade). **Plan deviation** (parameterized concept → dedicated concept) — to be recorded in the review.

Green after all three: full codev suite 3192 passed / 13 pre-existing skips ✓; vscode check-types ✓ / lint ✓ / esbuild ✓ / 135 unit ✓.

### Review phase: PR #957 + 3-way consultation (2026-06-01)
Wrote review + arch/lessons updates, opened PR #957 (`Fixes #920`). 3-way consult: **Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES** (2 findings).
- #1 stale-criteria desync (real bug, missed by the other two): FIXED — added pure `clampCriteriaToDataset()` + wired into `fetchAndRender()`; 5 regression tests. vscode 197 tests now.
- #2 Open omits active-builder exclusion: REBUTTED — plan's explicit Open def is "no active PR" (implemented); Gemini concurred it's fine for exploratory search; issue says "every open issue". Flagged for human decision at pr gate (small follow-up if they want sidebar-strict).
- Applied Claude's note: removed `void` prefixes (project preference). Documented all in review "3-Way Consultation Outcome". Escalating the REQUEST_CHANGES to the human since PIR is single-pass.

### main merged + dev-approval approved → review phase (2026-06-01)
Merged `origin/main` (202 commits behind: v3.1.6 + merged builders incl. #918 Quick Pick). One conflict (`extension.ts`): kept both search imports, adapted my command to main's new `reg()`/`regCli()` registration wrappers, preserved `IssueCommandArg` widening on `referenceIssueInArchitect`. Verified no double-icon (only `openBacklogSearch` in title bar; #918 Quick Pick palette-only). Post-merge green: vscode 192, codev 3210. `extension.ts` left tab-indented (pre-existing file style; no repo formatter). dev-approval gate approved by human; advanced to review.

---

(earlier dev-approval feedback rounds, for reference:)

4. **Naming consistency** — reviewer flagged the route `/api/backlog-search` was inconsistent with the resource-named `/api/issue` (and with my own `issue-search` concept / `searchIssues` lib). Unified the data path on `issue-search`: route `/api/issue-search`, handler `handleIssueSearch`, client `TowerClient.searchIssues`, wire types `IssueSearchItem`/`IssueSearchResponse`. "Backlog" survives only on the feature side — `BacklogSearchPanel`, the "Search Backlog" tab, and the host-side `searchBacklog`/`BacklogSearchCriteria` filter helpers (describe the panel feature, not the resource). Principle: transport/server = resource (issue), UI = feature (backlog). Green: types/core/codev build ✓, vscode 135 ✓, codev forge/github/overview/tower-routes 359 ✓.
