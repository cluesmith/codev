# PIR Plan: Edit + Preview-Side Delete on Review Comments

Issue #1055 — make the markdown reviewer functional by adding **edit** (both
surfaces) and **preview-side delete** to review comments, using line + content
identity with **no on-disk format change**.

## Understanding

The review-comment feature ships across two surfaces that both read/write the
same flat on-disk marker, `<!-- REVIEW(@author): body -->`, via the shared codec
`@cluesmith/codev-core/review-markers`:

1. **Editor Comments-API surface** — `packages/vscode/src/comments/plan-review.ts`.
   Renders one `CommentThread` per marker, anchored at the marker's **own physical
   file line** (`document.positionAt(match.index)`, `plan-review.ts:85`). It has
   **submit** (`submitReviewComment`) and **delete** (`deleteReviewCommentByThread`,
   which re-confirms the line is still a REVIEW marker before deleting,
   `plan-review.ts:191-210`). It has **no edit**.

2. **Preview surface** — `packages/vscode/src/markdown-preview/preview-provider.ts`
   (host) ↔ `webview/main.ts` ↔ `@cluesmith/codev-artifact-canvas`
   (`ArtifactCanvas.tsx` → `buildMarkerCards`). The host pushes raw text + parsed
   markers; the canvas renders inline comment cards below each annotated block and
   emits an `addComment { line, text }` intent, which the host writes with a
   `WorkspaceEdit` then saves; the file change re-pushes (`preview-provider.ts:69-95`).
   It has **add** only — **no edit, no delete**.

So today: edit exists nowhere; delete exists only in the editor gutter. This PR
adds edit to both surfaces and delete to the preview.

### The identity problem (why a small model change is needed)

The parsed `ReviewMarker` (`packages/core/src/review-markers.ts:37-46` and the
mirrored `packages/artifact-canvas/src/types.ts:35-44`) carries `line` = the
**anchor** line (the non-marker line *above* the marker). For a stack of three
comments on one block, all three markers share the **same** `line`. The anchor
line therefore does **not** uniquely identify a marker.

The editor surface is already unambiguous: each thread is anchored at the marker's
own physical line, so `thread.range.start.line` *is* the marker line. But the
**preview card** only knows the anchor line — it cannot tell the host "edit the
second of three." The issue's stated approach is **line-identity**: each card must
carry the marker's **own physical file line**. That value is computed inside
`parseReviewMarkers` (the loop index `i`) but currently discarded. We surface it
as a new parsed field `markerLine`.

