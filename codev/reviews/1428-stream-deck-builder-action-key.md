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

**Owner ruling (Amr, 2026-08-12):** no cross-app import and no shared vocabulary module — the
goal is to *replicate the behaviour*, not to share the source. The small maps are deliberately
duplicated and kept aligned by sync-note comments (the same pattern already used between
`overview.ts` and `builder-row.ts` for `GATE_LABELS`). This is a fine, intended pattern here, not
single-source-of-truth debt.

Context: a shared-home module was raised as a candidate by `main`/the architect for the humans to
weigh; the owner weighed it and **declined** — recorded here so the decision isn't re-litigated.
No action.

## Lessons (seed)

- **`verify-approval` press-path gap → filed as #1431 (BUGFIX, sequenced after this merge).**
  Investigating the VS Code sidebar's gate map surfaced that `apps/vscode/src/views/builder-row.ts`
  handles a `verify-approval` gate that the Stream Deck's press resolver
  `phaseArtifactVerb` (`apps/streamdeck/src/actions.ts:229-239`) does not. #1428 renders
  `verify-approval` on the *face* (label + `verified` icon) but leaves the *press* path untouched
  (out of scope: press/rotate is a hard boundary). The press gap is #1431. Lesson: cross-checking a
  sibling surface (the sidebar) against the one you're changing catches vocabulary drift that
  single-surface work misses.
