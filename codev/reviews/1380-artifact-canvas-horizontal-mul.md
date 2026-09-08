# Review: Horizontal Multi-Column Reading Mode for the Artifact Canvas

## Summary

Built the opt-in horizontal multi-column reading mode for `@cluesmith/codev-artifact-canvas`
across six plan phases (mode core → fragmentation protection + browser fixture → input
semantics → fragment-aware affordance → progress/a11y → host wiring), plus the root fix for
#1396 (fence rows carry `data-line` on the `pre`). Net outcome: the full review workflow
works in both modes in both v1 hosts, guarded by 146 jsdom + 31 real-browser + 751 VS Code
tests, with vertical mode's only change being the deliberate #1396 fence-row fix.

## Spec Compliance

- [x] AC1: Long mixed document reflows with no clipped/unreachable content — Phase 2
      (reachability sweep over a 1109-line fixture; caps guarantee no vertical overflow).
- [x] AC2: Toggling back restores vertical exactly; existing tests pass unchanged — Phase 1
      (body/rows carry no new attributes in vertical; full suite green throughout).
- [x] AC3: Complete review pass mouse-only AND keyboard-only in horizontal — Phases 2/3/6
      (browser review-pass test drives add → edit → delete; keyboard flow unit + browser
      tests; the interactive dual-host pass is demonstrated at dev-approval).
- [x] AC4: No protected block type straddles a column boundary — Phase 2 (single-rect
      assertions incl. nested pre/table).
- [x] AC5: Over-tall code fully readable via inner scroll, row fits one column — Phase 2.
- [x] AC6: Wheel remap with pass-through rules; vertical wheel untouched — Phase 3
      (native non-passive listener; no-residual-vertical-scroll browser assertion).
- [x] AC7: Preference persists per-user; garbage coerced to vertical; failure degrades —
      Phases 1/6 (coercion in the package; globalState/localStorage in hosts; round-trip
      tests both sides; restart persistence demonstrated at dev-approval).
- [x] AC8: Resize/zoom recomputes geometry/caps/readout and keeps the viewport-start block —
      Phase 5 (browser resize test).
- [x] AC9: Unbounded embed self-bounds to viewport height — Phases 1/2 (CSS max-height
      chain; `?height=unbounded` fixture assertion).
- [x] AC10: Mode switch lands the reader in the same section — Phase 1 (D7 anchoring,
      axis-aware restore, nearest-preceding fallback).
- [x] AC11: Progress indication visible and accessibly announced — Phase 5 (chip +
      debounced aria-live; formula-independent browser assertions).
- [x] AC12: Token compliance, light + dark — Phases 1/2/5 (token-vocabulary snapshot,
      scoping guard, dark-override browser smoke).
- [x] AC13: Demonstrated running in both hosts — Phase 6 wiring complete; the interactive
      demos happen at the dev-approval gate per the testing guide (the code path for every
      demo item is test-covered).

## Deviations from Plan

- **Phase 2**: protection selectors are *descendant*, not the plan's "top-level rows" — a
  consult-verified spec correction (nested fences/tables in real artifacts were left
  fragmenting + overflowing). The fixture also grew past the plan's sketch to the spec's
  ≥1000-line scale.
- **Phase 3**: container-level paging reachability was consciously deferred to Phase 5
  (where the focusable container landed), as recorded in the phase-3 consultation.
- **Phase 4**: took the renderer-route option for #1396 (data-line stamped on the fence
  `pre`) rather than selector alignment — the architect offered both; the renderer fix is
  root-cause and makes fences match `code_block`. Pure fragment math landed in a new
  `fragment-geometry.test.ts` rather than extending `full-row-affordance.test.tsx`
  (equivalent coverage, noted by consultation as acceptable). This intentionally changes
  vertical fences: they gain the row model (gutter padding, position context) and become two
  tab stops (pre row + code scroller) — called out in the PR body.
- **Phase 5**: the recompute-staleness fix grew beyond the plan (memoized layout key plus a
  capture-phase image-`load` listener discovered via a parallel-run flake).
- **Phase 6**: the dev host needed stub-level edit/delete (markerLine + verified writes) to
  satisfy the full-review-pass criterion — the plan's file list hadn't enumerated it. The
  stub parser also gained comment-stacking (consecutive REVIEW lines annotate the preceding
  content block), a shared-fixture behavior change flagged here deliberately.

## Consultation Feedback

