# PIR Plan: Reading aids — highlight line above the pointer, click-the-paragraph annotation entry

## Understanding

#1802 shipped two reading aids for the Codev Markdown Preview: `codev.markdownPreview.hoverHighlight`
(six styles: word pill, line band, paragraph tint) and `codev.markdownPreview.readingCursor`. Both
are chosen from the "Reading Aids…" title-bar picker. #1850 adds two more options in the same
places:

1. **`highlightLine`**: `underPointer` (today) | `abovePointer`. The model is a reader's index finger
   on a printed page: the fingertip sits **below** the line being read. With `abovePointer`, the line
   band (and everything that follows it) sits on the line above the pointer.
2. **`annotationEntry`**: `gutterButton` (today) | `clickParagraph`. With `clickParagraph`, the in-row
   `+` is never mounted, and a plain primary click on prose opens the inline composer.

Both default to today's behaviour, byte for byte.

### Owner rulings (as revised at plan review, 2026-10-21)

- **The line above may cross into the previous block** (revises the issue's first ruling). With the
  finger on a block's first line, or in the gap just below a block, the band goes on the last line of
  the block above, as on a book page. The issue's original rule (no band on a block's first line,
  never use the previous paragraph) meant the **last line of every paragraph, and every one-line
  block (headings, short list items), could never be highlighted**. The owner chose crossing over that.
- **The `+` and the composer follow the band** (unchanged): the annotated block is the block that
  contains the highlighted line, even when that is the block above the pointer.

### How the code works today

- **Hover aid** (`packages/artifact-canvas/src/components/useHoverWordHighlight.ts`,
  `hover-word.ts`). `HoverWordController.draw()` (useHoverWordHighlight.ts:244-285) resolves the
  word under the pointer. It collects the block's inline line rects (`blockRange.getClientRects()`)
  and its fragments, picks the column with `fragmentContainingX`, and calls `lineBand(anchor,
  lineRects, column, m)` (hover-word.ts:301-325). `current.lineBox` is that band, and it doubles as
  the "sticky" region: the pointer can cross spaces and punctuation on the same line without a
  redraw (useHoverWordHighlight.ts:196-203). When the pointer is not on a word, nothing is drawn.
- **`+` affordance** (`ArtifactCanvas.tsx:1200-1340`).
  - `activateFromPointer` resolves the `[data-line]` block under the target (`resolveBlock`), sets
    `activeLine` to that block's line, and `placeAffordance(el, clientY, clientX)` positions the
    wrapper. It quantizes `clientY - frag.top` to the element's line-height, so the `+` snaps line to
    line.
  - Moves over dead strips (margins, the gutter) keep the current row lit: the `+` is sticky.
  - `activateFromFocus` does the same for keyboard focus, anchored to the block's first line, and
    records `cursorLineRef` (the navigation cursor, spec 1401).
  - The button is portalled in only when `activeLine !== null && affordanceWrapRef.current`
    (ArtifactCanvas.tsx:1398).
- **Composer target.** `CommentAffordance` calls `openComposer(activeLine)`. The target is always a
  block's source line (`data-line`). The visual line only decides where the `+` is drawn.
- **Body click** (`onBodyClick`, ArtifactCanvas.tsx:599-617) today only routes card edit/delete
  buttons (`[data-action]`).
- **Host.** `reading-aids.ts` holds the vocabularies, the case-insensitive `known*` parsers, the
  compile-time exhaustiveness checks, `readingAidItems`, and `initialActiveRow`.
  `preview-provider.ts:262-265` reads the settings into `renderMarkdownPreviewHtml`.
  `preview-template.ts:133-145` emits `data-*` attributes on `#root`. `webview/main.ts:59-60` parses
  them and passes them as props (`main.ts:144-145`). Any `codev.markdownPreview` change re-renders the
  webview (`preview-provider.ts:119`), which is how "takes effect without reopening" already works.
  `extension.ts:200-246` builds the QuickPick.

## Proposed Change

### The reading target (one geometry, three consumers)

Under `abovePointer`, the band, the paragraph tint, the `+` and the click all have to agree on one
thing: **the reading target**, meaning the line being read and the block that contains it. It is
resolved in one place, the hover controller, and queried by the canvas. That way the band and the
`+` can never disagree.

`resolveReading(x, y)` returns `{ block: Element, band: Box } | null`:

