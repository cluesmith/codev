# PIR Plan: Reading aids — highlight line above the pointer, click-the-paragraph annotation entry

## Understanding

#1802 shipped two reading aids for the Codev Markdown Preview: `codev.markdownPreview.hoverHighlight`
(six styles: word pill, line band, paragraph tint) and `codev.markdownPreview.readingCursor`. Both
are chosen from the "Reading Aids…" title-bar picker. #1850 adds two more options in the same
places:

1. **`highlightLine`**: `underPointer` (today) | `abovePointer`. With `abovePointer`, the line band
   moves to the line above the pointer **inside the same block**, so the mouse sits below the text
   being read. The word pill stays under the pointer. The `+` and the composer target follow the band.
2. **`annotationEntry`**: `gutterButton` (today) | `clickParagraph`. With `clickParagraph`, the
   in-row `+` is never mounted, and a plain primary click on prose opens the inline composer.

Both default to today's behaviour, byte for byte.

### How the code works today

- **Hover aid** (`packages/artifact-canvas/src/components/useHoverWordHighlight.ts`,
  `hover-word.ts`). `HoverWordController.draw()` (useHoverWordHighlight.ts:244-285) resolves the
  word under the pointer. It collects the block's inline line rects (`blockRange.getClientRects()`)
  and its fragments, picks the column with `fragmentContainingX`, and calls `lineBand(anchor,
  lineRects, column, m)` (hover-word.ts:301-325). `current.lineBox` is that band, and it doubles as
  the "sticky" region: the pointer can cross spaces and punctuation on the same line without a
  redraw (useHoverWordHighlight.ts:196-203).
- **`+` affordance** (`ArtifactCanvas.tsx:1200-1340`). `activateFromPointer` resolves the
  `[data-line]` block under the target (`resolveBlock`), sets `activeLine` to that block's line, and
  `placeAffordance(el, clientY, clientX)` positions the wrapper. It quantizes `clientY - frag.top`
  to `el`'s line-height, so the `+` snaps line to line, within the fragment (column) under the
  pointer. `activateFromFocus` does the same for keyboard focus, anchored to the block's first line,
  and also records `cursorLineRef` (the navigation cursor, spec 1401). The button is portalled in only
  when `activeLine !== null && affordanceWrapRef.current` (ArtifactCanvas.tsx:1398).
- **Composer target.** `CommentAffordance` calls `openComposer(activeLine)`. The target is always a
  block's source line (`data-line`). The visual line only decides where the `+` is drawn, not what
  gets annotated. So "the composer opens for the highlighted line" means: the block that contains the
  highlighted line. With `abovePointer` that is always the pointer's own block, because the band
  never leaves it (owner ruling).
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

### Canvas package (`packages/artifact-canvas`)

**Types** (`src/types.ts`, exported via `src/index.ts`):

```ts
export type HighlightLine = 'underPointer' | 'abovePointer';
export type AnnotationEntry = 'gutterButton' | 'clickParagraph';
// ArtifactCanvasProps, both optional and additive (contract amendment #1850):
highlightLine?: HighlightLine;      // omitted → 'underPointer'
annotationEntry?: AnnotationEntry;  // omitted → 'gutterButton'
```

**Pure helpers** (`src/components/hover-word.ts`):

- `parseHighlightLine` / `parseAnnotationEntry`: same `matchVocabulary` case-insensitive coercion,
  with unknown values falling back to the default.
- `lineAboveBand(pointerLine: Box, lineRects: readonly Box[], column: Box | null, m: TextMetrics): Box | null`.
  It takes the block's line rects that lie in `column` (same filter `lineBand` uses) and whose
  vertical centre is above `pointerLine.top`. Of those, it keeps the row nearest to the pointer line:
  rects whose centre is within half a line-height of the lowest such centre. It unions them into a
  band with the same padding and height rules as `lineBand`. It returns `null` when nothing qualifies,
  which is the block's first line, or the first line of a continuation fragment in a new column.
  Column-aware by construction: the line above the top of column N is never the bottom of column N-1.

**Hover controller** (`useHoverWordHighlight.ts`):

- The hook and controller take `highlightLine`. In `draw()`, `band` is computed exactly as today and
  stays the `current.lineBox` sticky region, which is still the pointer's line. When `abovePointer`,
  the painted line shape is `lineAboveBand(band, lineRects, column, m)`. A `null` result paints no
  line shape. The paragraph tint and word pill are unchanged.
