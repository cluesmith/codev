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

## Implement phases 1–4 (same day)

Plan approved. Porch-driven phase loop, one commit per phase + a consult-fix commit each:

- **Phase 1 (reading-mode core)**: mode prop/coercion, toggle chrome, horizontal CSS layer,
  D7 anchoring, column-height observation. Consult: Codex APPROVE, Claude COMMENT — toggle
  moved before the body (first tab stop), CSS scoping guard test added.
- **Phase 2 (fragmentation protection + fixture)**: break-inside + caps, 1109-line fixture,
  Playwright suite + CI job. Fixture immediately caught that markdown-it stamps fence attrs
  on the inner code (→ architect filed #1396). Consult iter-1: both REQUEST_CHANGES —
  nested pre/table were unprotected (child combinators), fixed with descendant selectors +
  nested fixtures/tests; iter-2: both APPROVE.
- **Phase 3 (input semantics)**: non-passive wheel remap with inner-scroller yield, measured
  column paging, axis-aware jumps, focusable card scrollers. Consult: Codex APPROVE, Claude
  COMMENT — guard-order/clamp polish + legend/minimap tests added. Container-level paging
  reachability deliberately deferred to phase 5 (focusable container lands there).
- **Phase 4 (fragment-aware "+")**: #1396 fixed at the ROOT — custom fence renderer stamps
  data-line on the pre (code keeps tabindex as scroller); placeAffordance rewritten in flow
  coordinates over pure, unit-tested fragment math; offsetTop eliminated outside the
  no-layout fallback. Browser tests: addendum both directions, first-fragment keyboard,
  pre-row regression, scenario-9 watch-reload, nested×fragmented-host lock. Consult: both
  APPROVE. NOTE for PR body: the #1396 fix intentionally changes vertical fences (row model
  + two tab stops: pre row + code scroller) — defensible, demo at dev-approval.

Suites: 137 jsdom + 25 browser green; repo-wide green. Next: phase 5 (progress indicator,
minimap suppression, a11y — incl. the deferred container-paging decision), phase 6 (hosts).

## Implement phases 5–6 (same day)

- **Phase 5 (progress + a11y)**: "Column k of n" readout (live chip + debounced aria-live),
  minimap suppressed in horizontal, body became a focusable labeled region — which closed
  phase-3's deferred container-paging decision — resize re-anchoring via a scroll-tracked
  viewport-start line. Consult iter-1: Codex REQUEST_CHANGES (staleness when cards/composer
  move layout without an html change) + Claude polish; fixed with a memoized layout key, and
  chasing a parallel-run flake exposed a 4th silent scrollWidth mover (async image load) —
  capture-phase load listener. Iter-2: both APPROVE.
- **Phase 6 (host wiring)**: VS Code webview — persisted mode bootstrapped via
  data-reading-mode in the initial HTML (canvas mounts before the first message),
  WebviewToHostMessage gains readingModeChange, Memento plumbed through the provider,
  sanitizeReadingMode gates both untrusted directions; vite dev host — localStorage +
  mode-aware layout in one stable tree (no remount, D7 demo preserved); height contexts in
  both hosts; README modes/tokens sections. Consult iter-1: both REQUEST_CHANGES — README
  paragraph had landed mid-table (fixed), persistence round-trip now driven end-to-end
  through resolveCustomTextEditor with a fake panel+Memento (10 host tests), dev-host mode
  state defended as Constraint-3 layout glue (comment records the reasoning).

All six phases done pending phase-6 iter-2. Next: PR → dev-approval demos (both hosts, incl.
vertical-mode fence pass for the #1396 change) → merge → verify.
