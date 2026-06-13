# PIR Review: VSCode PR sidebar — sort mine first, then review-requested, then others; draft badge

Fixes #787

## Summary

The Codev sidebar's Pull Requests view rendered `data.pendingPRs` in arbitrary forge order, with no fast scan-path to the reviewer's own PRs or the ones awaiting their review, and no way to tell drafts apart. This change flows two new fields (`reviewRequests: string[]`, `isDraft: boolean`) from the `pr-list` forge concept through `PrListItem` → `OverviewPR` → the overview-server mapping, then sorts the view into a single flat list (mine → review-requested → others, newest-first within each bucket) and marks drafts with a `(draft)` suffix plus a draft icon. The "me" identity reuses the already-populated `OverviewData.currentUser` (same source the backlog view uses), so no new lookup was added.

## Files Changed

- `packages/codev/scripts/forge/github/pr-list.sh` (+9 / -2) — add `isDraft,reviewRequests` to `gh --json`; jq flattens reviewer objects to logins
- `packages/codev/scripts/forge/gitlab/pr-list.sh` (+10 / -2) — populate `isDraft`/`reviewRequests` from glab's real `draft`/`reviewers[].username`
- `packages/codev/scripts/forge/gitea/pr-list.sh` (+13 / -2) — default both fields (`tea pulls list` exposes neither); documented rationale
- `packages/codev/src/lib/forge-contracts.ts` (+9 / -0) — `PrListItem` gains `reviewRequests` + `isDraft`
- `packages/types/src/api.ts` (+9 / -0) — `OverviewPR` gains `reviewRequests` + `isDraft`
- `packages/codev/src/agent-farm/servers/overview.ts` (+2 / -0) — map both through with `?? []` / `?? false`
- `packages/codev/src/agent-farm/__tests__/overview.test.ts` (+26 / -0) — flow-through + default coverage
- `packages/vscode/src/views/pull-requests-sort.ts` (+46 / -0, new) — pure `comparePendingPRs` / `sortPendingPRs`
- `packages/vscode/src/views/pull-requests.ts` (+9 / -1) — sort + draft badge in `getChildren()`
- `packages/vscode/src/__tests__/pull-requests-sort.test.ts` (+85 / -0, new) — comparator unit tests

(Plus `codev/plans/787-*.md`, `codev/reviews/787-*.md`, `codev/state/pir-787_thread.md`, `codev/resources/lessons-learned.md`, and porch `status.yaml`.)

## Commits

- `21ff84bb` [PIR #787] Flow reviewRequests + isDraft through pr-list forge concept
- `a1d3f9a5` [PIR #787] Carry reviewRequests + isDraft through OverviewPR mapping
- `c4aa15f5` [PIR #787] Sort PR sidebar (mine/review-requested/others) + draft badge
- `d5d20b70` [PIR #787] Update builder thread for implement phase
- `226fc6d9` [PIR #787] Correct thread note: test failures were stale artifacts
- `fddc7b98` [PIR #787] Populate gitlab reviewRequests + isDraft from real glab fields
- `f1df53b6` [PIR #787] Update thread: gitlab fields now populated from glab
- `8195ee4b` [PIR #787] Document verified rationale for gitea reviewRequests/isDraft defaults
- `841ad23d` [PIR #787] Update thread: gitea verified against docs, defaults correct

## Test Results

- `npm run build`: ✓ pass (porch `build` check, 7.2s)
- `npm test`: ✓ pass (porch `tests` check, 20.3s)
- vscode vitest suite: ✓ 360 pass (7 new in `pull-requests-sort.test.ts`)
- codev overview suite: ✓ 164 pass (2 new mapping tests)
- vscode `check-types` (tsc --noEmit): ✓ pass
- Manual verification (human, at `dev-approval` gate): reviewed the running worktree and approved.
- Forge field verification: github verified live (PR #593) + `gh --json`; gitlab verified live against `gitlab-org/cli` + GitLab docs; gitea verified via `tea --help` + official Gitea tea CLI docs.

## Architecture Updates

No `arch.md` changes needed. This change rides two patterns already documented there: the forge-concept abstraction (`arch.md` §"forge concept commands") and the VSCode host-side pure-helper pattern for testable view logic (`arch.md` #920/#1067 — `views/backlog-filter.ts`). `pull-requests-sort.ts` mirrors that exact pattern; no new module boundary or architectural concept was introduced — two fields were added to an existing contract.

## Lessons Learned Updates

Added one entry to `codev/resources/lessons-learned.md` ([From 787]): when adding a field to a multi-forge concept contract, per-CLI data availability diverges (`gh` and `glab` expose draft/reviewers; `tea pulls list` does not) — verify each empirically rather than assuming parity, populate where the existing command can, default safely where it can't, and document the verified reason. This was the non-obvious finding of the work and is reusable for anyone extending `pr-list` / `issue-list` / similar concepts.

## Things to Look At During PR Review

- **The comparator** (`pull-requests-sort.ts`): bucket 0 = mine (`author === me`, wins even if I'm also a reviewer), 1 = review-requested (`me ∈ reviewRequests`), 2 = others; `createdAt`-desc tiebreak via lexicographic compare on ISO-8601 strings (no `Date` parsing). `me` undefined → all bucket 2 → stable createdAt-desc fallback (the gh-unavailable case from the acceptance criteria). Identity matching is case-insensitive.
- **github jq filter**: `[.reviewRequests[].login // empty]` keeps user reviewers and drops team reviewers (Team nodes have no `.login`). Verified against real PR #593 and a mixed user+team sample.
- **gitea defaults are deliberate, not a stub oversight**: `tea pulls list`'s selectable `--fields` omit draft/reviewers, and its JSON is field-limited, so the data is unreachable via that command (only via raw `tea api`). The script comment records this. github + gitlab are fully populated.
- **Defensive defaults at the server boundary** (`overview.ts`: `?? []` / `?? false`) mean a forge that omits the fields degrades cleanly instead of emitting `undefined` on the wire.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-787 → **Review Diff**
- **Run dev server**: VSCode sidebar → **Run Dev Server**, or `afx dev pir-787`
- **What to verify**:
  - In the Pull Requests view, against a repo with a mix of authored / review-requested / unrelated PRs plus a draft: your PRs sort first, review-requested next, others last; newest-first within each bucket; the draft shows `(draft)` + the draft icon.
  - Break `gh auth` (or simulate `currentUser` null) and confirm the list falls back to createdAt-desc with no partitioning and no crash.
