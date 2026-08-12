# PIR Review: Stream Deck Builder Action composite, state-coded key face

> **Status: seeded during the plan phase.** This file currently holds only the forward-looking
> notes the architect asked to record before the plan-approval gate. The full review (what was
> built, what was learned at the hardware gate, CMAP outcomes) is written in the review phase.

## Decision: twinned presentation vocabulary is intentional replication (not shared code)

The deck reproduces the VS Code sidebar's visual language — state colours + gate icons —
**independently**. It does not import from the vscode app and is not meant to.

- `apps/streamdeck/src/face.ts` — `STATE_COLOR` (state → hex), `GATE_ICONS` (gate → glyph),
  `GATE_LABELS` / `PHASE_LABELS`. Self-contained: inlined hexes (a static SVG can't bind VS Code
  `ThemeColor` tokens) and its own transcribed codicon paths.
- `apps/vscode/src/views/builder-row.ts` — the sidebar's `BUILDER_STATE_GLYPH` / `gateIconFor`.

**Owner ruling (Amr, 2026-08-12) — this is an ACCEPTED PATTERN, not tech debt.** Twinned per-app
presentation maps kept aligned by sync-note comments (the same pattern already used between
`overview.ts` and `builder-row.ts` for `GATE_LABELS`) are the intended design here: no cross-app
import, no shared vocabulary module. The goal is to *replicate the behaviour*, not to share the
source. It is explicitly **not** a single-source-of-truth violation and needs no shared home.

Context: a shared-home module was raised as a candidate by `main`/the architect for the humans to
weigh; the owner weighed it and **ruled** the twinned pattern accepted — recorded here as the
settled decision so it isn't re-litigated or re-proposed as a consolidation follow-up. No action.

## Lessons (seed)

- **Stream Deck `setImage`: the SDK's "SVG string" claim does not survive contact with the device.**
  `@elgato/streamdeck@2.1.0`'s `key.d.ts` documents that `setImage` accepts *"an SVG string"*, and
  the SDK forwards it verbatim (`key.js:51-59`). On real hardware (Stream Deck 6.9) a raw `<svg>`
  string is **silently dropped** — the key reverts to its manifest PNG with no error. Two things are
  required and neither is in the type doc: (1) encode as a base64 **`data:image/svg+xml`** data URI
  (the SDK's separately-documented "base64 encoded string with the mime type declared" form), and
  (2) give the root `<svg>` an **intrinsic `width`/`height`**, not just a `viewBox`, or the
  rasterizer drops the sizeless image. Diagnosis was fast because `setTitle('')` had visibly taken
  effect (text gone) while the face stayed on the PNG — isolating the failure to the image layer,
  not a pinned custom image. This is exactly the class of defect the PIR hardware gate exists to
  catch: build + typecheck + unit tests were all green, but "it renders" was only true on the
  device. Reusable for anyone touching `setImage` (`svgToDataUri` + `width`/`height` in `face.ts`).
- **Twinned per-app presentation maps with sync-notes are an accepted pattern, not SSOT debt
  (owner-ruled).** When two apps must present the same vocabulary but can't/shouldn't cross-import
  (e.g. a static SVG can't bind VS Code `ThemeColor` tokens), duplicating the small maps with a
  sync-note comment naming the counterpart is the intended design — don't reflexively flag it as a
  single-source-of-truth violation or propose a shared home. Candidate for the lessons doc at
  review time.
- **`verify-approval` press-path gap → filed as #1431 (BUGFIX, sequenced after this merge).**
  Investigating the VS Code sidebar's gate map surfaced that `apps/vscode/src/views/builder-row.ts`
  handles a `verify-approval` gate that the Stream Deck's press resolver
  `phaseArtifactVerb` (`apps/streamdeck/src/actions.ts:229-239`) does not. #1428 renders
  `verify-approval` on the *face* (label + `verified` icon) but leaves the *press* path untouched
  (out of scope: press/rotate is a hard boundary). The press gap is #1431. Lesson: cross-checking a
  sibling surface (the sidebar) against the one you're changing catches vocabulary drift that
  single-surface work misses.
