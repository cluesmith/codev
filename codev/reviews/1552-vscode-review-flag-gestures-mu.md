# PIR Review: Review-flag gestures author prose in a native comment thread (no promptless default)

Fixes #1552

## Summary

The VS Code review-flag gestures (`codev.feedbackCurrentFileToBuilder` / `-CurrentHunkToBuilder` /
`-SelectionToBuilder`, driven by keybindings and Stream Deck dials) used to stamp a fixed placeholder
body (`DECK_FLAG_BODY = "Flagged for review from Stream Deck."`) and never ask the reviewer for the
actual comment. Owner-ruled that promptless flagging must not exist. This PR makes every gesture open
the **native inline comment reply box** at the anchor so the reviewer types/dictates real prose, which
becomes the comment body — enqueued (comment mode) or forwarded with the range ref (forward mode). It
then went further, under an owner ruling made during dev-approval testing: **deck composer parity**, so
a bare dial sequence (open → dictate → same dial submits) works hands-free, with cancel via the box's
visible **Cancel** button.

## Files Changed

(`git diff --stat` vs merge-base `b0c3b755`)

- `apps/vscode/src/review-queue/feedback.ts` (+~90 / -~55) — gestures resolve an anchor then open the
  native comment box; pure `decideFeedbackAction` composer state machine (open | submit | noop).
- `apps/vscode/src/comments/builder-review.ts` (+~110 / -~10) — mode-aware/empty-guarded Submit;
  composer-open tracking (flag ∪ focused-comment-input detection); submit executor; visible Cancel
  button command; `DECK_FLAG_BODY` deleted.
- `apps/vscode/src/extension.ts` (12) — drop the now-unused `store` arg from the three registrations;
  refresh the block comment.
- `apps/vscode/package.json` (17) — Cancel button + menu wiring (Submit primary/right, Cancel
  secondary/left); dropped the redundant `Codev:` title prefix on the two comment-box buttons.
- `apps/vscode/src/__tests__/feedback.test.ts`, `builder-review-submit.test.ts` (new),
  `builder-review-ranges.test.ts`, `contributes-review-queue.test.ts` — decision machine, gesture
  routing, composer lifecycle, verified built-in ids, menu scoping.

## Commits

Substantive commits (per-phase narrative lives in `codev/state/pir-1552_thread.md`):

- `d75b96efe` Flag gestures author prose via native comment thread; mode-aware Submit
- `e23973940` Deck composer parity: context-aware feedback verbs drive the open box
- `9ed92b843` Add visible Cancel button to the builder-review comment box
- `2da54ca32` Fix reversed comment-box buttons + let selection dial submit
- `36f4aaa73` Fix dial submit/cancel: detect focused comment input; close (not hideComment) to cancel
- `c535b8f1e` Dial cancel: neutralize harmful closeActiveEditor → safe no-op
- `f6ee2e5d2` Ruling B: drop dial cancel from the vocabulary; button-only discard
- `82de2b748` Drop redundant "Codev:" prefix from the comment box buttons
- `135ddd3e3` Remove the dial-diag diagnostic tracer (root-cause complete)

## Test Results

- `pnpm check-types`: ✓ pass
- `pnpm exec eslint`: ✓ pass
- `node esbuild.js` (build): ✓ pass
- `pnpm test:unit`: ✓ pass (950 tests; ~30 new/rewritten across the four files above)
- Manual verification (owner, at the dev-approval gate, across the full parity arc on his Stream Deck
  reviewing a live builder diff): flag gesture opens the native thread; typed prose becomes the comment
  body and queues (verified 6 real comments in `<worktree>/.codev/pending-comments.json`, no
  placeholder); a bare dial open→dictate→same-dial-submit works; the Files dial is a harmless no-op;
  the visible **Cancel** button discards leaving nothing queued; buttons read cleanly (Submit
  primary/right, Cancel secondary/left).

## The Design Journey (read this before the diff)

This lane's value is as much in what was *rejected* as in what shipped. The arc, with its decision
points and refutations:

