# PIR #1740: review iteration 1 rebuttals

Verdicts: Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES. Codex's four points:

1. **Jira list/search omit `createdAt` while the contracts require it: FIXED** (`3cbdc6b8f`).
   - `createdAt` is now optional on `IssueListItem`, `OverviewBacklogItem` and `IssueSearchItem`.
   - The dashboard age cell and VS Code `formatAge` render nothing when it is missing, so no `NaN`.
   - Undated items sort last on the age column in both directions.
   - Tests: `apps/web/__tests__/BacklogList.test.tsx`, `apps/vscode/src/__tests__/backlog-filter.test.ts`.

2. **Web UI changes not browser-verified: FIXED** (recorded in the review's Test Results).
   - **Setup:** headless Chromium against this branch's built `apps/web/dist`, with the API answered by fixtures (one Jira-key builder, two numeric) and isolation asserted.
   - **Branch build:** every builder card opens its own terminal tab, and labels render without `#` for keys and without `NaN`.
   - **Negative control:** main's `WorkView` fails all three cards: the Jira card opens nothing, and builders 12 and 123 open the Jira builder's tab.

3. **`search-backlog.ts` exits on an empty or unloaded backlog: REBUTTED.**
   - That early return ("No backlog issues to search") is pre-existing and identical for numeric workspaces; this PR does not touch it.
   - The plan's gate table describes which dynamic rows are offered once the picker is open.
   - A Jira user's empty-backlog path is Open Issue by ID (`Cmd+K I`), which accepts keys when the id kind is unknown (tested in `open-issue-by-id.test.ts`).
   - Opening an empty picker would change existing UX for every forge, which is a separate decision.

4. **Branch-name PR linking listed in the plan but not done: ACKNOWLEDGED, deferred.**
   - `parseLinkedIssue` receives only the PR title and body, and the `pr-list` contract carries no branch, so branch linking needs a contract change.
   - The protocols' PRs link through their commit tags (`[PIR #KEY]`, `[Bugfix #KEY]`, `[Spec KEY]`) and closing keywords on a `#`-prefixed key (`Fixes #KEY`, the BUGFIX title `Fix #KEY: …`), all tested.
   - The architect's integration review classed branch linking as "no change required" for this PR. It is recorded under "Not done" in the review for a follow-up.
