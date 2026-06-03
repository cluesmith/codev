# PIR Review: Collapse duplicate Overview*/*Overview types into a single source of truth

Fixes #875

## Summary

The `Overview*` dashboard-payload types were declared twice — as server-internal types in `packages/codev/src/agent-farm/servers/overview.ts` (`BuilderOverview`, `PROverview`, `BacklogItem`, `RecentlyClosedItem`, `OverviewData`, plus a local `PlanPhase`) and as wire contracts in `packages/types/src/api.ts` (`OverviewBuilder`, `OverviewPR`, …). Every field addition (e.g. #819's `area`) had to land in both, with no compiler check catching drift. This PR makes `@cluesmith/codev-types` the single source of truth: the server now imports the wire types and the six local declarations are deleted. A named `PlanPhase` interface moves into `api.ts` and replaces the previously-inlined `planPhases` shape, so both sides reference one declaration.

## Files Changed

Source (vs `merge-base`):

- `packages/codev/src/agent-farm/servers/overview.ts` (+15 / -159) — import 6 types from `@cluesmith/codev-types`; delete the 6 local interface blocks; rename server identifiers to the wire names
- `packages/types/src/api.ts` (+13 / -1) — add named `PlanPhase`; `OverviewBuilder.planPhases` → `PlanPhase[]`
- `packages/types/src/index.ts` (+1) — export `PlanPhase` from the barrel

Protocol artifacts also in the branch: `codev/plans/875-collapse-duplicate-overview-ov.md`, `codev/state/pir-875_thread.md`, and the porch `status.yaml`.

## Commits

- `9b5c911d` [PIR #875] Plan draft
- `48db6ec7` [PIR #875] Collapse duplicate Overview types into @cluesmith/codev-types
- `94357700` [PIR #875] Thread: full-suite verification notes

## Test Results

- `pnpm build`: ✓ pass (porch check: build 5.2s)
- `pnpm test` (overview suite): ✓ 150/150 (porch check: tests 20.5s)
- Full workspace `pnpm -r test`: core ✓ 17/17, codev ✓, types ✓ builds, vscode ✓ `check-types` + `compile`. One **pre-existing, unrelated** dashboard failure remains (see Flaky / Pre-existing below).
- Manual verification: human approved the running worktree at the `dev-approval` gate. Type-only change — no runtime surface; the `/api/overview` payload is byte-identical.

## Architecture Updates

No `arch.md` changes needed. This PR does not introduce or alter an architectural pattern — it *enforces* an already-documented one: `@cluesmith/codev-types` is wire-contracts-only, and the server should import those contracts rather than re-declare them. The change removes a violation-by-duplication of that existing principle; it does not establish a new boundary worth recording.

## Lessons Learned Updates

No `lessons-learned.md` edit. The code change itself is a mechanical consolidation with no novel engineering wisdom to encode. One genuinely non-obvious gotcha *was* observed during verification (the `exports` src-vs-dist resolution asymmetry below), but it is an environment/build-flow characteristic, not a lesson arising from this diff — and it has been escalated to the architect for a root-cause fix (worktree `postSpawn` install + whether the build flow should produce `types/dist`). Encoding it mid-investigation would be premature; if the architect decides it warrants a permanent note, that's a separate change.

## Things to Look At During PR Review

- **The build passing is the substantive correctness signal.** Pointing the server at the wire types means TypeScript now checks the emitted objects against the single wire contract. A green build proves the two formerly-duplicated declarations were structurally identical — no field divergence was hiding.
- **Naming.** Server identifiers were renamed to the wire names (`BuilderOverview` → `OverviewBuilder`, `PROverview` → `OverviewPR`, `BacklogItem` → `OverviewBacklogItem`, `RecentlyClosedItem` → `OverviewRecentlyClosed`) rather than kept as aliases. Safe because the only external importer of the `servers/overview.js` module is its own unit test, which imports functions, not these type names. The `Overview*` prefix family was an explicit decision (reviewed at the gate) — keeps the public contract stable and groups the payload types in autocomplete.
- **Two distinct `PlanPhase` types.** Only the overview one (`status: string`) moved to `api.ts`. Porch's `commands/porch/types.ts` `PlanPhase` (`status: PlanPhaseStatus`, a different package and concern) is deliberately untouched — no collision, since it's never imported from `codev-types`. The wire `PlanPhase.status` stays `string` (not the narrower union) to match the parser's arbitrary-string reads and the prior inlined shape.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-875` → **View Diff**
- **Run dev server**: VSCode sidebar → **Run Dev Server**, or `afx dev pir-875`
- **What to verify**:
  - `pnpm --filter @cluesmith/codev-types build && pnpm build` is green
  - Work view (dashboard) renders builders / PRs / backlog / recently-closed identically — same fields incl. `area` and `planPhases` sub-phase progress
  - `rg "export interface (Overview|.*Overview|PlanPhase)" packages/codev/src/agent-farm/servers/overview.ts` returns nothing

## Flaky / Pre-existing Tests

- `packages/dashboard/__tests__/scrollController.test.ts` → "warns on unexpected scroll-to-top but does not auto-correct (Issue #630)" — 1 failing assertion (`warnSpy` expected to be called, 0 calls). **Pre-existing and unrelated**: this PR modifies zero dashboard files, and the test imports nothing this change touches (no `Overview` / `PlanPhase` / `codev-types` references). Failed deterministically across two full runs, independent of this diff. Not fixed here — out of scope per PIR (don't make an unrelated red go green). Tracked separately in **#967** (CI-gap follow-up from pir-961). The rest of the dashboard suite passes (316/318, 1 skipped).
