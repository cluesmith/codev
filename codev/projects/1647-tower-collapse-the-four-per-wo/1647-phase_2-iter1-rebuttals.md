# Phase 2, iteration 1: review dispositions

Both lanes: **APPROVE**, confidence HIGH. Codex raised no issues. Claude raised three
non-blocking gaps and two notes. Gaps 1 and 2 and the first note were fixed in place. Gap 3
and the second note need no change. Nothing is rebutted.

| # | Finding (claude) | Disposition |
|---|---|---|
| 1 | The churn half of the projection is not pinned: inlining `60_000` for `INVALIDATE_DEBOUNCE_MS` in `overview.ts` breaks no test | **Fixed.** New test: after `invalidate()`, `pr-list` does not refetch at `INVALIDATE_DEBOUNCE_MS - 1` and does at `INVALIDATE_DEBOUNCE_MS`. Mutation check: replacing the constant with `60_001` turns exactly this test red. |
| 2 | `describeOverviewPlan`'s disabled-only bypass branch and a 3-item `joinWithAnd` are uncovered | **Fixed.** Two new rows: `bypasses the disabled recently-merged`, and `four calls: pr-list, issue-list and recently-closed overridden`. |
| 3 | The doctor `overview-bundle` row test proves rendering against the mocked resolution, not real resolution | No change. Real resolution of the row is pinned in `forge.test.ts` (Phase 1), and the doctor overview-line tests already run the real `resolveOverviewPlan`. |
| 4 | Note: the `provider === undefined` arm of the disabled-bundle cause is unreachable | **Fixed.** A comment says it exists for type narrowing. |
| 5 | Note: doctor's separator is ` — `, not the plan's `:` | No change. The reason is recorded in the thread. |

After the fixes: 32 tests in `spec-1647-overview-plan.test.ts` pass.
