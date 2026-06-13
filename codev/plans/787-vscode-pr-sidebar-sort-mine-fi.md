# PIR Plan: VSCode PR sidebar — sort mine first, then review-requested, then others; draft badge

## Understanding

The Codev sidebar's Pull Requests view (`packages/vscode/src/views/pull-requests.ts`) renders
`data.pendingPRs` in whatever order Tower returns them (`getChildren()` does a bare `.map`, no sort).
A reviewer scanning the list has no fast path to "my PRs" or "PRs waiting on my review" — they sit
interleaved with everyone else's. Draft PRs look identical to ready ones.

Issue #787 asks for a **single flat list** (no group headers, no collapsible sections) sorted by a
three-bucket comparator, with drafts visually marked. The "me" identity is already solved:
`OverviewData.currentUser` is populated server-side (`overview.ts:959-961`, via
`fetchCurrentUserCached`) and already consumed by `views/backlog.ts:122,156` for the assignee swap —
this view should reuse the exact same identity source.

The blocker is that the data needed for buckets 1–2 and the draft badge isn't flowed through yet:
- `PrListItem` (`forge-contracts.ts:64-73`) has `author`, `createdAt`, `reviewDecision` but **no**
  `reviewRequests` and **no** `isDraft`.
- `OverviewPR` (`packages/types/src/api.ts:227-235`) likewise carries neither.
- The GitHub data is already reachable: the Team view's GraphQL fetches both `isDraft` and
  `reviewRequests(first: 20){ nodes { requestedReviewer { ... on User { login } } } }`
  (`team-github.ts:119,122`). We don't reuse that query (it's per-team-member and search-scoped);
  instead we extend the existing `pr-list` forge concept, which already powers `pendingPRs`.

## Proposed Change

Flow `reviewRequests: string[]` and `isDraft: boolean` from the `pr-list` forge concept all the way
to the VSCode tree item, then sort + badge in the view. Five layers, bottom-up:

1. **Forge concept (data source).** Extend `gh pr list --json` to also request `isDraft` and
   `reviewRequests`, then normalize `reviewRequests` to a `string[]` of user logins via `jq` (gh
   returns objects; teams have no `login` and are dropped). The github script is the only one that
   gains real data; gitlab/gitea scripts emit safe defaults (`reviewRequests: []`, `isDraft: false`)
   so the `string[]`/`boolean` contract holds across forges.

2. **Contract type.** Add `reviewRequests: string[]` and `isDraft: boolean` to `PrListItem`.

3. **API type.** Add the same two fields to `OverviewPR` (`packages/types/src/api.ts`).

4. **Overview server mapping.** In `overview.ts:859-867`, map the new fields through with defensive
   defaults (`pr.reviewRequests ?? []`, `pr.isDraft ?? false`) so a forge that omits them never
   produces `undefined` on the wire.

