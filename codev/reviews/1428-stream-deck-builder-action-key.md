# PIR Review: Stream Deck Builder Action composite, state-coded key face

> **Status: seeded during the plan phase.** This file currently holds only the forward-looking
> notes the architect asked to record before the plan-approval gate. The full review (what was
> built, what was learned at the hardware gate, CMAP outcomes) is written in the review phase.

## Follow-up candidates (recorded for humans to weigh — not implemented here)

### Twinned presentation vocabulary: `face.ts` ↔ `builder-row.ts` wants a shared home

This project deliberately **duplicates** the builder presentation vocabulary across two apps:

- `apps/streamdeck/src/face.ts` — `STATE_COLOR` (state → hex), `GATE_ICONS` (gate → glyph),
  `GATE_LABELS` / `PHASE_LABELS`.
- `apps/vscode/src/views/builder-row.ts` — `BUILDER_STATE_GLYPH` (state → codicon + ThemeColor),
  `gateIconFor` (gate → codicon), and the sidebar's label vocabulary.

The duplication is **forced by the current architecture**: the two apps can't import each other,
so the streamdeck twin carries inlined hexes (a static SVG can't bind VS Code `ThemeColor`
tokens) and its own transcribed codicon paths, kept in sync only by comments.

This sits in direct tension with our **single-source-of-truth** lesson (consolidate duplicates
rather than syncing them). It is flagged as a **candidate** for a shared home — e.g. a
neutral, environment-agnostic vocabulary module (gate/phase ids → semantic label + icon *name* +
semantic colour *role*), consumed by both apps, with each app binding the semantic roles to its
own render primitives (ThemeColor tokens in vscode, inlined hexes + codicon paths on the deck).

**Not in scope for #1428** (it would touch shared packages and the vscode app; #1428 is
plugin-local by requirement). Co-flagged by `main`. Recorded here for the humans to decide
whether/when to spin it out. Do not implement as part of this PR.

## Lessons (seed)

- **`verify-approval` press-path gap → filed as #1431 (BUGFIX, sequenced after this merge).**
  Investigating the VS Code sidebar's gate map surfaced that `apps/vscode/src/views/builder-row.ts`
  handles a `verify-approval` gate that the Stream Deck's press resolver
  `phaseArtifactVerb` (`apps/streamdeck/src/actions.ts:229-239`) does not. #1428 renders
  `verify-approval` on the *face* (label + `verified` icon) but leaves the *press* path untouched
  (out of scope: press/rotate is a hard boundary). The press gap is #1431. Lesson: cross-checking a
  sibling surface (the sidebar) against the one you're changing catches vocabulary drift that
  single-surface work misses.
