# Builder thread — pir-1495

**Issue:** #1495 — Stream Deck: Architect Action key (scope the fleet to one architect's builders)
**Protocol:** PIR (plan-approval + dev-approval gates before PR)

## Plan phase (done, awaiting plan-approval)

Wrote `codev/plans/1495-stream-deck-architect-action-k.md`.

Key design decisions, all confirmed against the code:

- **Scope, not a mode.** The selection is always a builder. Scope only narrows *which builders
  are listed/navigable*. Row 2 + dials keep acting on the selected builder.
- **Store carries the scope.** `builders()` becomes scope-aware (filters `allBuilders()` by
  `spawnedByArchitect`); every existing consumer (Row 1 window, selection, cursor bounds, zoom
  dial) narrows for free because they already read through `builders()`. New: `allBuilders()`,
  `architects()` (distinct non-null `spawnedByArchitect`, sorted), `toggleArchitectScope()`.
- **Selection preserved by id across a scope toggle** (falls back to 0) so the dials keep
  reviewing the same builder — matches the issue's language.
- **Reuse #1465, don't reimplement.** Extract the positional-ordering core out of `SlotKey`
  into a shared `PlacedKeys` base; `SlotKey` and the new `ArchitectAction` both extend it. The
  #1465 tests are the regression guard for the extraction.
- **Derive architects from builders, never `OverviewData.architects`** (architect scoping
  instruction + #1463 rationale).
- Ruling 1 (reset on workspace switch): clear scope in the 3 store workspace-change paths.
  Ruling 2 (empty scope visibly empty): falls out of scoped `builders()` returning `[]`; do NOT
  auto-clear. Ruling 3 (no summoning): press relays no command, deck-local state only.
- New manifest action + icon (`architect-action`, rendered from the existing `architect` glyph
  via `scripts/render-action-icons.mjs` — needs librsvg + imagemagick).

**#1406** stated as impact only (mis-attributed → wrong scope; null → unreachable), NOT fixed.

**Dev-approval is hardware** and needs a board where ≥2 architects own builders — planned the
demo in the Test Plan; will flag if a two-architect board can't be stood up at review time.

Routed the plan to the architect before the gate (architect asked to review pre-gate).
