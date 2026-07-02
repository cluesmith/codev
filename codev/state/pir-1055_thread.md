# PIR #1055 — vscode: edit + preview-side delete on review comments

## Builder: pir-1055 (strict mode, PIR protocol)

### Plan phase (in progress)
Investigated the review-comment architecture:
- **Editor Comments-API surface**: `packages/vscode/src/comments/plan-review.ts` — creates one CommentThread per marker, anchored at the marker's own physical file line. Already has submit + delete. Menu wiring in `package.json` under `comments/commentThread/*`.
- **Preview surface**: `packages/vscode/src/markdown-preview/preview-provider.ts` (host) ↔ `webview/main.ts` ↔ `@cluesmith/codev-artifact-canvas` (`ArtifactCanvas.tsx`, `buildMarkerCards`). Host writes markers via WorkspaceEdit; webview emits intent messages (`messages.ts` union). Currently only `addComment`.
- **Codec**: `packages/core/src/review-markers.ts` — `parseReviewMarkers` returns `{author, line (anchor), text, raw}`. **Key gap**: no physical marker-line in the parsed model → needed for stacked-comment edit/delete identity.

Design: add `markerLine` (physical 0-based file line) to the parsed `ReviewMarker`; surface it through the message channel; add `editComment`/`deleteComment` webview→host messages with optimistic-concurrency check (`expectedAuthor` + `expectedBodyPrefix`) verified in core.

Plan-gate decisions surfaced (affordance UI, payload shape, race UX) per the issue.

### Plan approved → Implement phase (complete, pre-commit)
Implemented across four packages:
- **core**: `markerLine` on `ReviewMarker` (physical file line, surfaced from parse loop); pure `matchesExpectedMarker` (optimistic-concurrency check, author + normalized body-prefix) + `rewriteReviewMarkerBody` (author/indent preserved). 40 tests pass.
- **artifact-canvas**: optional `markerLine` + `onEditComment`/`onDeleteComment` props; per-card edit(✎)/delete(🗑) action row (rendered only when host provides the callback AND marker has markerLine); `CommentComposer` gained `initialText` (edit prefill → "Save"); delegated click handler resolves identity from marker list. 72 tests pass.
- **vscode preview host**: `editComment`/`deleteComment` messages; exported `verifyReviewMarker`/`editReviewMarker`/`deleteReviewMarker` (verify-then-write, race → refresh + info toast). webview wires the two intents.
- **vscode editor surface**: `ReviewComment` class carrying parent thread + saved body; `startEditReviewComment`/`saveEditReviewComment`/`cancelEditReviewComment` commands; package.json `comments/comment/title` (pencil) + `comments/comment/context` (save/cancel) menus.

All green: core 40, canvas 72, vscode 543 (typecheck + lint + esbuild clean). Decisions implemented as recommended (trash+pencil action row; author+bodyPrefix payload; refresh + info toast on race).

### Dev-approval gate — reviewer testing feedback
Three issues raised while testing the running worktree:
1. **Multi-line comments collapse to one line** — not a bug: the flat single-line marker format (`serializeReviewMarker` normalizes whitespace); same for add and edit; multi-line is format-v2, deferred to #1131. No change.
2. **Card icons looked odd** — were raw emoji glyphs (✎/🗑) that render inconsistently and can't use VS Code codicons in a host-agnostic webview. Replaced with inline stroke SVGs (pencil/trash, currentColor, hover bg) via createElementNS. Fixed + committed.
3. **Editor-gutter delete no-op** — investigated: delete command + menu are byte-identical to main (purely additive diff). Symptom was "trash visible, click does nothing." Turned out to be a **stale-build artifact — no longer reproducible after reload**. Briefly moved delete to per-comment placement speculatively, then **reverted** once confirmed environmental; editor delete stays unchanged on the thread header. No code change.

### Review phase → PR #1132 → PR-stage consult
Wrote review + retrospective; arch.md/lessons-learned.md cold-tier updates. Opened PR #1132 (Fixes #1055), recorded with porch.

**Consult env issue (codex):** macOS XProtect deleted the un-notarized @openai/codex vendor binary (SIGKILL→ENOENT) — identical to #1118. Fix: user reinstalled globally (step 1), I ran ad-hoc `codesign --force --sign -` + cleared quarantine (step 2). Codex consult then ran clean.

**Consult verdicts (2-of-2):** Claude=APPROVE (HIGH, no issues); Codex-lens=REQUEST_CHANGES with TWO real correctness bugs — both ACCEPTED + FIXED + regression-tested:
1. `matchesExpectedMarker` normalized only the expected side vs raw body → hand-authored markers with internal double-space/tab spuriously failed edit/delete verify. (Architect's own zen gpt-5.1-codex lens independently flagged this same one.) Fixed: normalize both sides.
2. `CommentComposer` stale text on same-block re-edit (shared `composingLine` → no remount) → save could write wrong body to a stacked marker. Fixed: `key` the composer on the edit target to force remount.

Green after fixes: core 41, canvas 73, vscode 543. Rebuttal/dispositions in `codev/projects/1055-*/1055-review-iter1-rebuttals.md`. **`pr` gate pending** — architect notified, leading with the RC disposition (PIR single-pass → not model-re-reviewed; human verifies at pr gate). Waiting for gate approval to merge.



