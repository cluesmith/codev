# PIR #875 — Collapse duplicate Overview*/*Overview types

## Plan phase (2026-06-03)

Investigated the duplication. Two parallel declarations:
- Wire: `packages/types/src/api.ts` (`OverviewBuilder`, `OverviewPR`, `OverviewBacklogItem`, `OverviewRecentlyClosed`, `OverviewData`)
- Server: `packages/codev/src/agent-farm/servers/overview.ts` (`BuilderOverview`, `PROverview`, `BacklogItem`, `RecentlyClosedItem`, `OverviewData`, local `PlanPhase`)

Key findings driving the plan:
- **Two unrelated `PlanPhase` types.** overview.ts's (`status: string`) is in scope → moves to api.ts. Porch's `commands/porch/types.ts` one (`status: PlanPhaseStatus`) is a different concern → untouched.
- **Rename is safe.** Only external importer of `servers/overview.js` is `overview.test.ts`, which imports functions, not type names. So renaming server-side identifiers to the wire names is clean, no alias layer needed.
- **No third copy.** dashboard `lib/api.ts` just re-exports from codev-types. VSCode/dashboard/core already consume the wire types — no consumer changes.
- **No name collision** for `PlanPhase` in codev-types.
- codev package already depends on `@cluesmith/codev-types` (workspace:*).

Plan written to `codev/plans/875-collapse-duplicate-overview-ov.md`, committed. Sitting at `plan-approval` gate.
