# PIR Review: Issue view metadata (author, created date, assignees, labels, milestone)

Fixes #1592

## Summary

The VS Code in-editor issue preview rendered only title, state, body, and comments —
no attribution or triage context. This change extends the forge `issue-view` concept and
the `IssueView` wire contract with five optional, forge-neutral fields (author, createdAt,
assignees, labels, milestone) and renders them as a metadata block under the title
(state + labels on one line, then opened-by + date, assignees, milestone; each line
omitted when its data is absent). A pre-existing race — a preview tab restored on launch
before Tower connected staying stuck on "Content unavailable" — was fixed along the way at
the reviewer's request.

## Files Changed

Substantive (code / tests / governance):

- `packages/types/src/api.ts` (+32) — five optional fields on the `IssueView` wire type, with per-field doc comments.
- `packages/codev/src/lib/forge-contracts.ts` (+32) — the mirrored `IssueViewResult`, changed in the same commit, field-for-field parallel.
- `packages/codev/scripts/forge/github/issue-view.sh` (+7/-…) — extend `--json` to fetch the new fields (GitHub, the default).
- `packages/codev/scripts/forge/gitlab/issue-view.sh` (+…) — jq-map the fields forge-neutrally (best-effort preset).
- `packages/codev/scripts/forge/gitea/issue-view.sh` (+…) — map the fields onto main's REST-passthrough rewrite (best-effort preset).
- `packages/codev/scripts/forge/linear/issue-view.sh` (+…) — extend the GraphQL query + jq (single assignee → one-element array; project → milestone).
- `apps/vscode/src/commands/view-issue.ts` (+125/-24) — export + render the metadata block; fix the restored-preview recovery race.
- `apps/vscode/src/__tests__/view-issue-render.test.ts` (+144, new) — `renderIssue` metadata unit tests.
- `apps/vscode/src/__tests__/view-issue-refresh.test.ts` (+55, new) — `openIssueDocIds` enumeration tests.
- `packages/codev/src/__tests__/github.test.ts` (+23) — `fetchIssue` field passthrough test.
- `codev/resources/lessons-learned.md` (+1 entry) — COLD lesson on content-provider recovery.

Process artifacts also in the branch: `codev/plans/1592-…md`, `codev/state/pir-1592_thread.md`, `codev/projects/1592-…/status.yaml`.

## Commits

`git log main..HEAD --oneline` (substantive; porch bookkeeping omitted):

- `9c24c7488` [PIR #1592] Add author, createdAt, assignees, labels, milestone to IssueView contract (both mirrored declarations)
- `727a69380` [PIR #1592] Fetch author, createdAt, assignees, labels, milestone in issue-view forge scripts (all four forges, forge-neutral)
- `30f48dd2a` [PIR #1592] Render issue metadata block (opened-by, labels, assignees, milestone) under the title
- `a5345ce59` [PIR #1592] Tests: renderIssue metadata block + fetchIssue field passthrough
- `c97a3b0b3` Merge remote-tracking branch 'origin/main' into builder/pir-1592
- `7b6a797eb` [PIR #1592] Render state + labels on one line; singular Label/Assignee for a single item
- `a51cfbec6` [PIR #1592] Fix issue preview stuck on 'Content unavailable' when a tab is restored before Tower connects

## Test Results

- `npm run build` (types + sdk + codev, vscode `check-types`): ✓ pass
- `npm test`: ✓ pass — codev suite 5550 passed / 0 failed (48 pre-existing skips); vscode suite 970 passed / 0 failed. New tests: 10 (renderIssue) + 3 (openIssueDocIds) + 1 (fetchIssue passthrough).
- porch `build` + `tests` checks: ✓ (green at dev-approval and again at this gate)
- Manual verification (Amr, dev-approval gate, running worktree against Tower): opened real issues in the preview; confirmed the metadata block renders (author/date/labels), drove the state+label-one-line and singular-Label/Assignee refinements, and reproduced + confirmed the restored-preview "Content unavailable" fix.

## Architecture Updates

No arch changes. The `IssueView` / `IssueViewResult` contract grew **additively** with
optional fields (same pattern as the existing `url` field) — no new module boundary, data
store, or invariant. Tower's `GET /api/issue` already serializes the forge result verbatim
and the SDK's `getIssue` is a generic `request<IssueView>`, so no server/client boundary
shifted. The existing HOT fact about server/client isolation (codev-core / codev-sdk /
codev-types) is unchanged and already covers this shape.

## Lessons Learned Updates

One COLD lesson added to `codev/resources/lessons-learned.md` (UI/UX): a synchronous
`TextDocumentContentProvider` can't fetch, so its recovery set must be the currently-open
documents (`vscode.workspace.textDocuments` by scheme), not a session-populated cache;
trigger fetches on connect / open / activation since any can happen first; and don't burn
the refresh throttle while disconnected. Not HOT — it's a VS Code content-provider recipe,
not a repo-wide invariant. The same-commit mirror rule for the two `IssueView` declarations
is captured in the plan's acceptance criteria rather than a lesson (it's contract-local).

## Things to Look At During PR Review

- **Non-GitHub forge scripts are best-effort** (Spec 589 preset doctrine). GitHub is verified live against real issues; gitlab/gitea/linear are mapped with null-safe jq (validated against sample payloads) but not run against live instances here. A wrong field name degrades to an omitted line, never a crash (jq returns null for missing keys; guards tolerate it).
- **The gitea script was a merge conflict** — main rewrote it (bugfix-1455/1137) to a `tea api` REST passthrough with shape validation. I took main's version as the base and folded the five fields into its final jq object with matching defensive type guards. Worth a look that the merge preserved both intents.
- **Restored-preview recovery** (`view-issue.ts` `refreshOpenPreviews` / `refreshNow` / `openIssueDocIds`): the three triggers (onStateChange('connected'), onDidOpenTextDocument, activation pass) are deliberately redundant to cover every ordering of activate/restore/connect. The throttle is reset by `refreshNow` and only consumed after the connection check.
- **Scope note:** the restored-preview fix is beyond the approved plan (which was the metadata contract + render). It was reported and requested by Amr at the dev-approval gate and is local to `view-issue.ts`; flagged to the architect.

## How to Test Locally

For reviewers pulling the branch:

- **View diff**: VSCode sidebar → right-click builder `pir-1592` → **Review Diff**.
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1592`.
- **What to verify**:
  - Right-click a backlog row → **View Issue**: metadata block under the title; state + label(s) on one line; opened-by + date; assignees; milestone when present.
  - An issue with a single label / single assignee reads "Label" / "Assignee" (singular); multiple read plural.
  - An issue with no assignees / no milestone omits those lines.
  - Restored-tab recovery: open an issue preview, reload the window (or relaunch before Tower connects) — the tab shows "Content unavailable" briefly, then fills in once Tower connects, rather than staying stuck.

## Follow-ups

- **PRView / `GET /api/pr` has the analogous contract gap** (`PrViewResult` `forge-contracts.ts` / `PRView` `api.ts` lack labels/assignees/createdAt), but there is no in-editor PR render surface (`getPR`'s only consumer opens the browser). A separate issue will be filed at completion rather than expanding this PR.
