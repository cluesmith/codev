# PIR #1107 — Inline composer for preview-pane review comments

Builder: `pir-1107` · Branch: `builder/pir-1107` · Protocol: PIR

## Phase: Plan

### Investigation (2026-06-30)
Goal: replace `vscode.window.showInputBox` (center-top Quick Pick) in the markdown
preview's add-comment flow with an inline composer co-located with the clicked block.

Key files mapped:
- `packages/vscode/src/markdown-preview/preview-provider.ts:92-113` — host `addComment`
  uses `showInputBox`, then writes the marker via `WorkspaceEdit`.
- `packages/vscode/src/markdown-preview/webview/main.ts` — webview bridge; posts
  `{ type: 'addComment', line }` to the host; mounts `<ArtifactCanvas>`.
- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx` — shared React canvas.
  `+` click / Enter on a focused block calls `onAddComment(line)` (intent-only seam, D6).
  Overlay is React-rendered and anchored at the block's vertical center via `overlayTop`.
- `packages/artifact-canvas/src/overlays/CommentAffordance.tsx` — the `+` button.
- `packages/core/src/review-markers.ts` — `serializeReviewMarker` **already normalizes
  body to single line** (`/\s+/g → ' '`). So multi-line composer input is fine; on-disk
  format is unchanged. No marker-format change needed in this issue (#1055 owns v2 format).

### Design decision
Going with **Option A** (issue's recommendation): inline composer rendered by the
webview/canvas. Render it as a React component in the existing overlay (anchored at the
block via `overlayTop`) — keeps it React-owned (clean state / focus / Esc), avoids the
innerHTML-managed body's "cards flash then vanish" hazard, reuses the anchor mechanism.

Seam change: `onAddComment(line)` → `onAddComment(line, text)`. Click/Enter now *opens*
the composer; submit emits with text. Host drops `showInputBox` and writes the marker
directly from the posted text. Only production consumer is the vscode webview (+ a dev
example), so blast radius is contained.

Open UX question for the dev-approval gate: submit-on-Enter vs Cmd/Ctrl+Enter (with Enter
= newline for multi-line). Leaning Cmd/Ctrl+Enter to submit + Esc to cancel + buttons.

### Plan committed → plan-approval gate pending (2026-06-30)
Plan written to `codev/plans/1107-preview-inline-comment-composer.md`, committed and
pushed (907ed56b). `porch check` + `porch done` passed; `plan-approval` gate is now
**pending**. Waiting for human review. Implementation does not start until the gate is
approved.

### Plan revised on reviewer feedback (2026-06-30)
Reviewer asked to show the visual and questioned placement vs the existing read-only
cards. Settled a design fork: **composer renders in-flow directly below the block**
(same location as the read-only `.codev-canvas-marker-cards`), not in the gutter
overlay. Implementation: inject an in-flow placeholder below the block and
`createPortal` the composer into it (React-owned state/focus/Esc, in-flow position).
Clarified scope: this issue is **add only**; edit/delete/reply/resolve = #1055. The
composer sets the visual precedent #1055's edit mode will reuse. Plan sections 1, 2,
5, files table, risks, and test plan updated + recommitted. Gate still pending.
