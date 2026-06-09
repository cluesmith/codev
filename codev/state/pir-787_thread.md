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

## Implement phase (2026-06-08)

plan-approval approved. Implemented the 5-layer flow-through + view sort:
- `scripts/forge/github/pr-list.sh`: added `isDraft,reviewRequests` to `gh --json`; jq flattens reviewRequests objects → `[login]` (drops teams via `.login // empty`). Verified shape against live `gh` output.
- `scripts/forge/{gitlab,gitea}/pr-list.sh`: emit safe defaults `reviewRequests: []`, `isDraft: false` (surgical `. + {...}` for gitlab to avoid touching its pre-existing raw shape).
- `forge-contracts.ts` PrListItem + `types/api.ts` OverviewPR: gained `reviewRequests: string[]`, `isDraft: boolean`.
- `overview.ts:859`: maps both through with defensive `?? []` / `?? false`.
- VSCode: extracted pure `comparePendingPRs`/`sortPendingPRs` into `views/pull-requests-sort.ts` (mirrors `backlog-filter.ts` so it's testable without an Electron host); `pull-requests.ts` sorts + adds `(draft)` suffix + `git-pull-request-draft` icon.

Tests: `pull-requests-sort.test.ts` (7, all pass) covers bucket order, mine-beats-also-reviewer, createdAt-desc tiebreak, case-insensitivity, null-`me` fallback. overview mapping tests added (flow-through + defaults). Full vscode vitest: 360 pass. codev overview suite: 164 pass. types/core/codev builds + vscode check-types all green.

**Note on test runs:** an ad-hoc `vitest run` initially showed 24 failures in adopt/consult/update/cron-cli, but these were **stale build artifacts** (codev-core/types dist out of date in the worktree), not real breakage — porch's `build` check rebuilds core/types first, after which the full `npm test` (`tests` check) passed clean in 20.3s. Both porch checks green: build ✓ (7.2s), tests ✓ (20.3s).

dev-approval gate now pending — awaiting human review of the running worktree.

## gitlab refinement (2026-06-09)

User installed glab; verified the gitlab script against a live public project (`gitlab-org/cli`). Found glab's `mr list --output json` actually exposes `draft` (bool) and `reviewers[].username` — so the original `reviewRequests: []` / `isDraft: false` stub was discarding real data. Replaced with `reviewRequests: [.reviewers[]?.username]`, `isDraft: (.draft // false)`. Verified live (drafts + reviewers extracted correctly) and on null/missing edge cases. Pre-existing base-shape non-conformance (glab uses `iid`/`web_url`/`created_at`/`author.username` vs GitHub-style `number`/`url`/`createdAt`/`author.login`) left untouched — separate pre-existing concern, worth a follow-up issue if gitlab support is to be made first-class. gitea still defaults both (tea not installed, unverifiable).
