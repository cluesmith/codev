# PIR Review: Stream Deck composite, state-coded key faces

Fixes #1428

## Summary

The Builder Action key rendered by stacking a `setTitle` over a full-bleed bolt PNG, so text
landed on the icon's diagonal (`#1414` even read as `#1,414` where the bolt edge bled between
digits), casing came raw off the wire, and long phase names clipped. This PR composes the **whole**
key face in-plugin as one SVG handed to `setImage` — an icon zone up top, a reserved text band
below — and adds a plugin-local presentation vocabulary that mirrors the VS Code Builders sidebar's
two axes: **colour = state** (blocked yellow / active green) and **icon = gate**
(book / checklist / code / pull-request / verified, bolt otherwise), with short deliberate labels.
The same composite treatment was applied to the **Gates key** (`ApproveGate`), which had the
identical text-over-icon overlap. Presentation is entirely plugin-local — no wire, types, or server
change — and press/rotate behaviour is untouched.

## Files Changed

vs merge-base `84407b8`:

- `apps/streamdeck/src/face.ts` (+232 / -0) — new pure module: state classification, state→colour
  palette, gate→icon map + in-plugin glyphs, label maps, `faceForBuilder`, `builderFaceSvg`,
  `gatesFaceSvg`, `svgToDataUri`.
- `apps/streamdeck/src/actions.ts` (+12 / -3) — `BuilderAction.renderTo` and `ApproveGate.renderTo`
  switch from `setTitle` overlays to composite `setImage` SVG data URIs.
- `apps/streamdeck/src/__tests__/face.test.ts` (+122 / -0) — new unit tests for the pure module.
- `apps/streamdeck/src/__tests__/actions.test.ts` (+43 / -15) — render assertions updated to decode
  the data-URI face; Gates-face and empty-slot coverage added.
- `codev/resources/lessons-learned.md` (+2 lessons) — see Lessons Learned Updates.
- Plan / review / thread under `codev/`.

## Commits