1. **Pointer on a word** (today's hit test). Let `B` be its block, and `P` the pointer's line row in
   its column (today's `lineBand`).
   - `underPointer`: the target is `(B, P)`. Same as today.
   - `abovePointer`: if `B` has a row above `P` in the same column, the target is `(B, that row)`.
     Otherwise the target is `(A, A's last row in that column)`, where `A` is the **block above**.
2. **Pointer not on a word, but in the gap just below a block** (`abovePointer` only). The pointer's
   x must be within that block's text extent, and its y within one line-height below the block's
   last row in that column. The target is that block and its last row. This covers a finger resting
   in the space between paragraphs. The gutter is outside the text extent, so it never counts as a
   gap.
3. Otherwise `null`: nothing is drawn, as today.

**The block above** is the nearest preceding paragraph-level block (`BLOCK_SELECTOR`) in document
order that is not an ancestor of `B`. It only qualifies when:

- its last row sits in the same column as the pointer's line, above it; and
- it is not excluded (code block, comment cards, composer, the `+` wrapper).

If the immediately preceding content is a code block or a card stack, there is no target. A band
would otherwise jump over that content to an unrelated paragraph. At the very top of the document,
or at the top of a column in horizontal mode, there is also no target.

The **word pill** stays under the pointer (issue requirement). The **paragraph tint** follows the
reading target's block, so it always frames the line being read.

### Canvas package (`packages/artifact-canvas`)

**Types** (`src/types.ts`, exported via `src/index.ts`):

```ts
export type HighlightLine = 'underPointer' | 'abovePointer';
export type AnnotationEntry = 'gutterButton' | 'clickParagraph';
// ArtifactCanvasProps, both optional and additive (contract amendment #1850):
highlightLine?: HighlightLine;      // omitted → 'underPointer'
annotationEntry?: AnnotationEntry;  // omitted → 'gutterButton'
```

**Pure helpers** (`src/components/hover-word.ts`, unit-tested on plain boxes):

- `parseHighlightLine` / `parseAnnotationEntry`: same `matchVocabulary` coercion, with unknown
  values falling back to the default.
- `rowsInColumn(lineRects, column, m)`: groups a block's inline rects into visual rows (rects whose
  vertical centres are within half a line-height of each other), keeping only those in `column`.
  `lineBand`'s existing union and padding rules give each row's box.
- `rowAbove(rows, pointerRow)`: the nearest row whose centre is above the pointer row's top, or
  `null`.
- `lastRow(rows)`: the lowest row, or `null`.
- `inGapBelow(lastRowBox, textExtent, x, y, m)`: the gap test from rule 2.
- `previousBlock(block, body)`: the DOM walk for "the block above", including the exclusion rule.
  This is DOM-based, not geometry, so it is tested with jsdom fixtures.

**Hover controller** (`useHoverWordHighlight.ts`):

- The hook and controller take `highlightLine`. `draw()` is split into `resolveReading()` (above) and
  painting. With `underPointer`, the resolved target is exactly today's `(block, band)`, and painting
  is unchanged.
- `current.lineBox` (the sticky region) stays the **pointer's** row, so crossing spaces does not
  redraw. The painted band is the reading target's row.
- The gap case (rule 2) adds no sticky state: it redraws on every frame and clears when the pointer
  leaves the gap.
- The hook returns a stable ref to `resolveReading`. It is `null` when the controller is not
  attached, which is the `none` style.

**`+` affordance** (`ArtifactCanvas.tsx`):

- `aboveActive = highlightLine === 'abovePointer' && shapesOf(style).line`. Only band-drawing styles
  have a band to follow. With `none` / `word`, the `+` and the click behave exactly as today (the
  issue's "unaffected").
- When `aboveActive`, `activateFromPointer` asks `resolveReading(e.clientX, e.clientY)`. If it gets a
  target, it sets `activeLine` to the target block's line (`resolveBlock(target.block)`) and calls
  `placeAffordance(el, bandCentreY, bandCentreX)`. Quantization lands the `+` on the banded row, in
  that block's own row host. If it gets `null`, it does nothing: the current `+` stays lit (today's
  sticky rule).
- **Why the `+` can't run away from the pointer.** Reaching the `+` means moving left into the gutter,
  then up. The gutter has no words and is not a gap, so `resolveReading` returns `null` there and the
  `+` stays put until the pointer arrives. Pointer events on the button itself are already ignored
  (`fromAffordance`). Without this, the `+` would re-anchor one line higher every time the pointer
  crossed a line on its way up. This is checked explicitly in tests and at the dev gate.
- The keyboard focus path (`activateFromFocus`) is unchanged: it anchors to the focused block's first
  line, so Enter is unchanged.

**`clickParagraph`** (`ArtifactCanvas.tsx`, `CommentComposer.tsx`):

- `activateFromPointer` returns immediately. `activateFromFocus` still records `cursorLineRef`
  (navigation keeps working), but skips `setActiveLine` / `placeAffordance`. The wrapper node is then
  never created and the portal never mounts the button. The `+` is absent from the DOM, not hidden.
- The row gutter padding stays, so layout is identical between the two modes (no reflow on toggle).
- `onBodyClick`: after the existing `[data-action]` routing, if `clickParagraph`, it opens the
  composer when all of these hold:
  - `e.button === 0`, there are no modifier keys, and `e.detail === 1`. A double-click's second click
    is ignored.
  - `window.getSelection()` is collapsed, so a click that ends a text selection does nothing.
  - The target is not inside `a, code, pre, img, button, input, textarea, [data-action],
    .codev-canvas-marker-cards, .codev-canvas-comment-composer-host`. This is the hover aid's
    `EXCLUDED_SELECTOR` plus the issue's links, inline code, images and card-action seam. It is a named
    export next to `EXCLUDED_SELECTOR`.
  - The composer is closed, or open but **empty**. An empty composer (often from an accidental click)
    simply moves to the new target. A composer holding a draft ignores clicks elsewhere, so a stray
    click can never discard written text. This needs a new `hasDraft()` on `CommentComposerHandle`
    (`text.trim() !== ''`), alongside `submit()`.
- **The click target:**
  - When `aboveActive`, it is `resolveReading(e.clientX, e.clientY)`'s block. This is the line being
    read, the same block the band and tint show, even when that block is above the pointer.
  - If that returns `null` (for example, a first line below a code block), it falls back to the clicked
    block, so a click on prose is never dead.
  - Otherwise it is the clicked block (`resolveBlock(target)`).
- Enter on a focused block (`onBodyKeyDown`) and the remote `composer-open` commands are unchanged.
- No cursor CSS changes: `readingCursor` still governs the pointer.

### VS Code host (`apps/vscode`)

- **`reading-aids.ts`**:
  - Add `HIGHLIGHT_LINE_SETTING`, `ANNOTATION_ENTRY_SETTING`, the defaults, and
    `HIGHLIGHT_LINE_CHOICES` (`Line under the pointer`, `Line above the pointer`) and
    `ANNOTATION_ENTRY_CHOICES` (`Gutter + button`, `Click the paragraph`). Each is typed `satisfies`
    the canvas types, with two more `assertNoneMissing` checks.
  - Add `knownHighlightLine` / `knownAnnotationEntry`.
  - `ReadingAidSection` gains `'Highlight line'` and `'Annotation entry'`. `ReadingAidItem.setting`
    widens to the four settings.
  - `readingAidItems(storedHighlight, storedCursor, storedHighlightLine, storedAnnotationEntry)` emits
    four sections in order: Highlight, Cursor, Highlight line, Annotation entry.
  - `initialActiveRow` is unchanged (it still lands on the current highlight style).
  - `READING_AIDS_PLACEHOLDER` is reworded to cover all four sections.
- **`preview-template.ts`**: two more options, and `readingAidAttrs` emits `data-highlight-line` /
  `data-annotation-entry` only for known values, as today.
- **`preview-provider.ts`**: read `highlightLine` / `annotationEntry` from `cfg`.
- **`webview/main.ts`**: parse the two attributes with the canvas parsers and pass them as props.
- **`extension.ts`**: pass the two extra settings to `readingAidItems`. The QuickPick builder already
  renders sections generically.
- **`package.json`**: two new settings with enum descriptions in the existing voice:
  - `highlightLine`: "The line under the pointer." / "The line above the pointer, like a finger
    resting under the line you're reading. Comments go to the highlighted line's paragraph."
  - `annotationEntry`: "A + button in the hovered row's gutter." / "Click a paragraph to comment on
    it. No + button is shown."
  - Each description ends "Also available from the preview's title-bar menu (Reading Aids…)."

### Examples

`packages/artifact-canvas/examples/main.tsx` gets two more selectors next to the existing
highlight/cursor ones, mirroring #1802, so the options can be exercised in the canvas playground.

## Files to Change

- `packages/artifact-canvas/src/types.ts:140-157`: two types and two optional props
- `packages/artifact-canvas/src/index.ts`: export the new types
- `packages/artifact-canvas/src/components/hover-word.ts`: parsers, row helpers, `previousBlock`, gap test, click-exclusion selector
- `packages/artifact-canvas/src/components/useHoverWordHighlight.ts:196-285, 340-363`: `resolveReading`, paint split, returned ref
- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx`: props (~264), `onBodyClick` (~599), `activateFromPointer` / `activateFromFocus` (~1304-1331), hook call (~1350)
- `packages/artifact-canvas/src/overlays/CommentComposer.tsx:32-35, 81`: `hasDraft()` on the handle
- `packages/artifact-canvas/examples/main.tsx`: playground selectors
- `apps/vscode/src/markdown-preview/reading-aids.ts`: vocabularies, checks, four-section rows
- `apps/vscode/src/markdown-preview/preview-template.ts:33-40, 133-145`: options and attributes
- `apps/vscode/src/markdown-preview/preview-provider.ts:262-266`: read the two settings
- `apps/vscode/src/markdown-preview/webview/main.ts:59-60, 144-145`: parse and pass
- `apps/vscode/src/extension.ts:200-202`: four-argument `readingAidItems`
- `apps/vscode/package.json:1341-1378`: two settings
- Tests: `packages/artifact-canvas/src/components/__tests__/hover-word.test.ts`, `full-row-affordance.test.tsx`, new `annotation-entry.test.tsx`, `src/overlays/__tests__/comment-composer.test.tsx`; `apps/vscode/src/__tests__/preview-reading-aids.test.ts`

## Risks & Alternatives Considered

- **Crossing into the previous block.** This is the owner's revision of the issue's first ruling,
  chosen because the original rule left every paragraph's last line and every one-line block
  unhighlightable. The guard against surprises: the band only crosses to the immediately preceding
  prose block, in the same column, and never jumps over a code block or a comment-card stack.
- **The `+` landing in the block above.** With the finger on paragraph B's first line, the `+` appears
  in paragraph A's row, on A's last line. That is the "follows the band" ruling working as intended
  ("what you see highlighted is what you annotate"), but it is the most unfamiliar visual in this
  change. It will be called out in the dev-gate runbook.
- **`abovePointer` with `none` / `word`.** With no band, there is nothing to follow, so the `+` and
  the click stay on the pointer's block. The alternative (moving the target up with nothing drawn)
  would annotate something the reader can't see.
- **Accidental composer opens in `clickParagraph`.** People click while reading, and with the arrow
  cursor nothing signals that prose is clickable. This is an opt-in mode, an empty composer costs
  nothing (Esc, or just click where you meant), and a draft is never lost.
- **Double-click to select a word.** The first click opens the composer, and its second click is
  ignored. The composer's autofocus may pull focus from the selection. To be checked in the dev host.
  If it bites, the fix is to defer opening by a double-click interval (about 250ms, a small lag on
  every click-to-comment) and cancel on `dblclick`. This is not built unless the gate shows it is
  needed.
- **Approximation in the `+` position.** The `+` is quantized against the target element's
  line-height. It is fed the band's centre, so it lands on the band's row. Unusual rows (a tall
  inline image) can still be off by part of a line, as under `underPointer` today.
- **Rejected: keeping the `+` on the pointer's line.** This was my first fix for the run-away `+`.
  With crossing it breaks: the `+` would sit in paragraph B while the band is on paragraph A, so the
  `+` and the band would point at different blocks. Resolving the reading target in one place, plus
  the gutter's natural "no target" zone, fixes the run-away without that split.
- **Defaults are byte-for-byte.** Every new branch is gated on a non-default value. The existing
  reading-aid, affordance, keyboard and composer tests run unchanged as the regression net.

## Test Plan

### Unit (canvas, vitest + jsdom)

- `hover-word.test.ts`:
  - The parsers: case-insensitive matching, defaults, garbage input.
  - `rowsInColumn`: mixed-height inline rects (inline code) merge into one row; other-column rects are
    dropped.
  - `rowAbove`: a middle row gives the previous row; the top row gives `null`.
  - `lastRow`, and `inGapBelow` (inside the gap, below it, in the gutter, in the other column).
  - `previousBlock` on jsdom fixtures: the preceding `<p>`; skipping an ancestor `li` around a `p`;
    `null` when the preceding content is a `pre` or a comment-card stack; `null` at the top of the
    document.
- Controller behaviour (mocked rects):
  - Finger on line 2 bands line 1 of the same block.
  - Finger on a block's first line bands the last line of the block above, and the tint moves there.
  - Finger in the gap below a block bands its last line.
  - Finger on a first line below a `pre` draws no band.
  - The word pill stays under the pointer.
  - With `underPointer`, the output is identical to today.
- `full-row-affordance.test.tsx`:
  - `abovePointer` with a band style: the `+` lands on the reading target (same-block row above, and
    the previous block on a first line).
  - A `null` target keeps the current `+` (sticky), so the pointer can travel left and up into the
    gutter without the `+` moving.
  - The `word` style is unaffected.
  - The keyboard focus path is unchanged.
- New `annotation-entry.test.tsx`:
  - `clickParagraph`: no `.codev-canvas-add-comment` / `.codev-canvas-row-affordance` in the DOM after
    hover and after focus.
  - A click on a `<p>` opens the composer for that block's line. With `abovePointer`, a click on a
    first line opens the block above, and falls back to the clicked block when there is no target.
  - Clicks on `a`, `code`, `pre`, `img`, a card, a card edit button, and inside the composer do not
    open a new composer. The edit button still edits.
  - A non-collapsed selection, a modifier-click, and `detail: 2` do not open it.
  - An open empty composer moves on click elsewhere; an open composer with a draft stays put.
  - Enter on a focused block still opens it.
  - `gutterButton`: a click on prose does not open the composer (today's behaviour).
- `comment-composer.test.tsx`: `hasDraft()` returns false for empty or whitespace text, true once
  there is text.

### Unit (host)

- `preview-reading-aids.test.ts`:
  - Four sections in order, with the current value marked for each new setting.
  - Defaults when unset or garbage, and case-insensitive stored values.
  - Each new row's `setting` / `value`.
  - `initialActiveRow` still returns the current Highlight row.
  - The template emits the new `data-*` attributes only for known values.
- Typecheck both packages (`check-types`), which covers the exhaustiveness asserts.

### Manual: dev-gate runbook for Amr (F5 dev host)

1. Open the worktree (`.builders/pir-1850`) in VS Code and press **F5** ("Run Codev Extension"; its
   `build-extension` pre-launch task builds the canvas and the extension).
2. In the dev host, open a markdown file with multi-line paragraphs, headings, a list, a code block, a
   link, and at least one existing review comment (any `codev/specs/*.md` works). Open it with
   **Codev: Open Markdown Preview**.
3. **Defaults.** With neither new setting written: the band is on the pointer's line and the `+` is in
   the gutter. Clicking prose opens nothing. This is today's behaviour.
4. **`…` → Reading Aids…**: four sections (Highlight, Cursor, Highlight line, Annotation entry), each
   with a check on the current value. The list opens on the current Highlight row.
5. Pick **Line above the pointer** (the preview updates in place). Read a few paragraphs with the
   pointer just under the line, like a finger:
   - The band is on the line above the pointer.
   - On a paragraph's first line, the band is on the last line of the paragraph above, and the tint
     moves with it.
   - Resting in the gap between two paragraphs bands the upper paragraph's last line.
   - Headings and one-line items highlight when the pointer is just below them.
   - Below a code block, a paragraph's first line shows no band.
   - Switch the highlight to **Word, line and paragraph**: the word pill stays under the pointer.
   - **`+` reachability:** the `+` sits on the banded line, in that paragraph's gutter. Move the
     pointer left into the gutter, then up to the `+`. It must stay still and be clickable. The
     composer opens under the highlighted paragraph.
   - Optional: in horizontal reading mode, check the top line of a column (no band).
6. Pick **Click the paragraph**:
   - No `+` appears anywhere.
   - Click prose: the composer opens under the highlighted paragraph (with **Line above** on, that can
     be the paragraph above the pointer).
   - Drag-select text: no composer. Double-click a word: the word is selected and no second composer
     appears. Note whether the selection survives the composer opening.
   - Click a link, inline code, a code block, a comment card and its edit button: none opens a new
     composer (edit still edits).
   - Open a composer, leave it empty, click another paragraph: the composer moves.
   - Type a draft, click another paragraph: the draft stays where it is.
   - Tab or click to focus a block and press **Enter**: the composer opens.
7. Set both back to the defaults from the picker: the behaviour is identical to step 3.

The review will record the dev-gate run.
