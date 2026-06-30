# PIR Review: Inline composer for preview-pane review comments

Fixes #1107

## Summary

Adding a review comment from the Codev Markdown Preview previously opened
`vscode.window.showInputBox` — a center-top Quick Pick far from the block the
reviewer clicked `+` on, breaking the visual anchor while typing. This replaces it
with an **inline composer rendered in-flow directly below the block** (a textarea
with Submit/Cancel), so the reviewer types the comment exactly where it will live.
The comment-intent seam widened from `onAddComment(line)` to
`onAddComment(line, text)`; the host dropped its text prompt and writes the marker
straight from the body the composer collected. The on-disk REVIEW-marker format is
unchanged (multi-line input collapses to single-line at write time, as before).

## Files Changed

- `packages/artifact-canvas/src/overlays/CommentComposer.tsx` (+88 / −0) — new composer component
- `packages/artifact-canvas/src/overlays/__tests__/comment-composer.test.tsx` (+83 / −0) — new unit tests
- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx` (+~110 / −~24) — composer state, in-flow placeholder injection, portal wiring; JSX conversion
- `packages/artifact-canvas/src/components/__tests__/artifact-canvas.test.tsx` (+~80 / −~15) — open-composer→submit flow, Esc/reload coverage
- `packages/artifact-canvas/src/__tests__/end-to-end.test.tsx` (+~20 / −~14) — drive round-trip through the composer
- `packages/artifact-canvas/src/types.ts` (+8 / −4) — `onAddComment(line, text)` contract amendment
- `packages/artifact-canvas/src/overlays/CommentAffordance.tsx` (+11 / −9) — JSX conversion
- `packages/artifact-canvas/src/overlays/MarkerMinimap.tsx` (+21 / −17) — JSX conversion
- `packages/artifact-canvas/src/renderer/MarkdownView.tsx` (+7 / −3) — JSX conversion
- `packages/artifact-canvas/src/styles/default-theme.css` (+58 / −0) — composer styling
- `packages/artifact-canvas/examples/main.tsx` (+4 / −4) — example uses the new seam
- `packages/vscode/src/markdown-preview/messages.ts` (+24 / −0) — new named webview↔host protocol types
- `packages/vscode/src/markdown-preview/preview-provider.ts` (+~22 / −~15) — drop `showInputBox`; write from posted text; use protocol types
- `packages/vscode/src/markdown-preview/webview/main.ts` (+~9 / −~6) — post `{line, text}`; use protocol types
- `codev/plans/1107-preview-inline-comment-composer.md`, `codev/reviews/1107-preview-inline-comment-composer.md`, `codev/state/pir-1107_thread.md` — PIR artifacts
- `codev/resources/arch.md`, `codev/resources/lessons-learned.md` — governance updates (below)

## Commits

- `87a6788d` [PIR #1107] artifact-canvas: inline comment composer; widen onAddComment seam to (line, text)
- `1f5e0614` [PIR #1107] vscode preview: drop showInputBox; write marker from composer-collected text
- `69b6e39c` [PIR #1107] Define named webview<->host message protocol types (review feedback)
- `2b9528c4` [PIR #1107] Convert artifact-canvas source components from React.createElement to JSX (review feedback)
- (plus thread-update commits)

## Test Results

- `pnpm --filter @cluesmith/codev-artifact-canvas build`: ✓ pass
- `pnpm --filter @cluesmith/codev-artifact-canvas test`: ✓ pass (68 tests; 9 new composer unit tests + updated canvas/e2e tests driving the open-composer→submit flow)
- `pnpm --filter @cluesmith/codev-artifact-canvas check-types`: ✓ pass
- vscode `check-types` (host + `tsconfig.webview.json`): ✓ pass
- vscode esbuild bundle (`node esbuild.js --production`): ✓ pass
- vscode `lint`: ✓ pass
- vscode `test:unit`: ✓ pass (516 tests)
- Manual verification: confirmed by the human at the `dev-approval` gate — composer appears at the block (not the window top), block stays visible while typing, ⌘/Ctrl+Enter submits, Esc cancels and restores focus, multi-line input works, submitted comment collapses into the persisted card in place.

## Architecture Updates

**COLD — `codev/resources/arch.md` updated** (the "Markdown Preview / artifact-canvas
host integration" entry). The previous text described the now-removed flow
(`onAddComment(line)` → host `showInputBox` → `WorkspaceEdit`). Updated to reflect:
the inline composer (`overlays/CommentComposer.tsx`, portalled in-flow below the
block), the widened `onAddComment(line, text)` seam, and the new named host↔webview
message protocol (`markdown-preview/messages.ts`, shared by both ends; inbound data
still validated at runtime because it's untrusted).

**HOT — no `arch-critical.md` change.** This is a package-level seam/UX change, not a
framework-wide cross-cutting fact; it does not meet the hot-tier bar (and the file is
at/near its cap). Correctly routed to the cold reference.

## Lessons Learned Updates

**COLD — `codev/resources/lessons-learned.md` updated** (Architecture section): the
reusable pattern for placing an *interactive* React widget inside an
`innerHTML`-managed body — inject a placeholder node in an effect and `createPortal`
the component into it, with an idempotent injection effect to avoid a
`setState`-on-inject loop. Spec-narrow recipe → cold tier, not the capped hot file.

**HOT — no `lessons-critical.md` change.** No behavior-changing cross-cutting rule
emerged that warrants displacing a capped hot lesson.

## Things to Look At During PR Review

- **`ArtifactCanvas.tsx` placeholder-injection effect** — the trickiest part. It
  injects an in-flow `.codev-canvas-comment-composer-host` below the block (after the
  marker-card stack if present) and is guarded to be idempotent: it bails when a
  correctly-placed host already exists (`isConnected && previousElementSibling ===
  anchor`), so the `setComposerHost` call doesn't loop. An `html` rebuild disconnects
  the node and the guard re-creates it. Worth a careful read.
- **Event isolation via portal** — the composer's DOM lives inside the body div, but
  React routes synthetic events through the *fiber* tree (the portal's parent is the
  canvas root, not the body div), so the body's `onKeyDown` "open composer" handler
  does not fire for keystrokes typed into the composer. This is why plain Enter in the
  textarea inserts a newline rather than re-triggering the open path.
- **Keystroke choice** — ⌘/Ctrl+Enter submits, Enter = newline, Esc cancels (GitHub
  review-composer convention). This changed the old single-line Enter-to-submit muscle
  memory; confirmed acceptable at the dev-approval gate.
- **Untrusted `postMessage`** — `preview-provider.ts` casts inbound to the named union
  for the discriminant but still validates `line`/`text` at runtime. The named type
  documents the shape; it does not vouch for an arbitrary runtime value.
- **Scope note (JSX conversion)** — at the reviewer's request, all five artifact-canvas
  source components were converted from `React.createElement` to JSX in this PR (not
  just the new file), so the package is internally consistent. Behavior is unchanged;
  it inflates the diff. The package's `tsconfig.json` already had `"jsx": "react-jsx"`.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1107` → **View Diff**
- **Run dev server**: VSCode sidebar → **Run Dev Server**, or `afx dev pir-1107`
- **What to verify**:
  - Open a `codev/specs|plans|reviews/*.md` in the Codev Markdown Preview ("Reopen With… → Codev Markdown Preview").
  - Click `+` on blocks at the top, middle, and bottom of a long doc — the composer appears at the block each time, and the block stays visible while typing.
  - ⌘/Ctrl+Enter submits and the comment collapses into the persisted card in place; Esc cancels and returns focus to the block.
  - Keyboard-only: Tab to `+`, Enter to open, type, ⌘/Ctrl+Enter to submit.
  - Multi-line input works (Enter = newline); the on-disk marker is still single-line.
