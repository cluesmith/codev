# pir-1802 thread

## 2026-10-13 plan
- Architect is vscode. Read owner mock (rounded padded pill behind word, dark theme).
- Picked overlay rects (option 1): `::highlight` cannot round or pad. Layer is a fixed div in the canvas root, z-index -1 under `isolation: isolate` so the pill paints behind the glyphs; body DOM never written.
- Owner decisions proposed: default on; skip pre + inline code; include headings + links.
- Setting plumbs as a `data-hover-word-highlight` root attribute (same path as reading mode); config change already re-renders the webview HTML.

## 2026-10-16 plan revised (owner rulings from the lab review)
- Built a published lab (8 variants over real Spec 1595, cursor options incl. drawn finger) for the owner.
- Owner ruled: three styles word / wordLine / wordLineParagraph, default wordLine; pointer arrow / hand (system), default arrow (keeps #1232).
- Placement: two settings (`codev.markdownPreview.hoverHighlight`, `codev.markdownPreview.cursor`) + one "Reading Aids…" QuickPick in the title-bar `…` menu beside Reset Font Size. No new on-page button (columns toggle is per-document; these are set-once like zoom).
- Open: whether `off` appears in the picker or settings only (proposed settings-only).
- Owner ruled: `None` is the first Highlight item in the picker (setting value renamed `off` → `none` to match the label).
- vscode architect: setting renamed `codev.markdownPreview.cursor` → `codev.markdownPreview.readingCursor` (bare 'cursor' reads as the caret). Owner: cursor choice is its own section of the Reading Aids picker.
- Owner: add I-beam as a third cursor option (value `iBeam`, `cursor: text`); picker Cursor section is Arrow / I-beam / Hand, default arrow.

## 2026-10-16 implement
- Plan approved by Amr (relayed by vscode architect, 2026-10-15T23:11:19Z, head b189e6194); ran porch approve.
- Canvas: `hover-word.ts` (pure helpers) + `useHoverWordHighlight.ts` (controller, fixed layer at z-index -1 under `isolation: isolate`, pooled shapes, native listeners). Props `hoverHighlight` / `readingCursor`, three foreground-derived tokens, `data-reading-cursor` root attribute.
- Deviation, small: the line band spans the TEXT on the word's line (clipped to its column), not the block's full width. Matches what the owner approved in the lab and avoids a band running past a short last line.
- Bugs caught by the browser suite: sticky-gap rule used a stale line box after scroll (shape stayed on the old word); regex fallback treated `--` as a word. Both fixed with tests.
- Architect polish taken: both parsers match case-insensitively (`ibeam` → `iBeam`).
- VS Code: two enum settings, "Reading Aids…" QuickPick in editor/title `1_run`, attributes on `#root`, word pill mapped to `--vscode-toolbar-hoverBackground`.
- Verified the real webview bundle in Chromium with dark and light VS Code colors over this plan doc: pill behind the word, band, paragraph tint, none, cursors.
- Worktree has no `worktree.devCommand` (shared config); dev gate runs via `.vscode/launch.json` "Run Codev Extension".

## 2026-10-16 dev-gate feedback round 1 (Amr)
- Picker: the filter box is VS Code's own QuickPick input (cannot be hidden). Added a placeholder and the picker now opens on the current highlight style (it opened on None, where Enter would switch the aid off). Moved to createQuickPick for activeItems.
- Owner added two styles, `line` and `lineParagraph` (no word pill), and made `lineParagraph` the default. Highlight list: None, Word, Word and line, Word line and paragraph, Line, Line and paragraph.
- Owner: cursor flipped back to the arrow over inline code chips. Fix: only fenced code, cards, composer and "+" keep the arrow; inline code takes the prose cursor. Same root cause for the highlight: inline code now keeps the line band and paragraph tint (only the word pill is skipped, the chip's background would hide it). Supersedes plan decision 5 for inline code.
- Owner: dark mode too faint. VS Code template now sets line 12% / paragraph 6% under body.vscode-dark (and dark high contrast); light keeps the package's 6% / 3.5%.

## 2026-10-16 review
- PR #1812 (Refs #1802). 3-way: gemini APPROVE, codex COMMENT, claude APPROVE. Comments fixed in 3ba554fd9 (scroll test now requires a moved shape under the pointer; redraw anchors on the pointer's fragment; default pinned across canvas/host/package.json; README + plan notes). At pr gate, Amr's.