- `c4f4f1488` [PIR #1428] Composite state-coded key face: render Builder Action via setImage SVG
- `c0d7c1a5a` [PIR #1428] Tests: face.ts unit tests + BuilderAction setImage assertions
- `b64a7c546` [PIR #1428] Fix setImage: base64 svg+xml data URI + intrinsic width/height (raw SVG dropped by Stream Deck)
- `4d7170202` [PIR #1428] Apply composite face to the Gates key (same text-over-icon fix)
- `62290be9e` / `b0143c533` / `a6040a901` [PIR #1428] Review seed + owner-ruling + hardware lesson
- (plus thread + porch phase-transition commits)

## Test Results

- `pnpm --filter @cluesmith/codev-streamdeck check-types`: ✓ pass
- `pnpm --filter @cluesmith/codev-streamdeck build` (esbuild): ✓ pass
- `pnpm --filter @cluesmith/codev-streamdeck test`: ✓ pass (108 tests, ~27 new)
- **Manual (hardware, dev-approval gate, Amr):** photo-level check on the physical deck across
  states — Builder Action keys (active phase, blocked gates, empty slot) and the Gates key
  (pending badge count vs no-gates). The **first** hardware pass exposed that raw SVG didn't render
  (see Lessons); after the data-URI + intrinsic-size fix, faces render and read cleanly, and the
  Gates key was re-checked in the same session. Approved.

## Architecture Updates

No arch-doc change qualifies. This is plugin-internal rendering: it adds one module
(`apps/streamdeck/src/face.ts`) but changes no module boundary, invariant, port, state, or wire
contract (`arch-critical.md`'s system-shape facts are untouched, and the streamdeck entry in
`arch.md`'s Monorepo Structure still describes the plugin accurately). The reusable knowledge from
this PR is an API-gotcha recipe and a duplication-pattern ruling — both routed to lessons, the
correct tier, below.

## Lessons Learned Updates

Two COLD entries added to `codev/resources/lessons-learned.md` (both spec-narrow recipes/rulings,
not behavior-changing cross-cutting rules, so neither belongs in the capped HOT tier):

- **UI/UX** — Stream Deck `setImage` silently drops a raw `<svg>` on-device; it needs a base64
  `data:image/svg+xml` data URI **and** an intrinsic `width`/`height`. Build/typecheck/tests were
  green; only the hardware gate caught it — the defect class PIR's device gate exists for.
- **Architecture** — twinned per-app *presentation* maps with sync-note comments are an accepted
  pattern (owner-ruled), not a violation of the "consolidate duplicates" lesson; that lesson
  targets stateful/behavioural duplication, not independent look-replication across a boundary the
  architecture deliberately keeps un-crossed (`face.ts` ↔ `builder-row.ts`).

## Twinned presentation vocabulary — accepted pattern (owner ruling)

The deck reproduces the VS Code sidebar's visual language (state colours + gate icons)
independently; it does **not** import from the vscode app. `apps/streamdeck/src/face.ts` carries its
own `STATE_COLOR` (inlined hexes mirroring the sidebar's `ThemeColor` tokens) and `GATE_ICONS` +
in-plugin glyphs, twinned with `apps/vscode/src/views/builder-row.ts` and kept aligned by
sync-note comments. **Owner ruling (Amr):** this is the intended design — no cross-app import, no
shared vocabulary module — recorded so it isn't re-litigated. The lane owner ruled the Gates-key
extension **rides in this PR** (same root cause, shares the `face.ts` frame; the bug class ends
there — `action`/`dev-server` are icon-only and the dials use `setFeedback`).

## 3-Way Consultation Dispositions (review phase, single pass)

- **Codex — REQUEST_CHANGES (HIGH), fixed.** `stateLabel` let a *mapped phase* win over an
  *unmapped gate*, so a builder blocked at a future/unknown gate would show its phase label while
  the face was already yellow + bell (blocked) — masking the pending gate. Real defect in the
  documented "gate beats phase" fallback. **Fix:** any non-empty `blockedGate` now wins (mapped
  label, else its first token title-cased, e.g. `security-approval` → `Security`); phase only when
  there is no gate. **Regression test:** `face.test.ts` "an unmapped gate STILL wins over a known
  phase". PIR is single-pass — this fix was **not** independently re-reviewed; please sanity-check
  it at the `pr` gate.
- **Gemini — APPROVE.** No issues.
- **Claude — APPROVE**, with four non-blocking notes, all addressed: stale module-doc comment in
  `actions.ts` (updated); long builder-id / unmapped-label could overflow the 72px face (added
  `textLength`/`lengthAdjust` shrink-to-fit via `fit()`, with a test); the plan still said "only
  `BuilderAction.renderTo` changes" (added a post-approval scope addendum to the plan); a ternary
  in `renderTo` against the project's no-ternary preference (converted to if/else, and the
  `faceForBuilder` ternaries too).

## Things to Look At During PR Review

- **`svgToDataUri` + intrinsic `width`/`height`** (`face.ts`) — the load-bearing hardware fix. A raw
  `<svg>` string is silently dropped by Stream Deck 6.9 despite the SDK d.ts's "SVG string" claim.
- **`face.ts` glyphs are hand-drawn in the codicon idiom**, not the codicon font (not vendored →
  keeps the bundle dependency-free). Legibility at the deck's upscaled size was the hardware check.
- **Twinned maps** (`STATE_COLOR` / `GATE_ICONS` / labels) vs `builder-row.ts` — intentional
  duplication with sync-notes, per the owner ruling above; not a consolidation candidate.
- **`verify-approval`** renders on the face but the press resolver `phaseArtifactVerb` doesn't
  handle it — a pre-existing gap filed as **#1431** (BUGFIX, sequenced after this merge), out of
  scope here (press/rotate untouched).

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1428` → **Review Diff**.
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1428`, then load the plugin on a deck.
- **What to verify** (maps to the plan's Test Plan):
  - Builder Action — active (green bolt, `#NNNN`, phase label, no comma, no collision), each blocked
    gate (yellow, distinct glyph), empty slot (`Slot N`).
  - Gates key — pending count in warning-yellow vs dim `Gates` when none pending.
  - Press/rotate still fire the same verbs (regression on the untouched path).
  - Pre-flight if a face won't render: confirm no profile-pinned custom image on the key.

## Lessons (detail for this PR)

- **`verify-approval` press-path gap → #1431.** Cross-checking the VS Code sidebar's gate map
  against the Stream Deck press resolver surfaced that `builder-row.ts` handles a `verify-approval`
  gate `phaseArtifactVerb` doesn't. #1428 renders it on the face; the press gap is #1431. Lesson:
  cross-checking a sibling surface catches vocabulary drift single-surface work misses.
