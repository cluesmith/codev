# Plan — #1107: Inline composer for preview-pane review comments

> PIR plan. The GitHub issue (#1107) is the implicit spec. This document is the
> **plan-approval** artifact: how the change is built, where it lands, the risks,
> and the test plan. Reviewed before any code is written.

## Understanding

Adding a review comment from the Codev Markdown Preview
(`codev.openMarkdownPreview`) currently collects the comment body with
`vscode.window.showInputBox` — rendered in VS Code's center-top Quick Pick
chrome, physically far from the block the user clicked `+` on. The cognitive
distance between the block being commented on and the input box is the friction
the issue targets. The issue recommends **Option A**: render an inline composer
in the webview/canvas itself, co-located with the block, so the visual anchor is
preserved end-to-end while typing.

What the codebase already gives us:

- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx` is the shared React
  canvas. It renders a React overlay with the `CommentAffordance` (`+`) button
  anchored at the active block's vertical center (`overlayTop`); the `+` calls
  `onAddComment(line)` — the intent-only seam (spec 945 D6). The host then runs the
  text input and write-back.
- The **read-only comment cards** (existing comments) are injected imperatively as
  **in-flow DOM siblings directly below the block** (`.codev-canvas-marker-cards`,
  built in `buildMarkerCards` and inserted via `el.after(...)` in the `[html,
  markers]` effect). They sit in normal flow and push following content down.
- **Decision (reviewer, 2026-06-30): the composer renders in the same in-flow
  location as those read-only cards** — directly below the block, where the comment
  will live after submit — rather than in the left-gutter overlay. This keeps the
  add flow visually consistent with the existing card pattern and sets the precedent
  #1055 (edit mode) will reuse. To stay React-owned (clean state / focus / Esc) while
  living in the innerHTML-managed body, the composer mounts via **`ReactDOM.createPortal`
  into an in-flow placeholder element** injected below the block — the standard
  React-into-imperative-DOM pattern.
- `packages/core/src/review-markers.ts` `serializeReviewMarker` **already
  normalizes the body to a single line** (`body.replace(/\s+/g, ' ').trim()`). So
  a multi-line composer is purely an input ergonomics improvement; the on-disk
  marker form is unchanged. **No marker-format change is in scope** — #1055 owns
  the v2 format. Newlines typed in the composer collapse to spaces on write,
  matching today's single-line `<!-- REVIEW(@author): body -->` convention.

So the work is: move the text input from the host's Quick Pick into a
React composer in the canvas overlay, and widen the comment-intent seam to carry
the collected text.

## Proposed change

### 1. New composer component (artifact-canvas package)

Add `packages/artifact-canvas/src/overlays/CommentComposer.tsx`: a small
React component — a `<textarea>` plus **Submit** / **Cancel** affordances. Props:

```ts
interface CommentComposerProps {
  line: number;                       // 0-based source line (for aria-label)
  onSubmit: (text: string) => void;   // non-empty body
  onCancel: () => void;
}
```

Behavior:
- Autofocuses the textarea on mount.
- **Cmd/Ctrl+Enter submits**; **Enter inserts a newline** (multi-line natural);
  **Esc cancels**. (This keystroke mapping is the main thing to confirm at the
  dev-approval gate — see Risks.) Submit and Cancel buttons provide the same two
  actions for mouse / accessibility.
- Submit is a no-op (does not emit) when the trimmed body is empty — mirrors
  today's `if (!text) return;` guard in the host.
- `aria-label` on the textarea references the 1-based line (matches the
  `CommentAffordance` accessibility convention).

### 2. Wire the composer into ArtifactCanvas (in-flow, via portal)

In `ArtifactCanvas.tsx`:
- Add `composingLine: number | null` state and a `composerHost: HTMLElement | null`
  state (the in-flow placeholder node the composer portals into).
- The `+` click (`CommentAffordance.onActivate`) and the keyboard Enter/Space path
  now **open the composer** (`setComposingLine(line)`) instead of calling
  `onAddComment` directly. The `+` for that line is suppressed while its composer is
  open.
- A dedicated effect keyed on `[composingLine, html, markers]` manages the
  placeholder: remove any prior `.codev-canvas-comment-composer-host`, and if
  `composingLine !== null`, find the first `[data-line="<composingLine>"]` block and
  insert a fresh placeholder `<div>` **after the block's marker-card stack** (so the
  composer sits below any existing comments, like appending to a thread). Store the
  node via `setComposerHost`. This mirrors the marker-card injection and survives
  markers-only updates (the body isn't rebuilt then; the effect re-runs and re-places
  the placeholder). If the block no longer exists after a reload, clear
  `composingLine` (so the composer can't dangle).
- Render `composerHost && composingLine !== null ? createPortal(<CommentComposer
  line={composingLine} ... />, composerHost) : null`. The portal keeps the composer's
  state / focus / Esc React-owned even though its host node lives in the
  imperatively-managed body.
- On composer submit: call `onAddComment(line, text)`, then `setComposingLine(null)`.
  The host write-back fires a document change → re-list → the new card renders in the
  spot the composer occupied.
- On composer cancel / Esc: `setComposingLine(null)` and restore focus to the block
  (or its `+`), so keyboard users aren't stranded.

### 3. Widen the comment-intent seam

In `packages/artifact-canvas/src/types.ts`, change:

```ts
onAddComment(line: number): void;
// →
onAddComment(line: number, text: string): void;
```

This is a deliberate contract amendment to the spec-945 "locked" public surface,
recorded here as the PIR plan (the issue is the spec). The text is now collected
inside the canvas, so the seam carries it. The only production consumer is the
VSCode webview (updated below); `examples/main.tsx` is a dev aid (updated too).
`MarkerAdapter.add` stays host-invoked and unchanged — the package still never
writes markers itself (D6 invariant preserved).

### 4. Host: drop the Quick Pick

- `packages/vscode/src/markdown-preview/webview/main.ts`: change the callback to
  `onAddComment: (line, text) => vscodeApi.postMessage({ type: 'addComment', line, text })`.
- `packages/vscode/src/markdown-preview/preview-provider.ts`:
  - The `onDidReceiveMessage` handler reads `m.text` (string) alongside `m.line`.
  - `addComment(document, line, text)` **drops `showInputBox`** and writes the
    marker directly from the posted `text` (guard empty → no-op). The
    `WorkspaceEdit` / `serializeReviewMarker` / `document.save()` path is unchanged.
  - Update the class doc comment (lines ~18-21) that describes the `showInputBox`
    flow, so the architecture note matches the inline-composer reality.

### 5. Styling

Add `.codev-canvas-comment-composer-host` (the in-flow placeholder) and
`.codev-canvas-comment-composer` (and child) rules to
`packages/artifact-canvas/src/styles/default-theme.css`, using the existing
`--codev-canvas-*` tokens (border, background, accent, foreground) so the composer
matches the preview's prose typography and theme. Mirror the
`.codev-canvas-marker-cards` left-rule / spacing so the open composer reads as the
in-progress sibling of the comment cards it will become. The textarea is
full-width within the prose column; Submit / Cancel sit on a footer row.

## Files to change

| File | Change |
|---|---|
| `packages/artifact-canvas/src/overlays/CommentComposer.tsx` | **New** — textarea + Submit/Cancel composer |
| `packages/artifact-canvas/src/components/ArtifactCanvas.tsx` | `composingLine` + `composerHost` state; open composer on `+`/Enter; inject in-flow placeholder below the block + `createPortal` the composer into it; emit `onAddComment(line, text)` on submit; reconcile on reload |
| `packages/artifact-canvas/src/types.ts` | `onAddComment(line, text)` signature + doc |
| `packages/artifact-canvas/src/styles/default-theme.css` | `.codev-canvas-comment-composer` rules |
| `packages/artifact-canvas/examples/main.tsx` | Update dev-example `onAddComment` to new signature |
| `packages/vscode/src/markdown-preview/webview/main.ts` | Post `text` with `addComment` |
| `packages/vscode/src/markdown-preview/preview-provider.ts` | Drop `showInputBox`; read `text` from message; write marker from it; update doc comment |
| `packages/artifact-canvas/src/components/__tests__/artifact-canvas.test.tsx` | Update click/Enter tests to the open-composer→submit flow |
| `packages/artifact-canvas/src/overlays/__tests__/comment-composer.test.tsx` | **New** — composer unit tests |

## Risks & alternatives

- **Keystroke mapping (primary dev-gate question).** Cmd/Ctrl+Enter-to-submit with
  Enter=newline is the GitHub-review-composer convention and supports multi-line
  naturally, but it changes the muscle memory from today's single-line
  Enter-to-submit Quick Pick. This is exactly the kind of "does it feel right under
  real usage" call the PIR dev-approval gate exists for — the reviewer runs the
  preview and confirms submit / cancel / multi-line / focus behavior. Easy to flip
  to Enter-submit + Shift+Enter-newline if preferred.
- **Public-contract change.** Widening `onAddComment` touches the spec-945 "locked"
  surface. Contained: one production consumer, updated in the same PR; the D6
  "package never writes markers" invariant is preserved. Documented in types.ts and
  the review's Architecture Updates.
- **Imperative-body interaction (the main implementation risk).** The composer lives
  in-flow below the block, so its host placeholder is injected into the
  innerHTML-managed body — the same surface as the read-only cards. The "cards flash
  then vanish" hazard is avoided by (a) portalling the composer (React owns its
  content / focus / state; only the host *node* is in the body), and (b) re-placing
  the placeholder in the `[composingLine, html, markers]` effect, which re-runs on the
  same triggers that rebuild/redecorate the body. A document change while composing
  (rare — the reviewer is typing, not editing the file) rebuilds the body; the effect
  re-injects the placeholder and the portal re-attaches. The reconciliation guard also
  clears `composingLine` if the target block disappears on reload.
- **Multi-line vs single-line storage.** The composer accepts multi-line input;
  `serializeReviewMarker` collapses it to one line on write (unchanged behavior).
  No marker-format change here. If #1055 (v2 format) lands later, the composer's
  single submit site is the natural place to emit v2 markers.
- **Alternatives considered & rejected:** Option B (VS Code Comments API) forces a
  context switch back to the source editor, losing the read-while-write posture;
  Option C (floating popup) is still essentially relocated Quick Pick UX. Option A
  is the only one that preserves the visual anchor end-to-end (issue's recommendation).

## Test plan

**Unit (vitest, artifact-canvas):**
- `comment-composer.test.tsx` (new): autofocus; Cmd/Ctrl+Enter submits trimmed body;
  Enter inserts newline (does not submit); Esc cancels; empty/whitespace submit is a
  no-op; Submit/Cancel buttons work.
- `artifact-canvas.test.tsx` (updated): `+` click opens the composer **in-flow below
  the block** (placeholder is a sibling after the block / its card stack, not in the
  gutter; no immediate `onAddComment`); submitting the composer emits
  `onAddComment(line, text)`; Enter on a focused block opens the composer; the
  round-trip test drives text through the composer; D6 invariant (`markerAdapter.add`
  never called by the package) preserved; reload removing the active block clears the
  composer.

**Build / typecheck:**
- `pnpm --filter @cluesmith/codev-artifact-canvas check-types` and `build`.
- `pnpm --filter @cluesmith/codev-vscode` build/typecheck (the webview script is
  esbuild-bundled and excluded from tsc, per its file header — verify the host-side
  `preview-provider.ts` typechecks).

**Manual (dev-approval gate — the killer move):**
Run the worktree, open a spec/plan/review in the Codev Markdown Preview, click `+`
on several blocks (top, middle, bottom of a long doc), and confirm:
- The composer appears at the block, not at the top of the window.
- The block stays visible while typing (anchor preserved).
- Submit writes the marker; the comment card appears below the block.
- Multi-line input works; Esc cancels cleanly; focus is restored on cancel.
- Keyboard-only flow (Tab to `+`, Enter to open, type, Cmd/Ctrl+Enter to submit).

## Out of scope (per issue)

Source-editor `Codev: Add Review Comment` (`commands/review.ts`); the summary
webview (#860); codelens diff-editor comments (#1037); comment lifecycle
edit/delete/reply/resolve (#1055); author identity / placeholder / discoverability
(#857). Marker on-disk format change (#1055).
