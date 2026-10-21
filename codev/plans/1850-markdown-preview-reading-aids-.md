# PIR Plan: Reading aids — Hidden prose cursor, click-the-paragraph annotation entry

## Revision history

- **Plan approved** at `8cab2635d` (owner, 2026-10-21) with a `highlightLine` option: the band on
  the line above the pointer (finger-below model), crossing into the previous block, with the `+` and
  the click following the band.
- **Dev-gate revision (owner, 2026-10-21, in the builder pane).** After using it, the owner ruled the
  highlight-line option "not good from a usability point of view" and replaced it: **instead of moving
  the band, hide the pointer over prose**, so the reader sees what is under it without it covering
  the text. The owner chose:
  - **Always hidden over prose.** No idle timer: hiding only while still would show the pointer
    exactly when it sweeps along the line being read.
  - **A fourth `readingCursor` choice** (`none`, labelled Hidden), not a separate setting.

  `highlightLine` and all its machinery (reading target, crossing, `+` / click following the band)
  are removed. Its implementation stays in the branch history (`2af31184f`) for reference. Option 2
  (`annotationEntry`) is unchanged.

## Understanding

#1802 shipped two reading aids for the Codev Markdown Preview: `codev.markdownPreview.hoverHighlight`
(six styles: word pill, line band, paragraph tint) and `codev.markdownPreview.readingCursor`
(arrow, I-beam, hand). Both are chosen from the "Reading Aids…" title-bar picker. #1850 adds:

1. **A Hidden prose cursor**: `readingCursor: "none"`. Over prose the pointer is invisible, so it
   never sits on top of the words being read. The line band, for the styles that draw one, still
   marks where the pointer is, so the band effectively becomes the pointer. Code blocks, comment
   cards, the composer, the `+` and links keep a visible pointer, so everything clickable can still be
   found.
2. **`annotationEntry`**: `gutterButton` (today) | `clickParagraph`. With `clickParagraph`, the in-row
   `+` is never mounted, and a plain primary click on prose opens the inline composer for the clicked
   block.

Both default to today's behaviour: the arrow cursor and the gutter `+`.

### How the code works today

- **Prose cursor** (`packages/artifact-canvas/src/styles/default-theme.css:138-157`):
  - The composed body has `cursor: default`.
  - `[data-reading-cursor='iBeam' | 'hand']` on the canvas root switches it.
  - A shared `[data-reading-cursor]` rule puts the arrow back over `pre`, cards, the composer host
    and the `+` wrapper.
  - Links keep the hand through the UA's `a[href]` rule.
  - `ArtifactCanvas.tsx` sets `data-reading-cursor` only for non-arrow values.
- **`+` affordance** (`ArtifactCanvas.tsx:1200-1340`). `activateFromPointer` / `activateFromFocus`
  set `activeLine` and `placeAffordance` positions the wrapper. The button is portalled in only when
  `activeLine !== null && affordanceWrapRef.current`. `openComposer(activeLine)` always targets a
  block's source line (`data-line`).
- **Body click** (`onBodyClick`) today only routes card edit/delete buttons (`[data-action]`).
- **Host.** `reading-aids.ts` holds the vocabularies, the `known*` parsers, the compile-time
  exhaustiveness checks, `readingAidItems`, and `initialActiveRow`. `preview-provider.ts` reads the
  settings, `preview-template.ts` emits `data-*` attributes on `#root`, and `webview/main.ts` parses
  them into props. A `codev.markdownPreview` change re-renders the webview, so changes apply without
  reopening. `extension.ts` builds the QuickPick.

## Proposed Change

### Hidden cursor

- **Canvas** (`types.ts`): `ReadingCursor` gains `'none'`. `hover-word.ts`'s `READING_CURSORS`
  gains it too, so `parseReadingCursor('none')` (case-insensitive) is `none`.
- **CSS** (`default-theme.css`): one rule beside I-beam and Hand:
  `.codev-artifact-canvas[data-reading-cursor='none'] .codev-artifact-canvas-body { cursor: none; }`.
  The existing shared rule already restores the arrow over code, cards, the composer and the `+`.
  Links keep the hand through the UA rule. There is no JS.