Porch ran 2-way consultations (Claude + Codex; Gemini not in this lane) on the spec, the
plan, and every phase — 15 rounds total. No `CONSULT_ERROR` occurred. Full transcripts and
per-round rebuttal files live in `codev/projects/1380-artifact-canvas-horizontal-mul/`.

### Specify (Round 1) — Codex REQUEST_CHANGES, Claude COMMENT

- **Codex**: over-tall marker cards; MarkdownView scope; wheel-over-inner-scrollers;
  resize/zoom; persistence validation → **Addressed** (all folded into the spec).
- **Claude**: bounded-height assumption false in both hosts (host wiring scoped into v1);
  prose-max-width collides with the multicol container (declared inert); keyboard paging
  undefined; cross-column selection; persisted-value coercion; spike → committed fixture →
  **Addressed** (all).

### Plan (Round 1) — Codex REQUEST_CHANGES, Claude COMMENT

- **Codex**: measured column geometry (token is a preferred minimum); VS Code bootstrap
  lifecycle; native non-passive wheel; Playwright CI wiring; path/dependency fixes; Phase 1
  DOM-identity criterion; scenario homes → **Addressed** (all).
- **Claude**: same two blockers plus `Memento` plumbing, message-shape decision, mode-class
  placement, `offsetTop` premise downgrade → **Addressed** (all).

### Phase 1 (Round 1) — Codex APPROVE, Claude COMMENT

- **Claude**: toggle last tab stop → **Addressed** (moved before the body); CSS scoping
  unguarded → **Addressed** (regex guards); self-bounding engine behavior → **Addressed**
  (Phase 2 fixture assertion); toggle-over-prose note → **N/A** (verified at demo); style
  nits (ternaries, createElement icon) → **Addressed**.

### Phase 2 (Rounds 1–2) — R1 both REQUEST_CHANGES; R2 both APPROVE

- **Claude R1**: nested `pre`/`table` unprotected (child combinators) → **Addressed**
  (descendant selectors + nested fixtures/tests); light/dark smoke → **Addressed**;
  Playwright files outside `check-types` → **Addressed**; hardcoded cap offsets →
  **Rebutted** (they mirror untokenized chrome; linking comments retained); stub-stacking
  callout → **Addressed** (PR body).
- **Codex R1**: fixture scale/reachability → **Addressed** (1109 lines + sweep); images in
  `break-inside` → **Addressed** in letter (rebutted in substance: replaced elements are
  monolithic); composer/stack/dark scenarios → **Addressed**.
- **Claude R2 carry-forward**: card-body scroller focusability → **Addressed** in Phase 3.

### Phase 3 (Round 1) — Codex APPROVE, Claude COMMENT

- **Claude**: paging reachable only from blocks → **Addressed** in Phase 5 (deliberate
  deferral, then closed by the focusable container); `preventDefault` before the step guard
  → **Addressed**; clamp order → **Addressed**; 16px/line factor → **Rebutted** (documented
  Chromium-only convention); missing legend/minimap tests → **Addressed**.

### Phase 4 (Round 1) — both APPROVE

- **Claude** (polish): stale CSS comment → **Addressed**; nested×fragmented-host regression
  lock → **Addressed**; vertical fence-change callout → **Addressed** (PR body + demo item);
  `replace('<pre')` guard → **Addressed**; thread log → **Addressed**.

### Phase 5 (Rounds 1–2) — R1 Codex REQUEST_CHANGES / Claude APPROVE; R2 both APPROVE

- **Codex R1**: progress staleness on card/composer layout changes → **Addressed**
  (memoized layout key; a fourth trigger — async image load — surfaced and covered too).
- **Claude R1**: narrow-first-child geometry skew → **Addressed** (max-over-sample);
  formula-mirroring tests → **Addressed** (main test formula-independent; two freshness
  mirrors retained deliberately, rationale inline); resize-readout assertion → **Addressed**;
  per-tick re-render → **Addressed**; paging yield rule → **Addressed**.

### Phase 6 (Rounds 1–3) — R1 both REQUEST_CHANGES; R2 Claude APPROVE / Codex
REQUEST_CHANGES; R3 both APPROVE

- **Claude R1**: README paragraph inserted mid-table → **Addressed**; persistence
  round-trip untested → **Addressed** (end-to-end through `resolveCustomTextEditor`);
  thread log → **Addressed**; `examples/` outside tsconfig → **N/A** (pre-existing, noted
  as follow-up).
