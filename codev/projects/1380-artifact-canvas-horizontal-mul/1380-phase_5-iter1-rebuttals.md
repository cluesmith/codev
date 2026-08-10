# Phase 5 — iteration 1 rebuttals

## Codex (REQUEST_CHANGES)

1. **Progress can go stale when cards/composer change layout without an html change.**
   Accepted — the injected card stacks and the composer host change `scrollWidth` while
   neither `html` nor the body's border box moves. The recomputation key is now a memo over
   all three layout-affecting inputs (`html`, `markers`, `composingLine`), with a jsdom
   regression test (key change + scrollWidth change, no scroll/resize → fresh total) and a
   browser test (open composer → chip matches current layout). While fixing this a fourth
   trigger surfaced in the parallel Playwright run: an image finishing its async load also
   grows `scrollWidth` silently — covered with a capture-phase `load` listener.

## Claude (APPROVE, polish)

1. **`measureColumnGeometry` under-measures when the first child is a narrow table.**
   Accepted — the helper now takes the max first-rect width over a sample of ten children;
   unit test with a narrow leading table added.
2. **Playwright count assertion mirrors the implementation formula.** Accepted — the main
   readout test is now formula-independent (stable total, +1 per column step, endpoint bound
   at max scroll; the endpoint check also surfaced that `current` reports the viewport-start
   column, which the test now asserts correctly). The two remaining mirrors (composer
   freshness, post-resize freshness) intentionally reuse the component's exact sampling
   because their claim is "recomputed against current layout", not formula correctness —
   noted inline.
3. **Resize→readout recompute unasserted.** Accepted — asserted in the resize browser test.
4. **Per-tick re-render from fresh state objects.** Accepted — `setProgress` bails when
   `current`/`total` are unchanged.
5. **Paging doesn't yield to inner scrollers.** Accepted — PageUp/PageDown now apply the
   same yield rule as the wheel remap (`innerScrollerCanConsume`), with a unit test covering
   consume and exhausted-fall-through.
