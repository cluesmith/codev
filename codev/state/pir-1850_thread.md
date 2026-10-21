# pir-1850 thread

## 2026-10-21 plan
- Plan drafted: codev/plans/1850-markdown-preview-reading-aids-.md.
- Key finding: the composer target is always a block's data-line; the visual line only positions the "+". So "+ follows the band" = the "+" is drawn one quantized line up, on the same block, and is absent on a block's first line.
- Decisions flagged in the plan: (a) under abovePointer, one-line blocks have no pointer entry point (ruling applied literally; keyboard still works); (b) abovePointer has no effect for the none/word styles; (c) clickParagraph ignores prose clicks while a composer is open (protects the draft); (d) a continuation fragment's top line in horizontal mode gets no band.
