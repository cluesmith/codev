# PIR Plan: Review-flag gestures must author prose (native inline thread), no promptless default

> ## Scope delta — owner-ruled at dev-approval (2026-08-26)
>
> **The scope below is SUPERSEDED in one respect.** The original plan assumed the native comment
> box's own Submit/Cancel (keyboard `Cmd+Enter` / `Escape`, like spec/plan authoring) was enough.
> Dev-approval testing showed it is not for the **deck-driven, dictation** workflow this feature
> exists for: a Stream Deck dial can *open* the box but nothing on the deck can submit or cancel it,
> because the diff-mode review dials — unlike the artifact-canvas composer (#1425) — have no
> submit/cancel gesture. Amr (owner), testing at the deck, ruled in-session at the dev gate:
>
> > "we need to achieve parity first, the implementation is currently unusable."
>
> **Approved expansion (Option A, architect-ruled with three conditions):** VS Code becomes the
> diff-mode *composer owner* and interprets the SAME `feedback-*` verbs contextually — while a
> builder-review box is open, **hunk press = open-or-submit, file press = cancel, selection =
> inert** — exactly mirroring the canvas composer. No deck or command-relay change; parity by
> architecture. The state machine is a pure, unit-tested function (`decideFeedbackAction`), it is
> cancel-biased (a stale-open flag can only cost a no-op or an extra open, never a phantom submit,
> because SUBMIT runs VS Code's built-in `editor.action.submitComment`, a no-op when nothing is
> focused), and the native-Escape staleness edge is documented as a bounded known limitation.
> Built-in ids were verified against the bundled workbench source: submit = `editor.action.submitComment`
> (NOT `workbench.action.submitComment`, which does not exist), cancel = `workbench.action.hideComment`.
>
> **Not built (recorded follow-up):** Option B — dedicated `submit-comment`/`cancel-comment` relay
> verbs + deck-lane wiring — is the cleaner long-term shape if Option A's Escape edge proves real in
> use. Deferred, not implemented here.
>
> No re-gate (precedent: pir-1494's owner-redirect at dev-approval): the dev gate itself is the
> checkpoint and stays pending Amr's re-test of the expanded build. Files stayed in-fence:
> `review-queue/feedback.ts` + `comments/builder-review.ts` (+ the 3-line `extension.ts` wiring).

## Understanding

The three review-flag gestures — `codev.feedbackCurrentFileToBuilder`, `-CurrentHunkToBuilder`,
`-SelectionToBuilder` (all in `review-queue/feedback.ts`, backing the Stream Deck `feedback-*`
verbs and any keybinding) — currently attach a **fixed, promptless body** to the flagged chunk and
never ask the reviewer for the actual comment:

- **Queue mode** (`codev.diffCodelensMode === 'comment'`): `route()` enqueues a `PendingComment`
  whose body is the hard-coded `DECK_FLAG_BODY = 'Flagged for review from Stream Deck.'`
  (`feedback.ts:35`, used at `:128`) — a placeholder, and mislabeled "from Stream Deck" even when
  the trigger is a keybinding.
- **Forward mode** (`'forward'`, the default): `route()` immediately injects a bare file/range ref
  into the builder PTY via `codev.forwardToBuilder` with **no prose at all** (`feedback.ts:104-110`).

Owner ruling (settled during the 1049 dev-review session, relayed in the architect kickoff):
**promptless flagging must not exist at all.** Every flag gesture must open a comment-authoring
input at the anchor, and the reviewer's typed/dictated text becomes the comment body. There is no
keep-the-default option.

The authoring surface the codebase already uses for this is the **native inline comment thread
reply box** driven by `comments/builder-review.ts` (`createCommentController` + VS Code's
`workbench.action.addComment` + the `codev.submitBuilderComment` reply handler) — the same UX as
spec/plan comment authoring in `comments/plan-review.ts`. It is multi-line and dictation-friendly,
with Submit / Cancel / Edit (#1055) / Delete (#1037). Crucially, `builder-review.ts` already
exposes an authoring entry point — `COMMENT_FOR_BUILDER_COMMAND` (`codev.commentForBuilder`), whose
handler `openCommentInput(fsPath, range)` creates **and focuses** the reply box at a given anchor
(the comment-mode codelens already invokes it). What's missing is: (a) the flag gestures don't call
it, and (b) the submit handler always enqueues, so forward mode has no authored-prose path.

## Proposed Change

Move the **mode decision** out of `feedback.ts` (which currently pre-populates a placeholder or
force-forwards) and into the **submit** of the authoring thread. The flag gestures become a thin
"resolve anchor → open the native comment input" step, identical in both modes; the reviewer's
Submit then either enqueues (queue mode) or forwards ref + authored prose (forward mode).

This reuses the exact authoring path the issue points at, keeps a single authoring surface, and
deletes `DECK_FLAG_BODY` and every promptless branch.

### 1. `review-queue/feedback.ts` — flag gestures open the input, never stamp/force-forward

`route(anchor)` collapses to:

- **No anchor** (the focused editor is not a tracked builder diff — `activeEntry()` returns
  `undefined`): show `vscode.window.showWarningMessage('Codev: focus a builder diff first to flag it
  for review')` instead of the current **silent no-op** (Scenario 7 — a dial press over a
  non-diff editor gives a clear message, not nothing).
- **Anchor present**: invoke the existing authoring entry point
  `vscode.commands.executeCommand(COMMENT_FOR_BUILDER_COMMAND, entry.builderId, entry.fsPath,
  entry.relPath, lineRange)`. That opens **and focuses** the native reply box at the anchor
  (`openCommentInput` requires the active editor to be `fsPath` — always true here, since the anchor
  was derived from the active editor, so the deck-focus/dictation ergonomics of Scenario 7 hold).

The anchor resolvers are unchanged: `fileAnchor()` (whole file), `hunkAnchor()` (Scenario 4 — keeps
`resolvePressCursorRef`'s #1534 behavior: fresh single-file re-parse, hunk→symbol→file, and a
cursor on no changed line **degrades to whole-file with the existing status note**, never the old
"place the cursor in a changed hunk" error), and `selectionAnchor()`. All three route the same way,
so file / hunk / selection all prompt (Scenario 5).

Because the mode branch and the store write leave this module, `feedback.ts` sheds `DECK_FLAG_BODY`,
`getDiffCodelensMode`, `buildBuilderFileRef`/`buildBuilderRangeRef`, `deriveWorktreePath`,
`randomUUID`, `path`, and the `FeedbackDeps { store }` dependency. The three exported functions lose
their `deps` parameter.

### 2. `comments/builder-review.ts` — `codev.submitBuilderComment` becomes mode-aware + empty-guarded

The reply handler (currently `builder-review.ts:283-302`, which always enqueues) gains:

- **Empty / whitespace guard** (Scenario 3): `const text = reply.text.trim(); if (!text) {
  reply.thread.dispose(); return; }` — an empty or whitespace-only submit queues and forwards
  nothing and leaves no mounted thread. (Escape/Cancel already disposes the in-progress thread via
  VS Code, so Cancel leaves no artifact for free.)
- **Forward mode** (`getDiffCodelensMode() === 'forward'`): build the ref from the thread's file +
  range — `buildBuilderRangeRef(entry.relPath, start, end)` for a ranged thread, else
  `buildBuilderFileRef(entry.relPath)` — and forward `ref + text` via
  `vscode.commands.executeCommand('codev.forwardToBuilder', entry.builderId, ref + text)`, then
  `thread.dispose()`. No queue entry (Scenario 2). The ref helpers already emit a trailing space
  (`'src/a.ts:L5-L9 '`), so `ref + text` reads `@…:L5-L9 <prose>` — exactly the "ref then prose"
  shape the forward inject path was built for. Delivery uses the sanctioned #789 inject path
  (`codev.forwardToBuilder` → `injectBuilderText`, no auto-Enter), matching every other forward verb.
- **Queue mode** (default `'comment'`): unchanged behavior — `registerEntryWorktree(entry)` then
  `store.add(entry.builderId, { …, body: text })` (Scenario 1). The queued comment is a first-class
  entry: editable (#1055) and deletable (#1037) before the batched "Submit Review (N)" flush
  (Scenario 8 — no code change, it already is; we simply stop pre-seeding a placeholder).

Multi-line + dictation (Scenario 6) is inherent to the comment reply box; no `showInputBox`.

### 3. `extension.ts` — drop the now-unused `store` arg from the three registrations

`feedback.ts:1260-1262` change from `() => feedbackFile({ store: reviewQueueStore })` to
`() => feedbackFile()` (and likewise hunk/selection). `reviewQueueStore` stays wired to the
builder-review controller (unchanged) and to `submitReview`/`discardReviewComments`.

## Files to Change

- `apps/vscode/src/review-queue/feedback.ts` — delete `DECK_FLAG_BODY`; rewrite `route()` to
  warn-on-no-anchor + invoke `COMMENT_FOR_BUILDER_COMMAND`; drop the `store`/ref/uuid/path imports
  and the `FeedbackDeps` param from `feedbackFile`/`feedbackHunk`/`feedbackSelection`. Anchor
  resolvers unchanged. Update the module header comment (it currently describes the forward/enqueue
  split that is moving out).
- `apps/vscode/src/comments/builder-review.ts` — `codev.submitBuilderComment`: add the
  empty/whitespace guard and the forward-mode branch; import `getDiffCodelensMode` and the two ref
  builders. Update the handler's doc comment.
- `apps/vscode/src/extension.ts:1260-1262` — drop the `{ store }` arg from the three `feedback*`
  registrations.
- `apps/vscode/src/__tests__/feedback.test.ts` — rewrite: both modes and all three verbs now assert
  a single `codev.commentForBuilder` invocation with the resolved anchor args (no direct
  forward/enqueue); the no-builder-diff case asserts the warning; the #1534 fresh-parse and
  degrade-to-file-with-note cases assert the anchor/range passed to `commentForBuilder` (and the
  status note) rather than a queued body. `DECK_FLAG_BODY`/"Stream Deck" assertions removed.
- `apps/vscode/src/__tests__/builder-review-ranges.test.ts` (or a sibling
  `builder-review-submit.test.ts` reusing its vscode mock) — add submit coverage: forward mode
  forwards `ref + prose` and disposes with no `store.add`; queue mode `store.add`s the typed body;
  empty/whitespace disposes with neither forward nor `store.add`.

## Risks & Alternatives Considered

- **Risk — the mode-aware submit also changes the gutter "+" / context-menu / comment-codelens
  submit in forward mode** (they share the one `codev.submitBuilderComment`). Today those enqueue in
  every mode. After this change, an authored comment submitted while in forward mode is *forwarded*
  instead of queued. This is intentional and consistent with the mode contract ("forward mode =
  deliver now; comment mode = queue"), and it keeps exactly one authoring surface with
  mode-determined delivery. It is confined to the two in-scope files. If the architect wants the
  gutter/context-menu paths to stay queue-only regardless of mode, the alternative below applies.
  Called out here for the plan gate.
- **Alternative — tag only feedback-gesture threads as "forward intent"** so the gutter/context-menu
  submit stays queue-only. Rejected: VS Code's stable Comments API gives no handle to the thread
  `workbench.action.addComment` creates, so distinguishing gesture-opened threads at submit time
  requires a fragile pending-anchor handshake. Reading the current mode at submit is deterministic
  and simpler.
- **Alternative — `showInputBox` for the prose.** Rejected by the issue (Scenario 6): single-line,
  truncates dictated paragraphs. The native thread reply is the required surface.
- **Risk — forward-mode delivery semantics.** Forward uses the existing no-auto-Enter inject
  (`codev.forwardToBuilder`), so the ref + prose lands in the PTY prompt for the reviewer to send,
  matching every other forward verb and the mailbox discipline (no direct PTY write, no forced
  submit). Not a behavior regression; documented so the reviewer knows Enter is theirs to press.
- **Scope note.** No `apps/streamdeck` / `command-relay.ts` change — the deck already presses the
  existing `feedback-*` verbs; the behavior change is entirely VS Code-side. No
  `contextual-panel/*` or `OverviewCache` change (the pir-1553 sibling lane's set). No
  `packages/types` / Tower reach. If implementation forces any of these, I stop and tell the
  architect before proceeding.

## Test Plan

**Unit (vitest, run from the worktree):**

- `apps/vscode/src/__tests__/feedback.test.ts` (rewritten):
  - forward mode + comment mode, for file / hunk / selection: exactly one
    `codev.commentForBuilder` executed with `[builderId, fsPath, relPath, expectedRange]`
    (`null` for whole-file); nothing forwarded, nothing enqueued directly by `feedback.ts`.
  - no active builder diff → the "focus a builder diff first" warning, and no
    `commentForBuilder` invocation.
  - #1534 preserved: a hunk press resolves against the fresh git parse (range reflected in the
    `commentForBuilder` args); a cursor on no changed line degrades to a whole-file anchor
    (`range === null`) with the "no changed lines at the cursor" status note and never the old
    "place the cursor in a changed hunk" error.
- builder-review submit tests (new/extended): forward mode forwards `ref + prose` via
  `codev.forwardToBuilder` and disposes the thread with no `store.add`; queue mode `store.add`s the
  typed body; empty/whitespace submit disposes with neither forward nor `store.add`.
- `pnpm --filter @cluesmith/codev-vscode test` and `… check-types` green from the worktree.

**Manual (Extension Development Host — this is the dev-approval evidence, run in the worktree):**

1. Open a builder diff (`Codev: View Diff` / a builder file). Confirm the flag command path with
   the Command Palette (`Codev: Flag Current File to Builder` / hunk / selection) or the bound key.
2. **Queue mode** (`codev.diffCodelensMode = 'comment'`): run each of file / hunk / selection →
   the **native inline comment thread reply box opens and is focused** at the anchor (no
   placeholder text). Type multi-line prose → **Submit** → it appears as a pending review comment
   (status bar count +1, inline thread with Edit/Delete). **Cancel / empty submit** → nothing
   queued, no thread left mounted.
3. **Forward mode** (`'forward'`): repeat → the same reply box opens; Submit injects `ref + prose`
   into the builder PTY prompt; Cancel/empty injects nothing.
4. **No builder diff focused**: run a flag command over a plain file → the "focus a builder diff
   first" warning, not a silent no-op.
5. **Promptless default gone**: `grep -rn "DECK_FLAG_BODY\|Flagged for review from Stream Deck"
   apps/vscode/src` returns nothing; no gesture produces a comment without typed prose.

**Cannot drive from the builder shell (named plainly per the evidence bar):** a *physical* Stream
Deck dial press. The dial only presses the `feedback-*` VS Code commands via `command-relay.ts`,
which are exactly what steps 1-4 exercise directly, so the VS Code-side behavior under test is fully
covered; the hardware-to-command relay is unchanged and out of scope. The reviewer runs steps 1-5
against the running worktree at the dev-approval gate.
