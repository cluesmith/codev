# Builder pir-1191 — Recently Closed sorted by recency (Issue #1191)

## Plan phase (2026-08-12)

Investigated the chain: forge script `gh issue list --search` returns relevance order →
`fetchRecentlyClosed` filters the 24h window but doesn't reorder → `overview.ts` maps in
fetched order → VS Code view renders as-is. Confirmed `closedAt` is an ISO string on both
`ClosedIssue` (github.ts:266) and the output `OverviewRecentlyClosed` (api.ts:282), present
on every forge's items.

Decision: sort by `closedAt` descending once, at the assembly point in `overview.ts`
(after the `.map`, ~line 985). One change, correct for all forges, no `codev-skeleton/`
twin (product code, not framework template). Chose epoch-millis sort (`new Date().getTime()`)
over lexicographic to stay robust to non-normalized forge timestamps, matching the existing
24h-filter comparison.

Existing test harness in `overview.test.ts` mocks `fetchRecentlyClosed` — will extend with
an out-of-order fixture asserting descending order.

Plan written and committed. Awaiting plan-approval gate.
