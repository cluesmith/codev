# PIR Plan: Migrate the Stream Deck plugin into the monorepo as `apps/streamdeck`

## Understanding

Issue #1347 executes the migration decided on #1189 (comments 5185933478 and 5185972772): the Stream
Deck plugin moves from the `codev-integrations` repo into this monorepo as `apps/streamdeck`, becoming
`@cluesmith/codev-sdk`'s first consumer outside the original in-repo trio. The old
`@cluesmith/codev-client` package dissolves (its implementation was already absorbed into the sdk by
PR #1346).

**Scope, per architect instruction (2026-08-05):** issue steps 1–3 plus the published-SDK canary
workflow landed **manual-only** (step 4, activated after the sdk's first npm publish). Step 5
(npm deprecate + old-repo retirement) is **out of scope** — gated on the next release.

**Sequencing dependency:** #1357 (in flight on main via air-1357) adds the Overview* type re-exports
to `codev-sdk/controller` and settles the codev-types devDependency wrinkle. This plan assumes it
lands first; the migration then imports those types from `@cluesmith/codev-sdk/controller` and stays
purely a migration. If implementation starts before #1357 merges, `check-types` will fail on the four
Overview* imports — the correct response is to wait/rebase, not to hand-roll local types or import
`@cluesmith/codev-types` directly.

### What the plugin actually consumes (verified against source)

The plugin is 4 source files + 2 test files (~900 LOC) plus the `com.cluesmith.codev.sdPlugin/`
bundle directory (manifest, icons, layouts, PI html). Its entire `@cluesmith/codev-client` surface:

| Old import | Where | New home |
|---|---|---|
| `TowerClient` (value) | `plugin.ts:2` | `@cluesmith/codev-sdk/controller` |
| `TowerClient` (type-only) | `store.ts`, `__tests__/actions.test.ts` | `@cluesmith/codev-sdk/controller` |
| `WorkspaceSummary` (type) | `store.ts:8` | `TowerWorkspace` from `codev-sdk/controller` — **rename**; compatible superset (adds `proxyUrl`, `terminals`) |
| `OverviewData`, `OverviewBuilder`, `OverviewPR`, `OverviewBacklogItem` (types) | `store.ts`, `actions.ts:12` | `codev-sdk/controller` **after #1357 lands** |
| Methods: `sendCommand`, `subscribeEvents`, `listWorkspaces`, `getOverview` | `store.ts`, `actions.ts` | Identical signatures on the sdk's `TowerClient` (lifted verbatim in the #1189 absorption); `listWorkspaces` now returns `TowerWorkspace[]` |

**Auth is the one behavioral change:** the old client read `~/.agent-farm/local-key` implicitly by
default. The sdk's `TowerClient` defaults to *no auth*; the plugin must construct
`new TowerClient({ getAuthKey: readLocalKey })` with `readLocalKey` imported from
`@cluesmith/codev-sdk/node` (the plugin is a Node 20 process — the one consumer where the `/node`
adapter subpath is correct).

**Gap check (issue scope item 2):** no gaps found. Everything the plugin needs exists on the sdk
surface once #1357's re-exports land (#1357 itself *was* the gap-check finding, filed by the
streamdeck architect against #1189's follow-ups). Nothing needs hand-rolling.

## Proposed Change

### 1. History preservation: documented import-commit boundary (not git subtree)

The `codev-integrations` repo has **exactly two commits** (initial monorepo import + one docs
commit) — there is no meaningful history to graft. `git subtree`/filter-repo would add machinery to
preserve two commits of near-zero archaeology value. Instead:

- One migration commit imports the tree, with a message documenting provenance:
  `Imported from cluesmith/codev-integrations@77be3d0 (packages/streamdeck)`.
- `apps/streamdeck/README.md` gets a short **History** section pointing at the old repo as the
  pre-migration archive.

**Fidelity discipline — verbatim first, edit second.** The import commit copies the old repo's
tracked file set **byte-for-byte, zero edits**, and is verified mechanically before committing:
`git -C codev-integrations ls-files packages/streamdeck` drives the copy, then a `diff -r` of each
tracked file against the imported tree must come back empty. All migration edits (import swaps,
package.json deps, tsconfig extends path, alias removal) land in *separate commits on top*, so
`git diff <import-commit>..HEAD -- apps/streamdeck` is exactly the intended migration delta —
reviewable as a small diff against a machine-checked baseline, with no way for functionality to be
silently dropped inside a combined copy+edit blob. The old tests migrate verbatim under the same
rule and must pass with only their import line changed, pinning behavior independently.

### 2. Move the plugin source → `apps/streamdeck`

Files migrated (the old repo's tracked set, paths preserved under `apps/streamdeck/`):

- `src/plugin.ts`, `src/store.ts`, `src/actions.ts`, `src/nav/cursor.ts`
- `src/__tests__/actions.test.ts`, `src/__tests__/cursor.test.ts`
- `com.cluesmith.codev.sdPlugin/` — `manifest.json`, `layouts/*.json`, `ui/*.html`, `icons/*`
- `esbuild.js`, `tsconfig.json`, `vitest.config.ts`, `package.json`, `README.md`

Not migrated:

- `com.cluesmith.codev.sdPlugin/bin/` and `logs/` — build/runtime outputs (gitignored in the old repo
  too); a new `apps/streamdeck/.gitignore` carries those two entries.
- `PLAN.md` — historical planning artifact; stays behind in the archive repo.
- `packages/client/` — dissolved; the sdk already carries the implementation and its tests.

### 3. Migrate imports (`codev-client` → sdk subpaths)

- `plugin.ts`: `import { TowerClient } from '@cluesmith/codev-sdk/controller'`,
  `import { readLocalKey } from '@cluesmith/codev-sdk/node'`,
  construct `new TowerClient({ getAuthKey: readLocalKey })`.
- `store.ts`: switch the value import to `import type { TowerClient, TowerWorkspace, OverviewData, OverviewBuilder, OverviewPR, OverviewBacklogItem } from '@cluesmith/codev-sdk/controller'`;
  rename `WorkspaceSummary` → `TowerWorkspace` at its two usage sites (`workspaces` field,
  selection helpers). The old value-import of `TowerClient` was only used in type position —
  making it `import type` means **no runtime sdk import outside `plugin.ts`**.
- `actions.ts`: `import type { OverviewBuilder } from '@cluesmith/codev-sdk/controller'`.
- `__tests__/actions.test.ts`: `import type { TowerClient } from '@cluesmith/codev-sdk/controller'`.
- `vitest.config.ts`: **drop the resolve-alias block** (old hack aliasing `codev-client` to sibling
  source). With all non-entry sdk imports type-only, tests exercise `store.ts`/`actions.ts`/
  `cursor.ts` without needing the sdk's dist at runtime; `check-types` is what needs the sdk built
  (same ordering CI already uses for every other sdk consumer).

### 4. Workspace wiring

`apps/streamdeck/package.json` (name kept: `@cluesmith/codev-streamdeck`, private, version stays
0.1.0 — not release-versioned; the user-facing version lives in `manifest.json`):

- `dependencies`: `@cluesmith/codev-sdk: workspace:*`, `@elgato/streamdeck: ^2.1.0`
- `devDependencies`: `@elgato/cli: ^1.7.4`, `@types/node: 22.x`, `esbuild: ^0.27.1` (matches
  apps/vscode), `typescript: catalog:` (^6.0.3, matches workspace convention), `vitest: ^4.0.15`
  (matches sdk)
- `scripts` unchanged: `build` (esbuild bundle), `watch`, `check-types`, `test`, `validate`
  (`streamdeck validate com.cluesmith.codev.sdPlugin`), `pack`
- `tsconfig.json`: `extends: "../../packages/config/tsconfig.base.json"` (byte-identical to the old
  repo's base, so no behavior change beyond the TS version bump 5.9 → catalog 6.0)

`pnpm-workspace.yaml` already globs `apps/*` — no change needed. `@elgato/streamdeck` +
`@elgato/cli` land in the lockfile as the install-cost delta for other builders (runtime dep is
small; the CLI is dev-only).

### 5. Import-boundary pin (issue acceptance criterion 4)

New `src/__tests__/import-boundary.test.ts`, mirroring the sdk's own guard pattern (scan `src/`
excluding `__tests__/`, strip comments, assert on import specifiers). Allowed: `@cluesmith/codev-sdk/*`
subpaths, `@elgato/streamdeck`, `node:*` builtins, relative paths. Additional pins:

- `@cluesmith/codev-sdk/node` may be imported **only from `plugin.ts`** (the composition root — keeps
  store/actions environment-agnostic and testable).
- Forbidden by name: `@cluesmith/codev-client` (the migration's whole point), `@cluesmith/codev-types`
  (types must arrive via the controller subpath), `@cluesmith/codev-core`.

### 6. CI wiring (`.github/workflows/test.yml`, unit job)

After the existing "Build sdk package" step (order matters — `check-types` resolves the sdk's dist
`.d.ts`), append steps:

```yaml
- name: Type-check streamdeck plugin
  working-directory: apps/streamdeck
  run: pnpm check-types
- name: Run streamdeck unit tests
  working-directory: apps/streamdeck
  run: pnpm test
- name: Build + validate streamdeck plugin
  working-directory: apps/streamdeck
  run: pnpm build && pnpm validate
```

Placement: with the other apps/* steps at the end of the unit job (after the vscode steps).
`streamdeck validate` is a static manifest/layout schema check (file-based, headless — no Stream Deck
hardware or macOS dependency), so it should run fine on ubuntu-latest. Mild risk flagged below.
`pack` is not run in CI (no marketplace publish pipeline yet — same posture as apps/vscode, whose
packaging also isn't in test.yml).

### 7. Published-SDK canary (issue scope item 4, landed manual-only)

New `.github/workflows/sdk-canary.yml`:

- **Trigger: `workflow_dispatch` only.** A commented-out `schedule:` block (weekly cron) with a note:
  enable after `@cluesmith/codev-sdk`'s first npm publish (next release). This satisfies "land the
  workflow disabled/allowed-to-fail until then" without burning scheduled failures.
- Job shape: checkout → pnpm/node setup → `pnpm install` →
  `pnpm --filter @cluesmith/codev-streamdeck add @cluesmith/codev-sdk@latest` → re-run
  `check-types`, `test`, `build`, `validate` in `apps/streamdeck`.
- Why this shape: the `pnpm add @latest` rewrites the dependency from `workspace:*` to a registry
  semver range; with pnpm's default `link-workspace-packages: false`, that resolves from npm, not the
  local workspace — so the job exercises the **published** dist + types exactly where a third-party
  integrator would feel a break, while reusing all the workspace toolchain (no parallel standalone
  harness to maintain).

## Files to Change

- `apps/streamdeck/**` — new: the migrated tree per §2 (4 src files, 2 existing tests + 1 new
  boundary test, sdPlugin bundle dir, esbuild/tsconfig/vitest configs, package.json, README.md,
  .gitignore)
- `apps/streamdeck/src/plugin.ts:2,28-31` — sdk imports + `getAuthKey: readLocalKey` construction
- `apps/streamdeck/src/store.ts:1-8,32` — type-only controller imports; `WorkspaceSummary` →
  `TowerWorkspace`
- `apps/streamdeck/src/actions.ts:12` — controller type import
- `apps/streamdeck/src/__tests__/actions.test.ts:3` — controller type import
- `apps/streamdeck/vitest.config.ts` — drop resolve-alias block
- `.github/workflows/test.yml` — three streamdeck steps in the unit job
- `.github/workflows/sdk-canary.yml` — new, manual-only canary
- `codev/state/pir-1347_thread.md` — builder thread (committed per #1192 convention)

No changes to `packages/sdk` (that's #1357, sequenced ahead), no changes to `pnpm-workspace.yaml`
(apps/* already globbed), no skeleton mirroring (product code, not framework files).

## Risks & Alternatives Considered

- **Risk: #1357 hasn't merged when implementation starts** → `check-types` fails on the four
  Overview* type imports. Mitigation: rebase onto main once air-1357 lands before pushing; escalate
  to the architect if it stalls. No local workaround (a direct `codev-types` import would violate the
  boundary this migration is meant to establish).
- **Risk: `streamdeck validate` misbehaves on linux CI** (untested assumption; it's a static schema
  check but the Elgato CLI is primarily exercised on macOS/Windows). Mitigation: if it fails for
  platform reasons, keep `build` in CI and demote `validate` to a local/macOS script with a comment —
  and record it as a finding.
- **Risk: TS 5.9 → 6.0 bump surfaces new type errors** in the migrated source (workspace catalog is
  ^6.0.3). Likely nil (~900 LOC, strict already); fix trivially if so.
- **Risk: canary's `pnpm add @latest` silently linking the workspace copy** if
  `link-workspace-packages` were enabled repo-wide. It isn't (no `.npmrc` override); the workflow adds
  a guard comment. The alternative — copying the app to a temp dir outside the workspace for a fully
  standalone `npm install` — is *more* externally faithful but forks the toolchain (tsconfig extends,
  catalog refs break outside the workspace) and was rejected as more harness than signal.
- **Alternative: `git subtree` history graft** — rejected: two commits of history; a documented
  import boundary (commit message + README pointer) preserves everything worth preserving.
- **Alternative: keep the vitest alias pointing at sdk source** — rejected in favor of type-only
  import discipline (no alias to maintain; runtime coupling confined to the entry point; boundary
  test enforces it stays that way).
- **Alternative: `pnpm dlx @elgato/cli` instead of a devDependency** — rejected: unpinned (defeats
  the lockfile) and a network fetch per validate run; devDep cost is dev-only.

## Test Plan

For the `dev-approval` gate (reviewer, from the worktree):

- **Automated:** `pnpm install` at root, then in `apps/streamdeck`: `pnpm check-types && pnpm test &&
  pnpm build && pnpm validate` (sdk must be built first: `pnpm --filter @cluesmith/codev-sdk build`).
  Workspace-wide acceptance: `pnpm -r check-types && pnpm -r test` green.
- **Boundary:** the new import-boundary test fails if any `codev-client`/`codev-types`/`codev-core`
  import (or a non-plugin.ts `/node` import) is introduced; `grep -r "codev-client" apps/streamdeck/src`
  returns nothing.
- **Behavior parity against a live Tower** (the issue's acceptance criterion; needs a physical Stream
  Deck + Tower running): `pnpm build`, link/install the `com.cluesmith.codev.sdPlugin` bundle into the
  Stream Deck app, then verify: badge/online status renders (SSE connect with the local key — this
  exercises the one behavioral change, the injected `getAuthKey`); workspace/builder navigators rotate
  and descend; dials scroll; action keys POST verbs (e.g. approve-gate) and Tower acts on them; PR nav
  opens the PR URL in the browser.
- **Canary dry-run:** not runnable until the sdk publishes; the workflow is dispatch-only. Reviewer
  sanity-checks the YAML.
