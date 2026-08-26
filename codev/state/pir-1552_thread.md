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

RED RESOLVED (was stale-install, now green): the 20 import-time failures for
`@cluesmith/codev-sdk/reconnect-policy` were a stale worktree node_modules link (installed before
that subpath export landed on main) — same class as pir-1494's "Cannot find module three". Architect
diagnosed it; `pnpm install --frozen-lockfile` at the worktree root cleared it. Full apps/vscode
unit suite now 80 files / 935 tests all pass. Not a code issue; nothing in my diff changed for it.

Fences held: only feedback.ts + builder-review.ts + 3-line extension.ts wiring + tests. No streamdeck,
no contextual-panel/OverviewCache, no types/Tower.

Now at dev-approval gate (Amr's gate; evidence = native thread seen running on the gesture, Submit
queues/forwards typed prose per mode, Cancel/empty nothing, DECK_FLAG_BODY gone).

## Scope EXPANDED at dev-approval — deck composer parity (2026-08-26)

Amr, testing at the deck, found the box opens via a dial but nothing on the deck can submit/cancel
it (diff-mode review dials have no submit/cancel gesture, unlike the canvas composer #1425). He
ruled: "we need to achieve parity first, the implementation is currently unusable." Architect
approved Option A (VS Code = diff-mode composer owner, interprets the same feedback-* verbs
contextually) with 3 conditions: (a) mirror canvas exactly — hunk=open-or-submit, file=cancel,
selection=inert; (b) pure unit-tested cancel-biased state machine, never a phantom submit; (c)
document the Escape-staleness edge. No re-gate (pir-1494 precedent). Fences held (feedback.ts +
builder-review.ts only; no deck/relay change — parity by architecture).

Key correction from architect (verified vs bundled workbench source): SUBMIT built-in is
`editor.action.submitComment` (editor.*), NOT `workbench.action.submitComment` (does NOT exist);
CANCEL is `workbench.action.hideComment` (confirmed). Both behind named constants, flagged for EDH
confirmation (bundle presence proves id exists, not exact focused-comment behaviour).

Implemented:
- feedback.ts: pure `decideFeedbackAction(axis, composerOpen)` -> open|submit|cancel|noop
  (modeled on decideApprovalRelay). gesture() reads isBuilderComposerOpen() and dispatches.
- builder-review.ts: module `composerOpen` (single source), set true in openCommentInput, cleared
  in submit handler + both executors. Exports isBuilderComposerOpen / submitActiveBuilderComposer
  (editor.action.submitComment) / cancelActiveBuilderComposer (workbench.action.hideComment).
- Tests: decideFeedbackAction (6 combos + stale-flag), gesture routing (open + submit/cancel/noop
  branches), composer lifecycle + verified built-in ids + self-heal. Full apps/vscode suite 80
  files / 949 tests pass; check-types ✓, eslint ✓; AC grep empty.

Plan-delta (superseded-marker) recorded at top of plan file per architect. Option B
(dedicated relay verbs + deck lane) noted as the cleaner follow-up, NOT built.

Residual EDH-only evidence (named): the exact focused-comment behaviour of the two built-in ids,
and end-to-end dial submit/cancel — only the running host (VS Code EDH or the new Codev Desktop.app)
can confirm. Everything else unit-tested headlessly. dev gate stays pending Amr's re-test.

## Visible Cancel button added (2026-08-26)

Amr, testing, reported "the cancel button is still not there" (screenshot: box has Submit + trash
icon, no labelled Cancel). Root: my deck-parity work made the Files DIAL cancel (invisible), never
added a UI button. Added codev.cancelBuilderComment: click disposes the in-progress thread + clears
composerOpen (nothing queued/forwarded). package.json: command def + palette-hide + inline menu with
cancel@1 / submit@2 so Submit stays primary/last (the button Enter + deck-submit trigger). Updated
contributes-review-queue.test (builderCommands list) + builder-review-submit.test (cancel-button
handler). Pushed 9ed92b843. Full suite 80 files / 950 tests; check-types + eslint + build clean.

HOST-VERIFY (named, can't drive headlessly): that VS Code renders Submit (not Cancel) as the primary
button so Enter/Changes-dial still SUBMIT after adding the second inline button — flagged to Amr.

## Button reversal + selection-dial fixes (2026-08-26, commit 2da54ca32)

Amr's screenshots: builder box rendered [Queue Comment grey/left] [Cancel blue/PRIMARY/right] — the
REVERSE of the target [Cancel white/left] [Comment blue/right]. My inline@N guess was backwards:
empirically @1 = rightmost+primary. Root-cause insight: because Cancel was primary, the deck submit
(editor.action.submitComment fires the PRIMARY action) was triggering CANCEL — explaining "press
again to submit doesn't work." Fixed: submit@1 (primary/right), cancel@2 (secondary/left).

Also: Amr opens with the 3rd (Scroll/selection) dial and expects a 2nd press to submit; I'd made
selection inert-when-open. Changed decideFeedbackAction so the FILE dial is the sole cancel and every
other open dial (hunk, selection) is open-or-submit — whichever dial opened the box, 2nd press submits.
Updated feedback.test (selection now submits). Full suite 80 files / 950 tests; check-types+eslint+build clean.

STILL TO VERIFY at deck (Amr): (1) Submit now blue/right, Enter+Changes/Scroll dial submit; (2) Files
dial cancel — uses workbench.action.hideComment; if it still doesn't discard, the reliable fallback is
the visible Cancel BUTTON (click = dispose, works), and I'll get the exact Esc-bound cancel command id
from the architect (bundle-verified) rather than guess again.

## Queue path VERIFIED working; dial submit/cancel still failing → added transmission diagnostic (2026-08-26)

Amr reviewing shannon builder 4392: pending-comments.json has 6 comments, each with real typed prose
(NO placeholder) — so the #1552 queue path WORKS end-to-end (submitted via button/Cmd+Enter). But deck
DIAL submit/cancel still fails; earlier he saw "focus a builder diff first" on the 2nd dial press =
gesture went to OPEN = composerOpen read false. Couldn't resolve by static reading (trace says it should
be true), and repeated build/reload confusion (EDH loads dist/extension.js as-is; package.json refreshes
on reload but compiled JS needs rebuild).

Architect (both, via #1406 misroute + main relay): root-cause the transmission BEFORE proposing changes;
report WHERE it is — if command-relay.ts or apps/streamdeck, that's out of fence (route, don't reach).
Panel-body gap filed as #1559 (not this lane); contextual-panel fence re-confirmed.

Added TEMP diagnostic (commit 5c5b5dbd2, revert before PR): traces every gesture + composer transition to
a "Codev Feedback Debug" output channel, tagged [dial-diag-v1] (also proves build freshness).

## ROOT CAUSE FOUND from the trace (2026-08-26, fix 36f4aaa73)

VS Code persists output channels to disk (…/Code/logs/…/exthost/output_logging_…/1-Codev Feedback Debug.log),
so I read Amr's actual dial-press trace. WHERE: IN MY FENCE (not relay/streamdeck — commands reach the host,
routing decides correctly). The VS Code BUILT-INS were the problem:
1. workbench.action.hideComment does NOT discard an in-progress comment box (trace: box stayed open,
   activeEditor kept = …/commentinput-…md after exec).
