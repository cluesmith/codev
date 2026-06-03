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

## Implement phase (2026-06-03)

plan-approval approved. Applied the consolidation:
- `packages/types/src/api.ts`: added named `PlanPhase` interface; `OverviewBuilder.planPhases` now `PlanPhase[]` (was inlined).
- `packages/types/src/index.ts`: export `PlanPhase` from the barrel.
- `packages/codev/src/agent-farm/servers/overview.ts`: import the 5 wire types + `PlanPhase` from `@cluesmith/codev-types`; deleted the 6 local interface blocks; renamed server identifiers to the wire names (`BuilderOverview`→`OverviewBuilder`, `PROverview`→`OverviewPR`, `BacklogItem`→`OverviewBacklogItem`, `RecentlyClosedItem`→`OverviewRecentlyClosed`).

Note: worktree shipped without node_modules — had to `pnpm install` before the build/tests would run (the misleading first "exit 0" was `tail`'s, not the build's).

Verification: `pnpm build` green (no TS errors → confirms zero pre-existing drift between the formerly-duplicated declarations); overview unit suite 150/150 pass. No consumer changes needed (VSCode/dashboard/core already on the wire types; dashboard re-exports them).

Sitting at `dev-approval` gate.

### Full-suite verification (at reviewer request)

Ran `pnpm -r test` across all packages. Two failures surfaced, both investigated and ruled NOT caused by this diff:

1. **vscode `compile` — esbuild "Could not resolve @cluesmith/codev-types"** (env, now fixed).
   Root cause: `packages/types/dist/` didn't exist — the types package was never built in this worktree (it shipped without node_modules; the `postSpawn` install never ran, I `pnpm install`ed manually, which links the workspace symlink but doesn't compile dist). The types package exposes `exports["."] = { types: "./src/index.ts", default: "./dist/index.js" }`: tsc (core/codev/all vitest) resolves the `types`→src entry, so every tsc build was green; esbuild (vscode bundler) resolves the `default`→dist entry and needs the compiled artifact. The root `pnpm build` only builds `@cluesmith/codev-core` + `@cluesmith/codev` — NOT types or vscode — so it never produced types/dist. Built types (`pnpm --filter @cluesmith/codev-types build`); vscode `compile` then green. vscode `check-types` (tsc) passed throughout → my type changes are valid.

2. **dashboard `scrollController.test.ts` — 1 failed (Issue #630, terminal scroll-to-top warn spy), 316/318 pass.** Pre-existing & unrelated: my diff modifies ZERO dashboard files, and the test imports nothing I changed (no Overview/PlanPhase/codev-types refs). Deterministic across both runs. Out of scope per PIR (don't fix unrelated reds). Noted here for Lessons Learned.

Net: core ✓, codev ✓ (overview 150/150), types ✓, vscode compile ✓; only the pre-existing dashboard scroll test red remains.
