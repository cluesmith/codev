# PIR Plan: One-step "view issue N" / "view pr N" from the backlog QuickPick + Cmd+K P Open-PR-by-ID

## Understanding

Issue #1179 asks for two additive changes to the VS Code extension:

1. **Type-ahead in the backlog search QuickPick.** The picker the issue describes is
   `codev.searchBacklog` (`apps/vscode/src/commands/search-backlog.ts` — the issue said
   "verify at implement time"; verified, this is the only issue-navigation QuickPick).
   Today it only filters the loaded backlog rows; an issue outside that set (closed,
   claimed by a builder, or any PR) is unreachable from it. The fix: when the typed value
   matches a numeric grammar (`1350`, `#1350`, `issue 1350`, `view pr 1350`, ...), prepend
   dynamic `View Issue #1350` / `View PR #1350` items that open the target directly in the
   browser — one gesture instead of picker → command → InputBox → Enter.

2. **`codev.openPRById` + Cmd+K P.** Mirror of `codev.openIssueById`
   (`apps/vscode/src/commands/open-issue-by-id.ts`, bound to Cmd+K I): InputBox with
   `parseIssueId` validation, forge-agnostic fetch, `vscode.env.openExternal(pr.url)`.

### Corrections to the issue text (verified against the tree)

- **Paths**: the extension lives at `apps/vscode/`, not `packages/vscode/`. The client is
  `TowerClient` in `packages/sdk/src/tower-client.ts` (the extension's
  `connection-manager.ts` just holds it); the server is Tower in
  `packages/codev/src/agent-farm/servers/tower-routes.ts`.
- **`client.getPR` does not exist, and neither does its server side.** `getIssue`
  (`tower-client.ts:473`) calls Tower's `GET /api/issue` (`tower-routes.ts:182` →
  `handleIssueView` → `fetchIssue` → the `issue-view` forge concept). There is no
  `GET /api/pr`. A `pr-view` forge concept **does** exist
  (`packages/codev/src/lib/forge.ts:67`, scripts in `packages/codev/scripts/forge/*/pr-view.sh`)
  but its output contract (`PrViewResult`, `forge-contracts.ts:121`) carries **no `url`**
  — the GitHub script doesn't request the field. So Part 2 needs a thin vertical slice:
  add `url` to the `pr-view` concept output, a `fetchPR` helper, a `GET /api/pr` route, a
  `PRView` wire type, and `TowerClient.getPR`.
- **"straight to `codev.openBacklogIssue`" can't be taken literally**: that command
  (`extension.ts:1085`) opens `arg.issueUrl` from a `BacklogTreeItem` — for a typed number
  we have no URL yet. The dynamic items instead route through the same fetch-then-open
  logic `openIssueById` uses, extracted into a shared helper. Same outcome (browser), one
  code path.
- **No in-editor PR preview exists** (no `codev.viewBacklogPR`), so the issue's own
  fallback applies: PR fetched but no `url` → `showWarningMessage`. Not-found → warning
  too (Q2c).
- **`ctrl+k p` / `cmd+k p` confirmed free** in `contributes.keybindings` (current family:
  a, d, g, b, i).

## Proposed Change

Three commits inside one PR, plumbing-first so each layer lands testable.

### Commit 1 — PR-fetch plumbing (forge → Tower → SDK)

