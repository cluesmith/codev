# air-1390 — Fold the Stream Deck plugin's design rationale in-tree

**Protocol:** AIR (strict). **Issue:** #1390. **Scope:** docs + a doc-invariant test.

## What the issue asked

`apps/streamdeck/README.md` deferred "architecture and design decisions" to the
pre-migration repository's `PLAN.md`, a live dependency on a repository whose
retirement is a tracked follow-up (gated on the sdk's first npm publish). Move the
still-relevant rationale in-tree; keep provenance in the History section only.

## Decisions

- **Home = README Design section** (architect's steer; issue left README-vs-arch.md
  to me). Co-located with the code, free of the COLD arch.md hot/cold tier discipline.
- **Reconstructed the rationale from what's in-tree** (the README, `store.ts` /
  `plugin.ts`, `codev/plans/1347-*`, `codev/reviews/1347-*`, arch.md's Spec 1410
  coherence section), not the external `PLAN.md` — did not assume I could read the
  pre-migration repo, and the architect confirmed I likely can't. Wrote the *why*
  behind the system as it actually ships: stateless controller, canonical-verb relay,
  one shared selection, keys-commit/dials-review hardware mapping, canvas-owns-composer
  state, and why silent gate approval is out of scope.
- **Naming:** scrubbed the external repo name/URL (`cluesmith/codev-integrations`,
  github.com link) and every `PLAN.md` mention from committed prose, per the standing
  "describe in codev's own terms" rule and the architect's naming instruction.
  Provenance survives in History described as "the pre-migration repository" (commit
  `77be3d0`, `packages/streamdeck`, #1347/#1189 kept as codev's own reference terms).

## Changes

- `apps/streamdeck/README.md`: new `## Design` section (the *why*); intro pointer now
  points at Design + History; Status/roadmap and History rewritten to drop the three
  `PLAN.md` references and the external repo name.
- `apps/streamdeck/src/__tests__/readme-design.test.ts` (new): pins the Design section,
  no `PLAN.md` deferral, no external repo name, provenance retained in History. Mirrors
  the existing `vendored-ui-lib.test.ts` doc-invariant pattern.

## Verification

`pnpm --filter @cluesmith/codev-sdk build && ...streamdeck check-types && ...test`:
check-types clean; 166/166 tests pass across 9 files (4 new).
