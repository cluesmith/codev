# Plan: Horizontal Multi-Column Reading Mode for the Artifact Canvas

**Specification**: [codev/specs/1380-artifact-canvas-horizontal-mul.md](../specs/1380-artifact-canvas-horizontal-mul.md)

## Executive Summary

Implements the spec's Approach 1: native CSS multi-column on the existing
`.codev-artifact-canvas-body` (`column-width` + `column-fill: auto`, overflow columns
scrolling horizontally on the same element), with the mode as a class + controlled prop. All
mechanism lives in `packages/artifact-canvas`; the two v1 hosts get only a height context and
persistence glue (spec Constraint 3). The phases build inside-out: mode core and CSS first,
then the fragmentation-protection layer with its real-browser regression fixture (the spec's
spike findings turned into tests), then input/navigation semantics, then the fragment-aware
affordance, then progress/accessibility chrome, and finally host wiring + demos. Each phase
is one atomic commit on `builder/spir-1380`; a single PR at the end (per PR strategy).

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Reading-mode core: prop, toggle, column CSS, mode-switch anchoring"},
    {"id": "phase_2", "title": "Fragmentation protection + real-browser regression fixture"},
    {"id": "phase_3", "title": "Wheel remap, keyboard paging, axis-aware navigation"},
    {"id": "phase_4", "title": "Fragment-aware '+' affordance placement"},
    {"id": "phase_5", "title": "Progress indicator, minimap suppression, accessibility chrome"},
    {"id": "phase_6", "title": "Host wiring: VS Code webview + vite dev host, docs, demos"}
  ]
}
```

## Phase Breakdown

### Phase 1: Reading-mode core: prop, toggle, column CSS, mode-switch anchoring

**Dependencies**: None

#### Objective

The mode exists end-to-end inside the package: a validated reading-mode state, a token-styled
toggle in canvas chrome, the horizontal-mode CSS layer, and coarse position preservation on
toggle (spec D4/D6/D7). Vertical mode is untouched by construction (no mode class → no new
CSS applies).

#### Files to Create / Modify

- `packages/artifact-canvas/src/types.ts` — `ReadingMode` type; `ArtifactCanvasProps` gains
  `initialReadingMode?` and `onReadingModeChange?` (contract extension, spec D4).
- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx` — mode state (coercing
  unrecognized values to `vertical`), mode class on the canvas root, toggle handling,
  viewport-start block anchoring on switch (D7), container-height observation
  (`--codev-canvas-column-height` custom property set from a ResizeObserver; visual-viewport
  fallback when the host provides no height).
- `packages/artifact-canvas/src/overlays/ReadingModeToggle.tsx` (new) — the toggle button.
- `packages/artifact-canvas/src/styles/default-theme.css` — `--codev-canvas-column-width` /
  `--codev-canvas-column-gap` tokens; `.codev-canvas-mode-horizontal` layer (column-width,
  column-fill: auto, height, overflow-x auto / overflow-y hidden); prose-max-width made
  inert in horizontal mode; toggle chrome.
- `packages/artifact-canvas/src/index.ts` — export the new type.
- Tests: `src/components/__tests__/reading-mode.test.tsx` (new),
  `src/__tests__/default-theme.test.ts` (token additions).

#### Deliverables

- [ ] Controlled/validated mode state + change callback; garbage input coerces to vertical.
- [ ] Toggle button rendered in canvas chrome, token-styled, keyboard-operable.
- [ ] Horizontal CSS layer with the two new tokens; `MarkdownView` untouched by every new rule.
- [ ] D7 anchoring: viewport-start `[data-line]` block recorded before switch, brought back
      into view after (axis-aware), nearest-preceding fallback if it vanished.
- [ ] Tests for this phase (mode state, coercion, toggle interaction, callback emission,
      vertical-mode DOM identical when mode never toggled).

#### Acceptance Criteria

- [ ] With no mode props and no toggle click, rendered DOM (classes/attributes) is identical
      to pre-phase output (spec: "vertical untouched"); full existing suite passes unchanged.
- [ ] Toggling emits `onReadingModeChange` and applies/removes the mode class; build + tests
      pass.