- With `underPointer`, the code path is identical to today.

**`+` affordance and composer target** (`ArtifactCanvas.tsx`):

- `aboveActive = highlightLine === 'abovePointer' && shapesOf(style).line`. The setting only takes
  effect for band-drawing styles, which keeps `none` / `word` "unaffected" as the issue requires
  (see Risks).
- In `placeAffordance`'s mouse path, the quantized line index `k = floor((clientY - frag.top) /
  lineHeight)` becomes `k - 1` when `aboveActive`. If that is `< 0` (first line of the fragment, so no
  band), it returns "not placed". `activateFromPointer` then clears `activeLine` and detaches the
  wrapper, so no `+` is lit for that block. The jsdom offset fallback gets the same `- 1` treatment, so
  it is unit-testable. `placeAffordance` returns a boolean. The keyboard path (`clientY === null`) is
  untouched.
- Known approximation: the `+` uses line-height quantization while the band uses measured line rects.
  This is how they already relate under `underPointer` today, so both stay "one line up" together.

**`clickParagraph`** (`ArtifactCanvas.tsx`):

- `activateFromPointer` returns immediately. `activateFromFocus` still records `cursorLineRef`
  (navigation must keep working), but skips `setActiveLine` / `placeAffordance`. The wrapper node is
  then never created, `activeLine` stays `null`, and the portal never mounts the button. So the `+` is
  absent from the DOM, not hidden. The decoration effect's re-host is already guarded on the wrapper
  existing.
- The row gutter padding stays, so the layout is identical between the two modes (no reflow on
  toggle).
- `onBodyClick`: after the existing `[data-action]` routing, if `clickParagraph`, it calls
  `maybeOpenComposerFromClick(e)`, which opens the composer for `resolveBlock(target).line` only when
  all of these hold:
  - `e.button === 0`, there are no modifier keys, and `e.detail === 1`. A double-click's second click
    is ignored, so word selection keeps working.
  - `window.getSelection()` is collapsed (a click that ends a text selection does nothing).
  - The target is not inside `a, code, pre, img, button, input, textarea, [data-action],
    .codev-canvas-marker-cards, .codev-canvas-comment-composer-host`. This is the hover aid's
    `EXCLUDED_SELECTOR` plus the issue's links, inline code, images and card-action seam. The
    selector lives as a named export next to `EXCLUDED_SELECTOR` in `hover-word.ts`.
  - No composer is already open. A stray click on prose must not discard a draft. Today's `+` can
    move an open composer, but it needs an aimed click on the button, while click-anywhere makes that
    an accident (see Risks).
  - With `aboveActive`, the click is not on the block's first line, using the same `k - 1 < 0` test
    as the `+`. Per the ruling, there is no band there and so nothing to annotate.
- Enter on a focused block (`onBodyKeyDown`) and the remote `composer-open` commands are unchanged.
- No cursor CSS changes: `readingCursor` still governs the pointer.

### VS Code host (`apps/vscode`)

- **`reading-aids.ts`**:
  - Add `HIGHLIGHT_LINE_SETTING`, `ANNOTATION_ENTRY_SETTING`, the defaults, and
    `HIGHLIGHT_LINE_CHOICES` (`Line under the pointer`, `Line above the pointer`) and
    `ANNOTATION_ENTRY_CHOICES` (`Gutter + button`, `Click the paragraph`). Each is typed
    `satisfies` the canvas types, with two more `assertNoneMissing` checks.
  - Add `knownHighlightLine` / `knownAnnotationEntry`.
  - `ReadingAidSection` gains `'Highlight line'` and `'Annotation entry'`. `ReadingAidItem.setting`
    widens to the four settings.
  - `readingAidItems(storedHighlight, storedCursor, storedHighlightLine, storedAnnotationEntry)`
    emits four sections in order: Highlight, Cursor, Highlight line, Annotation entry.
  - `initialActiveRow` is unchanged, so it still lands on the current highlight style.
  - `READING_AIDS_PLACEHOLDER` gets a wording that covers all four sections.
- **`preview-template.ts`**: two more options, and `readingAidAttrs` emits `data-highlight-line` /
  `data-annotation-entry` only for known values, as today.
- **`preview-provider.ts`**: read `highlightLine` / `annotationEntry` from `cfg`.
- **`webview/main.ts`**: parse the two attributes with the canvas parsers and pass them as props.
- **`extension.ts`**: pass the two extra settings to `readingAidItems`. The QuickPick builder
  already renders sections generically, so separators come out of the new sections automatically.
- **`package.json`**: two new settings with enum descriptions in the existing voice. For example:
  `highlightLine`: "The line under the pointer." / "The line above the pointer, so the pointer
  trails below the text you're reading. No band on a paragraph's first line." `annotationEntry`:
  "A + button in the hovered row's gutter." / "Click a paragraph to comment on it. No + button is
  shown." Each description ends "Also available from the preview's title-bar menu (Reading Aids…)."

### Examples

`packages/artifact-canvas/examples/main.tsx` gets two more selectors next to the existing
highlight/cursor ones, so the options can be exercised in the canvas playground. This is small and
optional; it mirrors what #1802 did.

## Files to Change

- `packages/artifact-canvas/src/types.ts:140-157`: two types and two optional props
- `packages/artifact-canvas/src/index.ts`: export the new types
- `packages/artifact-canvas/src/components/hover-word.ts`: parsers, `lineAboveBand`, the click-exclusion selector
- `packages/artifact-canvas/src/components/useHoverWordHighlight.ts:244-285, 340-363`: thread `highlightLine` into the band shape
- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx`: props destructure (~264), `onBodyClick` (~599), `placeAffordance` / `activateFromPointer` / `activateFromFocus` (~1253-1340), hook call (~1350)
- `packages/artifact-canvas/examples/main.tsx`: playground selectors
- `apps/vscode/src/markdown-preview/reading-aids.ts`: vocabularies, checks, four-section rows
- `apps/vscode/src/markdown-preview/preview-template.ts:33-40, 133-145`: options and attributes
- `apps/vscode/src/markdown-preview/preview-provider.ts:262-266`: read the two settings
- `apps/vscode/src/markdown-preview/webview/main.ts:59-60, 144-145`: parse and pass
- `apps/vscode/src/extension.ts:200-202`: four-arg `readingAidItems`
- `apps/vscode/package.json:1341-1378`: two settings
- Tests: `packages/artifact-canvas/src/components/__tests__/hover-word.test.ts`, `full-row-affordance.test.tsx`, new `annotation-entry.test.tsx`; `apps/vscode/src/__tests__/preview-reading-aids.test.ts`

