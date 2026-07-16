# PIR #855 — Monorepo layout: introduce apps/ for end-user surfaces

## Plan phase (2026-07-16)

Investigated the monorepo. Key findings:

- **7 packages now, not 6** (issue predates `@cluesmith/codev-artifact-canvas`).
  artifact-canvas is a shared React lib → stays in `packages/`.
- Moves: `packages/vscode` → `apps/vscode`, `packages/dashboard` → `apps/web`.
- **Highest-risk edit**: `packages/codev/package.json` `build:dashboard` /
  `dev:dashboard` use `cd ../dashboard` relative path → must become
  `cd ../../apps/web`. Silent failure mode if wrong (empty `dashboard-dist`).
- **tsconfig**: `apps/vscode/tsconfig.json` + `tsconfig.webview.json` extend
  `../config/tsconfig.base.json` → `../../packages/config/...`. dashboard tsconfig
  is self-contained.
- CI: only `test.yml:74,78` working-directories. No `paths:` filters affected.
- Scripts: `bump-vscode.sh` (real paths), `bump-all.sh` (comments only).
- `.vscode/{launch,tasks,settings}.json` live dev-env refs.
- Package rename `@cluesmith/codev-dashboard` → `@cluesmith/codev-web` is
  Decision 2 (open Q): blast radius is internal-only (1 dep + 3 test imports).
- Skeleton has ZERO refs — not a framework-file change, no dual-tree mirror.
- Historical records (specs/plans/reviews/projects/state/research) left as-is.

Plan written to `codev/plans/855-monorepo-layout-introduce-apps.md`. Awaiting
plan-approval gate. Presented issue's 4 open questions as reviewer decisions.

## Research: unified Expo/RNW app vs separate apps (2026-07-16)

Architect asked to research whether one Expo/RNW app could cover web + mobile,
as it "drives monorepo restructuring." Finding: **keep separate apps — reinforces
#855, does not change it.**

- Existing project research already decided this: `interaction-model.md` §7.1
  ("Do NOT merge apps/web and apps/mobile") + `feasibility-2026-07.md` §9 Q7.
  Recommended layout (§7.3) == #855's apps/* split + future `packages/tower-sdk`.
- External web research (2026-07) corroborates: RNW for feed/touch apps; web-first
  React DOM for the desktop console. Vite avoids RNW emulation/hydration overhead.
- Blocker: xterm.js terminal attach is DOM-only, no RN path.
- Right sharing lever = extract `packages/tower-sdk` (data layer, ~70-75% portable,
  types already shared) — separate future workstream, #855 enables it.

Decisions 3 (keep Dashboard word) + 4 (keep separate apps) now CONFIRMED in plan.
