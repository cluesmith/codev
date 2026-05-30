# PIR Review: VSCode builder row legibility — phase prefix + gate-specific icons

Fixes #810

## Summary

The Builders tree now leads each row with the coarse protocol phase (`[plan]` / `[implement]` / `[review]`) immediately after the icon, and dispatches a gate-specific codicon for blocked builders (book / checklist / code / git-pull-request / verified, with a `bell` fallback) while keeping the warning-yellow color uniform. Both changes make protocol state legible at a glance — phase across all three row states (not just active rows, where it was previously a truncation-prone trailing suffix), and gate type via icon shape (previously a single generic bell for every gate). A new `protocolPhase` wire field was added so the prefix shows the true high-level phase instead of the low-level plan sub-phase id that the collapsed `phase` field carries.

## Files Changed

- `packages/vscode/src/views/builder-row.ts` (+90 / -0) — new pure, vscode-free module: `gateIconFor`, `builderRowLabel`, `timeSince`
- `packages/vscode/src/views/builders.ts` (+7 / -21) — `makeBuilderRow` delegates to the helpers; local `timeSince` removed
- `packages/vscode/src/__tests__/builder-row.test.ts` (+134 / -0) — new unit suite (label states, empty-phase edge, sub-phase→implement, gate mapping, regression guards)
- `packages/types/src/api.ts` (+15 / -0) — `OverviewBuilder.protocolPhase` field + docs
- `packages/codev/src/agent-farm/servers/overview.ts` (+18 / -0) — populate `protocolPhase` at the 3 push sites; add it to the local `BuilderOverview` interface
- `packages/dashboard/__tests__/BuilderCard.test.tsx` (+1 / -0) — fixture field
- `packages/dashboard/__tests__/NeedsAttentionList.test.tsx` (+1 / -0) — fixture field
- `packages/codev/src/agent-farm/__tests__/e2e/spec-823-builder-attribution.test.ts` (+1 / -0) — mock field
- `codev/resources/lessons-learned.md` — dual-type footgun entry (see Lessons Learned)
- `codev/plans/810-vscode-builder-row-legibility.md`, `codev/state/pir-810_thread.md` — plan + thread

## Commits

- `82aeff84` [PIR #810] Phase prefix + gate-specific icons for builder rows
- `1535e4c2` [PIR #810] Show coarse protocolPhase in row prefix, not plan sub-phase id
- `a77a4b4a` [PIR #810] Lead the row label with the phase prefix, before the issue id
- `8e69aa48` [PIR #810] Add protocolPhase to the local BuilderOverview interface

## Test Results

- Build: `pnpm --filter @cluesmith/codev build` ✓; vscode `check-types` ✓, `lint` ✓, `esbuild` ✓
- `pnpm test:unit` (vscode): ✓ 123 passed (10 new in `builder-row.test.ts`)
- `pnpm test` (dashboard): 314 passed, **1 pre-existing unrelated failure** (`scrollController.test.ts`, Issue #630) — see Flaky Tests
- Manual verification (human, `dev-approval` gate): ran the worktree dev server, confirmed phase prefix renders the coarse phase and gate icons dispatch per gate. The reviewer drove two design refinements during this gate (see Things to Look At).

## Architecture Updates

No `arch.md` changes needed. `arch.md` documents `status.yaml` fields (`current_plan_phase`) but not the `/api/overview` projection shape, so the new `protocolPhase` field doesn't intersect any documented architectural boundary or pattern — it's an additive field on an existing wire type, not a structural change.

## Lessons Learned Updates

Added one entry to `codev/resources/lessons-learned.md` (Architecture): the builder-overview shape is defined twice — the `OverviewBuilder` wire type and a hand-synced local `BuilderOverview` interface in `overview.ts` — and the codev package has no `check-types` script, so a field added only to the wire type passes client type-checks but breaks the codev build at the server push sites, invisible until a full `pnpm build`. This bit this PR directly (the dev-approval build error). Recording it so the next person touching the overview projection builds the codev package, not just the client type-check.

## Things to Look At During PR Review

- **`protocolPhase` vs `phase` (the core design decision).** The issue assumed the prefix could use `b.phase`, but `phase` is *collapsed* in `overview.ts` — it prefers `current_plan_phase` (a free-form plan sub-phase id like `phase_0_rebase_onto_ci`) over the protocol phase, because the dashboard matches that id against `planPhases` to render sub-phase progress (`BuilderCard.tsx:23`). So the prefix would have leaked low-level slugs. The fix exposes the protocol phase as its own field (`protocolPhase = parsed.phase`), leaving `phase` untouched so the dashboard is unaffected. A rejected alternative — a vscode-only heuristic mapping `phase`→`implement` when it matches a `planPhases` id — was discarded because it encodes an unproven protocol invariant in the view layer. Verify the dashboard's `(1/4)` progress still reads `phase` and is unchanged.
- **Label order is phase-first** (`[<phase>] #<id> <title>`), not the issue's written "immediately after the issue number." This was a deliberate reviewer call at the dev-approval gate: phase-first pins the phase bracket to a fixed offset after the icon so the phase column scans straight down (issue ids vary in width, which would otherwise make it jiggle). Noted that the "icon represents phase" rationale only strictly holds for blocked rows (active/idle icons are generic).
- **Icon map keys off `b.blockedGate`, not `b.blocked`.** `b.blocked` is a human-readable label (`"plan review"`); `b.blockedGate` is the canonical gate name (`"plan-approval"`). Keying off the label would silently no-op (every row → bell). There's a regression test asserting `gateIconFor('plan review') === 'bell'`. The `verify-approval` gate (#927) was added to the map (the issue's draft omitted it).
- **Helper purity.** `builderRowLabel` takes `isIdle` as a parameter rather than importing `isIdleWaiting` from codev-core, so the unit suite runs under vitest against source without needing codev-core built. The caller already computes `isIdle`.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-810` → **View Diff**
- **Run dev server**: VSCode sidebar → **Run Dev Server**, or `afx dev pir-810` (reload the VSCode window after a rebuild to pick up the extension)
- **What to verify** (maps to the plan's Test Plan):
  - Every row shows `[<protocol-phase>]` right after the icon — `plan` / `implement` / `review`, never a `phase_*` slug
  - Narrowing the sidebar clips the title tail, not the phase
  - Blocked rows show gate-specific glyphs (checklist=plan, code=dev, git-pull-request=pr), all warning-yellow; idle (`comment-discussion`) and active (`circle-filled`) icons unchanged
  - Empty-phase rows render `#<id> <title>` with no stray `[]`
  - Dashboard builder cards still show sub-phase progress `(n/m)` (the `phase` field is untouched)

## Flaky Tests

- `packages/dashboard/__tests__/scrollController.test.ts` — "warns on unexpected scroll-to-top but does not auto-correct (Issue #630)" fails on this branch. **Pre-existing and unrelated**: it fails identically with this PR's entire diff stashed on a clean tree, and touches nothing in this change (scroll behavior / `console.warn` spying, no `OverviewBuilder` usage). Not skipped or modified — left as-is per PIR's out-of-scope guidance. Porch's `tests` check runs the codev package only (not the dashboard suite), so it is unaffected.
