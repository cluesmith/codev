# PIR #952 — Builders tree: group by phase, area becomes row prefix

## Plan phase (in progress)

Investigated the Builders tree grouping stack:
- `packages/vscode/src/views/builders.ts` — `BuildersProvider`, groups via `groupByArea(ordered, b => b.area)`.
- `packages/vscode/src/views/builder-row.ts` — `builderRowLabel` (currently `[<phase>] #id title`), `rollupGroupState`, `BUILDER_STATE_GLYPH`, `gateIconFor`.
- `packages/core/src/area-grouping.ts` — `groupByArea` (alphabetical + Uncategorized-last) + `uppercaseAreaName`.
- `area-group-tree-item.ts` (base, field `areaName`), `builder-tree-item.ts` (`BuilderGroupTreeItem`), `area-group-expansion.ts` (generic store, `persistAreaGroupExpansion`).

Key data facts:
- `OverviewBuilder.protocolPhase` = coarse phase (raw `phase:` from status.yaml). Phase ids by protocol: spir/aspir = specify/plan/implement/review/verify; pir = plan/implement/review; air = implement/pr; bugfix = investigate/fix/pr; maintain = maintain/review; experiment = hypothesis/design/execute/analyze; research = scope/investigate/synthesize/critique; spike = spike. Terminal status values: `verified`/`complete`. Empty string when no live status.
- `b.area` wire values are lowercase (`vscode`, `tower`, `cross-cutting`); `Uncategorized` sentinel when unlabeled.

Design approach (recommendations in plan):
- New core helper `groupByPhase` (lifecycle order: specify→plan→implement→review→pr→verify→verified, custom phases appended sorted, unknown/empty bucket last). Empty groups omitted naturally.
- Reuse generic `AreaGroupExpansionStore` with NEW key `codev.buildersPhaseGroupExpansion`.
- `BuilderGroupTreeItem` shape unchanged — pass phase string into the `areaName` slot (per issue's explicit guidance; minimal churn).
- `builderRowLabel`: `[<area>] #id title<stateLabel>`, omit prefix when Uncategorized.
- Backlog tree untouched. Dashboard has no builders-by-area grouping → no dashboard scope.

#913 (ephemeral group state) still OPEN, not merged → proceed with persistence (new key); note coordination.

## Plan revision 1 (architect Q: "all phase types across all protocols?")

Audited all 9 bundled protocols (no `tick` protocol.json ships). Confirmed experiment/maintain/research/spike ARE spawnable as builders → their phases can appear. Found 2 gaps in draft 1:
- Gap A: `complete` (backward-compat terminal synonym of `verified`) would render as a stray COMPLETE group → fix: normalize complete→verified before bucketing.
- Gap B: "custom phases alphabetical" scrambles experiment/research/bugfix natural sequences → fix: single curated PHASE_DISPLAY_ORDER (17 ids) keeping each protocol's natural order; unrecognized-future alphabetical; unknown(empty) last.
Distinct buckets possible ≈ 19 (17 authored ids + verified + unknown, complete normalized away); realistically 1–7 live.

## Plan revision 2 (architect: "reduce max groups" → closed canonical stage set)

19 max groups defeats triage. Pivoted from one-group-per-phase to a CLOSED 6-stage set with a `PHASE_TO_STAGE` map folding all 17 phase ids in. Max groups now FIXED at 7 (6 stages + unknown) regardless of protocol count.
- Stages: SPECIFY · PLAN · IMPLEMENT · REVIEW · PR · VERIFIED (+ UNKNOWN).
- Architect calls: 6 stages (not 5); `investigate → plan`; PR & VERIFIED stay separate (PR = action-needed merge-triage query; VERIFIED = terminal).
- verify/verified/complete → verified stage. Unmapped/empty → unknown.
- Helper renamed groupByPhase → `groupByStage`; storage key → `codev.buildersStageGroupExpansion`.
- Design call #7 (group header icons): KEEP #926 worst-of-state rollup icon unchanged (orthogonal to grouping axis — label=stage, icon=attention signal). Only cosmetic "area-group"→"stage-group" rename in builder-tree-item.ts.
- Acceptance criteria delta documented: issue's "append protocol phases after VERIFIED" REPLACED by the closed-stage fold.

## IMPLEMENT phase (plan-approval APPROVED 2026-06-02)

Building per approved plan. Harness notes: core has no test runner (build/check-types only); pure phase-grouping helper goes in core, tested via vitest in vscode `src/__tests__/` (mirrors builder-row.test.ts, resolves `@cluesmith/codev-core/phase-grouping` via exports→dist, so build core first).

First swap landed + green (root build/test, vscode check-types, 255 vscode tests, lint). Dev-approval gate reached.

## Scope expansion at dev-approval gate (architect-directed): add phase/area TOGGLE

Architect: some users prefer area-grouping. Keep BOTH, default stage, add a view-header toggle. (Issue #952 listed this exact toggle as a potential follow-up under Out-of-scope.) Bundling into #952 per architect choice.
Mirror the `buildersFileViewAsTree` house pattern: config setting `codev.buildersGroupBy` (enum stage|area, default stage) + two paired view/title commands gated on a `codev.buildersGroupBy` context key.
Key design: the ROW PREFIX flips with mode — area-mode shows `[<phase>]` (restores #810), stage-mode shows `[<area>]`. Per-mode expansion stores (stage key + reuse original area key `codev.buildersGroupExpansion`). Area-mode keeps the single-Uncategorized flatten; stage-mode doesn't.
