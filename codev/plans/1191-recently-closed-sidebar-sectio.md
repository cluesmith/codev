# PIR Plan: Sort Recently Closed by closedAt descending

## Understanding

The **Recently Closed** section in the Codev sidebar lists items in whatever order the
forge returns them. For GitHub that order is the search API's default relevance ("best
match") ranking, not closure time — verified empirically in the issue: an item closed at
08:00Z today renders *below* items closed the previous day.

**Root cause.** No layer in the chain imposes an ordering:

- `packages/codev/scripts/forge/github/recently-closed.sh` runs
  `gh issue list --state closed --search "closed:>$SINCE"`; `--search` delegates to
  GitHub's search API, whose default sort is relevance.
- `fetchRecentlyClosed` (`packages/codev/src/lib/github.ts:210-218`) filters to the 24h
  window but does not reorder.
- `overview.ts` (`packages/codev/src/agent-farm/servers/overview.ts:963-985`) maps the
  fetched list into `OverviewRecentlyClosed[]` **in fetched order**, preserving it.
- `apps/vscode/src/views/recently-closed.ts` renders `data.recentlyClosed` as-is.

`closedAt` is already an ISO-8601 string on every closed item
(`ClosedIssue.closedAt: string` — `packages/codev/src/lib/github.ts:266`; and on the
output type `OverviewRecentlyClosed.closedAt: string` —
`packages/types/src/api.ts:282`), for every forge. So a single sort at the assembly point
fixes ordering for all forges at once.

## Proposed Change

Sort the assembled `recentlyClosed` array by `closedAt` **descending** (most recently
closed first) in `overview.ts`, immediately after the `.map()` that builds it and before
it is placed on the `OverviewData` result.

Sort using parsed timestamps (`new Date(x.closedAt).getTime()`) rather than lexicographic
string comparison. ISO-8601 UTC strings do sort correctly lexicographically, but the forge
scripts are provider-specific and not guaranteed to emit a normalized `Z`-suffixed form for
every forge (gitlab/gitea/linear); parsing to epoch millis is unambiguous and matches how
the 24h-window filter already interprets `closedAt`
(`github.ts:216` uses `new Date(i.closedAt).getTime()`).

This is product code in `packages/codev` (the server that assembles the overview), not a
framework template file, so there is **no** `codev-skeleton/` twin to mirror.

## Files to Change

- `packages/codev/src/agent-farm/servers/overview.ts:985` — after the
  `recentlyClosed = closed.map(...)` block (inside `if (closed !== null)`), append
  `recentlyClosed.sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime());`
  with a short comment explaining the forge search APIs return relevance order, not
  closure order (issue #1191).
- `packages/codev/src/agent-farm/__tests__/overview.test.ts` — add a test that mocks
  `fetchRecentlyClosed` with items whose `closedAt` values are deliberately out of order
  and asserts `data.recentlyClosed` comes back in descending `closedAt` order.

## Risks & Alternatives Considered

- **Risk:** an item with a malformed/absent `closedAt` would parse to `NaN` and sort
  unpredictably. Mitigation: `fetchRecentlyClosed` already filters on
  `i.closedAt && new Date(i.closedAt).getTime() >= cutoff`, so any item reaching this
  point has a valid, parseable `closedAt`. No extra guarding needed.
- **Alternative — patch each forge script with a `sort:` qualifier
  (`--search "... sort:updated"` etc.):** rejected. It multiplies the fix across four
  provider scripts (github/gitlab/gitea/linear), each with different sort grammar, and
  GitHub's search `sort:` options don't include a true `closed`-time sort anyway (only
  created/updated/comments). Sorting on the already-present `closedAt` field in the shared
  assembly layer is one change that is correct for every forge.
- **Alternative — sort in the VS Code view (`recently-closed.ts`):** rejected. The view is
  a presentation layer; ordering the data at the server keeps every consumer (view, any
  future API client) consistent and matches where the data is shaped.

## Test Plan

- **Unit test** (`overview.test.ts`): mock `fetchRecentlyClosed` to return three items with
  `closedAt` timestamps in non-descending order (e.g. yesterday, today-08:00Z,
  two-days-ago). Assert `data.recentlyClosed.map(i => i.id)` equals the ids in
  most-recent-first order. Run:
  `pnpm --filter @cluesmith/codev test overview` (from the worktree).
- **Regression:** existing `overview.test.ts` recentlyClosed cases must still pass (they
  use single-item or find-by-id assertions, so order-agnostic).
- **Manual (dev-approval gate):** run the worktree, open the Codev sidebar → Recently
  Closed section, confirm items are ordered most-recently-closed first (the item closed
  earliest today appears above yesterday's). The reviewer can compare against
  `gh issue list --state closed --search "closed:>$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ)"`
  sorted by `closedAt`.
- **Cross-forge:** logic is forge-agnostic (operates on the normalized `closedAt` field);
  no per-forge manual verification required.
