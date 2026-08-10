# Builder thread — spir-1380 (horizontal multi-column reading mode)

## 2026-08-10 — Specify phase

**Orientation.** Read the merged #1343 implementation (PR #1385): the "+" affordance is
block-scoped (abspos wrapper inside the row, row-relative `top`), gutter is block-local
(`--codev-canvas-gutter` per-row padding), pre's scroll container is the inner `code`. All
in-flow interactions (#863 cards, #1107 composer) are siblings/children of their blocks.

**Ground-truth finding (corrects the issue premise).** The canvas package's only production
host is the VS Code webview. `afx open` serves `templates/open.html` — a bespoke legacy
annotator that never adopted the canvas (spec 945 deferred dashboard host integration).
Flagged to architect; **ruling A**: implement once in the package, prove in vite dev host +
VS Code webview; `afx open` parity arrives via new issue #1386 (canvas adoption, architect
lane). Spec's requirement 9 restated accordingly.

**Spike (architect-recommended, run before finalizing the spec).** Headless Chromium 147 over
the real theme CSS + renderer-shaped DOM under `column-width:400px; column-fill:auto;
overflow-x:auto`. Decisive findings:
1. Overflow columns scroll horizontally on the multicol element directly.
2. `break-inside: avoid` protects pre/table/cards/composer/img (1 client rect each).
3. BUT a protected block taller than the column fragments anyway AND overflows the column
   (852/1427/17px fragments in a 900px column) → unreachable content under overflow-y:hidden.
   Tall-block policy is load-bearing → inner-scroll cap (verified clean: 1 fragment, fits).
4. Fragmented prose yields per-fragment `getClientRects()` → pointer-side "+" anchoring
   feasible.
5. **Gift**: abspos children of a fragmented row resolve `top` in FLOW coordinates and render
   in the correct fragment — #1343's placeAffordance mechanism generalizes with only
   fragment-aware `top` math. The `::before` marked-row strip also renders on every fragment.
6. `offsetTop` in multicol = within-column visual position → minimap fractions meaningless →
   suppress minimap in horizontal (D3).
7. `scrollIntoView({inline:'center'})` scrolls the multicol container correctly.

**Spec written** with all eight decisions resolved (D1 tall-block inner scroll; D2
pointer-side fragment anchoring; D3 minimap suppressed; D4 canvas-owned toggle + host-owned
per-user persistence; D5 no scroll-snap; D6 column width as theme token; D7 viewport-start
block anchor on mode switch; D8 column-count progress readout). Spike code stayed in
scratchpad (throwaway, not committed per research-docs convention).

Next: porch checks → porch done → 3-way consultation → spec-approval gate.

**Iter-1 consultation.** Codex REQUEST_CHANGES (5 findings), Claude COMMENT (6 findings,
code-verified — caught that neither v1 host provides a bounded height today, and that
`--codev-canvas-prose-max-width` sits on the future multicol element). All 11 accepted:
card-body caps, MarkdownView exclusion, wheel yield-to-inner-scrollers, resize/zoom
recompute, persistence validation, in-scope host height wiring, prose-cap inert in
horizontal, PageUp/PageDown column paging, selection scenario, spike→Playwright fixture.
Spec revised + rebuttals committed. **spec-approval gate requested; waiting on human.**

## Plan phase (same day)

Spec approved at gate. Plan drafted: 6 phases, inside-out (mode core → fragmentation
protection + Playwright fixture → input semantics → fragment-aware affordance → progress/
a11y → host wiring). Iter-1 consultation: Codex REQUEST_CHANGES (7) + Claude COMMENT (7,
code-verified). All 14 accepted — the big ones: measured column geometry (the width token is
a preferred minimum, real columns stretch), VS Code bootstrap must embed the persisted mode
in the initial webview HTML (canvas mounts before the first host message), native
non-passive wheel listener, @playwright/test as artifact-canvas devDep + a PR-triggered CI
step (fixture had no CI home), Memento plumbed through MarkdownPreviewProvider's
constructor, homes for spec scenarios 9 + 5c. Plan + rebuttals committed.
**plan-approval gate requested; waiting on human.**
