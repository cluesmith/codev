# PIR Plan: Introduce `apps/` for end-user surfaces

Issue: #855 — Monorepo layout: introduce apps/ for end-user surfaces

## Understanding

Today all workspace members live under `packages/*`. The issue proposes an
`apps/` vs `packages/` split so end-user client surfaces form a discoverable
peer set, distinct from shared libraries — motivated by an upcoming mobile app
(`apps/mobile`) that would look out of place if the existing clients stayed
under `packages/`.

Concretely, this PR:

- Adds `apps/*` to the workspace glob.
- Moves `packages/vscode` → `apps/vscode` (VS Code extension — end-user surface).
- Moves + renames `packages/dashboard` → `apps/web` (Tower management SPA — end-user surface).
- Leaves the shared libraries in place: `packages/codev`, `packages/core`,
  `packages/types`, `packages/config`, and `packages/artifact-canvas`.

Note vs. the issue text: the issue was written when there were "six packages."
There are now **seven** — `@cluesmith/codev-artifact-canvas` was added since.
It is a **shared React rendering library** ("Reusable React surface for
rendering and reviewing Codev markdown artifacts … across VSCode, the dashboard,
and future mobile hosts"), not an end-user surface, so it correctly **stays in
`packages/`**. This is consistent with the issue's rule that only end-user
clients move.

`workspace:*` deps resolve by package *name*, not path, and npm/Marketplace
publish key off the package, not the directory — so the move is mechanical. The
real work is fixing the handful of places that hardcode the *relative source
path* of the two moved packages, plus updating live docs that describe the
layout. Historical records (`codev/specs`, `codev/plans`, `codev/reviews`,
`codev/projects`, `codev/state`, `codev/research`) are point-in-time and are
**not** rewritten.

## Proposed Change

Do the whole split in **this one PR** (glob + both moves), rather than the
issue's suggested three separate PRs. Rationale: the changes are mechanical and
tightly coupled (the glob addition is a prerequisite for both moves, and leaving
one client under `packages/` mid-migration is exactly the half-applied-convention
state the issue warns against). `apps/mobile` still lands fresh later, out of
scope here. (See Decision 1 — the reviewer can redirect to phased PRs at the gate.)

Use `git mv` for the directory moves so `git log --follow` history is preserved.
After the moves, run `pnpm install` to regenerate `pnpm-lock.yaml` importer keys,
then `pnpm build` + tests to confirm the wiring.

### Decisions (issue's open questions — resolved with the reviewer)

1. **Split now, all in one PR?** — **CONFIRMED: yes**, single PR, glob + both moves.
2. **Rename npm package `@cluesmith/codev-dashboard` → `@cluesmith/codev-web`?**
   — **CONFIRMED: yes.** The package is `private: true`; blast radius is fully
   internal (one dependency entry in `packages/codev/package.json` + three test
   imports of `@cluesmith/codev-dashboard/lib/*` in `packages/codev`). Baked into
   "Files to Change" below as a definite change.
3. **User-facing "Dashboard" brand** — **CONFIRMED: keep as-is.** This PR renames
   only the *directory* (`apps/web`) and the *package name* (`@cluesmith/codev-web`).
   It does **not** sweep the word "Dashboard" from user-facing/product surfaces —
   the `area/dashboard` GitHub label, "Tower dashboard" code comments, and UI copy
   describe the *product concept* and stay untouched.
4. **Naming + single unified app** — **CONFIRMED: keep the issue's
   `web` / `mobile` / `vscode` surface axis.** The reviewer asked to evaluate a
   single Expo / React Native Web app covering web + mobile. **Research finding
   (2026-07-16): keep them as separate apps — do NOT unify, and do NOT collapse
   `apps/web` + `apps/mobile` into one `apps/app`.** This *reinforces* #855's
   `apps/*` split as planned rather than changing it. Basis:
   - The exact question ("could RN + RNW give us one codebase for iOS + Android +
     web?") was already **considered and rejected** in the project's own mobile
     research — `codev/research/mobile/interaction-model.md` §7.1 ("Do NOT merge
     `apps/web` and `apps/mobile`") and `feasibility-2026-07.md` §9 Q7. That
     research's recommended end-state layout (interaction-model §7.3) is *exactly*
     #855's `apps/*` split plus a future `packages/tower-sdk`.
   - Fresh external verification (web research, 2026-07) corroborates it: RNW is
     suited to feed-based touch-first apps, and industry guidance is explicitly
     "web-first React DOM for the desktop management console, lightweight RN views
     for on-the-go mobile" — the codev split precisely. RNW adds an emulation-layer
     runtime/hydration cost that Vite avoids for the DOM-heavy console.
   - The load-bearing blocker is concrete: the web surface's live **xterm.js
     terminal attach** is DOM-only and has no React Native path (RN has no DOM).
     Unifying would force either a lowest-common-denominator UX or per-platform
     branches everywhere (defeating the merge's premise).
   - The *correct* code-sharing lever is not a unified app but extracting the
     framework-agnostic data layer into `packages/tower-sdk` (~70-75% of `apps/web`'s
     hooks are portable; wire contracts already in `@cluesmith/codev-types`). That
     is a **separate future workstream** (mobile Phase S spike) that #855 *enables*
     (apps/web is the extraction source) and does not conflict with. No #855 change.

## Files to Change

### Directory moves (git mv)
- `packages/vscode/` → `apps/vscode/`
- `packages/dashboard/` → `apps/web/`

### Workspace glob
- `pnpm-workspace.yaml` — add `- apps/*` under `packages:`.

### Build wiring (highest risk — relative paths that break on move)
- `packages/codev/package.json:26` — `build:dashboard`: `cd ../dashboard` →
  `cd ../../apps/web`. The copy target `../../packages/codev/dashboard-dist`
  stays (codev doesn't move). *(The internal `dashboard-dist` output dir name and
  `tower-server.ts`'s `../../../dashboard-dist` resolve are unchanged — that's a
  concept name, not the moved path.)*
- `packages/codev/package.json:27` — `dev:dashboard`: `cd ../dashboard` →
  `cd ../../apps/web`.

### TypeScript config (relative `extends` from the moved vscode package)
- `apps/vscode/tsconfig.json:2` — `"../config/tsconfig.base.json"` →
  `"../../packages/config/tsconfig.base.json"`.
- `apps/vscode/tsconfig.webview.json:5` — same fix.
  *(dashboard/`apps/web` tsconfig is self-contained — no relative `extends` to fix.)*

### CI
- `.github/workflows/test.yml:74` — `working-directory: packages/dashboard` → `apps/web`.
- `.github/workflows/test.yml:78` — `working-directory: packages/vscode` → `apps/vscode`.
  *(Other workflows only reference `packages/core` / `packages/codev`, which don't move.
  No `on: paths:` filters reference the moved dirs.)*

### Release scripts
- `scripts/bump-vscode.sh` — real path refs `packages/vscode/package.json` and
  `packages/vscode/CHANGELOG.md` (lines ~29, 30, 64, 82) → `apps/vscode/...`,
  plus header comments (lines ~2, 4).
- `scripts/bump-all.sh` — comment/echo mentions of `packages/vscode` (lines ~18,
  23, 98) → `apps/vscode` for accuracy. The bump loop (line 90) doesn't touch the
  moved dirs.

### VS Code dev-environment configs (live)
- `.vscode/launch.json:9,12` — `packages/vscode` → `apps/vscode`.
- `.vscode/tasks.json:8` — `packages/vscode` → `apps/vscode`.
- `.vscode/settings.json:3,4,14,15` — `packages/vscode/out|dist` → `apps/vscode/...`.

### Moved package's own metadata
- `apps/vscode/package.json` — `repository.directory: "packages/vscode"` → `"apps/vscode"`.

### Package rename (Decision 2 = confirmed yes)
- `apps/web/package.json:2` — name `@cluesmith/codev-dashboard` → `@cluesmith/codev-web`.
- `packages/codev/package.json:55` — dependency key → `@cluesmith/codev-web: workspace:*`.
- `packages/codev/src/__tests__/filePathLinkProvider.test.ts:13-14` and
  `packages/codev/src/agent-farm/__tests__/open-files-shells-section.test.ts:11`
  — import specifiers `@cluesmith/codev-dashboard/lib/*` → `@cluesmith/codev-web/lib/*`.
- After the rename, re-grep for any lingering `@cluesmith/codev-dashboard`
  (excluding historical `codev/` records) to confirm the sweep is complete.

### Live docs describing the layout
- `codev/resources/arch.md` — Monorepo Structure table + structure tree + ASCII
  diagram + prose (lines ~17-18, 120, 1026, 1053-1064, 1083, 1205-1207, 1284):
  update `packages/dashboard` / `packages/vscode` → `apps/web` / `apps/vscode`.
- `CLAUDE.md` / `AGENTS.md` — the "Directory Map" / structure references. These
  two must stay **byte-identical** to each other. Update only genuine
  *current-layout* references. The `area/dashboard` label description stays
  untouched (Decision 3: the "Dashboard" product concept is not rebranded — the
  package-rename in Decision 2 does not touch the label).
- `packages/core/src/review-markers.ts:16` — comment path
  `packages/vscode/src/comments/plan-review.ts` → `apps/vscode/...` (cosmetic accuracy).

### Not changed (intentionally)
- `codev-skeleton/**` — zero references to the moved paths; this is our own
  package layout, not framework content shipped to adopters. No dual-tree mirror needed.
- Historical records under `codev/specs|plans|reviews|projects|state|research` —
  point-in-time; left as written.
- `packages/vscode/src/**/*.test.ts` fixture strings like `packages/vscode/src/a.ts`
  — arbitrary path-tree test data, not real references; the tree logic is
  path-agnostic so they need no change.
- `pnpm-lock.yaml` — regenerated by `pnpm install`, not hand-edited.

## Risks & Alternatives Considered

- **Risk: broken dashboard build wiring.** The `cd ../dashboard` relative path in
  `build:dashboard`/`dev:dashboard` is the single most breakage-prone edit — a
  wrong relative depth silently fails to produce `dashboard-dist`, and Tower then
  serves no SPA. *Mitigation:* after the change, run `pnpm build` from repo root
  and confirm `packages/codev/dashboard-dist/index.html` exists; exercise Tower
  serving the web UI at the dev-approval gate.
- **Risk: stale relative `extends` in vscode tsconfig.** Missing the
  `../config` → `../../packages/config` fix breaks `tsc`/build for the extension.
  *Mitigation:* `pnpm --filter codev-vscode build` (or the workspace build) must pass.
- **Risk: lockfile / CI drift.** Importer keys are path-based. *Mitigation:*
  regenerate via `pnpm install`; CI `test.yml` working-directories updated in lockstep.
- **Risk: over-reaching doc edits.** Rewriting historical plans/reviews would be
  revisionist. *Mitigation:* explicit exclude list above; only live layout docs change.
- **Alternative: fix vscode tsconfig by switching `extends` to the package name
  `@cluesmith/codev-config/tsconfig.base.json`** (TS supports node_modules
  resolution). Rejected for this PR: it's a behavior-neutral refactor beyond the
  move's scope and would diverge the vscode tsconfig from how the other six
  packages extend the base. Keeping the relative form (just corrected for depth)
  matches the existing convention.
- **Alternative: phased PRs (issue's suggestion).** Rejected as default (see
  Proposed Change), but trivially available if the reviewer prefers it.

## Test Plan

- **Build:** `pnpm build` from repo root succeeds; `packages/codev/dashboard-dist/`
  is populated (index.html + assets present).
- **Unit tests:** `pnpm --filter @cluesmith/codev test` passes; the moved
  packages' own suites pass (`apps/web`, `apps/vscode`), including the three
  `packages/codev` tests that import from the web package's `/lib/*` (verifies the
  rename if Decision 2 = yes).
- **Workspace resolution:** `pnpm install` completes cleanly; `pnpm ls -r`
  shows all seven members with `apps/web` and `apps/vscode` at their new paths.
- **VS Code extension:** `pnpm --filter codev-vscode build` (or workspace build)
  succeeds — confirms the tsconfig `extends` depth fix.
- **Manual (dev-approval gate):** run the worktree via `afx dev pir-855`; confirm
  Tower serves the web management UI (workspace overview, terminals) — proves the
  `dashboard-dist` copy path survived the move.
- **git history:** `git log --follow apps/web/package.json` and
  `git log --follow apps/vscode/package.json` show history across the rename.
- **Grep sweep:** no operational (non-historical) file still references
  `packages/dashboard` or `packages/vscode`.
