# pir-2008 thread — PR review lane 1 (read-only PR diffs in the Pull Requests group)

## 2026-11-28 — plan phase
- Contract item 1 (PRView.headRefOid?) confirmed by architect main via architect vscode, with four conditions (optional + same doc; degrade, never guess from branch name; only this field; types-only). Folded into the plan.
- Fetch mechanism: by SHA from origin into refs/codev/pr/<id>/{head,base}. Verified on GitHub with fork PR #1896 (scratch bare repo). No forge ref layout in extension code; an optional `headFetchRef` pr-view field is named as a possible second contract item but NOT requested.
- Isolation from builder-only surfaces relies on PR diffs never entering the diff-inject registry (right side is codev-diff:, not file:).
- Plan at codev/plans/2008-vscode-pull-requests-group-sho.md; waiting at plan-approval.

## 2026-11-28 — implement phase
- plan-approval approved by the owner (relayed by architect vscode); headFetchRef explicitly out of scope.
- Shape as built: diff-query.ts (codev-diff identity + PR decoder, kept git-free so nav/reveal don't import the git layer); pr-refs.ts (fetch-by-SHA into refs/codev/pr/<id>/{head,base}, validation, prune); BuilderDiffCache.getPullRequestDiff (60s TTL, in-flight dedupe, shared decoration map); ChangedFileTreeItem base shared by builder + PR rows; PullRequestsProvider rows collapsible; diff-nav position is builder|pr.
- findParentNode moved to file-path-tree.ts (pure) and re-exported from architect-tree.ts so builders.ts/tests keep their import.
- Tests: real-git fixture (bare upstream with hideRefs + allowAnySHA1InWant = fork-PR simulation) backs pr-refs + cache tests. Two test expectations I wrote were wrong (head == base tip diffs to nothing; uncompacted `src` folder) — code was right.
- Updated contributes-commands keybinding assertion + contributes-cockpit snapshot (intended package.json changes).
