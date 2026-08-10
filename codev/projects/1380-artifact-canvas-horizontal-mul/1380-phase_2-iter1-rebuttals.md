# Phase 2 — iteration 1 rebuttals

Both reviews REQUEST_CHANGES; every point accepted except one answered with evidence.

## Claude

1. **Blocking: nested `pre`/`table` unprotected (child combinators).** Accepted — verified
   real, and the reviewer's browser probe reproduced spike finding 3 exactly. Protection and
   cap rules now use descendant selectors (matching how cards/composer/images already
   scoped); the fixture gained a 120-line fence nested in a list item and a table nested in a
   blockquote, with dedicated tests (`li pre` protected + inner-scrolls, `blockquote table`
   protected). The CSS comment records why descendant scoping is deliberate.
2. **Light/dark smoke missing.** Accepted — dark-token override test added (layout invariants
   hold, toggle visible).
3. **Playwright files outside `check-types`.** Accepted — tsconfig `include` now carries
   `playwright.config.ts` + `playwright/`; `tsc --noEmit` clean.
4. **Hardcoded cap offsets (34/24/60px).** Acknowledged, left as commented literals: they
   mirror `pre` padding/border and card chrome that are themselves untokenized literals in
   this stylesheet — deriving would first mean tokenizing that chrome, a wider change than
   this phase warrants. The linking comments stay.
5. **Stub-adapter stacking change is shared-fixture behavior.** Agreed — will be called out
   in the PR description as noted.

## Codex

1. **Fixture too small (≥1000-line criterion), no nested lists, no reachability check.**
   Accepted — the fixture is now a 1109-line mixed document (filler sections with prose,
   lists, fences, tables), includes nested list levels, and a reachability test sweeps every
   `[data-line]` block asserting all fragment rects sit within the column's vertical box
   (content inside an inner scroll container exempted — it is reachable via that container's
   own scrollbar, which the first version of the test wrongly flagged).
2. **Images omitted from `break-inside: avoid`.** Accepted in letter — `img` added to the
   protection list. In substance images were already safe (replaced elements are monolithic
   per css-break and cannot fragment), but the explicit rule costs nothing and also covers a
   host that restyles images as block-level.
3. **Missing scenarios: over-tall composer, stack-vs-card break policy, light/dark.**
   Accepted — all three added: a resize-to-3000px textarea cannot push the composer past the
   column; computed-style policy pair asserted (stack `break-inside: auto`, every card
   `avoid`); dark smoke as above.

Result: 16 browser tests + 109 jsdom tests pass; `tsc --noEmit` clean.
