# Experiment 1560: Thread-owning open path for the builder review composer

**Status**: Complete (H0 disproved; a stable-API alternative validated headlessly) · **Date**: 2026-10-05

## Goal

**Question** (issue #1560, follow-up to #1552): can the builder-review composer own its
`CommentThread` handle at open time *without losing input focus*, so a Stream Deck dial can discard
the draft with `thread.dispose()` as reliably as the visible Cancel button?

**Hypothesis H0 (the issue's)**: open via `controller.createCommentThread(...)` (handle owned), then
immediately run `workbench.action.addComment` at the same anchor; the built-in focuses the EXISTING
thread's reply input instead of creating a second thread.

**Secondary probes** (only if H0 fails, per the issue): collapsibleState manipulation + focus
commands; any other route that yields an owned handle with a focused input.

**Success criteria** (all must hold for a "yes"), written before the runtime probe ran:

1. Focus: after open, the focused editor is a comment input (`activeTextEditor.document.uri.scheme
   === 'comment'`) with no further click.
2. Ownership: text typed into that focused input, then `editor.action.submitComment` (the dial-submit
   built-in), arrives at our submit handler on the **same** `CommentThread` object we created.
3. No duplicate threads: exactly one thread exists for the anchor after open.
4. Discard: `thread.dispose()` on the owned handle removes the box; no host editor closes.
5. Dictation lands in the input: the runtime proxy is criterion 1 (OS dictation types into the DOM
   focused element). A real deck/dictation re-test is the owner's; this lane states the limit.

A route that fails any of 1-4 is a "no" for that route.

## Approach

Two layers, in this order:

1. **Source trace** of the shipped workbench bundle (the comment contribution is minified but intact),
   for VS Code 1.140 (`/Applications/Visual Studio Code.app`) and Codev.app 1.138
   (`/Applications/Codev.app`, which bundles `codev-vscode` as a **built-in** extension).
2. **Runtime probe**: a throwaway extension run in an Extension Development Host via
   `@vscode/test-electron`, driven with the command-level equivalents of the deck gestures (the deck
   dials invoke these same command ids). It measures criteria 1-4 per route on both hosts, with and
   without the `commentReveal` API proposal enabled.

Routes probed:

| Route | What it does |
|---|---|
| **H0a/b/c** | `createCommentThread` (Expanded, or Collapsed) → `addComment` at the same line (immediately, or after an 800ms mount wait) |
| **DH0** | H0b in a diff editor (builder diffs are diffs) |
| **CTRL** | The shipped #1552 path: `addComment` alone (focus, but no handle) |
| **C** | `createCommentThread` → cursor on the line → `workbench.action.focusCommentOnCurrentLine` |
| **A** | `createCommentThread` (empty, `canReply`) → `thread.reveal(undefined, { focus: CommentThreadFocus.Reply })` (proposed `commentReveal` API) |
| **B** | `createCommentThread(uri, range, [draft])` where `draft` is a single comment in `CommentMode.Editing` with an empty body; `canReply = false`; Expanded (B2) or Collapsed→Expanded flip (B1) |
| **D\*/F\*/R\*** | A and B in a diff editor (DA/DB), as a range-less file comment (FA/FB), and 5× repeated with a 250ms or no wait (RA/RB) |
| **E\*** | Type, then `workbench.action.hideComment` (Escape's command), then the dial-submit built-in: on CTRL, A, and B |

## Environment & Reproduction

- macOS 26 (Darwin 25.5), VS Code 1.140.0, Codev.app 1.138.0. `@vscode/test-electron` from
  `apps/vscode/node_modules`.
- The probe is not in the tree (experiment code stays off `main`). Restore it from history, then
  run from the repo root:

  ```bash
  git checkout 077949ac4 -- codev/experiments/1560-thread-owning-open-path/probe
  P=codev/experiments/1560-thread-owning-open-path/probe
  node $P/run.js "/Applications/Visual Studio Code.app/Contents/MacOS/Code" out.json --proposed
  node $P/run.js "/Applications/Visual Studio Code.app/Contents/MacOS/Code" out.json   # proposal OFF
  node $P/run.js /Applications/Codev.app/Contents/MacOS/Codev out.json --proposed
  PROBE_ROUTES=ECTRL,EA,EB2 node $P/run.js <exe> out.json --proposed                  # route subset
  ```

  `--proposed` adds `--enable-proposed-api codev-probe.probe-1560`. That stands in for the built-in
  case: the host strips declared proposals only for non-built-in extensions (see Results, S3).
- Each run opens a short-lived EDH window (fresh `--user-data-dir`, `--disable-extensions`).

## Code

The probe lived at `probe/` in commit `077949ac4` and was removed from the tree afterwards. The
results it produced stay here in `results/`.

- `probe/ext/package.json`: probe manifest. It declares `enabledApiProposals: ["commentReveal"]` and
  the thread-level (reply) and comment-level (edit) inline menu actions.
- `probe/ext/extension.js`: comment controller shaped like `codev-builder-review`. It records which
  thread or comment object each submit/save arrives on.
- `probe/ext/runner.js`: the routes and measurements (runs inside the EDH as `extensionTestsPath`).
- `probe/run.js`: the launcher.
- `probe/ws/`: sample files for the workspace (`base.txt` is the diff base).
- `results/*.json`: raw results per host × proposal state, plus the Escape and file-comment runs.

None of this touches production code. The shipped #1552 open path is unchanged.

## Results

**H0 is disproved.** `createCommentThread` followed by `workbench.action.addComment` never focused the
owned thread's input, in any variant, on either host, in a plain editor or a diff. The source shows
why: `addComment` is a **toggle**, not a focus. **Two alternative routes do meet criteria 1-4.**

- **Recipe A** (proposed `thread.reveal({focus: Reply})`) works wherever the proposal is enabled. In
  practice that is only Codev.app, where the extension is built-in.
- **Recipe B** (an owned thread whose only comment is an empty Editing-mode draft) works on the
  **stable API** on both hosts with no proposal: plain editor, diff editor, file comment, and 5/5
  repeats with a 250ms wait.

### Source findings (S1-S5)

- **S1, `addComment` toggles.** `workbench.action.addComment` → `addOrToggleCommentAtLine(range)`:
  `getCommentsAtLine` matches widgets whose glyph is on `range.endLineNumber` (glyph 0 for file
  comments). If any match: all expanded → `collapse(true)`, otherwise `expand(true)`. `expand` sets
  `collapsibleState = 1` plus the active-thread bookkeeping and **never focuses the reply editor**. If
  no widget has mounted yet (ext-host thread updates flush on a 100ms debounce,
  `eventuallyUpdateCommentThread`), it falls through to `addCommentAtLine` and creates a **second,
  unowned** thread. Every branch fails H0.
- **S2, the focus primitive exists but is not on the stable surface.** Main-thread
  `$revealCommentThread(…, {focusReply})` → `revealCommentThread(threadId, …, focus=2)` →
  `_setFocus(…, 2)` → `focusCommentEditor()` → `expandReplyAreaAndFocusCommentEditor()`. The ext-host
  `thread.reveal()` calls it, but first runs `checkProposedApiEnabled(ext, "commentReveal")`.
- **S3, built-ins keep their proposals.** `ExtensionsProposedApi.doUpdateEnabledApiProposals` clears
  declared proposals only when `!isBuiltin && !envEnabled`. Codev.app ships `codev-vscode` under
  `Contents/Resources/app/extensions/` (a built-in), so a Codev.app build that declares
  `commentReveal` gets it. VS Code, Cursor and other Marketplace or Open VSX installs do not: the
  call throws `CANNOT use API proposal: commentReveal`. `vsce` packages the declaration locally
  without complaint. Whether the Marketplace accepts a VSIX that declares proposals was **not
  verified** here.
- **S4, `comments.reply` is not targetable.** This Comments-view action calls the same
  focusReply path, but its argument needs the main-side `threadId`, which is
  `${controllerId}.${handle}`. `handle` comes from a static pool shared by every extension in the
  host, and the stable `CommentThread` wrapper doesn't expose it.
- **S5, Recipe B's mechanism.** On `collapsibleState` → Expanded, the zone widget calls
  `ensureFocusIntoNewEditingComment()`. That focuses the comment's own editor when the thread holds
  exactly one comment and it is in Editing mode (`comment.mode === 0 && _commentEditor.focus()`). The
  editor is the same `SimpleCommentEditor` class as the reply box, so `editor.action.submitComment`
  (the dial-submit built-in) accepts it and its `submitComment()` routes to
  `_body.activeComment.submitComment()`. That triggers the **default action of the comment's edit
  form** (`comments/comment/context`, `inline@1`), and the extension receives the comment with
  `body` set to the typed text.

### Runtime results (both hosts)

| Route | Focus (crit. 1) | Submit lands on owned thread (crit. 2/3) | Discard clean (crit. 4) | Verdict |
|---|---|---|---|---|
| H0a create→addComment (immediate) | ✗ `file` | ✗ nothing submitted | — | **no** |
| H0b create→wait→addComment | ✗ | ✗ | — | **no** |
| H0c collapsed→wait→addComment | ✗ | ✗ | — | **no** |
| DH0 (diff) | ✗ | ✗ | — | **no** |
| C `focusCommentOnCurrentLine` | ✗ | ✗ | — | **no** |
| CTRL shipped `addComment` | ✓ | ✗ arrives on a *foreign* thread (expected) | n/a | baseline |
| A reveal(focus Reply), proposal ON | ✓ (A1, DA, FA, RA 5/5) | ✓ | ✓ tabs 1→1, host open, post-dispose submit = 0 | **yes** (built-in only) |
| A, proposal OFF | ✗ throws `CANNOT use API proposal` | ✗ | — | **no** (Marketplace/Cursor) |
| B editing-mode draft, proposal ON or OFF | ✓ (B1, B2, DB, FB, RB 5/5) | ✓ the same thread **and** the same comment object | ✓ tabs 1→1, host open, post-dispose submit = 0 | **yes** (stable API) |

The results are identical on VS Code 1.140 and Codev.app 1.138
(`results/{vscode-1.140,codev-1.138}-{proposed,stable}.json`).

**Escape baseline** (`results/escape-*.json`): after typing and then `workbench.action.hideComment`,
focus **stays** in the comment input on CTRL, A and B alike, and a following dial-submit delivers the
"escaped" text on all three. Recipe B therefore adds **no new** phantom-submit exposure. It is a
pre-existing property of the shipped #1552 flow. Caveat: this is the command invoked
programmatically, and a real Escape keypress may move DOM focus differently.

**File comments** (`results/filecomment-*.json`): A and B both focus and submit on the owned
range-less thread (`range === undefined` at submit, matching the shipped file-comment semantics).

### What the probe could not verify (owner re-test)

- **Real dictation**: the probe types via `TextEditor.edit`. Criterion 1 (DOM focus in the input) is
  the proxy.
- **Real deck dials**: the probe invokes the same command ids the dials do.
- **A real Escape keypress**, as opposed to the command (see the caveat above).
- **Recipe B's look.** The draft renders as an *authored comment in edit mode* (author header, edit
  form with its own inline buttons), not the bare reply box. The visual parity and button placement
  of Submit/Cancel need eyes on the real UI.

## What Worked / What Didn't

- **Didn't**: H0. The premise ("addComment focuses the existing thread") is false by construction:
  the command toggles. Waiting for mount only changes *which* failure you get (collapse or
  expand-without-focus rather than a duplicate thread).
- **Didn't**: `focusCommentOnCurrentLine`. It reveals with `focus = 1` (the thread container, not
  the input).
- **Didn't**: `comments.reply` (S4). The thread id is not obtainable.
- **Worked, but scoped**: Recipe A. It is clean and keeps the exact reply-box UI, but runs only in
  the Codev.app built-in. Everywhere else it needs a fallback to the handle-less `addComment` path,
  which means two open paths and a dial-cancel that works only in Codev.app.
- **Worked**: Recipe B. It is stable API, has a single path for every host, owns the handle, keeps
  focus, and the dial-submit built-in reaches it. Its cost is a UI shape change (an edit-mode draft
  comment, not a reply box), and its submit/cancel buttons move from the
  `comments/commentThread/context` menu to `comments/comment/context`.
- **Method note**: as with #1552, the runtime probe was decisive. Source reading predicted S5, but
  only the probe showed that B also focuses when created already Expanded (B2), which removes the
  flip-timing race S5 suggested.

## Next Steps

- **Answer to #1560: the hypothesis as posed is NO (final).** A thread-owning open path *is*
  achievable, by Recipe B (stable) or Recipe A (Codev.app-only).
- Follow-up implementation issue: filed as **#1775** from `followup-issue-draft.md`. It
  recommends Recipe B behind an owner look-and-feel check, with Recipe A as the alternative if B's
  edit-mode presentation is rejected.
- Out of scope, surfaced for the architect: the Escape → dial-submit delivery on the **shipped**
  path. Whether a real Escape keypress leaves focus in the collapsed input deserves its own look.