- **Host:**
  - `CURSOR_CHOICES` gains `{ value: 'none', label: 'Hidden' }`. The exhaustiveness check enforces it.
  - `package.json` `readingCursor` enum gains `none`, described as "Hidden over prose, so it never
    covers the text you're reading. The line highlight shows where the pointer is."
- Hidden plus the highlight style `None` gives no position feedback. That is allowed as an explicit
  choice.

### Click-the-paragraph (unchanged from the approved plan, minus the band-following)

- `annotationEntry?: AnnotationEntry` prop. `parseAnnotationEntry` coerces it, with unknown values
  falling back to `gutterButton`.
- With `clickParagraph`:
  - `activateFromPointer` returns immediately. `activateFromFocus` records `cursorLineRef` but skips
    the `+`. The wrapper is never created and the button never mounted.
  - Row gutter padding stays (no reflow on toggle).
- `onBodyClick` opens the composer for `resolveBlock(target).line` only when all of these hold:
  - a plain primary click (`button 0`, no modifiers, `detail === 1`);
  - no non-collapsed selection at click time;
  - no selection existed at `mousedown` (a dismissing click opens nothing);
  - the target is outside `CLICK_EXCLUDED_SELECTOR` (hover aid exclusions, plus links, code, images,
    form controls, `[data-action]`);
  - the composer is closed, or open but empty. A drafted composer ignores clicks elsewhere, via a new
    `hasDraft()` on `CommentComposerHandle`.
- Enter on a focused block and the remote `composer-open` commands are unchanged. No cursor change.

### VS Code host

- `reading-aids.ts`:
  - `ANNOTATION_ENTRY_SETTING`, `DEFAULT_ANNOTATION_ENTRY` and `ANNOTATION_ENTRY_CHOICES`
    (`Gutter + button`, `Click the paragraph`), plus an exhaustiveness check and
    `knownAnnotationEntry`.
  - `readingAidItems(highlight, cursor, annotationEntry?)` emits three sections: Highlight, Cursor,
    Annotation entry.
  - `initialActiveRow` is unchanged.
  - The placeholder reads "Pick a reading aid (type to filter)".
- `preview-template.ts` emits `data-annotation-entry` only for known values, and `readingAidAttrs`
  now passes `none` through for the cursor.
- `preview-provider.ts` / `webview/main.ts` / `extension.ts` thread `annotationEntry`.
- `package.json`: the `annotationEntry` setting, and `none` added to `readingCursor`.

### Examples

`examples/main.tsx`: a Hidden option in the cursor selector, and an Entry selector (`?entry=`).

## Files to Change

