# pir-1850 thread

## 2026-10-21 plan
- Plan drafted: codev/plans/1850-markdown-preview-reading-aids-.md.
- Key finding: the composer target is always a block's data-line; the visual line only positions the "+". So "+ follows the band" = the "+" is drawn one quantized line up, on the same block, and is absent on a block's first line.
- Decisions flagged in the plan: (a) under abovePointer, one-line blocks have no pointer entry point (ruling applied literally; keyboard still works); (b) abovePointer has no effect for the none/word styles; (c) clickParagraph ignores prose clicks while a composer is open (protects the draft); (d) a continuation fragment's top line in horizontal mode gets no band.

## 2026-10-21 plan revision 1 (owner, in pane)
- Owner's intent: a reader's finger rests BELOW the line being read.
- Owner ruled the line above may cross into the previous block. The original first-line rule left every paragraph's last line and every one-line block unhighlightable.
- The "+" still follows the band. A run-away "+" (re-anchoring one line up as the pointer climbs) is avoided by resolving one "reading target" in the hover controller and letting the gutter's null target keep the "+" sticky.
- clickParagraph: an empty open composer moves on click; a composer holding a draft ignores clicks elsewhere (new hasDraft() on the composer handle).

## 2026-10-21 implement
- Plan approved by Amr (relayed by vscode) at 8cab2635d.
- Canvas: one ReadingTarget resolved in HoverWordController. The band, tint, "+" (via a listener) and click (snapshot at mousedown) all follow it. The sticky lineBox stays the pointer's row. Gap below a block counts; code blocks and card stacks are barriers; max cross distance is 3 line-heights.
- Host: two settings, four-section picker. Three existing picker-model assertions had to change, because the issue mandates the two extra sections.
- Tests: 44 new jsdom tests (a layout-mock.ts stand-in drives the controller) and 6 Chromium Playwright tests (the "+" is reachable by mouse, real line-above, drag/dismiss/double-click). The existing 202 jsdom and 58 Playwright tests are unchanged and green.
- Finding: in clickParagraph, a double-click opens the composer on its first click and the composer's autofocus drops the word selection (measured in Chromium). Not fixed; the plan's deferred-open fix (~250ms lag) is left for Amr's decision at the dev gate.

## 2026-10-21 dev-gate revision (owner, in pane)
- Owner after trying it: highlightLine "not good from a usability point of view"; replace with hiding the cursor over prose.
- Owner chose: always hidden over prose (no idle timer), as a 4th readingCursor choice `none` ("Hidden").
- Implemented as one CSS rule (cursor: none on the body). The existing shared rule keeps the arrow over code, cards, the composer and the "+"; links keep the hand via the UA rule.
- highlightLine fully removed (hover controller restored to main). Its implementation remains in history at 2af31184f.
- Tests: canvas 221 jsdom, 63 Chromium (5 new), extension 1245, all green.

## 2026-10-21 dev-gate revision 2 (owner, in pane)
- "Hidden on its own is confusing": with Hidden, the word under the invisible pointer is underlined (owner picked the word over the whole line). It shows with every highlight style, including None.
- An underline shape kind in the hover controller; the controller attaches for Hidden even with style none; the bar goes below inline-code chips; new token --codev-canvas-hover-underline-color added to the locked snapshot.
- Tests: canvas 225 jsdom, 66 Chromium (3 new), extension 1245, all green.