2. editor.action.submitComment no-ops unless the comment box is the FOCUSED editor (trace: submit fired
   with activeEditor=a non-box file → no codev.submitBuilderComment FIRED after).
3. Lever discovered: a focused comment box IS the active editor, as a `commentinput-…` document.

FIX (36f4aaa73): isBuilderComposerOpen() = flag OR isCommentInputFocused() (live signal → stale-flag
recovery + submit only fires while box focused so the built-in hits it). Cancel closes the focused
comment-input editor via workbench.action.closeActiveEditor, GATED on isCommentInputFocused() so it can
never close a real file editor. Full suite 952 pass; check-types+eslint clean.

Residual: closeActiveEditor-as-discard inferred from trace (gated, safe), awaits Amr's re-test to confirm
it visibly discards; asked architect to bundle-verify the exact Esc-bound discard id as the definitive
option. Reported root cause to architect. Waiting on Amr to restart debug session + re-capture the tracer.

## Architect DESIGN RULING — discard stands (2026-08-26) [RECORD IN REVIEW]

Main bundle-verified all three trace facts at source and established there is NO native discard command:
Esc IS workbench.action.hideComment and even used correctly only COLLAPSES the widget, draft surviving.
So closeActiveEditor-gated-on-comment-input-focus is not a workaround — it is the ONLY true discard. KEEP it.
Two verified reasons discard is correct (record in review; note hide-with-draft-survival as
considered-and-rejected, reason 2 the decider):
  1. Canvas parity: canvas composer-cancel → cancelComposer → setComposingLine(null) UNMOUNTS the composer,
     destroying the draft (local React state). Same gesture, same meaning — dial-cancel discards in both modes.
  2. Condition (b) safety: a hidden-but-surviving draft could be resurrected + SUBMITTED by a later
     open-or-submit press = phantom submit of cancelled text. Discard makes that structurally impossible.

