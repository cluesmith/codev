# PIR Review: Sort Recently Closed by closedAt descending

Fixes #1191

## Summary

The Codev sidebar's **Recently Closed** section listed items in the forge search API's
relevance ("best match") order, so an item closed this morning could render below one closed
the previous day. This PR sorts the assembled `recentlyClosed` list by `closedAt` descending
in the shared overview-assembly layer (`overview.ts`), fixing ordering for every forge at
once since `closedAt` is present on every item.

## Files Changed

- `packages/codev/src/agent-farm/servers/overview.ts` (+9 / -0): sort `recentlyClosed` by `closedAt` descending after assembly
- `packages/codev/src/agent-farm/__tests__/overview.test.ts` (+17 / -0): regression test asserting descending order from an out-of-order fixture

## Commits

- `da7a44f86` [PIR #1191] Sort Recently Closed by closedAt descending
- `b33ac8f4c` [PIR #1191] thread: implement phase

## Test Results

- `pnpm --filter @cluesmith/codev build`: ✓ pass
- `pnpm --filter @cluesmith/codev test`: ✓ pass (4851 passed, 48 pre-existing skips; 1 new test)
- Manual verification: the running worktree was reviewed and the `dev-approval` gate was granted.

## Architecture Updates

No arch changes: this is a localized ordering fix at an existing assembly point. It does not
change module boundaries, the forge abstraction, or any invariant. The fact that ordering
belongs in the shared assembly layer (not per-forge scripts) is already implied by the
existing single-assembly design.

## Lessons Learned Updates

No lessons captured: the change was a mechanical, well-scoped fix. The one reusable insight
(sort shared, forge-normalized fields in the assembly layer rather than patching each
provider script) is a narrow recipe, not a cross-cutting rule worth a hot/cold entry.

## Things to Look At During PR Review

- The sort parses `closedAt` to epoch millis (`new Date(x.closedAt).getTime()`) rather than
  comparing ISO strings lexicographically. Deliberate: provider scripts
  (github/gitlab/gitea/linear) aren't guaranteed to emit a normalized `Z`-suffixed form, and
  this matches how the existing 24h-window filter (`github.ts:216`) interprets `closedAt`.
- No `NaN` guarding: every item reaching the sort has already passed
  `fetchRecentlyClosed`'s `i.closedAt && new Date(i.closedAt).getTime() >= cutoff` filter, so
  `closedAt` is always present and parseable here.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1191 → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1191`
- **What to verify**: open the Codev sidebar → **Recently Closed**; items appear
  most-recently-closed first (an item closed this morning sits above yesterday's). Compare
  against `gh issue list --state closed --search "closed:>$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ)"`.
