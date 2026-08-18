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
written, and the `PlacedKeys` extraction over a copy.

## MAJOR REFRAME (owner decision, Amr, 2026-08-18) — scope model DROPPED

Amr (issue author/owner) reversed the "scope, not a mode" framing in the interactive session:
**no filtering of builders at all.** The feature is two independent boards + a native switch:

- **Builders board** — full fleet, unchanged.
- **Architects board** — self-ordering Architect Action keys (reuse #1465), one per architect;
  press opens that architect's terminal (`open-architect-terminal`, reusing #1463's verb).
- **Switch** — a NATIVE Stream Deck key (Switch Profile, recommended two-profile symmetric, or
  a Folder) carrying a CUSTOM Codev-styled icon we ship (new `switch` glyph). Stream Deck does
  the flip; no plugin switch code. Plugin-driven `switchToProfile` stays deferred (#1381/#1440).

Consequences vs the approved plan:
- `scopedArchitect`, `builders()` filtering, selection preservation → all GONE.
- Store gains ONLY `architects()` (distinct non-null spawnedByArchitect, main-first then
  alphabetical, twinning `sortArchitectsForPicker`).
- Ruling 3 ("no summoning") intentionally lifted — the key opens the terminal.
- Rulings 1 & 2 (scope reset / empty-scope) no longer apply.
- The null-attribution superset test is moot (builders board never filtered) — dropped
  deliberately, noted in the plan so the architect sees why.
- Still reuse #1465: extract `PlacedKeys` base from `SlotKey`; `ArchitectAction` extends it.

Rewrote the plan to this shape (commit below). This reverses the plan the architect (main)
approved on the scope model — flagging to main; Amr's word governs. Gate stays pending Amr.
