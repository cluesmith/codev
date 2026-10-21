# PIR Plan: Hover-word highlight in the artifact viewer

> **Superseded in part at the dev gate.** The owner added `line` and `lineParagraph`, moved the
> default to `lineParagraph` (no word pill), and inline code now keeps the cursor and the line
> band (decision 5 narrowed to fenced code). See `codev/reviews/1802-artifact-viewer-highlight-the-.md`.

## Understanding

The markdown preview (`packages/artifact-canvas`, hosted by `apps/vscode/src/markdown-preview`)
gives the eye nothing to lock onto while the pointer travels across long prose. The owner wants
the word under the pointer to carry a soft rounded pill, as in the reference mock
(`1802-mock.png`: dark theme, muted grey pill, rounded corners, a few px of horizontal padding past
the glyphs, roughly line-box tall, sitting *behind* the text so the glyphs stay full-contrast).

After reviewing a side-by-side lab of eight variants rendered over a real spec, the owner widened
the ask to three highlight styles (word; word + line; word + line + paragraph) and a choice of
cursor (arrow, I-beam or hand), both chosen from the preview's title-bar menu.

Constraints that shape the design, verified in source:

- The body is imperatively owned. `ArtifactCanvas.tsx` sets `innerHTML` in an effect and later
  injects `.codev-canvas-marker-cards` stacks and the `.codev-canvas-comment-composer-host`
  placeholder next to `[data-line]` blocks (`ArtifactCanvas.tsx:401-551`). Wrapping words in spans
  would break `data-line` anchoring, card placement and marker verification. So: no DOM writes
  inside the body.
- The pointer path already exists: `onMouseOver`/`onMouseMove={activateFromPointer}` on the body
  (`ArtifactCanvas.tsx:1319-1327`, `1369-1370`) drives the "+" affordance and already ignores
  primary-button drags (`e.buttons & 1`). `onMouseLeave={dismissAffordance}` sits on the root
  (`:1350`).
- Two scrollers: vertical mode scrolls the document, horizontal mode scrolls the body itself
  (`default-theme.css:502-516`, `overflow-x: auto`). Inner `pre`/table/card blocks can scroll too.
- The package ships only light defaults; dark comes from the host mapping the color tokens to
  `--vscode-*` variables (`preview-template.ts:57-71`).
- Preview settings reach the webview by re-rendering the webview HTML on any
  `codev.markdownPreview` config change (`preview-provider.ts:118-123`), with the reading mode
  bootstrapped as a `data-reading-mode` attribute on `#root` that `webview/main.ts` reads and passes
  as a canvas prop. The same path carries the two new choices.
- The preview has two existing control surfaces. Zoom lives in the VS Code editor title bar
  (`package.json` `menus.editor/title`, Reset in the `…` overflow under group `1_run`), backed by a
  user setting written through `resolveWriteScope` + `configTargetFor` (`extension.ts:173-184`,
  `1267-1281`). The vertical/columns toggle is canvas chrome (`overlays/ReadingModeToggle.tsx`),
  because it is flipped per document. Highlight style and pointer are set-and-forget reading
  preferences, so they follow the zoom pattern.

## Decisions (stated for the owner)

1. **Rendering: overlay rects (fix-shape option 1).** The mock is a rounded, padded pill; the
   CSS Custom Highlight API (`::highlight`) can paint neither rounded corners nor padding, so it
   cannot produce the requested look.
2. **Highlight styles (owner ruling):** `none`, `word`, `wordLine`, `wordLineParagraph`,
   **default `wordLine`**. `none` turns the highlight off entirely.
