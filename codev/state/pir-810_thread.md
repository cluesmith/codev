# PIR #810 — vscode builder row legibility

## Plan phase

Wrote `codev/plans/810-vscode-builder-row-legibility.md`.

Two changes in `packages/vscode/src/views/builders.ts` (`makeBuilderRow`):
- **A** — phase as leading prefix `#<id> [<phase>] <title>...` (was trailing suffix, truncated off-screen).
- **B** — blocked-row codicon dispatched by gate (uniform warning-yellow), bell fallback.

### Key findings (corrections to the issue's proposed code)
1. **Icon map must key off `b.blockedGate`, not `b.blocked`.** `b.blocked` is a human-readable label (`"plan review"`) per `overview.ts:410-455`; `b.blockedGate` is the canonical name (`"plan-approval"`). The issue's snippet (`GATE_ICONS[b.blocked]`) would never match → Change B would silently no-op. Added a regression test asserting `gateIconFor('plan review') === 'bell'`.
2. **Added `verify-approval` → `verified`** to the icon map (a real gate from #927 the issue's map omitted).

### Design decision
Extracting two pure vscode-free helpers (`gateIconFor`, `builderRowLabel`) into new `builder-row.ts` (mirrors `backlog-filter.ts`) so the acceptance-criteria unit tests run under vitest `__tests__/` instead of the heavier Electron `src/test/` harness. Slightly more LOC than the issue's inline sketch, but the testing requirement makes extraction the right call.

Plan approved.

## Implement phase

Extracted two pure helpers into new `packages/vscode/src/views/builder-row.ts`:
- `gateIconFor(blockedGate)` — gate→codicon, keyed off canonical `b.blockedGate`, bell fallback. Includes `verify-approval`→`verified`.
- `builderRowLabel(b, isIdle, now)` — phase-prefix label.
- `timeSince(isoDate, now)` — moved here, now takes `now` param for deterministic tests.

`builders.ts` `makeBuilderRow` now calls both; removed its local `timeSince`.

### Deviation from plan
`builderRowLabel` takes `isIdle` as a **parameter** rather than importing `isIdleWaiting` from `@cluesmith/codev-core`. Reason: the vitest `__tests__/` harness runs against source with codev-core unbuilt, so a runtime import of `@cluesmith/codev-core/builder-helpers` (subpath → `dist/`) fails to resolve. Injecting `isIdle` (which the caller already computes for icon/contextValue dispatch) keeps the helper genuinely pure + test-runnable with no build step, and avoids a double `isIdleWaiting` call. Cleaner separation overall.

### Checks
- `pnpm check-types` ✓ (after building codev-types + codev-core, which the fresh worktree `pnpm install` had left without `dist/`)
- `pnpm lint` ✓
- `node esbuild.js` ✓
- `pnpm test:unit` ✓ 122 passed (9 new in `builder-row.test.ts`)

Awaiting `dev-approval` gate.

## Dev-approval feedback: phase prefix showed low-level plan sub-phase ids

Reviewer caught that some rows displayed `[phase_0_rebase_onto_ci]` / `[phase_1_schema]` instead of `[implement]`. Root cause: `OverviewBuilder.phase` is **collapsed** in `overview.ts:714` — it prefers `current_plan_phase` (a free-form plan sub-phase id) over the protocol phase, because the **dashboard intentionally** matches that id against `planPhases` to render `(1/4)` sub-phase progress (`BuilderCard.tsx:23`). So `b.phase` is the wrong field for a high-level prefix.

Considered a vscode-only heuristic (map `b.phase` → `implement` if it's a `planPhases` id) but rejected it: it relies on an unproven "sub-phase ⟹ implement" invariant and would silently rot. Reviewer agreed — went with exposing ground truth instead.

### Fix: new `protocolPhase` wire field (expands beyond the vscode-only plan)
- `packages/types/src/api.ts` — added `OverviewBuilder.protocolPhase` (= raw `parsed.phase`: plan/implement/review). `phase` documented as the collapsed/sub-phase field; unchanged.
- `packages/codev/src/agent-farm/servers/overview.ts` — set `protocolPhase: parsed.phase` at the active push site, `''` at the two soft fallbacks. **`phase` left untouched → dashboard `(1/4)` unaffected.**
- `builder-row.ts` — prefix reads `b.protocolPhase`.
- Fixtures updated for the new required field: `builder-row.test.ts` (+ new test: sub-phase id in `phase` still renders `[implement]`), dashboard `BuilderCard`/`NeedsAttentionList` tests, codev e2e `spec-823` mock.

### Checks (re-run)
- vscode `check-types` ✓, `lint` ✓, `esbuild` ✓; `test:unit` ✓ 123 passed (10 in builder-row).
- dashboard `tsc -b --force` ✓; `pnpm test` 314 passed, **1 pre-existing failure** in `scrollController.test.ts` (Issue #630, console.warn spy) — **proven unrelated**: fails identically with my entire diff stashed on a clean tree. Out of scope per PIR flaky-test guidance; noted here + for the review file. (Porch's `tests` check runs the codev package only, not dashboard, so it's green.)
- codev-types + codev-core rebuilt (fresh-worktree `pnpm install` had left them without `dist/`).

## Dev-approval feedback #2: phase prefix moved before the issue id

Reviewer asked for `[<phase>] #<id> <title>` (phase first, right after the icon) instead of `#<id> [<phase>] <title>`. Agreed — strongest reason is **column alignment**: issue ids vary in width, so an id-first order makes the phase bracket jiggle row-to-row; phase-first pins it to a fixed offset after the icon, so the phase column scans straight down. (Noted the "icon represents phase" premise is only strictly true for blocked rows — active/idle icons are generic — but the alignment win holds regardless.) This diverges from the issue's written "immediately after the issue number" spec; reviewer's call.

- `builder-row.ts` — label is now `${phasePrefix}#${id} ${title}${state}`; doc comment updated.
- `builder-row.test.ts` — all label assertions flipped to phase-first order.
- vscode `test:unit` ✓ 123, `lint` ✓, `esbuild` ✓.

## Post-PR tweak: dev-approval gate icon play → code

Reviewer asked for an icon reflecting "coding" rather than "run". Switched `dev-approval` → `code` (`</>` glyph) — more consistent with the other phase-reflecting icons (book=spec, checklist=plan, git-pull-request=pr). Lost the `play` "run-and-verify" hint, accepted. Updated test + review file. vscode unit ✓ 123, lint ✓, esbuild ✓. (Made during the pr-gate consult window; PR updates automatically.)

---

## Review phase

dev-approval approved. Wrote `codev/reviews/810-vscode-builder-row-legibility.md` (PR body). Added one lessons-learned entry (dual BuilderOverview/OverviewBuilder type + codev-no-check-types footgun). No arch.md change (overview projection shape isn't documented there). Opening PR next, then porch's single-pass 3-way consult, then `pr` gate.

---

## Build fix: BuilderOverview local interface also needed the field

`pnpm build` failed (TS2353) — `overview.ts` defines a **local `BuilderOverview` interface duplicating** codev-types' `OverviewBuilder`, and the `builders.push({...})` sites are typed as the local one. Added `protocolPhase` there too. The codev package has **no `check-types` script**, so vscode check-types passed while this stayed hidden until a full `pnpm build` ran `tsc` over codev/src. Lesson: when touching the overview shape, build the codev package, not just vscode check-types. `pnpm --filter @cluesmith/codev build` ✓ now.