Canvas precedent: canvas verbs are VIEW-scoped, not focus-scoped ("a remote driver never moved focus into
the textarea", ArtifactCanvas.tsx:982-984). Native built-ins ARE focus-gated (submitComment no-ops without
comment-editor focus). So the OPEN path must leave focus IN the input for a bare open→submit dial sequence.
My open uses workbench.action.addComment, which focuses the reply input for RANGE comments (trace press 4:
activeEditor=commentinput after a range open). The focus-detection fix then makes submit fire only while
focused. Edge to watch: a hunk press that degrades to a whole-FILE comment (fileComment:true) — confirm on
re-test whether it also leaves focus in the input; if not, that whole-file deck case needs a focus nudge.
Amr can overrule discard at re-test (one-function swap to draft-survival) but discard is the presented design.

## Re-test: SUBMIT works; CANCEL hits a hard native-API limit (2026-08-26, c535b8f1e)

Amr re-tested: dial SUBMIT now works (focus-detection fix landed). Dial CANCEL via closeActiveEditor was
HARMFUL — closed the HOST editor, focus jumped to a different VS Code window. Neutralized to a harmless
no-op. All three discard routes are dead ends: hideComment collapses (draft survives, unsafe), closeActiveEditor
closes host (wrong), submit-empty blocked by the submit button's `enablement: !commentIsEmpty` (no enabled
submit action on an empty box). The ONE reliable discard is the visible Cancel BUTTON (VS Code hands us the
thread on click → codev.cancelBuilderComment disposes it); the deck can't invoke it (no thread arg), and
addComment never returns the thread (no onDidCreateCommentThread, no CommentThread.reveal).

Asked architect to rule: (A) thread-owning rework — open via createCommentThread to get the handle for
dial-cancel dispose, but createCommentThread doesn't auto-focus (would regress dictation + focus-gated submit);
mitigation createCommentThread+addComment is unverified. (B) button-only cancel — ship dial open+submit +
Cancel BUTTON discard (fully working, zero risk), file thread-owning dial-cancel as a follow-up spike. My lean: B.
Awaiting ruling. Current state: submit-via-dial + Cancel-button-discard both work; dial-cancel is a safe no-op.

## RULING B — dial cancel dropped, button-only discard (2026-08-26, f6ee2e5d2)

Architect ruled B: ship button-only cancel. Applied — `decideFeedbackAction` is now purely open|submit|noop
(cancel removed from the dial vocabulary). Box open: hunk & selection = open-or-submit (verified load-bearing
path, untouched); FILE dial = defined no-op. Deleted the dead cancelActiveBuilderComposer executor. Visible
Cancel button (codev.cancelBuilderComment → dispose thread) is the sole discard. Confirmed the architect's
one point: Files-dial = defined no-op, never hide/close. Thread-owning dial-cancel = #1560 spike. 950 tests pass.

REVIEW ARTIFACT must record (architect directive): the three-dead-ends dead-ends record; BOTH refutation
ownerships (main owned the closeActiveEditor-closes-host implication; the reviewer/relaying architect owned
building the discard ruling on bundle-presence-as-behaviour — Amr's live re-test refuted a claim two seats
endorsed and none ran; the empirical test + neutralization c535b8f1e outranked both seats); B's three grounds
(AC met by prompting; risk asymmetry of the thread-owning rework; API offers no native discard today); and
#1560 as deliberate-decision-behind-spike.

Tracer REMOVED (135ddd3e3): logFeedbackDebug + "Codev Feedback Debug" channel + all call sites + test-mock
stubs stripped; grep for logFeedbackDebug/feedbackDbg/dial-diag empty; 950 tests pass. Also dropped the
redundant "Codev:" prefix from the comment-box buttons (82de2b748) → "Cancel" / "Queue Comment for Builder".
Production code now carries zero diagnostics. Remaining before PR: none code-side; review phase writes
codev/reviews/1552-*. Dev gate → Amr's deck re-test (button-cancel confirmed working by Amr; can override B).
