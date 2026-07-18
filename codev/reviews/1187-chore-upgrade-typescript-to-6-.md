# PIR Review: Upgrade TypeScript to 6.0.3 across the monorepo

Fixes #1187

## Summary

Unified the monorepo's TypeScript compiler on a single version (**6.0.3**), resolving the prior 5.7/5.9 drift across the six packages that carry a `typescript` devDependency. The version is now pinned once in a pnpm `catalog:` entry (every manifest references `"typescript": "catalog:"`), so future bumps — including the anticipated TS 7 move — are a one-line change and drift is structurally impossible. Fixed the two genuine TypeScript 6 breaking changes (the new `types: []` compiler default, and `baseUrl`-deprecation-as-hard-error), the latter by migrating `packages/artifact-canvas` off the unmaintained tsup onto tsdown.

## Files Changed

Source changes (excludes the 715/-269 `pnpm-lock.yaml` refresh and porch's own `status.yaml`):

- `pnpm-workspace.yaml` (+2 / -0) — new `catalog: { typescript: ^6.0.3 }`
- `apps/web/package.json` (+1 / -1) — `typescript` → `catalog:`
- `apps/vscode/package.json` (+1 / -1) — `typescript` → `catalog:`
- `packages/types/package.json` (+1 / -1) — `typescript` → `catalog:`
- `packages/core/package.json` (+1 / -1) — `typescript` → `catalog:`
- `packages/codev/package.json` (+1 / -1) — `typescript` → `catalog:`
- `packages/artifact-canvas/package.json` (+13 / -8) — `typescript` → `catalog:`; tsup → tsdown; `exports`/`main`/`module`/`types` retargeted to tsdown filenames
- `packages/core/tsconfig.json` (+2 / -1) — add `"types": ["node"]`
- `packages/codev/tsconfig.json` (+2 / -1) — add `"types": ["node"]`
- `apps/web/src/vite-env.d.ts` (+1 / -0) — new; `/// <reference types="vite/client" />`
- `packages/artifact-canvas/tsdown.config.ts` (+20 / -0) — new build config
- `packages/artifact-canvas/tsup.config.ts` (+0 / -24) — deleted
- `packages/artifact-canvas/scripts/smoke.mjs` (+2 / -2) — retarget dist filenames to tsdown's
- `packages/codev/src/commands/porch/__tests__/e2e/fixtures/todo-app/package.json` (+3 / -3) — bump the last remaining TS 5 pin (dead e2e fixture) to TS 6
- `codev/resources/arch.md`, `codev/resources/lessons-learned.md` — governance updates (see below)
- `codev/plans/1187-*.md`, `codev/reviews/1187-*.md`, `codev/state/pir-1187_thread.md` — protocol artifacts

## Commits

```
cdd949ee [PIR #1187] Bump e2e todo-app fixture to TS 6 (no TS 5 artifacts remain)
fdea8c60 [PIR #1187] Migrate artifact-canvas build from tsup to tsdown
6b90d0f4 [PIR #1187] Fix TS 6 types:[] default fallout (node types + vite/client)
a984e884 [PIR #1187] Unify TypeScript on 6.0.3 via pnpm catalog
```
(plus thread/review commits and porch's phase-transition commits)

## Test Results

Full suite re-run under the final catalog + tsdown state:

- `pnpm --recursive build`: ✓ pass (every package, incl. apps/web vite, codev dashboard bundle, artifact-canvas tsdown dual-format)
- `pnpm --recursive check-types`: ✓ pass (types, artifact-canvas, core, apps/vscode host + webview)
- `pnpm --filter codev-vscode run vscode:prepublish`: ✓ pass (topological workspace-dep build + check-types + lint + production esbuild)
- `packages/artifact-canvas` `pnpm build:smoke`: ✓ pass (CJS + ESM entries load, `ArtifactCanvas` exported, dist assets present)
- Tests: core **41**, artifact-canvas **73**, apps/web **323** (+1 skip), codev **3482** (+48 skip) — all passing, zero new failures
- porch gate checks (`build`, `tests`): ✓ pass
- **Manual verification (human, `dev-approval` gate)**: reviewer approved the running worktree.

No `engines.node` change was needed — TS 6.0.3 declares `engines.node: ">=14.17"`, below the repo's existing `>=20.0.0`.

## Architecture Updates

Routed to the **COLD** tier (`codev/resources/arch.md`) — reference-level toolchain facts, not decision-gating invariants, and the HOT `arch-critical.md` is at its cap (adding would require displacing a stronger invariant, which none of these warrant):

- **Technology Stack** — documented that the TypeScript version is pinned once in the `pnpm-workspace.yaml` `catalog:` and referenced as `"typescript": "catalog:"` everywhere (bump the catalog, never a single package), plus the TS 6 `types: []` default and its `["node"]` / `vite-env.d.ts` implications.
- **Monorepo Structure → Per-package build tools** — noted that `packages/artifact-canvas` builds via tsdown (Rolldown, the maintained tsup successor) and why its `exports` map uses nested per-format `import`/`require` conditions.

(These live in our project's own evolved docs, not framework files, so no `codev-skeleton/` mirror is required.)

## Lessons Learned Updates

Routed to the **COLD** tier (`codev/resources/lessons-learned.md` → Debugging and Root Cause Analysis) — a spec-narrow-but-durable recipe, not a new always-on invariant (HOT `lessons-critical.md` already covers the adjacent "captured raw data beats speculation" / "grep the whole repo after a framework change" rules):

- **[From 1187]** A cross-package `check-types` tally is meaningless until every workspace dependency is *built* — ~100 phantom `TS2307`/`TS7006` errors in downstream packages all vanished once the upstream `dist/*.d.ts` existed. Build the dep graph (or check-types topologically) before trusting a monorepo error count. Corollary: discover a major dependency upgrade's real fallout **empirically at plan time** (install + run the full suite), not by predicting it from release notes.

## Things to Look At During PR Review

- **The `exports` map change in `packages/artifact-canvas/package.json`** is the highest-signal diff. tsup emitted `index.js` (ESM) + a single `index.d.ts`; tsdown emits per-format `index.mjs`/`index.d.mts` (ESM) and `index.cjs`/`index.d.cts` (CJS). The map was restructured from a flat `{types, import, require}` to nested `import`/`require` conditions each pointing at their matching declaration file — the correct dual-package layout (avoids CJS/ESM type masquerading). Downstream resolution was verified: apps/web build, vscode webview check-types, and the `build:smoke` all pass against the new names.
- **`types: ["node"]` on core/codev only** — deliberately *not* added to `packages/config/tsconfig.base.json` (the shared base), because `packages/types` (no `@types/node` dep) and the browser-context `tsconfig.webview.json` would then error. Per-package is the correct scope.
- **The e2e `todo-app` fixture bump** — this fixture is vestigial (no src, not referenced by any test; e2e `setup.ts` builds its own inline `package.json`) and is not a pnpm workspace member, so it can't use `catalog:` (direct `^6.0.3` pin) and its bump produced zero lockfile change. Bumped per architect request to leave no TS 5 pin anywhere; `@types/node` and `vitest` were aligned to the workspace's versions for internal consistency.
- **tsdown is pre-1.0 (`0.22.8`)** — the maintained Rolldown-based tsup successor. If pre-1.0 tooling is a concern, the fallback is tsup + `"ignoreDeprecations": "6.0"`, but that silence stops working in TS 7.
- **The build script is `tsdown --config-loader native`, and the config is `tsdown.config.mjs` (not `.ts`)** — both deliberate and load-bearing. tsdown 0.22.8's default `auto` config-loader only imports the config natively when the Node runtime has native TS support (Bun / Node ≥24.11); otherwise it falls back to `unrun`, an *optional* peer dependency pnpm doesn't install. On CI's older Node with a clean `--frozen-lockfile` install, that path fails with "Failed to import module 'unrun'". The choice is Node-version-driven, **not** file-extension-driven — it failed CI as both `tsdown.config.ts` and `tsdown.config.mjs` before this fix. Forcing `--config-loader native` makes Node import the plain-ESM `.mjs` config directly on every supported Node version (a `.ts` config can't use `native` on older Node — hence `.mjs`). Reproduce the CI failure locally with `pnpm exec tsdown --config-loader unrun` (forces the broken path); `--config-loader native` builds clean under the identical condition.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1187` → **View Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1187`
- **What to verify** (maps to the plan's Test Plan):
  - `pnpm install` refreshes the lockfile to `typescript@6.0.3` cleanly (catalog resolves; zero tsup refs remain)
  - `pnpm --recursive build` then `pnpm --recursive check-types` — both clean (build first so downstream `.d.ts` exist)
  - `pnpm --filter codev-vscode run vscode:prepublish` — production extension build succeeds
  - Per-package `vitest run` (note `packages/codev`'s `test` script is watch-mode `vitest` — use `vitest run`) + artifact-canvas `pnpm build:smoke`