#### Test Plan

Unit (jsdom): mode state transitions, value coercion, toggle a11y (button role/label),
callback wiring, no-mode-class snapshot parity, theme test asserts new tokens documented.
Layout behavior is deferred to Phase 2's real-browser fixture (jsdom has no fragmentation).

### Phase 2: Fragmentation protection + real-browser regression fixture

**Dependencies**: Phase 1

#### Objective

The spec's protection rules (Constraint 4, D1) enforced in CSS, and the load-bearing spike
findings committed as a real-browser regression test (spec Test Scenario 14) so they can
never silently regress.

#### Files to Create / Modify

- `packages/artifact-canvas/src/styles/default-theme.css` — `break-inside: avoid` for
  protected types (top-level `pre`/`table` rows, images, individual `.codev-canvas-marker-card`,
  `.codev-canvas-comment-composer-host`); stacks break between cards; horizontal-mode
  max-height caps driven by `--codev-canvas-column-height` (inner scroll for `pre code`,
  `table`, card body; `max-height` fit for images; composer textarea cap).
- `packages/artifact-canvas/playwright/columns-fragmentation.spec.ts` (new; location final at
  implementation — wherever the repo's Playwright harness convention puts package-level
  browser tests) + a fixture document exercising every protected type, tall variants, and
  fragmenting prose.
- `packages/artifact-canvas/package.json` — browser-test script wiring (dev-dependency reuse
  of the workspace's existing Playwright; no new runtime dependency).

#### Deliverables

- [ ] Protection CSS per spec D1, including the over-tall card cap (iter-1 Codex).
- [ ] Committed Playwright fixture asserting: every protected element reports exactly one
      client rect; an over-tall `pre`/`table`/card fits its column with a working inner
      scroll; fragmented prose reports one rect per fragment; no rendered box is vertically
      unreachable; horizontal scrollability (`scrollWidth > clientWidth`).
- [ ] Tests for this phase (the fixture is the test).

#### Acceptance Criteria

- [ ] Fixture passes headlessly in CI-runnable form; spec success criteria 1 (no clipped /
      unreachable content), 4 (no straddling), and 5 (tall code readable) hold on the fixture
      document; build + full suite pass.

#### Test Plan

Real browser (Chromium via Playwright): the fixture assertions above, light + dark theme
smoke (protection is theme-independent but the run costs nothing). jsdom: none (out of
jsdom's power — the split verification the spec's Assumptions codify).

### Phase 3: Wheel remap, keyboard paging, axis-aware navigation

**Dependencies**: Phase 1

#### Objective

Input semantics per spec Constraint 5 and Desired State: vertical wheel deltas become
horizontal scroll (yielding to inner scrollers), PageUp/PageDown step columns, and every
existing #1237 navigation lands axis-correctly.

#### Files to Create / Modify

- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx` — mode-gated wheel handler
  (vertical-dominant unmodified deltas only; ctrl/meta pass-through; walk the target chain
  for an inner vertical scroller that can still consume the delta and yield to it);
  PageUp/PageDown one-column stepping (column width + gap; never intercepted while the
  composer has focus); `focusBlock` and Home/End use axis-aware `scrollIntoView` options
  (`inline: 'center', block: 'nearest'` in horizontal).
- `packages/artifact-canvas/src/overlays/MarkerMinimap.tsx` — dot-click scroll becomes
  axis-aware (shared helper), ahead of Phase 5's suppression (the helper also serves future
  re-enablement).
- `packages/artifact-canvas/src/overlays/KeyboardHelp.tsx` — legend gains the paging keys,
  mode-conditionally.
- Tests: `src/components/__tests__/horizontal-input.test.tsx` (new).

#### Deliverables

- [ ] Wheel remap with all four pass-through rules (horizontal-dominant, pinch, inner
      scroller, vertical mode inactive).
- [ ] Column paging keys; existing block bindings untouched (Space/Enter keep composer
      semantics on blocks).
- [ ] Axis-aware `scrollIntoView` in every jump path (`n`/`p`, `[`/`]`, Home/End, minimap).
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Spec success criterion 6 (wheel) verified: unit tests assert handler dispatch logic
      (which events are consumed vs passed) in jsdom via synthetic events; scroll-effect
      verification rides the Phase 2 fixture harness. Build + suite pass; vertical-mode
      wheel/keyboard behavior byte-identical (no handler attached).

#### Test Plan

Unit (jsdom): wheel-handler decision table (deltaY-dominant / deltaX-dominant / ctrlKey /
target-inside-inner-scroller / vertical mode); paging-key routing incl. composer-focus
exemption; scrollIntoView option selection per mode (spy-based). Browser (fixture harness):
actual scrollLeft movement for wheel + paging + jumps.

### Phase 4: Fragment-aware "+" affordance placement

**Dependencies**: Phase 1 (Phase 2's harness used for verification)

#### Objective

Spec D2: the "+" appears in the column fragment under the pointer for fragmented prose —
pointer-side anchoring via `getClientRects()` flow-coordinate math — and the addendum's
cross-column travel bug is structurally impossible.

#### Files to Create / Modify

- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx` — `placeAffordance` becomes
  fragment-aware: resolve the pointer's fragment from `getClientRects()`, convert clientY to
  a flow-coordinate `top` (sum of preceding fragment heights + within-fragment offset,
  line-height quantization preserved), clamp against flow height (fragment-height sum, not
  the union box — fixing the existing `hostRect.height` clamp under fragmentation); keyboard
  path anchors to the block's first fragment (current `offsetTop` math verified row-relative
  in columns). Audit pass over remaining geometry readers (`lineHeightOf` callers,
  focus-restoration paths) for union-rect assumptions, per the spec's risk table.
