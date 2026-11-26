# Plan iteration 1: disposition of review findings

Both reviewers returned REQUEST_CHANGES. Every finding was checked against the code and
**accepted**; none is rebutted. Where a finding made a factual claim about the code, the
check that confirmed it is noted.

## codex (REQUEST_CHANGES, HIGH)

| # | Finding | Disposition |
|---|---|---|
| 1 | Item validation (`number` + `title`) is weaker than the spec's "each section conforms to its existing item contract" | Accepted. Phase 1 now validates every required field, and every optional field present, against `PrListItem` / `IssueListItem` / `MergedPrItem`, nested shapes included. Errors name the section, index and field. One test per contract |
| 2 | "neither both arrays nor `windowsError`" permits both at once | Accepted. Exactly one of the two is required; arrays together with `windowsError` is non-conforming. Tested |
| 3 | `orderBy: CREATED_AT DESC` is not valid GraphQL | Accepted. Written as `{field: CREATED_AT, direction: DESC}`, and Step 1 confirms it matches gh's ordering so the caps keep the same items |

## claude (REQUEST_CHANGES, HIGH)

| # | Finding | Disposition |
|---|---|---|
| 1 | The 30 s dispatcher timeout now covers every page of every section | Accepted (confirmed at `forge.ts:417`). The bundle fetch passes an explicit 60 s budget, a named constant. The script prints only after the last page, so a timeout is an honest failure. Stub test with a sleeping second page |
| 2 | `deepMerge` deletes `null`, so `"overview-bundle": null` can be lost when a lower config layer has a `forge` object; fixtures depend on `$HOME` | Accepted (confirmed at `config.ts:263-267`). This is a pre-existing bug that breaks every documented concept disable for those users. **Fixed in place** in Phase 2: the `forge` section merges key by key with null kept as "disabled". Every other key keeps `deepMerge` semantics. Tests no longer trust on-disk config to pick their path: they mock `overviewPath` or assert the resolved path first |
| 3 | Spec test 21's dashboard render is missing | Accepted, placed in the **verify phase**. The suggested e2e suite defaults to the live Tower on 4100, which runs the installed build, and its global setup activates a workspace there. A second Tower would share `global.db`. So: payload deep-equality on real data in Phase 2 (the dashboard renders only from the payload), then a read-only Playwright render check after the human-approved Tower restart onto the merged build |
| 4 | Window search qualifiers and `SearchResultItem` fragments unspecified; a field diff cannot catch PRs leaking into `recentlyClosed` | Accepted. Step 0 names `is:issue is:closed closed:>T` / `is:pr is:merged merged:>T` and the `... on Issue` / `... on PullRequest` fragments. Step 1 adds a same-item-set-by-number assertion per section |
| 5 | The whole-call-failure divergence should reach the architect, not only the plan | Accepted. Raised as an explicit question in the plan-gate message and recorded in the thread |
| 6 | `ISSUE_CONCEPTS` side effect on linear/jira overrides | Accepted. Code comment plus a test pinning both behaviours: an override drops the id kind; a preset disable does not |
| 7 | `windowsError` → `noteFailure` is unreachable from GitHub | Accepted. Kept as defence in depth for adopter bundles, tested at the contract level with a fake bundle, and not claimed as GitHub coverage |
| 8 | Conformance misses `closedAt`/`mergedAt` on the windows | Accepted. Both required as parseable dates; a missing one is reported, not silently filtered out by `withinLast24h` |
