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

**Plan review — APPROVED WITH TWO ADDITIONS (folded in, commit below):**
1. **Ordering:** `architects()` is `main`-first then alphabetical, twinning
   `sortArchitectsForPicker` (`apps/vscode/src/views/architect-display.ts:31`) with a sync-note.
   Load-bearing because keys are positional — pins `main` to key 1 permanently.
2. **Null-attribution superset test:** a `null`-`spawnedByArchitect` builder must (a) show in
   the unscoped list, (b) be reachable under no scope, (c) be restored on clear — keeps #1406 a
   display bug, not a reachability bug.

Also folded the real fleet into the dev-approval demo: four architects own builders (main,
security, vscode, streamdeck); reviewer + demos own none and must NOT appear — demonstrating
that absence is the derive-from-builders decision made visible.

Architect endorsed keeping scope-through-`builders()` and the id-preserving selection as
written, and the `PlacedKeys` extraction over a copy. Gate now goes to Amr.