5. **VSCode view.** In `pull-requests.ts` `getChildren()`:
   - Compute `me = data.currentUser?.toLowerCase()` (same idiom as `backlog.ts:122`).
   - Sort a copy of `data.pendingPRs` with the comparator below.
   - Append ` (draft)` to the label for drafts (and overlay a distinct icon — `git-pull-request-draft`
     ThemeIcon — so it's visible even when the label is truncated).

### Sort comparator

```
bucket(pr):
  if me && pr.author?.toLowerCase() === me            -> 0   (mine — wins even if I'm also a reviewer)
  if me && pr.reviewRequests.map(lower).includes(me)  -> 1   (review-requested)
  else                                                -> 2   (everything else)

compare(a, b):
  if bucket(a) !== bucket(b) -> bucket(a) - bucket(b)
  else                       -> b.createdAt.localeCompare(a.createdAt)   (createdAt DESC within bucket)
```

When `me` is undefined (gh unavailable / not authenticated), every PR lands in bucket 2, so the sort
collapses to a stable `createdAt`-desc ordering — the partitioning is skipped silently, exactly as
the acceptance criteria require. ISO-8601 `createdAt` strings compare correctly lexicographically, so
`localeCompare` gives true chronological order without `Date` parsing.

## Files to Change

- `packages/codev/scripts/forge/github/pr-list.sh` — add `isDraft,reviewRequests` to `--json`; pipe
  through `jq` to flatten `reviewRequests` to `[login]` and pass `isDraft` through.
- `packages/codev/scripts/forge/gitlab/pr-list.sh` — `jq`-normalize to add `reviewRequests: []`,
  `isDraft: false` (and the existing fields) so the contract holds.
- `packages/codev/scripts/forge/gitea/pr-list.sh:13-24` — extend the existing `jq` map with
  `reviewRequests: []`, `isDraft: false`.
- `packages/codev/src/lib/forge-contracts.ts:64-73` — add `reviewRequests: string[]`, `isDraft: boolean`
  to `PrListItem`, with doc comments noting the cross-forge defaults.
- `packages/types/src/api.ts:227-235` — add `reviewRequests: string[]`, `isDraft: boolean` to `OverviewPR`.
- `packages/codev/src/agent-farm/servers/overview.ts:859-867` — map both fields through with `?? []`
  / `?? false` defaults.
- `packages/vscode/src/views/pull-requests.ts` — add the comparator + draft badge in `getChildren()`.

### Tests

- `packages/codev/src/agent-farm/__tests__/overview.test.ts` — extend the PR-mapping tests
  (around :1829) to assert `reviewRequests`/`isDraft` flow through and default correctly when the
  forge omits them.
- `packages/codev/src/__tests__/forge.test.ts` / `github.test.ts` — update any `PrListItem` fixtures
  that fail typecheck once the fields are required.
- VSCode view comparator: extract the comparator to a small pure exported function
  (e.g. `comparePendingPRs(a, b, me)`) so it's unit-testable without a VSCode host, and add a focused
  test (mine-first, review-requested-second, createdAt-desc tiebreak, null-`me` fallback,
  mine-beats-also-reviewer). Place it next to existing vscode view tests if a harness exists; if the
  vscode package has no unit-test harness, keep the function exported and cover the comparator logic
  via a codev-side test or document the manual check.

## Risks & Alternatives Considered

- **Risk: `gh pr list --json reviewRequests` shape.** gh returns reviewRequests as objects (users
  have `login`, teams have `slug`/`name`, no `login`). Mitigation: `jq '[.reviewRequests[].login //
  empty]'` extracts user logins and silently drops teams — matches the issue's "currentUser in
  reviewRequests" (currentUser is always a user login). I'll verify the exact gh JSON shape
  empirically with `gh pr list --json reviewRequests` before finalizing the jq filter.
- **Risk: making the fields required breaks existing `PrListItem` consumers/fixtures.** Mitigation:
  required-with-default at every boundary (jq emits them for all three forges; overview mapping
  defaults defensively). Typecheck will surface any fixture that needs updating; I'll fix those.
- **Alternative: reuse the Team view's GraphQL query** (`team-github.ts`). Rejected — it's
  per-member, search-scoped, and team-oriented; the `pr-list` concept is the existing repo-wide PR
  source feeding `pendingPRs`, so extending it is the smaller, correctly-scoped change and keeps the
  forge-abstraction boundary intact (gitlab/gitea get defaults, not a GitHub-only query).
- **Alternative: group headers / collapsible sections.** Explicitly out of scope per the issue — flat
  sorted list only.
- **Alternative: sort server-side in overview.ts.** Rejected — `currentUser` identity and the
  reviewer-centric ordering are a presentation concern; `pendingPRs` is a shared payload (also feeds
  the dashboard), so the per-viewer sort belongs in the VSCode view, mirroring how `backlog.ts` does
  its own "mine" filtering client-side.

## Test Plan

- **Unit:**
  - `comparePendingPRs`: mine-first, then review-requested, then others; createdAt-desc tiebreak
    within a bucket; mine-beats-also-a-reviewer (bucket 0); null/undefined `me` → stable createdAt-desc.
  - overview mapping: `reviewRequests`/`isDraft` flow through; default to `[]`/`false` when the forge
    omits them.
- **Build:** `pnpm --filter @cluesmith/codev-types build && pnpm --filter @cluesmith/codev build`
  (types first), plus the vscode package build, all from the worktree.
- **Manual (at the `dev-approval` gate):** Open the Codev sidebar → Pull Requests view against a repo
  with a mix of (a) PR I authored, (b) PR requesting my review, (c) unrelated PRs, and (d) a draft.
  Verify: my PR is at the top, review-requested next, others last; within each bucket newest-first;
  the draft shows `(draft)` + the draft icon. Then sign out / break `gh auth` (or simulate
  `currentUser` null) and confirm the list falls back to createdAt-desc with no crash and no
  partitioning.
