# phase_1 iter2 rebuttals

Gemini: skipped (agy produced no output; non-blocking). Claude: APPROVE. Codex: REQUEST_CHANGES.

## Codex
- Whitespace could hide a leftover marker from the validator: ACCEPTED. `isStarterMarker` now tests the trimmed line. Regression tests cover a padded `_No … yet._` and an indented slot line. The classifier is unaffected: its verbatim-subset rule still classifies a padded line as curated, which is the conservative direction, and the validator now catches the marker in a draft regardless.

## Claude (non-blocking, acted on)
- (a) An empty starter set made everything curated: `knownStarterTexts` now throws when the current starter is missing; tested.
- (b) Only ` — ` was a map separator: en dash ` – ` and hyphen ` - ` are now accepted too (the earliest one wins); tested. Phase 2's prompt will still prescribe the em dash.
- (e) Unreadable directories in the non-git walk are skipped instead of throwing.
- (c) Loose `Critical`/`Map` prefix lookup and (d) deletion-only starters classifying as placeholder: left as is. (c) matches the shipped hot-tier test's semantics. (d) is the spec's predicate (a subset of the starter, with a marker present).
