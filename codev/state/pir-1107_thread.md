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

## Phase: Implement

### Implemented (2026-06-30)
plan-approval approved → implement phase. Built the inline composer per the approved plan:
- New `CommentComposer.tsx` (textarea + Submit/Cancel; ⌘/Ctrl+Enter submits, Enter = newline,
  Esc cancels, empty = no-op) + unit tests.
- `types.ts`: `onAddComment(line)` → `onAddComment(line, text)` (contract amendment, documented).
- `ArtifactCanvas.tsx`: `composingLine` + `composerHost` state; `+`/Enter/Space open the composer;
  in-flow placeholder injected below the block (after the marker-card stack) via a dedicated
  idempotent effect; composer `createPortal`'d into it; submit emits `(line, text)` + closes;
  Esc/Cancel closes + restores focus; reload removing the block closes it; `+` suppressed for the
  composing line. Updated existing unit + e2e tests to drive through the composer; added
  Esc-closes + reload-clears tests.
- CSS: `.codev-canvas-comment-composer*` mirroring the marker-card left-rule/spacing.
- Host: `webview/main.ts` posts `{line, text}`; `preview-provider.ts` drops `showInputBox`, writes
  the marker from the posted text. Doc comments updated.

**Verification:** artifact-canvas `check-types` + `build` ✓, `test` ✓ (68 tests). vscode
`check-types` (host + webview) ✓, esbuild bundle ✓, `lint` ✓, `test:unit` ✓ (516). Note: had to
build codev-core/types first (pre-existing build-order, unrelated to this change).

→ dev-approval gate next. Reviewer should run the worktree and exercise the composer in the
Codev Markdown Preview. Key UX to confirm: ⌘/Ctrl+Enter-to-submit (vs old Enter-to-submit).

### Dev-gate feedback round 1 (2026-06-30)
Reviewer flagged `preview-provider.ts` inline anonymous message type. The postMessage value is
genuinely untrusted/unknown at the boundary, so runtime validation stays — but the shape is now a
named, shared protocol: new `markdown-preview/messages.ts` with `HostToWebviewMessage` +
`WebviewToHostMessage`, used by BOTH host (`preview-provider.ts`) and webview (`main.ts`) so the
two ends can't drift. Host casts unknown→union for the discriminant, still validates addComment
fields at runtime. check-types (host+webview) ✓, esbuild ✓, lint ✓, test:unit ✓ (516). Gate still
pending.

### Dev-gate feedback round 2 (2026-06-30)
Reviewer questioned `React.createElement` style in CommentComposer. Clarified it IS a real
component (createElement vs JSX is just syntax). Reviewer chose to convert the WHOLE package to
JSX (accepted scope expansion beyond #1107). Converted all 5 source components — CommentComposer,
ArtifactCanvas, CommentAffordance, MarkerMinimap, MarkdownView — from createElement to JSX
(package tsconfig already had jsx: react-jsx; tests already used JSX, so build supported it).
Behavior unchanged. artifact-canvas check-types ✓ + test ✓ (68) + build ✓; vscode check-types ✓ +
esbuild ✓ + test:unit ✓ (516). Gate still pending.

## Phase: Review

### Review artifact + governance (2026-06-30)
dev-approval approved → review phase. Wrote `codev/reviews/1107-preview-inline-comment-composer.md`
(Summary / Files / Commits / Test Results / Architecture Updates / Lessons Learned / Things to Look
At / How to Test). Governance routing (Spec 987 cold tier):
- arch.md: updated the "Markdown Preview / artifact-canvas host integration" entry — old text
  described the removed `onAddComment(line)`→`showInputBox` flow; now describes inline composer +
  `(line,text)` seam + named messages.ts protocol. No hot arch-critical change (package-level, not
  framework-wide; file near cap).
- lessons-learned.md (Architecture): added the createPortal-into-innerHTML-managed-body pattern with
  the idempotent-injection guard. No hot lessons-critical change.
Next: open PR with review as body, `porch done --pr`, then `porch done` → single CMAP-2 advisory
pass → pr gate.

### Consultation results + fix (2026-06-30)
PR #1121 opened. 2-way CMAP-2 (claude+codex, single pass): claude=APPROVE(HIGH),
codex=REQUEST_CHANGES(HIGH). Verified all 3 codex claims against code — all valid:
1. REAL DEFECT: host inserted at markerInsertionLine (line+1) = prepend, so a new comment on a
   block with existing markers rendered at TOP of the stack while the composer appeared BELOW.
   Fixed: added core `markerAppendLine` (insert after the contiguous marker run = newest-last,
   matching composer position + approved plan). Regression test in core review-markers.test.ts.
2. Test gap (stacked path) → covered by the new core test.
3. Stale `stripMarkersForRender` header comment → corrected to raw-text+renderer-strips.
Escalating at pr gate: editor path (plan-review.ts:171) still prepends (out of scope #1107) →
recommend follow-up issue to align. core build+test ✓ (32), vscode check-types/esbuild/lint/
test:unit ✓ (516). PIR single-pass: no re-consult; human verifies at pr gate.
