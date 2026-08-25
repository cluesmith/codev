# Builder thread — pir-1552

Issue #1552 — vscode: review-flag gestures must prompt for comment prose (native inline thread),
remove the promptless deck default. Protocol: PIR (strict). Files in scope:
`apps/vscode/src/review-queue/feedback.ts` + `apps/vscode/src/comments/builder-review.ts`.

## Plan phase (2026-08-25)

Investigated the flag-gesture path end to end:

- `feedback.ts` `route()` today either force-forwards a bare ref (forward mode) or enqueues a
  placeholder `DECK_FLAG_BODY = 'Flagged for review from Stream Deck.'` (:35, used :128). Both are
  promptless. Owner ruled promptless flagging must not exist (relayed by architect; settled in the
  1049 dev-review session — no keep-the-default option).
- The authoring surface already exists: `builder-review.ts` exposes `COMMENT_FOR_BUILDER_COMMAND`
  (`codev.commentForBuilder`) → `openCommentInput(fsPath, range)`, which creates + focuses the
  native inline comment reply box at an anchor (the comment-mode codelens already uses it). Same UX
  as spec/plan authoring (`plan-review.ts`).

Design chosen: move the mode decision OUT of `feedback.ts` and INTO the submit handler.
- `feedback.ts`: resolve anchor → if none, warn "focus a builder diff first" (was a silent no-op);
  else invoke `COMMENT_FOR_BUILDER_COMMAND`. Delete `DECK_FLAG_BODY` + store/ref/uuid deps. Anchor
  resolvers unchanged (keeps #1534 `resolvePressCursorRef` degrade-to-file-with-note in `hunkAnchor`
  — pir-1534 merged 93874894d touched this; read its role before editing).
- `builder-review.ts` `codev.submitBuilderComment`: add empty/whitespace guard (dispose, no
  artifact) + forward-mode branch (build ref, forward `ref + prose` via `codev.forwardToBuilder`,
  dispose, no queue) ; queue mode unchanged (enqueue typed body).
- `extension.ts:1260-1262`: drop the now-unused `{ store }` arg from the 3 registrations.

Risk flagged at plan gate: the mode-aware submit also affects gutter "+" / context-menu submit in
forward mode (they share `codev.submitBuilderComment`) — intentional unification, called out for
Amr's decision. Alternative (tag only gesture threads) rejected: no stable-API handle to the
addComment-created thread.

Scope fences respected: VS Code side only; no `apps/streamdeck`/`command-relay.ts`; no
`contextual-panel/*`/`OverviewCache` (pir-1553 sibling lane); no `packages/types`/Tower.

Evidence bar (UX-rule change): dev-approval needs it seen running — native thread opens on gesture,
Submit queues typed prose, Cancel/empty queues nothing, promptless default provably gone (grep +
behaviour). Cannot drive a PHYSICAL Stream Deck dial from the builder shell; the dial only presses
the `feedback-*` VS Code commands (via `command-relay.ts`), which the manual EDH steps exercise
directly — named plainly in the plan.

Plan written to `codev/plans/1552-vscode-review-flag-gestures-mu.md`, committed. Awaiting
plan-approval (Amr's gate; architect relays; I run porch approve).
