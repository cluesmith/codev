# PIR Plan: Collapse duplicate Overview*/*Overview types into a single source of truth

## Understanding

The `Overview*` family of dashboard-overview types is declared twice:

- **Wire contract** in `packages/types/src/api.ts` — `OverviewBuilder`, `OverviewPR`, `OverviewBacklogItem`, `OverviewRecentlyClosed`, `OverviewData` (`@cluesmith/codev-types`, consumed by VSCode, dashboard, core).
- **Server-internal** in `packages/codev/src/agent-farm/servers/overview.ts` — `BuilderOverview`, `PROverview`, `BacklogItem`, `RecentlyClosedItem`, `OverviewData`, plus a local `PlanPhase` interface.

The server emits objects that exactly match the wire shape — no transformation, no internal-only fields, no renaming. The two declarations are structurally identical save for docstring wording and one detail: `BuilderOverview.planPhases: PlanPhase[]` (named local interface) vs `OverviewBuilder.planPhases: Array<{ id: string; title: string; status: string }>` (inlined). This is the duplication the project memory rule [[feedback_types_are_wire_contracts]] flags — `@cluesmith/codev-types` is the wire-contract home; the server should import, not re-declare. The cost is that every field addition (e.g. #819's `area: string`) must land in both files manually, and TypeScript won't catch drift because the two are independent declarations ([[reference_overview_builder_dual_type]]).

**Scope boundary — two unrelated `PlanPhase` types exist:**
- `overview.ts:31` — `{ id; title; status: string }`, the *wire/overview* plan-phase summary used by `OverviewBuilder.planPhases` and `ParsedStatus`. **In scope** — this is the one the issue moves to `api.ts`.
- `packages/codev/src/commands/porch/types.ts:108` — `{ id; title; status: PlanPhaseStatus }`, porch's *internal* plan-phase model (used by `plan.ts`, `state.ts`, `index.ts`, `prompts.ts`). **Out of scope** — a different concern with a narrower `status` union; left untouched.

## Proposed Change

Make `@cluesmith/codev-types` the single source of truth. `overview.ts` imports the wire types and uses them directly, deleting its local declarations.

1. **Move `PlanPhase` to the wire package.** Add `export interface PlanPhase { id: string; title: string; status: string }` to `packages/types/src/api.ts` and export it from `packages/types/src/index.ts`. Keep `status: string` (not the narrower porch `PlanPhaseStatus` union) — the overview parser reads arbitrary strings out of `status.yaml`, and `string` matches the existing inlined wire shape, so the contract doesn't narrow.
2. **Use the named `PlanPhase` in `OverviewBuilder`.** Replace `planPhases: Array<{ id: string; title: string; status: string }>` with `planPhases: PlanPhase[]` in `api.ts`. Structurally identical; no consumer change.
3. **Server imports the wire types.** In `overview.ts`, add `import type { OverviewBuilder, OverviewPR, OverviewBacklogItem, OverviewRecentlyClosed, OverviewData, PlanPhase } from '@cluesmith/codev-types';` and delete the six local `export interface` blocks (`PlanPhase`, `BuilderOverview`, `PROverview`, `BacklogItem`, `RecentlyClosedItem`, `OverviewData`).
4. **Rename server-side identifiers to the wire names** (rather than keeping aliases — cleaner, and a confirmed-safe rename: the only external importer of the `servers/overview.js` module is its own unit test, which imports *functions only*, not these type names). Within `overview.ts`:
   - `BuilderOverview` → `OverviewBuilder` (incl. `discoverBuilders(): OverviewBuilder[]`, the `builders` array)
   - `PROverview` → `OverviewPR`
   - `BacklogItem` → `OverviewBacklogItem` (incl. `deriveBacklog(): OverviewBacklogItem[]`, the `item` local)
   - `RecentlyClosedItem` → `OverviewRecentlyClosed`
   - local `PlanPhase` references (`ParsedStatus.planPhases`, `currentPlanPhase: Partial<PlanPhase>`, `pushPlanPhase`) now resolve to the imported wire `PlanPhase`.

`dashboard/src/lib/api.ts` already re-exports these from `@cluesmith/codev-types` (no third copy), so dashboard/VSCode/core consumers are unaffected.

## Files to Change

- `packages/types/src/api.ts` — add `PlanPhase` interface (near the Overview block, ~line 127); change `OverviewBuilder.planPhases` (`:161`) from the inlined array to `PlanPhase[]`.
- `packages/types/src/index.ts` — add `type PlanPhase` to the `./api.js` export list (~line 22).
- `packages/codev/src/agent-farm/servers/overview.ts`:
  - `:13-23` — add `PlanPhase` and the four/five Overview wire types to an `import type { … } from '@cluesmith/codev-types'` (new import).
  - `:31-175` — delete the six local `export interface` blocks (`PlanPhase`, `BuilderOverview`, `PROverview`, `BacklogItem`, `RecentlyClosedItem`, `OverviewData`).
  - `:643, :647, :668-690, :724-785` — `BuilderOverview` → `OverviewBuilder` in `discoverBuilders` signature, array decl, and the two pushed object literals.
  - `:823, :836, :959` — `BacklogItem` → `OverviewBacklogItem` in `deriveBacklog` return type, `item` local, and the `getOverview` local.
  - `:937` — `PROverview` → `OverviewPR`.
  - `:981, :1005` — `RecentlyClosedItem` → `OverviewRecentlyClosed`.
  - `:168-171` (inside the deleted `OverviewData`) — gone; the imported `OverviewData` already names the wire member types.

No changes needed in VSCode/dashboard/core (already on the wire types) or in the overview unit test (imports functions, not types).

## Risks & Alternatives Considered

- **Risk: `PlanPhase` name collision in `@cluesmith/codev-types`.** Verified none — no existing `PlanPhase` in `packages/types`, and no VSCode/dashboard/core file declares or imports a `PlanPhase`. Porch's same-named type lives in a different package (`packages/codev/src/commands/porch/types.ts`) and is never imported from codev-types, so no clash.
- **Risk: renaming breaks an external importer of the server module.** Verified safe — `rg "from.*servers/overview"` returns only `overview.test.ts`, which imports functions (`OverviewCache`, `discoverBuilders`, …), not the type identifiers.
- **Risk: narrowing the wire `status` field.** Avoided — wire `PlanPhase.status` stays `string`, matching the current inlined shape and the parser's arbitrary-string reads.
- **Alternative: keep `type BuilderOverview = OverviewBuilder` aliases** to minimize churn. Rejected — the rename is mechanical and confined to one file with no external importers, so aliases would just add a permanent indirection layer for no benefit. Clean rename better serves the "single source of truth" goal.
- **Alternative: move the types the other direction** (server → wire as source). Rejected — contradicts [[feedback_types_are_wire_contracts]]; the wire package is the correct home for shared contracts.

## Test Plan

This is a pure type-consolidation change — no runtime behavior changes; the construction code in `getOverview`/`deriveBacklog`/`discoverBuilders` is untouched. Verification is compile-and-test:

- **Build (primary acceptance gate):** `pnpm -w build` green — TypeScript surfaces any leftover field divergence between the (now single) wire types and every consumer. This is the issue's stated acceptance check.
- **Unit tests:** `pnpm --filter @cluesmith/codev test` — `overview.test.ts` (TTL, degraded mode, builder discovery, backlog derivation, status.yaml parsing) passes unchanged, confirming the emitted shapes still satisfy the wire types.
- **Manual (dev-approval gate):** run the worktree dashboard (`afx dev pir-875`), open the Work view — builders, PRs, backlog, and recently-closed lists render identically (same data, same fields, including `area` and `planPhases` sub-phase progress).
- **Grep acceptance:** `rg "export interface (Overview|.*Overview|PlanPhase)" packages/codev/src/agent-farm/servers/overview.ts` returns nothing — overview.ts declares zero Overview*/`*Overview`/`PlanPhase` interfaces.