**This is not an on-disk format change** (explicitly out of scope, deferred to
#1131). The on-disk bytes stay `<!-- REVIEW(@author): body -->`. We only enrich
the **in-memory parsed model** with the physical line the parser already visits.

## Proposed Change

### 1. Core codec: surface the physical marker line + share the verify/write helpers

`packages/core/src/review-markers.ts`:

- Add `markerLine: number` (0-based physical file line of the marker itself) to the
  `ReviewMarker` interface and populate it in `parseReviewMarkers` (it is the loop
  index `i`, already computed — `review-markers.ts:122-129`).
- Add pure, host-agnostic, unit-testable helpers so the preview host, the editor
  path, and tests share one definition of the optimistic-concurrency check and the
  line rewrite/delete (no `vscode`, no DOM):
  - `matchesExpectedMarker(lineText, expectedAuthor, expectedBodyPrefix): boolean`
    — parse `lineText` with `REVIEW_MARKER_RE`; return true iff it is a marker whose
    author equals `expectedAuthor` **and** whose normalized body **starts with**
    `expectedBodyPrefix` (prefix, not equality — tolerant of trailing-whitespace
    normalization; see Decision 3).
  - `rewriteReviewMarkerBody(lineText, newBody): string | null` — if `lineText` is a
    marker, return the re-serialized marker preserving the **same author + indent**
    with `newBody` (via `serializeReviewMarker`); else `null`. Author is never taken
    from the caller — it is read back off the existing line, so an edit can never
    reassign authorship.

### 2. Artifact-canvas: `markerLine` on the model + edit/delete card affordances + intent seams

`packages/artifact-canvas/src/types.ts`:

- Add `markerLine?: number` to `ReviewMarker` (optional → additive, back-compat: a
  host that does not populate it simply gets no edit/delete affordances).
- Add two optional intent props to `ArtifactCanvasProps` (mirrors the existing
  `onAddComment` D6 seam; the package never writes markers itself):
  - `onEditComment?(markerLine, expectedAuthor, expectedBodyPrefix, newBody): void`
  - `onDeleteComment?(markerLine, expectedAuthor, expectedBodyPrefix): void`

`packages/artifact-canvas/src/components/ArtifactCanvas.tsx` (`buildMarkerCards` +
wiring):

- Render an **edit** and a **delete** affordance on each comment card, **only when**
  the corresponding `onEdit`/`onDelete` callback is provided **and** the marker has a
  `markerLine` (keeps the package usable by read-only hosts / the dashboard until it
  implements write-back).
- **Delete**: on activate, call `onDeleteComment(markerLine, author, textPrefix)`.
- **Edit**: on activate, open the existing `CommentComposer` **prefilled** with the
  card's current body (small additive prop `initialText` on `CommentComposer`),
  in an "editing this card" mode; on submit, call
  `onEditComment(markerLine, author, textPrefix, newBody)` instead of `onAddComment`.
  Reuses the composer's textarea, Cmd/Ctrl+Enter submit, Esc cancel — no new input UI.
- `buildMarkerCards` currently builds pure DOM (no React). The affordance buttons
  are added there with `data-marker-line` / `data-action` attributes and handled via
  a delegated click listener on the body (same imperative-DOM pattern the file
  already uses for cards), routing to `openComposer`-for-edit / `onDeleteComment`.
  Author/body continue to be set via `textContent` (no `innerHTML`) — the existing
  injection-safety invariant is preserved (`ArtifactCanvas.tsx:27-28`).

### 3. Preview host: `editComment` / `deleteComment` messages, verified before write

`packages/vscode/src/markdown-preview/messages.ts`:

- Extend `WebviewToHostMessage` with:
  - `{ type: 'editComment'; markerLine: number; expectedAuthor: string; expectedBodyPrefix: string; newBody: string }`
  - `{ type: 'deleteComment'; markerLine: number; expectedAuthor: string; expectedBodyPrefix: string }`

`packages/vscode/src/markdown-preview/preview-provider.ts`:

- Wire the webview's new intent props through `webview/main.ts` → `postMessage`.
- In `onDidReceiveMessage`, add runtime-validated handlers (the boundary is
  untrusted — same guard style as the existing `addComment` check at
  `preview-provider.ts:92`):
  - **editComment** → read `document.lineAt(markerLine)`; if
    `matchesExpectedMarker(...)` fails → **race**: do not write; call `pushUpdate()`
    to re-push current state (the card refreshes) and surface the race UX
    (Decision 4). If it matches → `rewriteReviewMarkerBody`, apply a `WorkspaceEdit`
    replacing that whole line, `save()`.
  - **deleteComment** → same verify; on match, delete the whole marker line
    (reusing the editor path's line+newline deletion logic, `plan-review.ts:202-207`)
    via `WorkspaceEdit`, `save()`.
- Both paths guard `markerLine` in range (`< document.lineCount`) and no-op
  gracefully otherwise, matching the editor delete's defensiveness.

### 4. Editor Comments-API surface: add edit

`packages/vscode/src/comments/plan-review.ts` + `packages/vscode/package.json`:

- Add a **pencil** action to each inline-review comment via a
  `comments/comment/title` menu (per-comment, distinct from the existing
  thread-title delete), command `codev.startEditReviewComment`, gated by
  `commentController == codev-review` + the `inline-review` context value.
- `startEditReviewComment(comment)` sets `comment.mode = CommentMode.Editing` and
  reassigns `thread.comments` (VS Code requires reassignment to re-render). VS Code
  renders its native inline edit textarea with Save/Cancel.
- Add `codev.saveEditReviewComment` (contributed to `comments/comment/context`)
  that reads the edited `comment.body`, rewrites the marker line via
  `rewriteReviewMarkerBody` (author preserved) with a `WorkspaceEdit`, saves; the
  file change fires `refreshDoc`, which disposes + recreates the thread from the new
  bytes (existing mechanism, `plan-review.ts:72-107`). Add a matching
  `codev.cancelEditReviewComment` that restores `mode = Preview`.
- The thread here is anchored at the marker's own physical line, so no
  `expectedBodyPrefix` race machinery is needed on this surface — the delete path
  already re-confirms the marker shape (`plan-review.ts:198-200`); edit reuses that
  guard before writing.

## Files to Change

- `packages/core/src/review-markers.ts` — add `markerLine` to `ReviewMarker` + to
  `parseReviewMarkers` output; add `matchesExpectedMarker`,
  `rewriteReviewMarkerBody`.
- `packages/core/src/__tests__/review-markers.test.ts` — unit tests for the new
  field + helpers (verify match/mismatch, author preservation, prefix tolerance).
- `packages/artifact-canvas/src/types.ts` — `markerLine?` on `ReviewMarker`;
  `onEditComment?` / `onDeleteComment?` on `ArtifactCanvasProps`.
- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx` — edit/delete card
  affordances + delegated handlers + edit-prefill wiring.
- `packages/artifact-canvas/src/overlays/CommentComposer.tsx` — optional
  `initialText` prop (prefill for edit).
- `packages/artifact-canvas/src/styles/default-theme.css` — affordance styling
  (`.codev-canvas-marker-card-actions` etc.), near the existing card rules (line 266+).
- `packages/vscode/src/markdown-preview/messages.ts` — `editComment` /
  `deleteComment` message shapes.
- `packages/vscode/src/markdown-preview/preview-provider.ts` — host handlers
  (verify → write) + thread of new props into the webview bootstrap.
- `packages/vscode/src/markdown-preview/webview/main.ts` — pass `onEditComment` /
  `onDeleteComment` to `<ArtifactCanvas>` → `postMessage`.
- `packages/vscode/src/comments/plan-review.ts` — `startEditReviewComment` /
  `saveEditReviewComment` / `cancelEditReviewComment`.
- `packages/vscode/package.json` — three new commands + `comments/comment/title`
  (pencil) and `comments/comment/context` (save/cancel) menu contributions.
- Tests (new): a preview-host edit/delete test file and an editor-edit test file
  (see Test Plan).

## Plan-Gate Decisions to Lock

**Decision 1 — Preview delete affordance UI.** Recommend a **trash icon inline in a
per-card action row** (revealed on card hover/focus, always present for keyboard
a11y), rather than a corner `×` (reads as "dismiss/close", ambiguous) or a `...`
overflow menu (an extra click for a two-item set). Pairs naturally with the pencil.

**Decision 2 — Edit affordance in preview.** Recommend a **pencil icon** in the same
per-card action row as delete. Rejected: `...` menu (extra click), double-click-body
(undiscoverable, and conflicts with text selection while reading).

**Decision 3 — Message payload shape.** Recommend **`expectedAuthor` +
`expectedBodyPrefix`** (semantic fields), not whole-raw-text byte-match. Byte-match
is brittle against the codec's whitespace normalization (`serializeReviewMarker`
collapses `\s+` → single space); a prefix check on the normalized body tolerates
that while still catching a genuinely different marker. `markerLine` + author +
body-prefix together are unambiguous even for stacked comments.

**Decision 4 — Error UX on race.** Recommend the host **always `pushUpdate()` on a
failed verify (silent refresh so the stale card corrects itself) AND surface a
`vscode.window.showInformationMessage`** ("This comment changed since you opened it —
showing the latest.") so the reviewer understands why their edit/delete "did
nothing." A silent-only refresh risks reading as a no-op bug. The write path errors
legibly rather than corrupting a different marker either way.

## Risks & Alternatives Considered

- **Risk: touching the shared `ReviewMarker` shape.** Mitigation: `markerLine` is
  **additive** (required in core where we control all callers; **optional** in the
  artifact-canvas public contract so external/read-only hosts are unaffected). No
  on-disk format change → the dashboard's bundled codec still round-trips existing
  markers. Cross-host format work stays deferred to #1131 as the issue directs.
- **Risk: stacked-comment identity.** Mitigation: physical `markerLine` (one marker
  per line) is the disambiguator; the verify check adds author+body as a second
  factor. Explicitly covered by regression tests (edit/delete second-of-three).
- **Risk: race between preview click and host write.** Mitigation: the verify-first
  write path is the core of the design; a mismatch refuses to write, refreshes, and
  informs (Decision 4). Covered by a race regression test (marker moved between
  click and write).
- **Risk: editor edit re-render.** VS Code's Comments API only re-renders on
  `thread.comments` reassignment; forgetting it leaves a stuck editing box.
  Mitigation: reassign on every mode transition; the subsequent file-change refresh
  recreates the thread from disk as the source of truth.
- **Alternative rejected — Format v2 (stable IDs).** Explicitly out of scope per the
  issue; line+content identity solves edit+delete without it and avoids cross-host
  codec risk. Deferred to #1131.
- **Alternative rejected — a separate edit composer component.** Reusing
  `CommentComposer` with an `initialText` prop keeps one input UX and less surface.

## Test Plan

**Unit (core — `review-markers.test.ts`):**
- `parseReviewMarkers` populates `markerLine` correctly, including a stack of three
  markers on one block (distinct `markerLine`, shared `line`).
- `matchesExpectedMarker`: matches on author + body-prefix; rejects on author
  mismatch, on body mismatch, and on a non-marker line.
- `rewriteReviewMarkerBody`: preserves author + indent, updates body; returns `null`
  for a non-marker line.

**Unit (preview host — new test, mocked `vscode`, following
`plan-review-append.test.ts`):**
- **delete-single**: one marker → correct line deleted (line + trailing newline).
- **delete-stacked-second-of-three**: three markers on one block; deleting the
  second removes only marker line #2, leaving #1 and #3.
- **edit-second-of-three**: rewrites only marker line #2; author preserved, body
  updated; #1 and #3 untouched.
- **race (marker moved between click and write)**: the marker at `markerLine` no
  longer matches expected author/body → **no `WorkspaceEdit` applied**, `pushUpdate`
  re-invoked (refresh), info message surfaced.
- **mismatched-expected-shape**: `markerLine` points at a non-marker / different
  author → write refuses cleanly (no edit applied).

**Unit (editor surface — new test):** `saveEditReviewComment` rewrites the marker
line preserving author, updating body; a stacked second-of-three thread edits only
its own line.

**Path eligibility (regression):** all new commands/handlers remain gated to
`codev/(plans|specs|reviews)/*.md` via `isEligibleReviewPath` — unchanged.

**Manual (at the `dev-approval` gate, on the running worktree):**
- Open a plan `.md` in the Codev Markdown Preview.
- Edit a comment from the preview composer → author unchanged, body updated in file.
- Delete a comment from the preview → marker removed from file.
- Stack three comments on one block; edit the middle one → only it changes; delete
  the middle one → only it is removed.
- Open the raw `.md` in the editor; edit a comment via the pencil → author
  preserved, body updated; both surfaces stay in sync (preview auto-refreshes).
- Race check: with the preview open, externally edit the file to move a marker, then
  click edit/delete on a stale card → the write refuses, the preview refreshes, and
  the info message appears (failure mode is legible, not a silent corruption).