- Tests: `src/components/__tests__/full-row-affordance.test.tsx` (extend) + fragment-math
  unit tests with injected rect data; fixture-harness assertions for real placement.

#### Deliverables

- [ ] Fragment-aware placement math, pure and unit-testable (rects in → flow top out).
- [ ] Flow-height clamping; vertical mode exercises the same code path with a single rect
      (degenerate case — no behavioral change, verified by the existing affordance suite).
- [ ] Geometry audit recorded in code comments where a vertical-only assumption was found.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Browser fixture: hovering a continuation fragment renders the "+" within that
      fragment's column band; hovering the first fragment keeps it there; keyboard focus
      lights the first fragment. Existing full-row-affordance suite passes unchanged. Build +
      suite pass.

#### Test Plan

Unit (jsdom): the flow-coordinate function against fabricated fragment-rect sets (single
rect, two columns, pointer in each fragment, clamp extremes). Browser: pointer-move across a
fragmented paragraph's two columns → affordance rect containment per column; composer opens
on the correct line from both fragments.

### Phase 5: Progress indicator, minimap suppression, accessibility chrome

**Dependencies**: Phase 1

#### Objective

Spec D3/D8 and Constraint 7: positional feedback and ARIA semantics for horizontal mode;
minimap cleanly absent.

#### Files to Create / Modify

- `packages/artifact-canvas/src/overlays/ReadingProgress.tsx` (new) — "column *k* of *n*"
  readout derived from scroll position/column geometry; hidden when content fits; doubles as
  the aria-live announcement (debounced — no per-tick spam).
- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx` — mount progress in
  horizontal mode only; suppress `MarkerMinimap` in horizontal mode; container
  `aria-roledescription` + resize-driven recompute (shares Phase 1's height observation).
- `packages/artifact-canvas/src/styles/default-theme.css` — progress chrome (tokens only).
- Tests: `src/overlays/__tests__/reading-progress.test.tsx` (new),
  `src/overlays/__tests__/marker-minimap.test.tsx` (extend: suppressed in horizontal).

#### Deliverables

- [ ] Progress readout + ARIA (roledescription, debounced aria-live), token-styled.
- [ ] Minimap absent in horizontal, unchanged in vertical.
- [ ] Resize/zoom recompute keeps readout and caps correct and re-anchors the viewport-start
      block (spec resize criterion, shared with D7 machinery).
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Spec success criteria for progress + resize verified (unit: computation from geometry
      inputs, hidden-when-fits, suppression logic; browser: readout tracks scrolling on the
      fixture). Build + suite pass.

#### Test Plan

Unit (jsdom): column-count/current-column computation from injected geometry; debounce;
hidden-when-fits; minimap suppression per mode; aria attributes present. Browser: scroll →
readout updates; window resize → column count changes and anchor block stays visible.

### Phase 6: Host wiring: VS Code webview + vite dev host, docs, demos

**Dependencies**: Phases 1–5

#### Objective

Spec Constraint 3's in-scope host work: a height context and per-user persistence in both v1
hosts; documentation; the running-flow demos for dev-approval.

#### Files to Create / Modify

- `apps/vscode/src/markdown-preview/preview-template.ts` — height context CSS (webview fills
  viewport; canvas gets the bounded height).
- `apps/vscode/src/markdown-preview/webview/main.ts` + `../messages.js` +
  `preview-provider.ts` — pass `initialReadingMode` from persisted state; forward
  `onReadingModeChange` to the host; persist per-user in extension `globalState`.
- `packages/artifact-canvas/examples/index.html` / `examples/main.tsx` — height context +
  `localStorage` persistence in the dev host.
- `packages/artifact-canvas/README.md` — modes, new props, new tokens, prose-max-width
  inertness, host integration notes (height context requirement + #1386 pointer).
- Tests: `apps/vscode` unit coverage for the persistence round-trip where the existing
  webview test seams allow; manual demo script for dev-approval.

#### Deliverables

- [ ] Both hosts: bounded height + per-user persistence wired through the D4 seam; no mode
      logic in hosts.
- [ ] Persistence robustness: corrupt stored value → vertical + working toggle (spec Test
      Scenario 15) covered at the host seam.
- [ ] README/docs updated.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Full review pass (read → comment → submit → edit → delete) demonstrated in horizontal
      mode, mouse-only and keyboard-only, in BOTH hosts (spec success criteria; testing-guide
      UI verification at dev-approval); preference survives a host restart in both; fresh
      profile defaults vertical. Build + full suite + fixture pass.

#### Test Plan

Manual/scripted at dev-approval per testing guide: vite dev host in a browser and the VS Code
webview — toggle, reflow, full review pass, restart persistence, resize, wheel/trackpad,
light + dark. Unit: globalState round-trip + garbage-value coercion at the host boundary.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Percentage/derived heights don't resolve inside the multicol context, breaking the caps | Medium | High | Phase 1 establishes `--codev-canvas-column-height` (px, JS-observed) as the single height source; Phase 2's fixture asserts cap behavior early |
| Playwright harness wiring for a workspace package is novel here | Medium | Medium | Reuse the workspace's existing Playwright dependency and testing-guide patterns; harness lands in Phase 2, early enough to unblock 3–5's browser assertions |
| Fragment-math edge cases (zero-height rects, single-line fragments, zoom) | Medium | Medium | Pure function + fabricated-rect unit table (Phase 4); browser fixture covers real geometry |
| Wheel yield-detection walks the wrong chain (portals, injected DOM) | Low | Medium | Decision-table unit tests enumerate target shapes (code, table, textarea, card, plain prose); browser check rides the fixture |
| VS Code webview persistence seam grows ad-hoc message types | Low | Low | Extend the existing typed `HostToWebviewMessage`/`WebviewToHostMessage` unions; no new channel |
| Mid-flight canvas changes on main (single-lane risk) | Low | Medium | Rebase at each phase boundary; phases are small atomic commits, conflicts stay local |

## Documentation Updates

- `packages/artifact-canvas/README.md` — reading modes, new props (`initialReadingMode`,
  `onReadingModeChange`), new tokens (`--codev-canvas-column-width`, `--codev-canvas-column-gap`,
  `--codev-canvas-column-height` as the derived height variable), prose-max-width inertness in
  horizontal mode, host height-context requirement, #1386 as the afx-open delivery path.
- `default-theme.css` docblock — token vocabulary additions (the file is its own contract doc).
- Review-phase (not this plan): arch/lessons routing per the two-tier governance model.
