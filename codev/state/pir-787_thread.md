# PIR #787 — vscode PR sidebar sort + draft badge

## Plan phase (2026-06-07)

Investigated the data flow. Key findings:
- `views/pull-requests.ts` does a bare `.map` over `data.pendingPRs`, no sort. This is where the comparator + draft badge go.
- `currentUser` identity is already solved: `OverviewData.currentUser`, consumed by `backlog.ts:122,156`. Reuse it.
- The two missing fields (`reviewRequests`, `isDraft`) aren't in `PrListItem` (forge-contracts.ts:64) or `OverviewPR` (types/api.ts:227). Must flow them through: forge concept → PrListItem → overview mapping (overview.ts:859) → OverviewPR → view.
- `pr-list` is a forge **shell script** (`scripts/forge/github/pr-list.sh`: `gh pr list --json ...`). Extending `--json` + jq-normalizing reviewRequests to `string[]` is the data-source change. gitlab/gitea scripts get safe defaults to keep the cross-forge contract.
- Decided against reusing Team view's GraphQL (per-member, search-scoped) — extend the existing repo-wide `pr-list` concept instead. Keeps forge abstraction intact.
- Comparator extracted to a pure exported `comparePendingPRs(a,b,me)` for testability without a VSCode host.

Plan written to `codev/plans/787-vscode-pr-sidebar-sort-mine-fi.md`. Awaiting plan-approval gate.
