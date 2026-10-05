# air-1559 thread

## Implement (2026-10-05)
- Wired the contextual panel's Code Review body (#1559) on the #1553 Attention pattern.
- The projection `contextual-panel/code-review.ts` (`deriveCodeReview`) is EXTENSION-LOCAL, not in codev-sdk:
  the queue is a worktree file owned by `ReviewQueueStore`, and files-to-review come from the diff-inject
  registry. Neither is overview wire data, so another client would have nothing to share.
- "Files to review" means the shown builder's diff-session files (registry entries for that builder),
  plus any commented file the session doesn't list, each with its queued-comment count.
- vscode architect coordination: #1562 adds `status: pending|sent`. The projection skips entries with
  `status === 'sent'` (read loosely), so it works with both store shapes. The store stays read-only from
  the panel: it reads `getComments` and does not call `load`, because builder-review's reconcile loads when
  a diff opens and the store fires `onDidChangeQueue`, which re-posts.
- Read-only list (no edit/delete). Edit and delete still work from the inline diff threads. Header untouched (#1672 owns it).
- Registry-change edge: on the same Code Review surface, the surface-keyed dedup would swallow a
  files-to-review change, so `refresh()` now returns whether it posted, and the registry listener re-posts.
- Verified the real webview bundle in Chromium (stubbed host): populated + empty states; HTML in a
  comment body renders as text.

## Owner-directed scope widening (2026-10-05)
- The owner, in this session, said to move the status-bar "Submit Review" button into the panel, include a Discard button, and first merge "develop". There's no origin/develop; the described changes are #1562, which is on main, so I merged origin/main (6acb82be5). The vscode architect confirmed "main" and that status-bar.ts fences no live lane.
- #1562's real shape is a separate `sent` array (`store.getSent`), not a per-entry status, so I removed the `status` filter. The projection now takes `{comments, sent}`, and the panel shows a "Sent · awaiting confirmation" section.
- The buttons send a validated `review-action` webview→host message. The host runs the existing `codev.submitReview` / `codev.discardReviewComments` for the SHOWN builder only. Submit already offers Re-send / Mark Delivered; with only sent entries the button reads "Re-send / Mark Delivered (N)". `codev.discardReviewComments` now accepts a builder id, mirroring submit.
- Deleted review-queue/status-bar.ts and its activation. Updated arch.md (#1037 and contextual-panel paragraphs) and the stale extension.ts comments. No tests referenced the status-bar item.