3. **Cursor (owner ruling, its own section in the Reading Aids picker):** `arrow` (default,
   keeps today's `cursor: default` from #1232), `iBeam` (the text cursor, `cursor: text`) or
   `hand` (the system pointing hand, `cursor: pointer`), applied over prose only.
4. **Where the choices live (owner ruling):** two user settings, plus one **"Reading Aids…"**
   item in the preview's title-bar `…` menu, next to Reset Font Size. No new button on the page.
5. **Code: skipped.** No highlight inside `pre` or inline `code`. Code is rarely read word by word,
   and inline code carries its own opaque background which would cover a behind-the-text pill.
   **Headings and link text: included.** They are prose.
6. **`None` in the picker (owner ruling):** listed as the first Highlight item, so turning the
   highlight off never requires the Settings editor.

Also excluded (per the issue): comment cards, the composer, the "+" affordance wrapper, and all
fixed overlays (minimap, reading-mode toggle, keyboard help, progress readout).

## Proposed Change

### 1. Resolution: pure helpers (`packages/artifact-canvas/src/components/hover-word.ts`, new)

- `wordBoundsAt(text: string, offset: number): { start: number; end: number } | null` uses
  `Intl.Segmenter(undefined, { granularity: 'word' })` (one cached instance) and returns the
  segment containing `offset` **only if `isWordLike`**. Fallback when `Intl.Segmenter` is absent:
  expand over a `[\p{L}\p{N}_'’-]` run (the `u` flag). Offsets landing exactly at a word's end
  resolve to that word (caret-at-boundary case).
- `caretAt(x, y): { node: Text; offset: number } | null` wraps
  `document.caretPositionFromPoint` (standard) with a `document.caretRangeFromPoint` (Chromium /
  VS Code webview) fallback; returns null for non-text nodes.
- `isExcluded(node)`: true when the node's element `closest()` matches
  `pre, code, .codev-canvas-marker-cards, .codev-canvas-comment-composer-host,
  .codev-canvas-row-affordance`, or the node is not inside the body.
- `blockOf(node, body)`: the nearest block ancestor inside the body (`p, li, h1-h6, blockquote,
  td, th, dd, dt`, else the nearest `[data-line]`). This is "the paragraph".
- `lineBandFor(wordRect, blockRects)`: the line band is the word rect's vertical extent
  (expanded to the line box) across the full width of the block fragment that contains it. In
  columns mode a block split across two columns has two fragments (`block.getClientRects()`),
  so the band stays inside the word's column.
- `parseHighlightStyle(value)` / `parseReadingCursor(value)`: closed-vocabulary coercion, unknown
  values fall back to the defaults (`wordLine`, `arrow`).

### 2. The highlight controller (`packages/artifact-canvas/src/components/useHoverWordHighlight.ts`, new)

A hook `useHoverWordHighlight(rootRef, bodyRef, style)` that owns everything, so
`ArtifactCanvas.tsx` gains one call and two props. It attaches **native** listeners (not React
props) so it never touches `activateFromPointer` or the affordance logic:

- **Layer.** One `div.codev-canvas-hover-word-layer` appended to the canvas root (outside the
  body, so the body's DOM is never written): `position: fixed; inset: 0; pointer-events: none;
  z-index: -1`. The root gets `isolation: isolate` so `z-index: -1` paints the layer above the
  root's own background but **below** the in-flow text (the shapes sit behind the glyphs, as in
  the mock) and below the cards, composer and every fixed overlay, which therefore always cover it.
  Three pooled shape kinds, drawn back to front: paragraph (`.codev-canvas-hover-paragraph`),
  line (`.codev-canvas-hover-line`), word (`.codev-canvas-hover-word`). Shapes are reused across
  moves (no create/destroy churn, no flicker); the style only decides which kinds are drawn.
- **Pipeline (one per animation frame).** `mousemove` on the body only stores
  `{clientX, clientY, buttons}` and schedules a single rAF. The frame:
  1. clears if `buttons & 1` (drag-select in progress), if `document.activeElement` is inside
     the composer, or if the event target is excluded;
  2. `caretAt(x, y)` → text node + offset; excluded node → clear;
  3. `wordBoundsAt` → `[start, end]`. If the caret is in a non-word segment (space, punctuation)
     **and** the pointer is still inside the current pill's (padded) rect, keep the current
     shapes. This is what stops flicker when the pointer crosses the gap between two words;
  4. dedupe: same `(node, start, end)` as now → nothing to do;
  5. build a `Range`, take `getClientRects()`, and **hit-test**: the pointer must fall inside one
     of the rects (widened by the pill padding). This rejects the "nearest caret" result the
     caret APIs return for the empty space past a short line's end or between paragraphs;
  6. write the word pill(s) (one per rect fragment; a word wrapped across lines or columns gives
     2); for `wordLine` and up, the line band from `lineBandFor`; for `wordLineParagraph`, one
     paragraph shape per `blockOf(...).getClientRects()` fragment. All in client coordinates,
     expanded by the padding.
- **Clearing.** `mouseleave` on the body, `mousedown` with the primary button (a drag starts),
  `focusin` inside the composer, and the style turning `none` (the hook removes the layer and all
  listeners).
- **Scroll.** A capture-phase `scroll` listener on `document` (catches window scroll in vertical
  mode, body scroll in horizontal mode, and inner scrollers) re-runs the same rAF pipeline at the
  last pointer position, so wheel-scrolling under a still pointer moves the shapes to the word now
  under it instead of leaving them stranded.
- **Content changes.** When `html`/markers/composer change (cards injected, reload), the stored
  node may be detached; the dedupe check treats a disconnected node as "no current word", so the
  next frame rebuilds cleanly. The shapes are also cleared on these changes.

Cost per frame: one caret lookup, one segmenter pass over a single text node, one `Range`
measure, and at most one `getClientRects()` on the block. No layout writes inside the body, no
reflow of the prose.

### 3. Cursor

- The canvas root gets `data-reading-cursor="iBeam"` or `"hand"` when the cursor prop is not
  `arrow`. Two CSS rules set `cursor: text` / `cursor: pointer` on the body's prose under that
  attribute, excluding the same regions as the highlight (cards, composer, affordance, `pre`,
  `code` keep their own cursors). With `arrow` nothing changes: the body keeps
  `cursor: default` (#1232).

### 4. Styling and tokens (`packages/artifact-canvas/src/styles/default-theme.css`)

- Three new public color tokens, all derived from the foreground so they invert with any host's
  dark mapping without the package needing a dark palette:
  - `--codev-canvas-hover-word-background`: `color-mix(in srgb, var(--codev-canvas-foreground) 12%, transparent)`
  - `--codev-canvas-hover-line-background`: `color-mix(in srgb, var(--codev-canvas-foreground) 6%, transparent)`
  - `--codev-canvas-hover-paragraph-background`: `color-mix(in srgb, var(--codev-canvas-foreground) 3%, transparent)`

  Exact percentages are tuned at the dev gate against the lab's look; the ordering (word darkest,
  paragraph faintest) is the contract.
- `.codev-artifact-canvas { isolation: isolate; }` (next to the existing `position: relative`).
- Layer and shape rules: fixed layer, `pointer-events: none`, word pill `border-radius: 0.3em`,
  line band and paragraph `border-radius: 0.4em`. Padding (≈0.2em horizontal, line-box tall) is
  applied in JS from the computed font size so it scales with the font-size / line-height settings.
- The I-beam and hand cursor rules from section 3.
- Update the token snapshot in `src/__tests__/default-theme.test.ts` and the color-token table
  in the package README.

### 5. Canvas props (`packages/artifact-canvas/src/types.ts`, `ArtifactCanvas.tsx`)

- `hoverHighlight?: 'none' | 'word' | 'wordLine' | 'wordLineParagraph'` (default `wordLine`) and
  `readingCursor?: 'arrow' | 'iBeam' | 'hand'` (default `arrow`) on `ArtifactCanvasProps`, doc-commented as
  a contract amendment (#1802). Additive and optional: existing hosts (including
  `examples/main.tsx`) get the default highlight with no code change. Exported type aliases
  `HoverHighlightStyle` and `ReadingCursor`.
- `ArtifactCanvas.tsx`: one `useHoverWordHighlight(rootRef, bodyRef, style)` call and the
  `data-reading-cursor` attribute on the root. No edits to the affordance, card injection or
  composer code.
- `examples/main.tsx`: two small selects so the styles and cursors can be tried in the browser
  without VS Code (also the Playwright fixture).

### 6. VS Code host (`apps/vscode`)

- `package.json` `contributes.configuration` (next to fontSize/lineHeight, ~line 1327):
  - `codev.markdownPreview.hoverHighlight`: string enum `none | word | wordLine | wordLineParagraph`,
    default `wordLine`, with `enumDescriptions`.
  - `codev.markdownPreview.readingCursor`: string enum `arrow | iBeam | hand`, default `arrow`, with
    `enumDescriptions`. Named `readingCursor` (vscode architect) so it does not read as the
    text caret in the Settings list, and so host and canvas prop share one word.
- `package.json` `commands`: `codev.markdownPreview.readingAids`, title
  "Codev: Markdown Preview Reading Aids…". `menus.editor/title`: same `when` as the font-size
  items (`activeCustomEditorId == codev.markdownPreview`), group `1_run` so it sits in the `…`
  overflow beside Reset Font Size. `commandPalette`: same `when`.
- `apps/vscode/src/markdown-preview/reading-aids.ts` (new, no `vscode` import, like
  `font-size-control.ts`): the picker item list (Highlight section: None / Word / Word and line /
  Word, line and paragraph; Cursor section: Arrow / I-beam / Hand), which item is current, and the
  (setting, value) pair an item writes.
- `extension.ts`: register the command next to the font-size commands. It shows one QuickPick
  with two separator-labelled sections, the current choice of each marked with a check; picking an
  item writes that one setting through the existing `resolveWriteScope` + `configTargetFor`, so
  a workspace-level override is never silently shadowed.
- `preview-provider.ts` `renderHtml` (~line 253): read both settings and pass them to the
  template. The existing config-change listener re-renders the webview HTML, so a pick applies to
  every open preview immediately (same behavior as font size today).
- `preview-template.ts`: emit `data-hover-highlight="<value>"` and `data-reading-cursor="<value>"`
  on `#root` only for known values (closed vocabulary, mirrors `readingModeAttr`); map the three
  tokens in the token block (word to `var(--vscode-toolbar-hoverBackground)`, line and paragraph
  to `color-mix` fractions of `var(--vscode-editor-foreground)`).
- `webview/main.ts`: read the two dataset values, coerce with the package's parsers, pass the props.

## Files to Change

- `packages/artifact-canvas/src/components/hover-word.ts`: new, pure helpers
- `packages/artifact-canvas/src/components/useHoverWordHighlight.ts`: new, the controller hook
- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx:~1350`: hook call, props, root attribute
- `packages/artifact-canvas/src/types.ts:~125`: the two props and type aliases
- `packages/artifact-canvas/src/index.ts`: export the type aliases and parsers
- `packages/artifact-canvas/src/styles/default-theme.css:~42, ~100`: tokens, `isolation`, layer, shapes, cursor rules
- `packages/artifact-canvas/src/__tests__/default-theme.test.ts`: token snapshot
- `packages/artifact-canvas/README.md`: token table + props
- `packages/artifact-canvas/examples/main.tsx`: style and cursor selects
- `packages/artifact-canvas/src/components/__tests__/hover-word.test.ts`: new unit tests
- `packages/artifact-canvas/playwright/hover-word.spec.ts`: new real-browser tests
- `apps/vscode/package.json`: two settings, one command, menu + palette entries
- `apps/vscode/src/markdown-preview/reading-aids.ts`: new, picker model
- `apps/vscode/src/extension.ts:~1267`: register the command
- `apps/vscode/src/markdown-preview/preview-provider.ts:~253`: read + pass the settings
- `apps/vscode/src/markdown-preview/preview-template.ts`: options, root attributes, token mapping
- `apps/vscode/src/markdown-preview/webview/main.ts`: read the attributes, pass the props
- `apps/vscode/src/__tests__/`: template test (alongside `preview-reading-mode.test.ts`) and a `reading-aids` unit test
- `codev/state/pir-1802_thread.md`: builder log

## Risks & Alternatives Considered

- **Risk: shapes paint over the text and dim it.** Mitigated by painting them behind the text
  (`isolation: isolate` + `z-index: -1` layer). Verified in Chromium by the Playwright spec
  (`elementFromPoint` at the word still returns the prose element).
- **Risk: `isolation: isolate` on the root changes stacking of the existing fixed overlays.**
  They already sit inside the root and use z-index 4-6; isolation only scopes them to the root,
  which is the whole page. Covered by re-running the existing Playwright suite.
- **Risk: the hand cursor blurs the "this is clickable" signal.** `cursor: pointer` normally marks
  links and buttons; over prose with the hand on, links no longer stand out by cursor. Links keep
  their underline and colour, and the hand is opt-in (default arrow).
- **Risk: line band in columns mode.** The band is clipped to the block fragment containing the
  word, so it never crosses into a neighbouring column. Covered by a Playwright case.
- **Risk: nearest-caret false positives** (highlighting a word when the pointer is in a margin or
  past a line end). Mitigated by the rect hit-test.
- **Risk: flicker between words.** Mitigated by the sticky-on-gap rule and the reused shape pool.
- **Risk: stale shapes after scroll or reflow.** Scroll recompute + clear on content change.
- **Alternative: a toggle button on the page** (next to the columns button). Rejected by the
  owner: these are set-once preferences, and a popover on the page would add chrome plus its own
  keyboard and accessibility work in the canvas package.
- **Alternative: CSS Custom Highlight API.** Zero layout work, but square, unpadded tint; does not
  match the mock. Rejected.
- **Alternative: hook into `activateFromPointer`.** Would couple the highlight to the "+"
  affordance's sticky-row semantics. Separate native listeners keep the two independent.
- **Alternative: wrap words in spans.** Forbidden by the issue and by the imperative body.
- **Alternative: a custom-drawn finger cursor** (tried in the lab). Not chosen; the system hand is
  native, crisp at every DPI, and needs no drawing code.

## Test Plan

- **Unit (vitest, `hover-word.test.ts`):** `wordBoundsAt` for mid-word, word start, word end,
  whitespace, punctuation (`phonetic.` → `phonetic`), apostrophes (`they're`), non-Latin text,
  and the no-`Segmenter` fallback; `isExcluded` for `pre`, inline `code`, cards, composer host,
  affordance; `blockOf` for `p`, `li`, headings; `lineBandFor` with one and two block fragments;
  the two parsers for known and unknown values.
- **Unit (vitest, `reading-aids`):** item list, current-item marking, and the (setting, value)
  each item writes.
- **Real browser (Playwright, `hover-word.spec.ts`, against the package's `examples/` page):**
  - `word`: hover a prose word → exactly one pill whose rect contains the word's rect, no line or
    paragraph shapes; move within the word → same pill, unchanged; next word → pill moves, no
    frame with zero pills when crossing the gap.
  - `wordLine`: a line band whose vertical extent contains the word rect and whose horizontal
    extent matches the block; in columns mode the band stays inside the word's column.
  - `wordLineParagraph`: paragraph shape(s) covering the block's client rects.
  - `none`: no layer.
  - Pointer past a short line's end → no shapes; inside `pre`, inline `code`, a marker card → no
    shapes; primary-button drag across lines → no shapes, and the selection text equals the
    dragged text; `mouseleave` → no shapes; wheel-scroll under a still pointer → shapes follow.
  - Cursor: computed `cursor` on a prose paragraph is `default` with `arrow`, `text` with
    `iBeam` and `pointer` with `hand`; on a marker card it is unchanged in all three.
  - The existing Playwright suite and `pnpm --filter @cluesmith/codev-artifact-canvas test` stay
    green (data-line, cards, "+", composer untouched).
- **VS Code host:** template test asserting the two root attributes for known values and their
  absence for unknown ones; `pnpm check-types` for both tsconfigs.
- **Manual (dev gate, the owner):** open a long plan in the Codev Markdown Preview from this
  worktree's extension build; use `…` → "Reading Aids…" to try None and all three styles and both
  cursors, confirming each applies immediately; dark and light themes; both reading modes; a
  couple of font sizes via the zoom buttons; drag-select across lines (no shapes, selection
  intact); hover a block with comment cards, use "+", type in the composer (no shapes while it has
  focus); pick Highlight → None and confirm the highlight disappears from the open
  preview. For a quick look without VS Code:
  `pnpm --filter @cluesmith/codev-artifact-canvas dev:example`.
