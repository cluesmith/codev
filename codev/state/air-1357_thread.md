# air-1357 — codev-sdk controller subpath: overview wire type re-exports

## 2026-08-06 — Implement phase

AIR strict mode, issue #1357. Two-part scope per architect instruction:

1. **Type-only re-exports** of `OverviewData`, `OverviewBuilder`, `OverviewPR`,
   `OverviewBacklogItem` from `@cluesmith/codev-types` on the sdk's
   `./controller` subpath (the streamdeck migration's import-boundary
   criterion in #1347 depends on this). Also added `OverviewData` to
   `./tower-client` since `getOverview` returns it. Both use the
   whole-statement `export type { ... } from` form — the mixed
   `export { type X } from` form still emits a runtime re-export statement,
   so the boundary test pins the erased form specifically.

2. **Packaging fix**: `@cluesmith/codev-types` moved from devDependencies to
   dependencies. Published `.d.ts` files reference it (`import type ... from
   '@cluesmith/codev-types'` in tower-client.d.ts), so a fresh npm consumer
   running tsc could not resolve it as a devDep. codev-types is published
   (3.2.4 on npm) and types-only, so the zero-RUNTIME-deps posture holds.
   The import-boundary test's `dependencies` assertion restated: exactly
   `['@cluesmith/codev-types']` allowed, with the intent documented (zero
   runtime deps; contract-types dep permitted for .d.ts resolution).

Boundary test extensions:
- New UNIVERSAL rule: value re-exports of codev-types forbidden
  (`export type` form required), mirroring the existing `import type` rule.
- New pin test: controller.ts must re-export the four overview types via
  `export type { ... } from '@cluesmith/codev-types'`.

Lockfile updated (dep group move). Building + testing next.

## PR phase

- Implement checks green (build 8.4s, tests 28.1s). Emit inspection confirmed
  the re-exports are erased from dist JS and present in the .d.ts.
- PR #1358 created with review in the body (AIR: no spec/plan/review files).
- Running porch PR-phase checks (pr_exists + e2e_tests), then notifying the
  architect and stopping at the pr gate.

## Gate approved, merge held

- PR-phase checks green; pr gate approved by the architect after review.
- Merge NOT yet authorized: workspace policy requires Amr's explicit per-PR
  word. Holding until the architect relays it.
- Architect confirmed the consult-skip was within AIR's builder discretion;
  the protocol-doc contradiction that made it ambiguous is tracked as #1359.
