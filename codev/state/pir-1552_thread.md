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

## Plan gate APPROVED + implement done (2026-08-26)

Amr approved the plan as presented, including the flagged unification (gutter+/context-menu/codelens
Submit forwards in forward mode). Convention resolved: builder runs `porch approve` — I ran
`porch approve 1552 plan-approval`. Recorded the unification as owner-approved-at-plan-gate; will
note it in the review artifact (not a side effect).

Implemented exactly as planned:
- `review-queue/feedback.ts`: `route()` → warn "focus a builder diff first" on no anchor, else
  `executeCommand(COMMENT_FOR_BUILDER_COMMAND, ...)`. Deleted DECK_FLAG_BODY + store/ref/uuid deps;
  gestures take no args. Anchor resolvers unchanged (kept #1534 hunkAnchor degrade-to-file-with-note).
- `comments/builder-review.ts` `codev.submitBuilderComment`: empty/whitespace → dispose no artifact;
  forward mode → `forwardToBuilder(builderId, ref + body)` (ref has trailing space); comment mode →
  enqueue trimmed body. Imports getDiffCodelensMode + buildBuilderFileRef/RangeRef.
- `extension.ts:1260-1262`: dropped `{ store }` arg; refreshed the block comment.

Tests: rewrote feedback.test.ts (7 tests), added builder-review-submit.test.ts (5 tests). Affected
files: 4 files / 22 tests pass. check-types ✓, eslint ✓ on all changed files. AC grep for
DECK_FLAG_BODY / "Flagged for review from Stream Deck" is empty.

PRE-EXISTING UNRELATED RED (not mine, not fixing): 20 test FILES in apps/vscode fail at import time
with `Cannot find package '@cluesmith/codev-sdk/reconnect-policy'` — the installed codev-sdk lacks
that subpath export (stale workspace build). None are files I touched; my diff imports nothing from
it. The 688 tests that load all pass. Noting for the review file per implement-phase guidance.

Fences held: only feedback.ts + builder-review.ts + 3-line extension.ts wiring + tests. No streamdeck,
no contextual-panel/OverviewCache, no types/Tower.

Now at dev-approval gate (Amr's gate; evidence = native thread seen running on the gesture, Submit
queues/forwards typed prose per mode, Cancel/empty nothing, DECK_FLAG_BODY gone).
