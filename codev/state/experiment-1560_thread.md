# experiment-1560 thread

## 2026-10-05 — start

Lane: #1560 spike (EXPERIMENT, soft). Owning architect: architect:vscode. Brief: findings only, do NOT
touch the shipped #1552 open path; probe code stays out of production.

No `codev/specs/1560-*` exists; the issue body is the spec. Wrote hypothesis + success criteria to
`codev/experiments/1560-thread-owning-open-path/notes.md` before running the runtime probe.

Source trace (workbench bundle, VS Code 1.140 + Codev.app 1.138):
- `workbench.action.addComment` → `addOrToggleCommentAtLine`: an existing widget at the line is
  TOGGLED (all expanded → collapse; else expand). No reply focus in either branch. If our widget
  hasn't mounted yet (ext-host flushes thread updates on a 100ms debounce) it creates a 2nd thread.
- `thread.reveal(…, {focus: Reply})` exists but is gated on the `commentReveal` proposal; the
  host strips proposals only for NON-built-in extensions. Codev.app bundles codev-vscode built-in.
- `comments.reply` reaches the same focusReply path but needs the main-side threadId
  (`<controllerId>.<handle>`, handle from a static pool shared across extensions) — not targetable.
- Editing-mode comment + Collapsed→Expanded flip calls `ensureFocusIntoNewEditingComment()`,
  which focuses that comment's editor. `editor.action.submitComment` then runs the edit form's
  default action. Candidate stable-API recipe.

Runtime probe: throwaway extension in an EDH via @vscode/test-electron (keyboard/command
equivalent of the deck gestures).

## 2026-10-05 — probe results (both hosts, ± proposal)

- H0 (create → addComment) = NO everywhere (plain, diff, immediate, after mount, collapsed). Final.
- Recipe A (`thread.reveal({focus: Reply})`, `commentReveal` proposal) = yes with the proposal; throws
  without. Works only for a built-in (Codev.app); Marketplace/Cursor need a fallback.
- Recipe B (owned thread, single empty Editing-mode draft comment) = YES on the stable API, both hosts:
  focus, dial-submit (`editor.action.submitComment`) lands on the owned thread+comment, dispose clean,
  diff + file comments, 5/5 repeats. Surprise: B also focuses when created already Expanded (no flip
  timing needed).
- Escape baseline: `hideComment` leaves focus in the collapsed input, and dial-submit then delivers the
  escaped text on the SHIPPED path too (and A, B). Pre-existing; flagged out of scope.
- Unverifiable here: real dictation, real deck, real Escape keypress, B's look (edit-mode comment, not
  the reply box). Those are for the owner re-test.

Deliverables: notes.md (findings), followup-issue-draft.md (recipe B + A as alternative), probe/ +
results/. Shipped open path untouched.

## 2026-10-05 — gate approved, findings landing

Owner approved experiment-complete (relayed by architect:vscode); porch protocol complete. Owner's
word "preserve the findings": the probe is removed from the tree (history keeps 077949ac4, and notes.md
says how to restore it). A docs-only PR lands notes, the follow-up draft, results and this thread.
Implementation issue filed as #1775 (not spawned).
