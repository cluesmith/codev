# PIR Review: Edit + Preview-Side Delete on Review Comments

Fixes #1055

## Summary

Makes the markdown reviewer a functional reviewing tool by adding **edit** to both review-comment surfaces (the editor Comments-API gutter and the preview cards) and **delete from the preview** (previously delete worked only from the editor gutter). Both operations use **line + content identity** — the marker's own physical file line plus an author + body-prefix optimistic-concurrency check — with **no on-disk format change**; a stable-ID "format v2" was explicitly left to #1131. A write that loses the race (file changed between click and host write) refuses to mutate, refreshes the preview, and surfaces an info toast rather than corrupting a different marker.

## Files Changed

- `packages/core/src/review-markers.ts` (+53 / -3) — `markerLine` on `ReviewMarker`; `matchesExpectedMarker` + `rewriteReviewMarkerBody` helpers
- `packages/core/src/__tests__/review-markers.test.ts` (+67 / -3) — unit tests for the new field + helpers
- `packages/artifact-canvas/src/types.ts` (+26) — optional `markerLine` + `onEditComment`/`onDeleteComment` props
- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx` (+132 / -6) — per-card edit/delete affordances (inline SVG icons), delegated click routing, edit-mode composer wiring
- `packages/artifact-canvas/src/overlays/CommentComposer.tsx` (+28 / -6) — optional `initialText` prefill for edit ("Save" vs "Comment")
- `packages/artifact-canvas/src/styles/default-theme.css` (+42) — card action-row + SVG-button styling
- `packages/artifact-canvas/src/components/__tests__/marker-card-edit-delete.test.tsx` (+104) — card → intent wiring, stacked second-of-three
- `packages/vscode/src/markdown-preview/messages.ts` (+8 / -1) — `editComment` / `deleteComment` message shapes
- `packages/vscode/src/markdown-preview/preview-provider.ts` (+101) — race-safe host handlers (`verifyReviewMarker` / `editReviewMarker` / `deleteReviewMarker`)
- `packages/vscode/src/markdown-preview/webview/main.ts` (+15) — wires the two intents to `postMessage`
- `packages/vscode/src/comments/plan-review.ts` (+105 / -12) — `ReviewComment` class + edit action (start/save/cancel), author preserved
- `packages/vscode/package.json` (+33) — three edit commands + `comments/comment/title` (pencil) and `comments/comment/context` (save/cancel) menus
- `packages/vscode/src/__tests__/preview-edit-delete.test.ts` (+197) — host edit/delete: stacked, race, delete-single/last-line, mismatch
- `packages/vscode/src/__tests__/plan-review-edit.test.ts` (+134) — editor save-edit: author preserved, stacked second-of-three
- `codev/resources/arch.md`, `codev/resources/lessons-learned.md` — cold-tier updates (see below)
- `codev/plans/1055-vscode-edit-preview-side-delet.md`, `codev/state/pir-1055_thread.md` — plan + thread

## Commits

- `f47a1bd6` [PIR #1055] core: surface markerLine + marker verify/rewrite helpers
- `8af0dc7f` [PIR #1055] artifact-canvas: per-card edit/delete affordances + edit-prefill composer
- `f7fb450f` [PIR #1055] vscode preview: editComment/deleteComment host handlers (race-safe)
- `795e50e2` [PIR #1055] vscode editor: edit action on review comments (author preserved)
- `602650cb` [PIR #1055] Thread: implement phase complete
- `ea266fc2` [PIR #1055] artifact-canvas: replace emoji card icons with inline SVGs
- `bb02892f` [PIR #1055] Thread: dev-approval testing feedback (icons fixed, delete non-issue)

## Test Results

- `pnpm build` (porch `build` check): ✓ pass (7.5s)
- Tests (porch `tests` check): ✓ pass (34.4s)
- Per-package: core 40 ✓, artifact-canvas 72 ✓, vscode 543 ✓ (25 new across the three review test files); typecheck (`tsc` host + webview), eslint, and esbuild bundle all clean.
- Manual verification at the `dev-approval` gate (running worktree): edit from the preview composer and the editor pencil (author preserved, body updated); delete from a preview card; stacked-comment edit/delete acting on only the intended marker; icon legibility. The reviewer surfaced three findings during testing — all resolved (see Things to Look At).

## Architecture Updates

**COLD (`codev/resources/arch.md`)** — added a bullet to the review-marker/artifact-canvas subsystem documenting the #1055 edit/delete design: the `markerLine` physical-line identity, the core `matchesExpectedMarker` / `rewriteReviewMarkerBody` mechanics, the verify-before-write race behavior (refuse + refresh + toast), the optional canvas props (read-only hosts render plain cards), and the editor `ReviewComment` / `thread.comments`-reassignment detail. This extends an existing documented subsystem rather than introducing a new module boundary, so it's reference detail (cold), not a top-tier always-inject fact.

**HOT (`arch-critical.md`)** — no change. No new always-on system-shape invariant; the on-disk marker format is deliberately unchanged, so the existing hot facts still hold.

## Lessons Learned Updates

**COLD (`codev/resources/lessons-learned.md`)** — added, under Debugging: a VS Code command that is *visible but does nothing* after an extension change is often a stale Extension Development Host, not a code regression — reload before diagnosing dispatch. Captured because a "delete no longer works" report against a byte-for-byte-unchanged command turned out to be environmental, and a speculative fix was started then reverted once confirmed.

**HOT (`lessons-critical.md`)** — no change. The lesson is a debugging recipe, not a cross-cutting behavior-changing rule; the existing hot lessons ("'it compiled' ≠ 'it works'", "verify claims against the actual file") already cover the general principle.

## Things to Look At During PR Review

- **Optimistic-concurrency check** (`matchesExpectedMarker`, `preview-provider.ts` verify path): the body match is a **prefix** on the whitespace-normalized body, deliberately tolerant of the codec's `\s+`→space normalization while still refusing a genuinely different marker. Combined with `markerLine` (one marker per line) it uniquely locates the target even in a stack. The race path is covered by `preview-edit-delete.test.ts` (marker moved between click and write → no write, refresh + toast).
- **Author preservation on edit**: both surfaces read the author *off the existing marker line* (`rewriteReviewMarkerBody`), never from the caller — an edit can rephrase the body but cannot reassign authorship. `plan-review-edit.test.ts` pins this (the comment's own author field is `'ignored'`; the on-disk `@amr` survives).
- **Editor edit re-render**: `startEditReviewComment` reassigns `thread.comments` because VS Code only re-renders a thread on reassignment; the subsequent file-change `refreshDoc` recreates the thread from disk as the source of truth.
- **Reviewer findings during dev-approval, all resolved**: (1) multi-line comments collapse to one line — inherent to the single-line marker format, same for add and edit, deferred to #1131 (no change); (2) card icons looked odd — replaced the emoji/dingbat glyphs with inline stroke SVGs (host-agnostic, no codicon-font dependency); (3) editor-gutter delete "no-op" — traced to a stale Extension Host, not reproducible after reload; the delete command/menu are unchanged from `main`.

### PR-stage consult verdicts + dispositions (single-pass; not independently re-reviewed)

The PR-stage consult was 2-of-2 (Claude + a Codex-family lens): **Claude → APPROVE** (HIGH, no issues); the **Codex lens → REQUEST_CHANGES** with two correctness findings, **both real and both fixed** (PIR is single-pass, so these fixes were NOT re-reviewed by the models — the human at the `pr` gate is the last check):

1. **`matchesExpectedMarker` one-sided normalization** (`packages/core/src/review-markers.ts`) — the verify check normalized only `expectedBodyPrefix` and compared it against the *raw* on-disk body, so a hand-authored marker with irregular internal whitespace (e.g. `foo  bar`) falsely failed verification → preview edit/delete would spuriously refuse with a "this comment changed" toast. **Fixed**: normalize both sides before the prefix compare. Regression test added (double-space + tab bodies still match the normalized prefix; a genuinely different body still rejects). *(Independently confirmed by the architect's own second lens.)*
2. **`CommentComposer` stale text on same-block re-edit** (`packages/artifact-canvas/src/components/ArtifactCanvas.tsx`) — two comments stacked on one block share `composingLine`, so clicking edit on a second card did not remount the composer and its textarea kept the first card's text; a save would write the wrong body to the second marker. **Fixed**: `key` the composer on the edit target (`markerLine`) so switching cards remounts it and re-seeds `useState(initialText)`. Regression test added (edit card #1 → edit card #2 same block → composer shows #2's text; save targets marker #2). This is the exact stacked-comment scenario the feature targets — worth a close look.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1055` → **Review Diff**
- **Run**: open a `codev/plans|specs|reviews/*.md` in the Codev Markdown Preview (and the raw editor)
- **What to verify** (maps to the plan's Test Plan):
  - Edit a comment from the preview composer and from the editor pencil → author preserved, body updated
  - Delete a comment from a preview card (in addition to the editor gutter)
  - Stack three comments on one block → edit/delete the middle one → only marker #2 changes
  - Externally move a marker while the preview is open, then act on a stale card → the write refuses, the preview refreshes, and the info toast appears
  - Path eligibility unchanged: affordances only appear on `codev/(plans|specs|reviews)/*.md`