- **Codex R1**: dev-host mode state "violates no-mode-logic-in-hosts" → **Rebutted**
  (Constraint 3 assigns hosts the height context; this host's height context is
  mode-dependent because its vertical chrome is a centered well; no mode semantics leave the
  package — reasoning recorded in a code comment).
- **Codex R2**: dev host couldn't complete the review pass (no `markerLine`, no edit/delete
  wiring) → **Addressed** (stub identity + verified-write helpers + full-pass browser test).

## Lessons Learned

### What Went Well

- The spec-phase spike converted four hard unknowns into evidence before design lock, and
  its findings became a committed regression fixture that caught a real pre-existing defect
  (#1396) before the feature it guards existed.
- The consultation loop was consistently load-bearing: 15 rounds produced ~40 accepted
  findings, several of them genuine blockers (nested-block protection, webview bootstrap
  lifecycle, progress staleness, the dev-host review-pass gap).
- Building the mechanism inside-out (CSS core before input before chrome before hosts) let
  every later phase ride the phase-2 browser harness.

### Challenges Encountered

- jsdom's inability to express layout shaped the whole test strategy; the browser fixture
  had to land early, and unit tests fabricate rects/geometry via injected shims.
- Silent `scrollWidth` movers (injected cards, composer, async image loads) made the
  progress readout's freshness the subtlest correctness problem of the project — found via
  a parallel-run flake, not by review.
- The issue's premise about hosts was wrong (only the VS Code webview hosts the canvas);
  correcting it early (architect ruling A, #1386 filed) kept scope sane.

### What Would Be Done Differently

- Write the browser fixture in the same commit as any new layout CSS, not after it — the
  one phase where CSS landed a step ahead of its fixture (phase 2 iter 1) is exactly where
  the nested-block hole survived to review.
- Treat "which element actually carries the attribute" as a verification item for every
  renderer-emitted structure up front; the `pre[data-line]` assumption had been wrong since
  #1343 and nothing structural would have caught it without the fixture.

### Methodology Improvements

- A porch convention for "fix committed before the fix-iteration was spawned" would avoid
  the empty extra `porch done` round-trip that occurred twice.
- Consultation reviewers repeatedly asked for the builder thread log to be current —
  updating it at every `porch done` (not phase boundaries) would be a cheap protocol norm.

## Architecture Updates

- Routed: **cold** — `codev/resources/arch.md` (VS Code Extension section) — new entry
  documenting the reading-mode architecture: package-owned mode semantics with host-owned
  persistence, the bootstrap-attribute seam (canvas mounts before the first webview
  message), the height-context contract, and the #1396 fence-row invariant (`data-line` on
  the `pre`, `tabindex` retained on the `code` scroller).
- No **hot** routing: the mode is canvas-scoped, not cross-cutting; nothing here changes how
  a future builder must behave repo-wide, and the hot cap is better spent on what is already
  there.

## Lessons Learned Updates

- Routed: **cold** — `lessons-learned.md` § Testing — jsdom cannot express CSS layout;
  commit a real-browser fixture alongside the first layout-dependent CSS, and let it assert
  invariants (rect counts, reachability), not implementation formulas.
- Routed: **cold** — `lessons-learned.md` § UI/UX — Chromium does not honor
  `break-inside: avoid` for a block taller than the fragmentainer (it fragments AND
  overflows); any protected-block design needs height caps so that fallback is never
  entered, and `scrollWidth` can move without scroll/resize/content events (injected DOM,
  async media) — freshness needs explicit triggers.
- No **hot** routing: both lessons are situation-specific (layout testing, CSS
  fragmentation), not the always-on kind; the hot tier's existing "verify the real user
  path" already carries the general form.

## Flaky Tests

No pre-existing flaky tests encountered or skipped. (Two transient failures during
development were defects in this project's own new tests — a mid-table README break was
unrelated; the flakes were an async-image-load staleness gap and a subpixel-width equality —
both fixed in-code, not skipped.)

## Follow-up Items

- **#1386** — `afx open` (templates/open.html) adopts the canvas; it inherits horizontal
  mode then (architect-owned issue; delivery path for browser-annotator parity).
- Horizontal minimap re-orientation, if reviewers miss the dot rail in horizontal mode
  (spec D3 suppressed it for v1).
- `packages/artifact-canvas/examples/` is outside the package tsconfig (pre-existing;
  Playwright exercises it, but typechecking it would be cheap hygiene).
- Gecko/WebKit fragmentation parity if a non-Chromium host ever appears (spec assumption).