## Risks & Alternatives Considered

- **Single-line blocks under `abovePointer` (owner FYI, not a blocker).** By the ruling, a block's
  first line has no band and no `+`. So a one-line block (most headings, short list items,
  one-sentence paragraphs) has no pointer entry point at all under `abovePointer`, in either entry
  mode. Keyboard focus plus Enter still works. I will implement the ruling literally. If the owner
  wants a fallback (for example, single-line blocks keep the under-pointer `+`), it is a small change
  in the same `k - 1 < 0` branch.
- **`abovePointer` with `none` / `word` styles.** The issue says these styles are "unaffected". I read
  that as: the setting does nothing for them, including the `+` and the click target, which stay under
  the pointer. The alternative (moving the `+` up even with no band) would put the `+` on a line with
  nothing highlighted, which contradicts "what the reviewer sees highlighted is what they annotate."
- **Draft loss with `clickParagraph`.** Without the "no composer open" guard, any stray click on prose
  would retarget an open composer and drop the draft. The guard costs one step (Esc, or Cancel) to
  move to another paragraph. The alternative (retarget like the `+`) is the riskier default.
- **Click versus selection.** The selection is checked at click time (after mouseup), so a drag that
  selects text does not open the composer. A plain click that only collapses an existing selection
  does open it, which reads as an intentional click. A double-click opens on its first click (the
  composer appears below the block) and ignores its second, so the word still gets selected. The
  composer's autofocus may take focus from that selection, and I'll check this in the dev host. If it
  bites, the fix is to defer opening by one tick and cancel on `dblclick`.
- **Column-aware "line above".** In horizontal mode, the top line of a block's continuation in column N
  gets no band. The line "above" it is in another column, and a band there would be off-screen or
  across the gutter. This is consistent with the first-line rule.