**1. The core fix (plan-gate approved).** Gestures open the native comment reply box (reusing
`comments/builder-review.ts`' `codev.commentForBuilder` authoring entry). The queue-vs-forward decision
moved into the box's Submit. A flagged concern — the **mode-aware Submit unification** (in forward mode
the gutter "+"/context-menu/codelens Submit now forward too, not just the deck gestures) — was shown to
the owner with its concrete consequence and **approved at the plan gate** as a deliberate unification,
not a side effect.

**2. Scope expanded at dev-approval (owner ruling).** Testing at the deck, the owner found the box
*opened* via a dial but nothing on the deck could submit or cancel it — unlike the artifact-canvas
composer (#1425), the diff-mode review dials had no submit/cancel gesture. His verbatim ruling: *"we
need to achieve parity first, the implementation is currently unusable."* The plan carries a
superseded-marker delta recording this. Architect approved **Option A** (VS Code, as the diff-mode
composer owner, interprets the same `feedback-*` verbs contextually) with three conditions: mirror the
canvas semantics; a pure cancel-biased state machine; document the native-Escape staleness edge.

**3. Root-causing the dial via captured data.** Submit-then-cancel still failed. A temporary tracer
(routed to a "Codev Feedback Debug" output channel; since removed) captured the actual dial-press
sequence and established the failure was **in-fence** (commands reach the host; routing decides
correctly) — the VS Code **built-ins** were the problem. Three facts, all later bundle-confirmed:
`editor.action.submitComment` no-ops unless the comment box is the *focused* editor (and
`workbench.action.submitComment` does not exist); a focused comment box *is* the active editor as a
`commentinput-…` document (the detection lever); and there is **no native discard** for a draft.

**4. The three dead ends for cancel (record for posterity).** Discarding a native comment draft
programmatically is impossible with the stable API:
- `workbench.action.hideComment` (what Esc binds to) only *collapses* the widget — the draft survives,
  and a survived draft could later be resurrected and submitted = a phantom submit of cancelled text,
  which the cancel-biased design forbids.
- `workbench.action.closeActiveEditor` closes the **host editor**, not the draft (observed: focus
  jumped to a different VS Code window). Harmful; neutralized in `c535b8f1e`.
- submit-empty-as-discard (clear the input, then submit → our empty-body guard disposes) is blocked by
  the submit button's `enablement: !commentIsEmpty` — an empty box has no enabled submit action to fire.

**5. Two refutation ownerships (both architect seats were wrong; the empirical test was right).** The
`closeActiveEditor` discard was endorsed by both architect seats as "the only true discard — keep it,"
built on treating **bundle-presence** of a command id as **behaviour**-presence. The owner's live
re-test refuted a claim two seats endorsed and none had run. Recorded exactly that way: the
three-dead-ends evidence plus the live re-test outranked both seats; the neutralization (`c535b8f1e`)
was the correct call.

**6. Ruling B (shipped).** Cancel is removed from the *dial* vocabulary — `decideFeedbackAction` is now
purely `open | submit | noop`; with a box open, hunk & selection are open-or-submit and the Files dial
is a defined no-op. The reliable discard is the visible **Cancel** button (VS Code hands us the thread
only on a click → `codev.cancelBuilderComment` disposes it). Three grounds: the acceptance criteria are
met by prompting; the risk asymmetry of the thread-owning rework against a now-working submit/dictation
path; and the API offers no native discard today. Draft-survival (hide) was considered and rejected on
the phantom-submit ground. The thread-owning rework that would restore a dial cancel is filed as the
**#1560** spike.

## Architecture Updates

Routed one COLD arch fact to `codev/resources/arch.md` (§ VS Code Extension): the **two-composer
ownership asymmetry** across the review-comment surfaces — the artifact-canvas composer (spec/plan) is
our own React component that owns its draft (so the deck can open/submit/**cancel** it, view-scoped),
while the builder-diff review box is VS Code's native Comments widget whose draft VS Code owns (opened
via `addComment`, no thread handle returned → no programmatic discard; `editor.action.submitComment` is
focus-gated). This is the durable "why" behind ruling B and #1560. Not hot-tier: it's reference detail
for anyone touching those surfaces, not an always-injected invariant that would displace a capped hot
fact.

## Lessons Learned Updates

Routed one COLD lesson to `codev/resources/lessons-learned.md` (§ Debugging and Root Cause Analysis):
**a built-in command id present in bundled source proves it EXISTS, not what it DOES to your
widget/state** — verify a built-in's *runtime behaviour* (a captured tracer beat source-reading here)
before building a design on it; two architect seats endorsed a discard design on bundle-presence-as-
behaviour and the owner's live re-test refuted it. A refinement of the existing hot lessons ("captured
raw data beats speculation"; "verify claims against the actual file"), narrow enough for the cold tier
rather than displacing a capped hot lesson.

## Things to Look At During PR Review

- **`decideFeedbackAction` purity + the composer-open signal.** The dial vocabulary is `open | submit |
  noop` (no cancel). `isBuilderComposerOpen()` reads **this controller's own `composerOpen` flag** (set
  only when we open a box). It deliberately does **not** probe "is a comment input focused" — CMAP
  (#1552) caught that a focus probe would let a diff-review dial submit the *plan/spec* review box
  (`codev-review`, a second native comment controller on the same extension whose `commentinput-…`
  URIs are indistinguishable). Submit stays reliable because `editor.action.submitComment` is
  focus-gated host-side and the normal open→dictate→submit flow keeps the box focused; a stale flag
  (native Escape) yields a no-op submit or an extra open, never a phantom submit.
- **Mode-aware Submit unification** (owner-approved at the plan gate): in forward mode the gutter "+" /
  context-menu / codelens Submit forward too, not just the deck gestures. Intentional; called out so it
  reads as design, not drift.
- **Native-Escape staleness edge** (documented, bounded): if the reviewer dismisses the box with the
  keyboard Escape (not the Cancel button), our `composerOpen` flag can stale-stick true; the union with
  `isCommentInputFocused()` and the no-op-on-unfocused submit built-in make the worst case a no-op or an
  extra open — never a phantom submit.
- **Button ordering is host-behavioural.** Submit is `inline@1`, Cancel `inline@2`; empirically the
  lower order renders rightmost/primary (the blue button that Enter/the submit dial fire). If a future
  VS Code changes that ordering semantics, re-verify Submit stays primary.

## How to Test Locally

- **View diff**: VS Code sidebar → right-click builder `pir-1552` → **Review Diff**.
- **Run dev**: VS Code sidebar → **Run Dev**, or `afx dev pir-1552`. (Note: the Extension Development
  Host loads the compiled `dist/extension.js` as-is — rebuild + reload the window to pick up changes.)
- **What to verify** (maps to the plan's Test Plan + the parity arc):
  - Open a builder diff. Cursor on a changed hunk → press the flag gesture (palette `Codev: Flag …`, a
    keybinding, or a Stream Deck dial) → the native inline reply box opens and is focused.
  - Type multi-line prose → Submit → it queues as a pending review comment (status-bar `Submit Review
    (N)` +1; inline thread with Edit/Delete). In forward mode it injects `ref + prose` into the builder
    PTY instead.
  - **Deck**: a bare open → dictate → **same dial** press submits; the **Files** dial is a no-op; the
    visible **Cancel** button discards (box vanishes, nothing queued).
  - No builder diff focused → a flag gesture shows "focus a builder diff first," not a silent no-op.
  - `grep -rn "DECK_FLAG_BODY\|Flagged for review from Stream Deck" apps/vscode/src` → empty.

## Follow-ups (not in scope; filed)

- **#1560** — thread-owning dial-cancel spike (would restore a deck cancel by owning the comment thread
  so it can be disposed, the way the canvas unmounts its composer). Deliberate decision-behind-spike.
- **#1559** — wire the contextual-panel "Code Review" surface to render the pending-comment queue; that
  panel is currently a stub ("… will appear here (#1037)") and belongs to the contextual-panel lane.
