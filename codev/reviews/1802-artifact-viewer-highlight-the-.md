# PIR Review: Hover reading aid and cursor choice in the artifact viewer

Refs #1802

## Summary

The Codev Markdown Preview (the artifact canvas) now gives the reader's eye an anchor under the pointer: soft shapes drawn behind the text for the word, its line and its paragraph, in six owner-chosen styles (`none`, `word`, `wordLine`, `wordLineParagraph`, `line`, `lineParagraph`; default `lineParagraph`). It also offers a choice of prose cursor (`arrow` default, `iBeam`, `hand`). Both are picked from a new "Reading Aids…" item in the preview's title-bar `…` menu, backed by two settings. The shapes live in a separate fixed layer, so the canvas body's DOM (cards, composer, `data-line` anchoring) is never touched.

Three things the issue reader should know up front:

1. **The shipped default draws no word pill.** The issue title asks for the word under the pointer to be highlighted, and the `word`, `wordLine` and `wordLineParagraph` styles do that. At the dev gate the owner moved the default to `lineParagraph` (line band plus paragraph tint, no pill). That was a deliberate owner ruling, not a regression.
2. **The line band spans the text on the word's line, not the block's full width** (clipped to the word's column in columns mode). The plan said "full width of the block fragment". This is an accepted deviation: it matches the lab the owner approved and avoids a band running far past a short last line.
3. **Inline code is part of the sentence** (dev-gate fix, superseding plan decision 5 for inline code). It takes the chosen cursor and keeps the line band and paragraph tint; only the word pill is skipped inside a chip, whose own background would hide it. Fenced code, comment cards, the composer and the "+" stay excluded and keep the arrow.

## Files Changed

- `apps/vscode/package.json` (+49 / -0)
- `apps/vscode/src/__tests__/preview-reading-aids.test.ts` (+129 / -0)
- `apps/vscode/src/extension.ts` (+59 / -0)
- `apps/vscode/src/markdown-preview/preview-provider.ts` (+3 / -0)
- `apps/vscode/src/markdown-preview/preview-template.ts` (+37 / -1)
- `apps/vscode/src/markdown-preview/reading-aids.ts` (+111 / -0)
- `apps/vscode/src/markdown-preview/webview/main.ts` (+7 / -0)
- `codev/plans/1802-artifact-viewer-highlight-the-.md` (+282 / -0)
- `codev/projects/1802-artifact-viewer-highlight-the-/status.yaml` (+22 / -0)
- `codev/resources/arch.md` (+1 / -0)
- `codev/resources/lessons-learned.md` (+3 / -0)
- `codev/reviews/1802-artifact-viewer-highlight-the-.md` (new)
- `codev/state/pir-1802_thread.md` (+32 / -0)
- `packages/artifact-canvas/README.md` (+11 / -0)
- `packages/artifact-canvas/examples/main.tsx` (+50 / -0)
- `packages/artifact-canvas/playwright/hover-word.spec.ts` (+321 / -0)
- `packages/artifact-canvas/src/__tests__/default-theme.test.ts` (+3 / -0)
- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx` (+20 / -1)
- `packages/artifact-canvas/src/components/__tests__/hover-word.test.ts` (+186 / -0)
- `packages/artifact-canvas/src/components/hover-word.ts` (+327 / -0)
- `packages/artifact-canvas/src/components/useHoverWordHighlight.ts` (+343 / -0)
- `packages/artifact-canvas/src/index.ts` (+9 / -1)
- `packages/artifact-canvas/src/styles/default-theme.css` (+49 / -1)
- `packages/artifact-canvas/src/types.ts` (+31 / -0)

## Commits

- `d6bcd99da` [PIR #1802] Dev-gate round 2: stronger line band and paragraph tint in dark themes
- `dca95cee5` [PIR #1802] Dev-gate round 1: line styles, lineParagraph default, picker opens on current, inline code keeps cursor and band
- `f7b594131` [PIR #1802] Thread: implement notes
- `064c7fc51` [PIR #1802] VS Code: Reading Aids picker and hoverHighlight / readingCursor settings
- `8193be35d` [PIR #1802] Canvas: hover reading aid (word, line, paragraph) and prose cursor choice
- `b189e6194` [PIR #1802] Plan: add I-beam cursor option
- `9b54292f8` [PIR #1802] Plan: rename cursor setting to readingCursor; Cursor section in picker
- `6319f854d` [PIR #1802] Plan: None as first highlight option in Reading Aids picker
- `ad0dcab51` [PIR #1802] Plan revised: three highlight styles, cursor choice, Reading Aids menu
- `fd07d8004` [PIR #1802] Plan draft
- plus porch chore commits (init, gate requests and approvals, phase transitions)

## Test Results

- Artifact canvas: `check-types` clean; vitest 202 passed (new `hover-word.test.ts`: word bounds with `Intl.Segmenter` and the regex fallback, parsers, `shapesOf`, exclusions, block resolution, shape geometry); Playwright 58 passed, 13 new in `hover-word.spec.ts` (each style, behind-the-text stacking, no empty frame crossing a word gap, short-line ends, code and cards, drag-select, mouseleave, columns mode, scroll under a still pointer, inline code, all three cursors). The existing 45 browser tests stay green.
- VS Code extension: `check-types` (host + webview tsconfigs) clean, lint clean, vitest 1188 passed (new `preview-reading-aids.test.ts`: picker rows and order, current marking, opening row, placeholder, bootstrap attributes incl. hostile values, token mapping, dark-theme strengths, contributions); `pnpm compile` bundles verified to contain the new code.
- Porch `build` and `tests` checks: pass (see the umask note under Things to Look At).
- Real bundle in Chromium: the compiled `markdown-preview.js`/`.css` loaded under the actual `renderMarkdownPreviewHtml` output with VS Code dark and light colors over a real plan doc, for every style and cursor.
- Manual (owner, dev gate): two feedback rounds in the VS Code dev host (picker placeholder and opening row, two added styles and the new default, cursor flicker over inline code, dark mode too faint), then approved at `d6bcd99da`.

## Architecture Updates

COLD `codev/resources/arch.md` (VS Code Extension, Key Design Decisions): one entry on the hover layer contract: shapes in a separate `position: fixed; z-index: -1` layer under an `isolation: isolate` root, never in the imperatively owned body; caret + `Intl.Segmenter` resolution per frame in client coordinates; the style and cursor vocabularies as canvas props bootstrapped through `#root` data attributes; and the dark-theme selector, including why `:not(.vscode-high-contrast-light)` is required (the webview preamble also stamps plain `vscode-high-contrast` on light high contrast). Nothing promoted to the HOT tier: it is subsystem detail, not a cross-cutting rule.

## Lessons Learned Updates

COLD `codev/resources/lessons-learned.md`, three entries:

- Testing: a test that writes a file with an explicit `mode` and asserts it depends on umask (`cloud-config.test.ts` under `umask 077`); check with `umask 022` before suspecting the code.
- UI/UX: VS Code's QuickPick always opens on its first row and always shows a filter box, so add a placeholder and set `activeItems` (via `createQuickPick`) when the first row is an "off" choice.
- UI/UX: for pointer-driven reading aids, inline code is part of the sentence; excluding it like fenced code makes the cursor and the band flicker on code-dense lines.

## Things to Look At During PR Review

- **Unrelated, environment-dependent test failure.** Porch's `tests` check (which runs only `packages/codev`) failed on `src/agent-farm/__tests__/cloud-config.test.ts` "enforces 0600 on pre-existing files with wrong permissions": the builder sandbox shell runs `umask 077`, so the test's `writeFileSync(..., { mode: 0o644 })` precondition yields `0600` and its first assertion fails. Unrelated to this diff (no `packages/codev` changes); it passes 41/41 under `umask 022`, and `porch done` / `porch approve` were re-run under `umask 022` with the full suite executing. Not fixed here (out of scope); noted in lessons.
- **Default without a word pill** and **line band = text extent**: see Summary items 1 and 2.
- **Stacking.** `isolation: isolate` on `.codev-artifact-canvas` makes the root a stacking context so the `z-index: -1` layer sits behind the prose. The fixed overlays (z-index 4 to 6) already lived inside the root; the full existing Playwright suite is green.
- **Sticky gap rule after scroll.** Crossing a space or punctuation keeps the current word while the pointer stays inside its line box; on a scroll-triggered frame the line box is re-measured before that test (a stale box left the shapes on the old word; caught by the scroll Playwright case).
- **Vocabulary twin.** The extension host cannot import the canvas runtime (it would pull React into the host bundle), so `reading-aids.ts` lists the choices itself, typed against the canvas types with a compile-time completeness check in both directions (`satisfies` plus an `Exclude`-must-be-`never` assertion).
- **Dark-theme strengths** are set in the VS Code template (line 12%, paragraph 6%) under `body.vscode-dark` and dark high contrast; light themes keep the package defaults (6%, 3.5%). The word pill maps to `--vscode-toolbar-hoverBackground`.
- **3-way consultation (single pass): Gemini APPROVE, Claude APPROVE, Codex COMMENT.** No REQUEST_CHANGES. Comments addressed in a follow-up commit:
  - Codex: the scroll Playwright case passed when every shape vanished. It now scrolls by whole lines onto a line with a letter under the pointer and requires exactly one shape, moved, under the pointer (and it caught that a whole-line scroll keeps the same `top`, so "moved" compares the horizontal extent too).
  - Codex: README said all code is excluded; corrected for inline code (keeps cursor, band and tint).
  - Claude: `redrawCurrent()` anchored the band on `wordRects[0]`; it now anchors on the fragment under the pointer, as `tryDraw` does.
  - Claude: the `lineParagraph` default lived in three places with no cross-check; a host test now pins canvas default = host picker default = `package.json` default (cursor too).
  - Claude: the plan still described the pre-dev-gate design; it now opens with a "superseded in part" pointer to this review.
  - Claude: the fixed full-viewport layer is now a documented host contract in the package README.
- **Hand cursor and links.** With `hand`, links no longer stand out by cursor; they keep their colour and underline, and `hand` is opt-in.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1802 → **Review Diff**
- **Run dev**: the worktree has no `worktree.devCommand`; open `.builders/pir-1802` in VS Code and use Run and Debug → **Run Codev Extension** (the extension is compiled there). For the canvas alone: `pnpm --filter @cluesmith/codev-artifact-canvas dev:example` (header selects switch style and cursor).
- **What to verify**:
  - Open a long spec or plan in the Codev Markdown Preview; move across a paragraph: line band and paragraph tint follow the pointer, no flicker.
  - `…` → **Reading Aids…**: the box has a placeholder, the list opens on the current style; try all six styles and three cursors, each applies immediately.
  - A line dense with inline code: the cursor and the band stay steady across the chips.
  - Fenced code, comment cards, the composer and "+": no shapes, arrow cursor.
  - Dark and light themes; columns mode (band stays in its column); zoom buttons (shapes scale).
  - Drag-select across lines: no shapes, selection intact.
