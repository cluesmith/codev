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

## Implement phase (2026-07-16)

Executed the move. Steps done:
- `git mv packages/vscode → apps/vscode`, `packages/dashboard → apps/web` (renames, history preserved).
- `pnpm-workspace.yaml`: added `apps/*`.
- `packages/codev/package.json`: build:dashboard/dev:dashboard `cd ../dashboard` → `cd ../../apps/web` (copy targets unchanged, both dirs depth-2 from root).
- Package rename (Decision 2): apps/web name → `@cluesmith/codev-web`; codev devDep; 3 test import specifiers.
- apps/vscode tsconfig.json + tsconfig.webview.json `extends` `../config` → `../../packages/config`.
- apps/vscode/package.json repository.directory → apps/vscode.
- CI test.yml working-directories.
- Release scripts bump-vscode.sh (real paths) + bump-all.sh (comments).
- .vscode/{launch,tasks,settings}.json.
- .gitignore build-output patterns (NOT in original plan — caught by post-rename grep sweep).
- Docs: arch.md (Monorepo table now shows apps/ vs packages/ + artifact-canvas row; tree; diagrams; dashboard-dist source path); CLAUDE.md+AGENTS.md area/dashboard label package-name citation (kept byte-identical).
- projectlist.md line 250 left as historical release-notes prose (not live structure).

Running `pnpm install` to regenerate lockfile, then build + tests.

## Added scope at dev-approval gate (2026-07-16)

Reviewer spotted `@cluesmith/config` breaks the `@cluesmith/codev-*` convention
(lone member missing `codev-` infix). Included the fix in this PR:
- `@cluesmith/config` → `@cluesmith/codev-config` (private pkg, ~3 lines).
- Zero blast radius: referenced only via relative `extends ../config/tsconfig.base.json`,
  never by name; pnpm-lock doesn't even record the name. Build (full tsc) + tests green.
- apps/vscode's unscoped `codev-vscode` left as-is (Marketplace publisher model, intentional).

## Review phase (2026-07-16)

- Wrote codev/reviews/855-monorepo-layout-introduce-apps.md (retrospective).
- Arch: updated COLD arch.md Monorepo Structure (done in implement); no HOT change (cap full, map already points there).
- Lessons: added one COLD Architecture entry [From #855] (relative-path breakage surface; dead-metadata package names); no HOT change.
- Ran full CI test matrix locally: unit all green (core/artifact-canvas/codev/web/vscode). Integration+CLI surfaced pre-existing FLAKY failures (terminal-spawn 500s non-deterministic; adopt CLAUDE.md-merge 30s timeout) — documented in review Flaky Tests, not caused by this PR (only non-test codev src change = 1 comment line). Playwright dashboard-e2e NOT run (port 4100 / shared global.db risk to live Tower).
- PR #1188 opened, recorded with porch. Running 3-way consult (config-scoped to claude+codex).

## Consultation + pr gate (2026-07-16)

3-way (config-scoped 2-way): Claude APPROVE, Codex REQUEST_CHANGES (3 findings, all valid, all fixed):
1. vscode compile/typecheck never verified → ran check-types (exit 0) + compile (green); proves tsconfig extends fix; added check-types to vscode CI job.
2. review How-to-Test commands misleading → fixed with per-package cmds.
3. arch.md vscode marketplace name codev → codev-vscode (cluesmith.codev-vscode).
Fixes in 4aaa2f68. Rebuttal at 855-review-iter1-rebuttals.md. pr gate now pending.
