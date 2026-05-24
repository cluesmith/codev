# bugfix-844 thread

## Investigation

**Bug**: Needs Attention list surfaces PRs the moment they're created — before CMAP reviews finish — instead of waiting until the builder reaches the porch `pr` gate (the actual "human, please review/merge" signal).

**Root cause confirmed**: `NeedsAttentionList.tsx:42-56` iterates every open PR from `overview.pendingPRs` and emits an attention row unconditionally. There is no cross-reference against builder gate state.

**Signal available**:
- `OverviewPR.linkedIssue` is already plumbed through (`api.ts:177-185`, populated in `overview.ts:840-849` via `parseLinkedIssue`).
- `OverviewBuilder.blocked === 'PR review'` is the human-readable label for a builder waiting at the `pr` gate (mapped in `overview.ts:GATE_LABELS`, `'pr': 'PR review'`).

## Approach

In `buildItems`:
1. Build `prGateIssueIds` = `Set` of `issueId` values where `builder.blocked === 'PR review'`.
2. PR loop: include a PR if EITHER (a) its `linkedIssue` is in `prGateIssueIds`, OR (b) it has no associated builder *and* `reviewStatus === 'REVIEW_REQUIRED'` (handles human-authored / externally opened PRs — these have no porch gate to wait on).
3. Keep the `continue` for `blocked === 'PR review'` in the builders loop — without it, a builder at the pr gate would be emitted twice (once by the PR loop, once by the gate loop). The issue text suggested dropping it but that creates duplicates; I'll explain in PR.

## Test plan

Three scenarios from acceptance criteria:
- PR with builder still in `review` phase (blocked == null or some other label) → excluded.
- PR with builder at `pr` gate (blocked == 'PR review') → included.
- PR with no associated builder + `reviewStatus === 'REVIEW_REQUIRED'` → included; same but APPROVED → excluded.
