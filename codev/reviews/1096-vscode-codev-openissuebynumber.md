# PIR Review: `codev.openIssueById` + `Cmd+K I` (open any issue in the browser)

Fixes #1096

## Summary

Adds `codev.openIssueById` ("Codev: Open Issue by ID...", bound to `Cmd+K I` /
`Ctrl+K I`): prompt for an issue id, fetch it live via the forge contract, and
open its page in the **browser**. This is the deliberate counterpart to the
backlog / "View Issue" family (which preview *in-editor*) — direct,
keyboard-driven access to *any* issue by id, including closed/archived ones and
ids already claimed by a builder (which the backlog filters out). To support it,
the `issue-view` forge concept now carries the issue's browser `url`. Also folds
in a small palette-clarity fix: the webview-panel command was retitled "Codev:
Open Backlog Search Panel" to stop colliding with the "Codev: Search Backlog..."
Quick Pick.

Naming note: the issue proposed `openIssueByNumber`; the shipped command is
`openIssueById` ("ID") per architect direction — "ID" is forge-neutral (GitLab
`iid`, Linear/Jira identifiers aren't bare numbers) and matches the extension's
existing `issueId` vocabulary. The porch slug / plan filename keep
`…openissuebynumber` (porch-managed, derived from the issue title).

## Files Changed

- `packages/vscode/src/commands/open-issue-by-id.ts` (+81 / -0) — new: `parseIssueId` + `openIssueById`
- `packages/vscode/src/__tests__/open-issue-by-id.test.ts` (+125 / -0) — new: parser + handler-routing tests
- `packages/vscode/src/extension.ts` (+2) — import + command registration
- `packages/vscode/package.json` (+11 / -1) — command, keybinding, panel title rename
- `packages/types/src/api.ts` (+9) — optional `IssueView.url`
- `packages/codev/src/lib/forge-contracts.ts` (+8) — optional `IssueViewResult.url`
- `packages/codev/scripts/forge/github/issue-view.sh` (+2 / -2) — emit `url`
- `packages/codev/scripts/forge/gitlab/issue-view.sh` (+4 / -1) — map `web_url` → `url`
- `packages/codev/scripts/forge/gitea/issue-view.sh` (+4 / -1) — map `html_url` → `url`
- `packages/codev/scripts/forge/linear/issue-view.sh` (+4 / -2) — add `url` to query + map
- `codev/resources/lessons-learned.md` (+1) — COLD lesson on per-forge field divergence
- `codev/plans/1096-vscode-codev-openissuebynumber.md` — plan (with mid-flight revisions)
- `codev/state/pir-1096_thread.md` — builder thread

## Commits

- `2a423a6e` [PIR #1096] Add codev.openIssueById command + Cmd+K I, disambiguate panel title
- `a0b76d1e` [PIR #1096] Open Issue by ID opens in browser; thread url through issue-view fetch
- `184ec314` [PIR #1096] Clarify url contract doc: browser URL + per-forge source field
- `73421def` [PIR #1096] Emit issue url from gitlab/gitea/linear issue-view scripts too

(Plan-draft and porch-transition commits omitted.)

## Test Results

- `npm run build`: ✓ pass
- `npm test`: ✓ pass — vscode unit suite 530/530 (14 new in `open-issue-by-id.test.ts`); codev package suite green via porch's `tests` check
- Manual verification: the human approved the running worktree at the `dev-approval` gate. Note the GitHub browser-open path requires the running Tower to serve the updated `issue-view` script (rebuild + restart Tower), since the live `/api/issue` was confirmed returning `url: null` on the stale global build during testing.

## Architecture Updates

No `arch.md` / `arch-critical.md` change. The one non-obvious fact — that the
`url` carried by `issue-view` maps to a different field per forge (GitHub `url`,
GitLab `web_url`, Gitea `html_url`, Linear `url`) — is documented **inline at the
contract** (`IssueView` / `IssueViewResult` doc-comments), which is where a
future forge-script author will look, rather than in the architecture reference.
No module boundaries, invariants, or system shape changed.

## Lessons Learned Updates

Added one COLD entry to `lessons-learned.md` (Architecture), `[From #1096]`: a
logical field crossing the forge-concept boundary maps to a different provider
field per forge, some are footguns (Gitea `url` = API endpoint, not the browser
page), so verify each against its own API docs and keep the contract field
optional so non-emitting forges degrade rather than break — plus the honest-verification
corollary (validate untestable forge transforms against sample payloads and say
so). Not hot-tier: it's a forge-scripting recipe, not a behavior-changing
cross-cutting rule. It extends the existing #920 / #909 forge-concept lessons.

## Things to Look At During PR Review

- **Multi-forge testability (the honest caveat).** Only the **GitHub** path is
  runtime-testable in this environment. The gitlab/gitea/linear `issue-view`
  edits were verified two ways — field names against each forge's API docs, and
  each `jq` transform against a representative sample payload (correct `url`
  extracted, other fields preserved, Gitea's `html_url`-over-`url` fallback
  exercised) — but **not** against a live `glab`/`tea`/Linear instance. A
  reviewer with those forges should sanity-check.
- **Gitea footgun.** `gitea/issue-view.sh` maps `html_url` (browser), *not* the
  raw `url` (API endpoint). Confirm the `jq '.url = (.html_url // .url)'` choice.
- **Non-destructive gitlab/gitea edits.** These two scripts were raw passthroughs;
  the change only adds/remaps `url` and deliberately leaves their existing
  body/state/comments handling alone (a separate, pre-existing concern).
- **Browser vs in-editor fallback.** `openIssueById` opens the browser when the
  fetch returns a `url`, and falls back to `codev.viewBacklogIssue` (in-editor)
  when it doesn't — so a forge without `url` still works, degraded.
- **Title-only panel rename.** `codev.openBacklogSearch`'s *command id* and its
  `view/title` 🔍 binding are untouched — only the display title changed.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1096` → **Review Diff**
- **Run the new code** (required for the GitHub browser path — the global Tower is stale):
  from the worktree root, `pnpm build && pnpm -w run local-install` (rebuilds + restarts Tower with the new `issue-view` script), then reload the VSCode window.
- **What to verify**:
  - `Cmd+K I` → `1096` and `#1096` → both open the GitHub issue page in the browser.
  - A closed / not-in-backlog id → still opens (live fetch, not the backlog set).
  - A non-existent id → clean warning, no exception in the dev console.
  - Empty / non-numeric → live input-box validation blocks submit.
  - `Cmd+Shift+P` → "Search Backlog" shows two distinct entries ("Codev: Search Backlog..." vs "Codev: Open Backlog Search Panel"); the 🔍 Backlog title-bar icon still opens the panel.
  - Regression: `codev.searchBacklog`, `codev.viewBacklogIssue`, `codev.openBacklogIssue` unaffected.
