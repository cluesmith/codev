# PIR Plan: Pull Requests group shows a PR's changed files and opens read-only diffs (lane 1)

## Understanding

Today a row in the **Pull Requests** sidebar view (`apps/vscode/src/views/pull-requests.ts:22-58`)
is a flat leaf whose click runs `vscode.open` on the forge URL. Builders get a far richer review
surface: an expandable changed-file list (`views/architect-tree.ts:758-786`), SCM-style status
decorations (`views/builder-file-decoration.ts`), a per-file native diff
(`commands/view-diff.ts:openBuilderFileDiff`), keyboard file navigation (`commands/diff-nav.ts`)
and editor→sidebar auto-reveal (`extension.ts:844-897`).

Lane 1 gives PR rows the same read-only surface without a worktree or checkout:

- left side = merge-base of the PR's base branch and its head commit;
- right side = the PR's **head commit** (a git blob, not a working-tree file);
- the head commit's objects are fetched into the main checkout under a Codev-owned hidden ref
  namespace (`refs/codev/pr/<id>/…`), removed once the PR is no longer open.

What the builder stack hard-codes that blocks reuse today:

| Piece | Builder assumption | File |
|---|---|---|
| `SideSpec` / `planResources` | right side is always an on-disk `file:` (`kind: 'file'`) | `commands/view-diff.ts:89-139` |
| `getBuilderChanges` | diffs the working tree against merge-base (`git diff <base>`) | `commands/view-diff.ts:251-283` |
| `BuilderDiffCache` | keyed by builder id, loads via `getBuilderChanges(worktreePath)` | `views/builder-diff-cache.ts:40-82` |
| tree rows | `BuilderFileTreeItem` carries `builderId`/`worktreePath`, command `codev.openBuilderFileDiff` | `views/builder-file-tree-item.ts:85-120` |
| navigation | "where am I" = diff-inject registry entry (builder-only, keyed by worktree fs path) or `lastPosition {builderId, relPath}` | `commands/diff-nav.ts:96-160` |
| auto-reveal | gated on `getDiffInjectEntry(fsPath)` → `hosts.revealFile(builderId, …)` | `extension.ts:862-897` |
| nav keybindings | `when: codev.activeEditorIsBuilderFile` | `apps/vscode/package.json:1268-1277` |

Builder-only surfaces (forward lenses, comment-for-builder, the pending review queue, the
`builder-active` hook) all key off the **diff-inject registry** (`getDiffInjectEntry(fsPath)`, e.g.
`comments/builder-review.ts:156-160`). A PR diff is never registered there, and its right side is a
`codev-diff:` URI rather than a worktree `file:` path, so none of those surfaces can attach. That is
the isolation mechanism, and the plan keeps it deliberately (with tests).

### Forge data available today

- `GET /api/pr?number=N` (`tower-routes.ts:1695-1721`) passes the `pr-view` concept result through
  verbatim. All three shipped presets emit `headRefOid` (github `--json …headRefOid`, gitlab `.sha`,
  gitea `.head.sha`; `forge-contracts.ts:197-198`), plus `baseRefName`. The SDK exposes it as
  `TowerClient.getPR()` (`packages/sdk/src/tower-client.ts:827`) returning `PRView`, which does not
  declare `headRefOid` yet.
- The overview's `pendingPRs` (`OverviewPR`) carries no SHA and stays unchanged; PR detail is only
  fetched when a row is expanded.

## Contract items

### Contract item 1 — `PRView.headRefOid` (CONFIRMED by architect main, 2026-11-27)

Add to `PRView` in `packages/types/src/api.ts:524`:

```ts
/** Full SHA of the PR's head commit as the forge sees it: GitHub `headRefOid`, GitLab `sha`,
 *  Gitea `head.sha`. A forge preset that cannot supply it omits it. */
headRefOid?: string;
```

main's four conditions, all adopted:

1. Optional, same doc comment as the server-side `PrViewResult.headRefOid`.
2. When absent, the PR row's children are a single explanatory row ("Diff unavailable: this forge
   preset does not report the PR head commit"). **No fallback** to resolving a commit from
   `headRefName` or any branch name.