- **`pr-view` concept gains `url`** (browser URL, forge-mapped), following exactly the
  `issue-view` precedent:
  - `packages/codev/scripts/forge/github/pr-view.sh` — add `url` to the `--json` field
    list (valid `gh pr view` field; the `CODEV_INCLUDE_COMMENTS=1` text branch is
    untouched).
  - `packages/codev/scripts/forge/gitlab/pr-view.sh` — pipe through
    `jq '. + {url: .web_url}'` (same as gitlab `issue-view.sh`).
  - `packages/codev/scripts/forge/gitea/pr-view.sh` — `jq '.url = (.html_url // .url)'`
    (same as gitea `issue-view.sh`; Gitea's `url` is the API endpoint).
  - `packages/codev/src/lib/forge-contracts.ts` — `PrViewResult` gains `url?: string`
    (optional, forge-neutral, mirroring `IssueViewResult`).
- **`fetchPR`** in `packages/codev/src/lib/github.ts`, next to `fetchIssue`: executes
  `pr-view` with `CODEV_PR_NUMBER`, returns the parsed result or null (non-fatal).
- **`GET /api/pr`** in `tower-routes.ts`: `handlePRView` mirroring `handleIssueView`
  (workspace resolution, `?number=` param, 400/404/200) calling `fetchPR`.
- **`PRView` wire type** in `packages/types/src/api.ts` (name verified free): `title`,
  `body`, `state`, `url?` (with the same web-URL-not-API-endpoint doc note as
  `IssueView.url`), plus the fields `pr-view` already emits (`author`, `baseRefName`,
  `headRefName`, `additions`, `deletions`).
- **`TowerClient.getPR(prNumber, workspacePath?)`** in `packages/sdk/src/tower-client.ts`,
  directly below `getIssue`, same shape (`URLSearchParams`, null on failure).

### Commit 2 — `codev.openPRById` + Cmd+K P

- Refactor `apps/vscode/src/commands/open-issue-by-id.ts`: extract the post-InputBox body
  (connection guard → `getIssue` → `openExternal` → `viewBacklogIssue` fallback) into an
  exported `openIssueInBrowser(connectionManager, issueId)`. `openIssueById` becomes
  InputBox + delegate. No behavior change; existing tests must pass unmodified.
- New `apps/vscode/src/commands/open-pr-by-id.ts`:
  - `openPRInBrowser(connectionManager, prId)` — connection guard (`Not connected to
    Tower` error, matching the issue sibling), `client.getPR`, on success
    `openExternal(pr.url)`; PR missing **or** url-less →
    `Codev: Could not open PR #N (not found, or forge unavailable).`
  - `openPRById(connectionManager)` — `showInputBox` titled `Codev: Open PR by ID`,
    reusing `parseIssueId` (imported from `open-issue-by-id.js`; already forge-neutral
    per its docstring) as validator, then delegate.
- `apps/vscode/src/extension.ts` — `reg('codev.openPRById', ...)` next to
  `codev.openIssueById` (`extension.ts:1101`).
- `apps/vscode/package.json` — command declaration `Codev: Open PR by ID...` +
  keybinding `ctrl+k p` / `cmd+k p` (no `when`, matching the i binding).

### Commit 3 — QuickPick type-ahead

- **Pure grammar helper** in `apps/vscode/src/views/backlog-search.ts` (vscode-free file,
  vitest-testable — the established pattern):
  `parseSearchDynamicQuery(value): Array<{ kind: 'issue' | 'pr'; id: string }>`
  - `1350` / `#1350` → `[issue, pr]` (issue first)
  - `issue 1350` / `view issue 1350` (case-insensitive, `#` tolerated) → `[issue]`
  - `pr 1350` / `view pr 1350` → `[pr]`
  - anything else (non-numeric, trailing text, bare keyword) → `[]`
- **`search-backlog.ts`** switches from `showQuickPick` to `createQuickPick` (required
  for `onDidChangeValue`):
  - static items, `matchOnDescription/Detail`, placeholder unchanged;
  - `onDidChangeValue` → `items = [...dynamicItems, ...staticItems]`; dynamic items get
    `alwaysShow: true` so VS Code's fuzzy filter can't hide them (Q1a/Q1b) and are
    labeled `View Issue #N` / `View PR #N`; empty grammar result restores the plain
    static list (Q1c — normal filtering untouched);
  - `onDidAccept`: dynamic issue → `openIssueInBrowser`, dynamic pr → `openPRInBrowser`,
    static row → `codev.viewBacklogIssue` (unchanged in-editor preview);
    `onDidHide` → `dispose`.
  - `searchBacklog` gains a `connectionManager` parameter; registration at
    `extension.ts:1100` updated.
  - The existing empty-backlog early-return stays as-is (see Risks).

## Files to Change

- `packages/codev/scripts/forge/github/pr-view.sh` — add `url` to `--json` list
- `packages/codev/scripts/forge/gitlab/pr-view.sh` — map `web_url` → `url` via jq
- `packages/codev/scripts/forge/gitea/pr-view.sh` — map `html_url` → `url` via jq
- `packages/codev/src/lib/forge-contracts.ts:121-131` — `PrViewResult.url?: string`
- `packages/codev/src/lib/github.ts` (near `fetchIssue`, :47) — new `fetchPR`
- `packages/codev/src/agent-farm/servers/tower-routes.ts:182` area — route
  `GET /api/pr` + `handlePRView` (mirror of `handleIssueView`, :1149)
- `packages/types/src/api.ts` (after `IssueView`, :391) — new `PRView`
- `packages/sdk/src/tower-client.ts:473` area — new `getPR`
- `apps/vscode/src/commands/open-issue-by-id.ts` — extract `openIssueInBrowser`
- `apps/vscode/src/commands/open-pr-by-id.ts` — new file
- `apps/vscode/src/views/backlog-search.ts` — new `parseSearchDynamicQuery` + item
  projection
- `apps/vscode/src/commands/search-backlog.ts` — `createQuickPick` + dynamic items +
  accept routing
- `apps/vscode/src/extension.ts:1100-1101` — register `codev.openPRById`; pass
  `connectionManager` to `searchBacklog`
- `apps/vscode/package.json` — command + `ctrl+k p`/`cmd+k p` keybinding
- Tests: `apps/vscode/src/__tests__/open-pr-by-id.test.ts` (new),
  `backlog-search.test.ts` (extend), `search-backlog-quickpick.test.ts` (new),
  `packages/sdk/src/__tests__/tower-client.test.ts` (extend)

Not touched (per issue scope): `codev.openIssueById` behavior, `codev.referencePRInArchitect`,
other QuickPicks. No `codev-skeleton/` mirror needed — the forge scripts and all touched
code ship from `packages/`, and skeleton carries no copy (verified by grep).

## Risks & Alternatives Considered

- **Risk: `gh pr view --json url` availability.** `url` is a standard `gh` pr field;
  verified in `gh` docs and used elsewhere in the repo for merged-PR queries
  (`forge-contracts.ts` `MergedPrItem.url`). Mitigation: exercised in Commit 1's manual
  check against this very repo.
- **Risk: dynamic items swallowed by QuickPick filtering.** Typing `view pr 1350` must not
  let VS Code's fuzzy matcher drop the injected item. `alwaysShow: true` is the API's
  dedicated escape hatch; unit test asserts it's set.
- **Risk: gitlab/gitea pr-view scripts already deviate from `PrViewResult`** (raw CLI
  JSON). Adding the jq url-mapping follows the issue-view precedent and doesn't tighten
  or loosen anything else — out of scope to fully align those contracts.
- **Alternative: route dynamic issue items to `codev.openBacklogIssue`** (issue's
  wording). Rejected: that command needs a `BacklogTreeItem` carrying a known URL; a
  typed number has none. The shared `openIssueInBrowser` helper gives the same browser
  outcome through the already-tested fetch path.
- **Alternative: skip the server slice and build the PR URL client-side.** Rejected:
  forge-neutrality is a stated invariant (`parseIssueId` doc, `IssueView.url` doc); URL
  synthesis would hardcode GitHub.
- **Alternative: also open the picker when the backlog is empty** (so the type-ahead
  works with no rows). Deliberately not done — current guard behavior kept, surgical
  scope. Flag at review if wanted.
- **Alternative: `when`-gated keybinding.** The sibling `cmd+k i` ships ungated; matching
  it keeps the family consistent.

## Test Plan

Unit (vitest — `apps/vscode`, `packages/sdk`; run from this worktree):

- `backlog-search.test.ts` — grammar table for `parseSearchDynamicQuery`: bare `1350`,
  `#1350` → issue+pr; `issue 1350`, `view issue 1350`, `ISSUE #1350` → issue; `pr 1350`,
  `view pr 1350` → pr; `abc`, `12a3`, `1350 fix`, `issue`, `view pr` → empty.
- `search-backlog-quickpick.test.ts` (new; vscode mocked with a fake `createQuickPick`,
  per the `open-issue-by-id.test.ts` stub pattern) — typing `1350` prepends both dynamic
  items with `alwaysShow`; non-numeric input restores static-only items; accepting the
  PR dynamic item calls `openPRInBrowser` with `1350`; accepting a static row executes
  `codev.viewBacklogIssue`.
- `open-pr-by-id.test.ts` (new; mirrors `open-issue-by-id.test.ts`) — opens `pr.url` in
  browser; warns on not-found (Q2c); warns when `url` absent; errors when disconnected;
  no-ops on dismissed InputBox; `#42` → fetches `42` (Q2b via `parseIssueId` reuse).
- `open-issue-by-id.test.ts` — must pass unmodified after the `openIssueInBrowser`
  extraction (refactor guard).
- `tower-client.test.ts` — `getPR` hits `/api/pr?number=N&workspace=...` and unwraps /
  nulls like `getIssue`.

Manual (dev-approval gate, reviewer-driven):

- Build + launch the extension against this worktree (Extension Development Host).
- **Q1a**: open backlog search, type `1350` → `View Issue #1350` + `View PR #1350` on
  top; Enter on the first opens the issue in the browser.
- **Q1b**: type `view pr 1350` → `View PR #1350` on top; Enter opens the PR in the
  browser.
- **Q1c**: type `tower` → normal filtering, no dynamic items.
- **Q2a**: `Cmd+K P` → InputBox; `1398` + Enter opens PR #1398 in the browser.
- **Q2b**: type `abc` → validation message, cannot submit.
- **Q2c**: enter `999999` → warning toast, no crash.
- Regression: `Cmd+K I` still opens an issue; backlog row Enter still opens the
  in-editor preview.
