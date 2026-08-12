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

## Implement phase (2026-08-12)

Plan-approval granted. Applied the one-line sort in `overview.ts` (after the
`recentlyClosed.map`, inside `if (closed !== null)`): epoch-millis descending sort with a
comment tying it to #1191. Added test `sorts recently closed items by closedAt descending
(#1191)` in `overview.test.ts` feeding items out of order and asserting `['2','3','1']`.

Build ✓. overview suite ✓ (165 tests). Full package suite ✓ (4851 passed, 48 pre-existing
skips). Committed da7a44f86. dev-approval gate reached.

## Review phase (2026-08-12)

dev-approval granted. Wrote retrospective `codev/reviews/1191-recently-closed-sidebar-sectio.md`.
No arch/lessons updates (mechanical localized fix). Opening PR next, then porch runs the
single 3-way consultation pass and fires the pr gate.