3. Only this field is declared; the other optional Spec 1951 fields stay off the wire type.
4. Type declaration only in `packages/types`; all validation (full-SHA check) and policy live in
   `apps/vscode`.

No server change is needed: Tower already passes the field through.

### Fetch mechanism — forge-neutral; no second contract item required

The head commit is fetched **by SHA**, not by a forge ref name:

```
git -C <repo> fetch --no-tags origin +<headSha>:refs/codev/pr/<id>/head
git -C <repo> fetch --no-tags origin +refs/heads/<baseRefName>:refs/codev/pr/<id>/base
```

- `<headSha>` comes from the contract (`headRefOid`); `<baseRefName>` is already a forge-neutral
  `PrViewResult` field and names a branch in the base repository, so `refs/heads/<base>` is plain git,
  not a forge layout.
- No `refs/pull/N/head` (GitHub/Gitea) or `refs/merge-requests/N/head` (GitLab) appears in extension
  code.
- **Verified** against GitHub with a fork PR: fetching #1896's head `0faaaa1…` (from
  `al-global-tech`'s fork) by SHA from `origin` into `refs/codev/pr/1896/head` succeeded in a scratch
  bare repo. GitHub serves fork-PR heads by SHA because they are reachable from the base repo's
  hidden pull refs. GitLab (Gitaly) also accepts any-SHA wants. Gitea depends on server config.
- When a server refuses a SHA want, the row reads **"Fetch failed"**, with git's stderr in the
  tooltip. There is no silent fallback.

**Named, not requested:** if the owner wants Gitea-style hosts that refuse SHA wants covered, that
would need a second contract item: an optional `pr-view` field naming a fetchable head ref
(`headFetchRef?: string`, per preset: `refs/pull/N/head` / `refs/merge-requests/N/head`). Lane 1 does
**not** add or use it. I'm raising it only so the decision is explicit.

Remote: `origin`, the same assumption `getBuilderChanges` already makes (`origin/HEAD`,
`view-diff.ts:253-262`). A checkout whose `origin` is not the forge repo gets the "Fetch failed" row.

## Proposed Change

### 1. Generalise the diff primitives (`commands/view-diff.ts`)

- `SideSpec.kind` gains `'head'`: a git blob at the second commit (the PR head).
- `planResources(changes, binaryPaths, rightKind: 'file' | 'head' = 'file')`: the default keeps
  builder output byte-identical. For PRs every non-placeholder right side is `{kind:'head', path}`.