- `packages/artifact-canvas/src/types.ts`: `ReadingCursor` + `'none'`, `AnnotationEntry`, `annotationEntry` prop
- `packages/artifact-canvas/src/index.ts`: export `AnnotationEntry`, `parseAnnotationEntry`
- `packages/artifact-canvas/src/components/hover-word.ts`: `'none'` cursor, `parseAnnotationEntry`, `CLICK_EXCLUDED_SELECTOR`
- `packages/artifact-canvas/src/styles/default-theme.css`: the Hidden rule
- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx`: click-to-annotate, `+` suppression
- `packages/artifact-canvas/src/overlays/CommentComposer.tsx`: `hasDraft()`
- `packages/artifact-canvas/examples/main.tsx`: playground selectors
- `apps/vscode/src/markdown-preview/reading-aids.ts`, `preview-template.ts`, `preview-provider.ts`, `webview/main.ts`, `apps/vscode/src/extension.ts`, `apps/vscode/package.json`
- Tests: `hover-word.test.ts`, `default-theme.test.ts`, new `annotation-entry.test.tsx`, `comment-composer.test.tsx`, new `playwright/annotation-entry.spec.ts`, `apps/vscode/src/__tests__/preview-reading-aids.test.ts`

## Risks & Alternatives Considered

- **Losing the pointer entirely.** With Hidden and a band style, the band is the position cue. With
  highlight `None` there is no cue. That is allowed as an explicit choice, and moving onto a link,
  code, a card or the `+` brings a pointer back.
- **The `+` with Hidden.** The `+` wrapper keeps the arrow (shared exclusion rule), so it is visible
  and clickable. Over prose nothing shows, which is the point.
- **Rejected: hide only while still** (owner ruling). It shows the pointer while it moves along the
  line, exactly when it covers the text, and it needs timers.
- **Rejected: a separate `hideCursor` toggle** (owner ruling). It is one more setting and picker
  section, for the rarely useful "I-beam but hidden" combination.
- **Removed: `highlightLine`** (owner ruling at the dev gate, usability).
- **Click-to-annotate, accidental opens.** Prose gives no clickable signal. It is opt-in, an empty
  composer costs one Esc or just clicking where you meant, and a draft is never lost.
- **Click-to-annotate, double-click.** The first click opens the composer, whose autofocus drops the
  word selection (measured in Chromium). The possible fix is to defer opening by a double-click
  interval, at about 250ms latency on every click. It is the owner's call at the gate and not built.
- **Defaults are byte-for-byte.** The arrow carries no attribute, and `gutterButton` takes no new
  branch.

## Test Plan

### Unit (canvas, vitest + jsdom)

- `hover-word.test.ts`: `parseReadingCursor('NONE')` is `none`; `parseAnnotationEntry` matches the
  vocabulary and its defaults; `CLICK_EXCLUDED_SELECTOR` coverage.
- `default-theme.test.ts`: the Hidden rule sets `cursor: none` on the body; the shared rule restores
  the arrow over code, cards, the composer and the `+`.
- `annotation-entry.test.tsx`:
  - No `+` on hover or focus.
  - A click opens the composer for the clicked block, and submit emits it.
  - Exclusions: link, code, image, `pre`, card, card edit button (which still edits), and inside the
    composer.
  - None of these open it: a selection at click, a dismissing click (selection at mousedown),
    modifier clicks, `detail: 2`.
  - An empty composer moves on click elsewhere; a drafted one stays put.
  - Enter on a focused block opens it.
  - `gutterButton` keeps today's behaviour.
- `comment-composer.test.tsx`: `hasDraft()`.

### Browser (Playwright, real Chromium)

- `clickParagraph`: no `+`, and a click opens the composer. Drag-select opens nothing, the dismissing
  click opens nothing, and the next click opens it. Double-click opens one composer.
- Hidden cursor: the computed cursor is `none` on prose, `default` on code, cards and the `+`, and
  `pointer` on links. The `+` and the line band still appear.

### Unit (host)

- `preview-reading-aids.test.ts`:
  - Three sections, including `Cursor:Hidden`.
  - Defaults and stored values marked (case-insensitive), with an unknown entry falling back to the
    default.
  - Row setting / value for Hidden and Click the paragraph.
  - `initialActiveRow` unchanged.
  - `data-reading-cursor="none"` / `data-annotation-entry` emitted for known values only.
  - The schema enums and the default agreement.
- Typecheck both packages, which covers the exhaustiveness asserts.

### Manual: dev-gate runbook for Amr (F5 dev host)

1. Open the worktree (`.builders/pir-1850`) in VS Code and press **F5** ("Run Codev Extension").
2. In the dev host, open a markdown file with paragraphs, a list, a code block, a link and an existing
   review comment (any `codev/specs/*.md`) using **Codev: Open Markdown Preview**.
3. **Defaults.** Arrow pointer, band under the pointer, `+` in the gutter, and clicking prose opens
   nothing. This is today's behaviour.
4. **`…` → Reading Aids…**: three sections (Highlight, Cursor, Annotation entry). Cursor lists Arrow,
   I-beam, Hand and Hidden. The list opens on the current Highlight row.
5. Pick **Hidden** (the preview updates in place):
   - Over prose the pointer disappears; the line band follows where it is.
   - Over a code block, a comment card or the `+`, the arrow is back.
   - Over a link, the hand is back.
   - The `+` is still clickable.
   - Optional: switch the highlight to **None** to see the no-feedback combination.
6. Pick **Click the paragraph**:
   - No `+` anywhere. Click a paragraph: the composer opens below it.
   - Drag-select text: no composer. Click once to dismiss the selection: no composer. Click again: it
     opens.
   - Double-click a word: one composer opens. Note whether the word selection survives (it does not
     today; deferring the open is the possible fix, at about 250ms per click).
   - Click a link, inline code, a code block, a comment card and its edit button: none opens a new
     composer (edit still edits).
   - Empty composer, click another paragraph: it moves. Type a draft, click another paragraph: the
     draft stays.
   - Focus a block and press **Enter**: the composer opens.
7. Set both back to the defaults: the behaviour is identical to step 3.
