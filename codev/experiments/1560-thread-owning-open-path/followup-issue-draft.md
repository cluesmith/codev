# DRAFT: follow-up implementation issue (for architect:vscode to file)

**Suggested title**: vscode: thread-owning builder-review composer — restore dial-cancel via an owned Editing-mode draft (#1560 recipe B)

**Suggested label**: `area/vscode`

---

## Context

Spike #1560 (findings: `codev/experiments/1560-thread-owning-open-path/notes.md`) answered the
question #1552 left open. The issue's hypothesis (create the thread, then `workbench.action.addComment`
to focus it) is **false**: `addComment` toggles an existing thread and never focuses its input. It
also found a **stable-API** way to open the composer with the `CommentThread` handle owned *and* the
input focused. With the handle owned, a dial cancel becomes `thread.dispose()`.

## Verified recipe (B: an owned Editing-mode draft)

Verified headlessly on VS Code 1.140 and Codev.app 1.138: plain editor, diff editor, range-less file
comment, and 5/5 repeats.

```ts
const draft: vscode.Comment = {
  body: '',
  mode: vscode.CommentMode.Editing,
  author: { name: currentUser },
  contextValue: 'codev-draft',
};
const thread = controller.createCommentThread(uri, anchorRange, [draft]);
(draft as any).parent = thread;          // our BuilderReviewComment subclass already carries parent
thread.canReply = false;                 // no reply box under the draft
thread.contextValue = 'codev-draft-thread';
thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
// For a file comment: thread.range = undefined;
// The host focuses the draft's editor (ensureFocusIntoNewEditingComment). No addComment call.
```

- **Submit** (the button or the dial's `editor.action.submitComment`): this runs the edit form's
  default action. Contribute the mode-labelled submit commands under `comments/comment/context`,
  `group: "inline@1"`, `when: commentController == codev-builder-review && comment == codev-draft`.
  The handler receives the draft **comment** (`comment.body` = the typed text, `comment.parent` = the
  owned thread), not a `CommentReply`.
- **Cancel** (button): a second `comments/comment/context` inline action, then `thread.dispose()`.
- **Dial cancel**: `activeDraft?.dispose()`. The handle is owned, so there is no dependency on a
  built-in and the host editor is never closed (probe: tabs 1→1, host still open, and a
  post-dispose dial-submit delivered nothing).
- **Composer-open state**: `composerOpen` becomes `activeDraft !== undefined`. It stays scoped to
  this controller, so the CMAP #1552 concern about plan/spec boxes is preserved.

## Scope

- `apps/vscode/src/comments/builder-review.ts`: the `openCommentInput` codelens and deck path switches
  from `addComment` to recipe B; `deliverBuilderComment` accepts a draft comment; add a dial-cancel
  executor.
- `apps/vscode/src/review-queue/feedback.ts`: `decideFeedbackAction` gets its cancel back (the
  Files dial, per the original canvas-parity ruling), mapping to the dial-cancel executor.
- `apps/vscode/package.json`: draft-comment menu entries. Submit and Cancel ordering must be
  re-verified in the host, because #1552 learned that `inline@1` = rightmost/primary.
- The gutter "+" and the context-menu `codev.commentSelectionForBuilder` path can stay on
  `addComment` (button-only cancel there), or move to recipe B too. That's a decision for the plan.

## Acceptance (owner re-test on the real deck; the spike could only proxy these)

- Open by dial → **dictation lands in the box** with no click.
- The same dial submits. The prose is queued or forwarded per the mode.
- **Dial cancel disposes the draft**: nothing queued, no host editor closes, focus returns to the
  diff.
- No duplicate threads. The file-level flow still records a whole-file comment.
- **Look-and-feel sign-off**: recipe B renders as an authored comment in edit mode (author header
  plus edit form), not the bare reply box. If the owner rejects that presentation, fall back to
  recipe A.

## Alternative (recipe A, Codev.app only)

`thread.reveal(undefined, { focus: CommentThreadFocus.Reply })` from the proposed `commentReveal`
API. It keeps the exact reply-box UI and was verified when the proposal is enabled. It only works
where the extension is **built-in** (Codev.app). In VS Code, Cursor and other Marketplace or Open VSX
installs it throws, so it needs a try/catch fallback to the current handle-less `addComment` path,
and dial-cancel would then work only in Codev.app. Marketplace acceptance of a VSIX that declares
`enabledApiProposals` was not verified.

## Noted, out of scope

On the **shipped** path (and on A and B alike), `workbench.action.hideComment` (Escape's command)
leaves focus in the collapsed input, and a following dial-submit delivers the escaped text. That
deserves its own look with a real Escape keypress.