- **Alternative: let the hover controller own the `+` position**, so band and `+` share one
  measurement. Rejected: the controller is disabled for `none`, it runs in a rAF while the affordance
  is synchronous React state, and coupling them would rework both #1343 and #1802. Quantizing one line
  up keeps the existing relationship between band and `+`.
- **Defaults are byte-for-byte.** Every new branch is gated on a non-default value. The existing
  reading-aid, affordance, keyboard and composer tests run unchanged as the regression net.

## Test Plan

### Unit (canvas, vitest + jsdom)

- `hover-word.test.ts`:
  - `parseHighlightLine` / `parseAnnotationEntry`: case-insensitive matching, defaults, garbage input.
  - `lineAboveBand`:
    - Middle line returns the previous row's union.
    - First line returns `null`.
    - Two-column block: the first line of the column-N fragment returns `null`, and the line above
      never comes from the other column.
    - Mixed-height inline rects on a row (inline code) union into one band.
- `full-row-affordance.test.tsx` (offset fallback path, inline `line-height`):
  - `abovePointer` with a band style: hovering line 2 places the `+` one line up.
  - Hovering line 1 renders no `+`.
  - The `word` style is unaffected.
  - The keyboard focus path is unchanged.
- New `annotation-entry.test.tsx`:
  - `clickParagraph`: no `.codev-canvas-add-comment` and no `.codev-canvas-row-affordance` in the DOM
    after hover and after focus.
  - A click on a `<p>` opens the composer for that block's line.
  - Clicks on `a`, `code`, `pre`, `img`, a card, a card edit button, and inside the composer do not
    open a new composer. The edit button still edits.
  - A non-collapsed selection at click does not open it.
  - Modifier-click and `detail: 2` do not open it.
  - With a composer open, a click elsewhere keeps it open on the original line.
  - Enter on a focused block still opens it.
  - `gutterButton`: a click on prose does not open the composer (today's behaviour).

### Unit (host)

- `preview-reading-aids.test.ts`:
  - Four sections in order, with the current value marked for each new setting, defaults when unset
    or garbage, and case-insensitive stored values.
  - Each new row's `setting` / `value` pair.
  - `initialActiveRow` still returns the current Highlight row.
  - The template emits the new `data-*` attributes only for known values.
- Typecheck: `pnpm --filter ... check-types` for both packages, covering the exhaustiveness asserts.

### Manual: dev-gate runbook for Amr (F5 dev host)

1. Open the worktree (`.builders/pir-1850`) in VS Code and press **F5** ("Run Codev Extension"; its
   `build-extension` pre-launch task builds the canvas and the extension).
2. In the dev host, open a markdown file with multi-line paragraphs, a heading, a list, a code block,
   a link, and at least one existing review comment (any `codev/specs/*.md` works). Open it with
   **Codev: Open Markdown Preview**.
3. **Defaults.** With neither new setting written, hover a paragraph: the band is on the pointer's
   line and the `+` is in the gutter. Click prose: nothing opens. This is today's behaviour.
4. **`…` → Reading Aids…**: four sections (Highlight, Cursor, Highlight line, Annotation entry), each
   with a check on the current value. The list opens on the current Highlight row.
5. Pick **Line above the pointer** (the preview updates in place):
   - On line 2+ of a paragraph, the band sits one line above the pointer.
   - On the first line, there is no band, but the paragraph tint stays (style `lineParagraph`).
   - Switch the highlight to **Word, line and paragraph**: the word pill stays under the pointer.
   - The `+` sits on the banded line. Click it: the composer opens under that paragraph. Hover a first
     line: no `+`.
   - Optional: toggle horizontal reading mode and check the top line of a paragraph that continues
     into the next column.
6. Pick **Click the paragraph**:
   - No `+` appears anywhere.
   - Click a paragraph: the composer opens below it. Type something, Cancel.
   - Drag-select text: no composer. Double-click a word: the word is selected and no second composer
     appears.
   - Click a link, inline code, a code block, an existing comment card and its edit button: none opens
     a new composer (edit still edits).
   - With a composer open, click another paragraph: the draft stays where it is.
   - Tab or click to focus a block and press **Enter**: the composer opens.
   - With **Line above the pointer** still on, click a paragraph's first line: nothing opens. Click
     line 2+: the composer opens for that paragraph.
7. Set both back to the defaults from the picker: the behaviour is identical to step 3.

The review will record the dev-gate run.
