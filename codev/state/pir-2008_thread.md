# pir-2008 thread — PR review lane 1 (read-only PR diffs in the Pull Requests group)

## 2026-11-28 — plan phase
- Contract item 1 (PRView.headRefOid?) confirmed by architect main via architect vscode, with four conditions (optional + same doc; degrade, never guess from branch name; only this field; types-only). Folded into the plan.
- Fetch mechanism: by SHA from origin into refs/codev/pr/<id>/{head,base}. Verified on GitHub with fork PR #1896 (scratch bare repo). No forge ref layout in extension code; an optional `headFetchRef` pr-view field is named as a possible second contract item but NOT requested.
- Isolation from builder-only surfaces relies on PR diffs never entering the diff-inject registry (right side is codev-diff:, not file:).
- Plan at codev/plans/2008-vscode-pull-requests-group-sho.md; waiting at plan-approval.
