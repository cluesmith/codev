# bugfix-1562 thread

## Investigate
- Root cause: `apps/vscode/src/review-queue/submit.ts` calls `store.remove()` immediately after
  `injectBuilderText` succeeds. Injection only places text in the prompt (final Enter is the
  human's, #1037), so the store discards its only copy before delivery completes.
- Scope: Stage 1 only (BUGFIX). Stage 2 (sent/actioned rollup in Attention view, alignment with
  #1131) left out — feature-shaped, needs its own issue.
- Design: on successful injection, MOVE submitted comments into a `sent` array inside the same
  `.codev/pending-comments.json` (already git-excluded, watched, removed by afx cleanup). Tower's
  `countQueuedFeedback` reads only `comments`, so queued counts are unchanged; no types/Tower change.
- Next submit with `sent` entries present asks explicitly: Re-send them (with any new ones) or
  Mark Delivered (drop the record). A sent-only builder is still targetable, which is the recovery path.

## Fix
- Lane brief from architect:vscode received: Stage 1 only, keep the pending shape readable for #1559,
  name the new field in the PR body. The design fits as-is: the new field is `sent` (array of
  PendingComment + `sentAt`), and `comments` is untouched and still pending-only.
- Regression: submit-review.test.ts asserts `markSent`, not `remove`, after injection; 6 tests fail
  against the pre-fix submit.ts. vscode check-types, lint and the full vitest run (1054) are green
  after building the workspace packages (the worktree needed `pnpm -r build` for the codev-sdk types).

## PR #1768
- CMAP iter1: gemini=APPROVE, codex=APPROVE, claude=COMMENT. Applied Claude's polish: the QuickPick shows the
  sent-unconfirmed count, and Mark Delivered with nothing pending now confirms. Left as-is: Discard on a
  sent-only builder reports "No pending comments" (accurate; Discard is pending-only).
- Open for the architect: `Fixes #1562` will close the issue while Stage 2 has no follow-up issue yet.