- `DiffQuery` gains optional `pr?: string` and `side?: 'base' | 'head'`, set **only** for PR URIs
  (builder URIs keep today's exact JSON, so existing `view-diff.test.ts` assertions hold). A PR
  side URI is `codev-diff:/<path>?{"wt":<repo>,"ref":<sha>,"path":<path>,"pr":<id>,"side":"base"|"head"}`.
  So **PR, commit, path and side are recoverable from every PR document URI**, which is the lane-2
  anchoring requirement. Empty/binary placeholders on a PR diff carry `pr` + `side` too, so a deleted
  or binary file is still identifiable as a PR document.
- `diffUrisForChange(plan, ctx)`: `ctx` gains optional `headRef` and `prId`. The `'head'` kind
  resolves to `codev-diff` with `ref = headRef`. The existing `DiffContentProvider` already serves it
  (`git -C wt show <ref>:<path>`). Content is keyed by immutable SHAs, so cached documents can't go
  stale.
- New `decodePullRequestDiffUri(uri)` returns `{ prId, relPath, sha, side } | undefined`. It's the
  single parser used by navigation, reveal and the context key.
- New `getPullRequestChanges(repo, mergeBase, headSha)` runs `git diff --name-status -M <base> <head>`
  plus `--numstat`, reusing `parseNameStatus` / `parseBinaryPaths`. This is commit-to-commit, the
  diff the forge shows, and never touches a working tree.
- New `openPullRequestFileDiff(args, showOptions?)` runs `vscode.diff(left, right, "<path> (PR #N)")`.
  It deliberately does **not** call `registerFileInjectSession` or `ensureDiffEditorCodeLens`, so no
  builder lens, comment range or review-queue surface can appear.

### 2. Hidden-ref fetch + lifecycle (new `apps/vscode/src/pr-refs.ts`)

Pure-ish git helpers (all `execFile`, no shell, `GIT_TERMINAL_PROMPT=0`, `windowsHide`):

- `ensurePullRequestHead(repo, { prId, headSha, baseRefName })` →
  `{ ok: true, mergeBase } | { ok: false, kind, detail }`:
  1. Validate inputs: `prId` is `[A-Za-z0-9._-]+`; `headSha` is a full hex SHA (40 or 64 chars);
     `baseRefName` passes `git check-ref-format --branch`. This rules out refspec injection
     (`:`/`+`/`..`).
  2. If `git rev-parse --is-shallow-repository` is true, return `kind: 'shallow'`.
  3. If `refs/codev/pr/<id>/head` already equals `headSha`, skip both fetches (no network).
     Otherwise fetch the head by SHA (failure → `'fetch-failed'`), then fetch the base branch
     (failure → `'base-missing'`). The base is fetched only when the head moves. A base tip that
     advances with an unchanged head can't change `merge-base(base, head)`, unless the head itself
     merged the newer base, which moves the head.
  4. `git merge-base refs/codev/pr/<id>/base <headSha>`; failure → `'no-merge-base'`.
- `prunePullRequestRefs(repo, openIds)` reads `git for-each-ref refs/codev/pr/` and runs
  `git update-ref -d` on every ref whose id isn't open.
- Calls are deduped per PR: concurrent expansions of the same PR share one in-flight promise.

Nothing is checked out, no `refs/heads/*` branch is created, and no hook runs (`git fetch` runs no
hooks). `git status` is unaffected because refs outside `refs/heads` don't touch the index or the
working tree.

### 3. Generalise the cache (`views/builder-diff-cache.ts`)

Keep the class (and its name, to avoid churn across about ten call sites). Internally it's keyed by a
**source key** (`builder:<id>` | `pr:<id>`). The existing `getDiff(builderId, worktreePath)` path is
untouched and keeps its 15s TTL. New methods:

- `getPullRequestDiff(pr: { id, repo }, loadPR: () => Promise<PRView | null>)` →
  `PullRequestDiffResult { headSha, baseRef /* merge-base */, files, error?, errorKind?, fileCount? }`.
  The flow on a TTL miss (60s; each miss costs one forge call via Tower): `loadPR()`.
  - `null` → `'forge-unavailable'`
  - missing or non-SHA `headRefOid` → `'no-head-commit'`
  - otherwise `ensurePullRequestHead` → `getPullRequestChanges` → `planResources(…, 'head')`
  - more than 3000 files → `'too-large'` (GitHub's own per-PR file-list cap). Rows aren't built, but
    the count is kept for the label.
- Decorations: PR files register in the **same** `uri → status` map via a new
  `pullRequestFileResourceUri(repo, prId, rel)` (same `codev-builder-diff` scheme and synthetic path,
  query `pr=<id>&repo=…`, distinct from any builder's). `BuilderFileDecorationProvider` therefore
  needs **no change**, and the #799 grey-tint fix applies to PR rows for free.
- `invalidatePullRequest(id)` and `retainPullRequests(openIds)` drop cache entries and decorations
  for PRs that closed.

**Freshness.** Every TTL miss re-reads `headRefOid`. A moved head triggers a fetch and a new file
list, and new clicks open diffs against the new SHA. An already-open diff tab keeps its URIs, which
embed the old SHAs, so it is **never swapped under the reader**. The Pull Requests view's existing
refresh button (`codev.refreshOverview`) also invalidates PR diff entries, for an on-demand re-check.

### 4. Tree rows (`views/builder-file-tree-item.ts`, `builder-folder-tree-item.ts`, new `views/pull-request-file-tree-item.ts`)

- Extract the shared row presentation into a base `ChangedFileTreeItem`: basename label, dir
  description with the `↤ oldPath` rename source, status tooltip, `resourceUri`. `BuilderFileTreeItem`
  extends it with **identical** fields, id, `contextValue: 'builder-file'` and command, so builder
  tests stay green unchanged. The folder row gets the same treatment.
- `PullRequestFileTreeItem extends ChangedFileTreeItem` carries `{ prId, repo, headSha, baseRef,
  change, plan }`, `id = pr:<id>::<rel>`, `contextValue: 'pull-request-file'` and command
  `codev.openPullRequestFileDiff`. `PullRequestFolderTreeItem` has `id = pr:<id>::folder::<path>`.
  The distinct context values keep every `viewItem == builder-file` menu (builder-only actions) off
  PR rows.

### 5. Pull Requests view (`views/pull-requests.ts`)

- PR rows become `Collapsed` with a stable `id` (`pr:<id>`) and **no `command`**, so a click toggles
  expansion. A collapsed row has no `getChildren` call, which means no git and no forge call.
- `getChildren(prRow)` calls `diffCache.getPullRequestDiff(...)` and renders a flat list or a folder
  tree per `codev.buildersFileViewAsTree`, reusing `buildFilePathTree`. The existing setting is shared
  (as the issue asks), and its title-bar toggle buttons are also contributed to `codev.pullRequests`.
- Failure rows: visible, non-expandable placeholder rows with tooltip detail:

  | errorKind | Row label |
  |---|---|
  | `no-head-commit` | Diff unavailable: this forge preset does not report the PR head commit |
  | `forge-unavailable` | Forge unavailable: could not load PR details |
  | `fetch-failed` | Fetch failed: could not fetch the PR head commit (tooltip: git stderr) |
  | `base-missing` | Base branch `<name>` not found on origin |
  | `shallow` | Shallow clone: run `git fetch --unshallow` to view PR diffs |
  | `no-merge-base` | No common history with `<base>` |
  | `too-large` | Diff too large to list (N files). Click to open in browser |
  | (empty) | No changed files |

- `getParent` (required for `TreeView.reveal`) and `findFileItem(prId, relPath)` follow
  `architect-tree.ts:346-389`.
- When an overview update arrives whose `errors?.prs` is absent (so a forge outage never deletes refs),
  `prunePullRequestRefs` and `retainPullRequests` run for the set of no-longer-open ids.
- The provider refreshes on `codev.buildersFileViewAsTree` changes.

### 6. Row actions (`package.json`, `extension.ts`)

- New `codev.openPullRequestInBrowser` (icon `$(link-external)`) appears inline on
  `viewItem == pull-request` and in the row context menu, so the browser open still has an explicit
  affordance now that a click expands. `codev.referencePRInArchitect` keeps its inline slot unchanged.
- New `codev.openPullRequestFileDiff` (hidden from the palette) receives a `PullRequestFileTreeItem`,
  calls `openPullRequestFileDiff` and records the navigation position.

### 7. Keyboard navigation (`commands/diff-nav.ts`, `package.json`)

- The retained position becomes `{ source: { kind: 'builder', builderId } | { kind: 'pr', prId },
  relPath }`. `recordDiffNavPosition(builderId, relPath)` keeps its signature as a builder wrapper,
  and `recordPullRequestNavPosition(prId, relPath)` is added.
- `resolveDiffContext`:
  - The **active tab** is checked first. If it's a `TabInputTextDiff` whose modified (or original)
    URI decodes via `decodePullRequestDiffUri`, the source is that PR.
  - Otherwise behaviour is today's: diff-inject entry, then `lastPosition`.
  - For a PR, the ordered list comes from `diffCache.getPullRequestDiff` plus the same
    `navigationOrder(files, viewAsTree)`, so the walk follows the **visible list order** and wraps
    via the existing `computeNavTarget`.
- `openDiffAt` dispatches to `openPullRequestFileDiff(…, { preview: true })` for a PR source.
- `navigateBuilderDiffToFirst` and `openBuilderDiffLocation` stay builder-only (explicit builder-id
  entry points).
- A new context key, `codev.activeTabIsPullRequestDiff`, is set from the active tab via
  `decodePullRequestDiffUri` on active-editor and tab changes. The `diffNextFile` / `diffPreviousFile`
  keybinding `when` becomes `codev.activeEditorIsBuilderFile || codev.activeTabIsPullRequestDiff`.
  `codev.diffFirstFile` works through its existing command path.

### 8. Sidebar follows the editor (`extension.ts`)

A sibling of `revealActiveBuilderFile`: `revealActivePullRequestFile` decodes the active diff tab.
When it is a PR document and `codev.buildersAutoReveal` is on, it calls
`pullRequestsView.reveal(findFileItem(prId, relPath), { select: true, expand: true, focus: false })`,
with the same `stillCurrent` guard against rapid navigation. It's triggered on
`onDidChangeActiveTextEditor` and `tabGroups.onDidChangeTabs`; PR diffs have no registry event. It
fires no `builder-active` activity, because a PR is not a builder.

## Files to Change

- `packages/types/src/api.ts:524-540`: `headRefOid?: string` on `PRView` (contract item 1).
- `apps/vscode/src/commands/view-diff.ts`: `'head'` side kind, `rightKind` param, `pr`/`side` query
  fields, `decodePullRequestDiffUri`, `getPullRequestChanges`, `openPullRequestFileDiff`.
- `apps/vscode/src/pr-refs.ts` (new): `ensurePullRequestHead`, `prunePullRequestRefs`, input
  validation, the `refs/codev/pr/` namespace constant.
- `apps/vscode/src/views/builder-diff-cache.ts`: source-keyed entries, `getPullRequestDiff`,
  `invalidatePullRequest`, `retainPullRequests`, in-flight dedupe.
- `apps/vscode/src/views/builder-file-tree-item.ts`, `builder-folder-tree-item.ts`: extract
  `ChangedFileTreeItem` / folder base. Builder subclasses stay unchanged in behaviour.
- `apps/vscode/src/views/pull-request-file-tree-item.ts` (new): PR file/folder rows +
  `pullRequestFileResourceUri`.
- `apps/vscode/src/views/pull-requests.ts`: expandable rows, children, failure rows, `getParent`,
  `findFileItem`, ref pruning.
- `apps/vscode/src/commands/diff-nav.ts`: source-generalised position and resolution, PR dispatch.
- `apps/vscode/src/extension.ts`:
  - provider deps (diff cache, `getPR` via the connection manager, workspace path)
  - the two new commands
  - the PR reveal and context-key sync
  - refresh invalidation
  - tree-mode refresh hookup
- `apps/vscode/package.json`:
  - command contributions (`openPullRequestInBrowser`, `openPullRequestFileDiff` hidden)
  - inline and context menu items on `pull-request`
  - view/title tree-list toggles for `codev.pullRequests`
  - keybinding `when` clauses
- Tests (below). The changelog is left to the architect's post-merge changelog workflow, per this
  repo's convention.

## Risks & Alternatives Considered

- **Risk: SHA fetch refused by a host** (some Gitea configs). This is mitigated by the visible
  "Fetch failed" row with stderr, and the named optional `headFetchRef` contract item if the owner
  wants that covered.
- **Risk: a forge call per expanded PR per TTL.** This is bounded by the 60s TTL, and only expanded
  rows pay it. Collapsed rows cost nothing.
- **Risk: a large fetch for a far-diverged PR on first expand.** It's a one-time, incremental object
  download into the main repo, run async with the tree showing VS Code's loading indicator.
- **Risk: stale refs if Tower is down for a long time.** Pruning runs only on a successful PR list,
  so refs can outlive a closed PR until the next good poll. They're harmless (hidden, unreachable
  from branches).
- **Risk: builder regressions from the shared extraction.** Builder defaults are preserved exactly
  (`rightKind` defaults to `'file'`, builder query JSON unchanged, subclass ids and context values
  unchanged), and the existing builder suites stay green.
- **Alternative: copying the builder stack into a PR stack.** Rejected; the issue forbids forking it.
- **Alternative: fetching `refs/pull/N/head`.** Rejected; it hardcodes a forge's ref layout in
  extension code.
- **Alternative: resolving the head from `headRefName`.** Rejected per main's condition 2 (and it's
  wrong for forks).
- **Alternative: a temporary worktree per PR.** Rejected by the issue ("no checkout, no worktree").
- **Alternative: putting the SHA on `OverviewPR`** (no per-expand forge call). This would need a
  `pr-list` contract change across three presets, a larger contract surface than lane 1 needs. It
  could come later.

## Test Plan

**Unit (vitest, `apps/vscode/src/__tests__/`):**

- `planResources(..., 'head')`: A/M/D/R/binary plans. The default `'file'` output is unchanged
  (regression).
- `diffUrisForChange` for PR context: both sides are `codev-diff`, and the query carries
  `pr`/`side`/`ref`/`path`. `decodePullRequestDiffUri` round-trips. Builder URIs decode to
  `undefined`.
- `pr-refs` input validation: rejects a short SHA, a `prId` with `/` or `:`, and an invalid base
  branch name.
- **Real-git integration test** (temp dirs):
  - Setup: an upstream bare repo with `main` and a PR commit reachable only from an unadvertised ref
    (simulating a fork PR's hidden ref), plus a clone.
  - `ensurePullRequestHead` produces `refs/codev/pr/7/{head,base}` and the correct merge-base.
  - After it, `git branch --list` and `git status --porcelain` are unchanged, and `HEAD` is unchanged.
  - A second call with the same SHA performs no fetch.
  - A moved head triggers a refetch.
  - `getPullRequestChanges` lists the A/M/D/R entries.
  - `prunePullRequestRefs` deletes closed ids only.
  - A shallow clone yields `'shallow'`, and a missing base branch yields `'base-missing'`.
- Cache: `getPullRequestDiff` error kinds (`null` PR, missing/invalid `headRefOid`, over 3000 files),
  TTL reuse, a head change producing a new list, decorations registered and pruned via
  `retainPullRequests`.
- `PullRequestsProvider`: rows are collapsible with no command, children are flat versus tree,
  failure rows, `getParent`/`findFileItem`, and no pruning when `errors.prs` is set.
- `diff-nav`: a PR active tab resolves the PR source, next/prev follow tree order and wrap, and a
  deleted-file placeholder still resolves.
- Isolation: a PR document never satisfies `getDiffInjectEntry`, so there are no commenting ranges,
  no forward lenses, and no `builder-active` event.
- Existing builder suites (`builder-file-tree-item`, `view-diff`, `diff-nav`, `builders-autoreveal`,
  …) pass unchanged. `pnpm check-types` and `pnpm lint` are clean.

**Manual (owner, dev host, `dev-approval`):**

1. Open the Pull Requests view. Clicking a PR row expands it into its files (status letters, file
   icons, rename `↤`, binaries shown as "Binary file — not shown"). Compare the list with the PR's
   "Files changed" on the forge.
2. Click files: left = merge-base, right = head. Both are read-only. Compare a few hunks with the
   forge.
3. Expand a **fork** PR (e.g. #1896). It works. Afterwards `git branch` shows nothing new, there's no
   new worktree, `git status` is unchanged, and `git for-each-ref refs/codev/pr/` lists the hidden
   refs.
4. Use `Ctrl+Alt+]` / `Ctrl+Alt+[` in a PR diff. It walks the visible order and wraps. Toggle tree
   vs list and repeat.
5. With auto-reveal on, navigating highlights the matching row without stealing focus. With
   `codev.buildersAutoReveal` off, it doesn't.
6. The inline Open in Browser and Reference in Architect buttons both work on a PR row.
7. No Forward to Builder lens, comment `+` gutter or review-queue entry appears on a PR diff.
8. Push to a PR branch, then wait 60s or press refresh. The list reflects the new head. An
   already-open diff tab is unchanged; newly opened diffs show the new head.
9. Close or merge a PR, then refresh. Its `refs/codev/pr/<id>/*` refs are gone.
10. Builders group: expand a builder, click files, navigate, auto-reveal. Behaviour is unchanged.

Cross-platform: all git calls go through `execFile` with arguments, with no shell or path joins on
refs. There is no platform-specific code, so no Windows workflow dispatch is needed unless review
finds one.
