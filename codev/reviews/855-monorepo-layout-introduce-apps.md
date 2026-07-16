# PIR Review: Introduce `apps/` for end-user surfaces

Fixes #855

## Summary

Adopted an `apps/` vs `packages/` split so end-user client surfaces are a
discoverable peer set distinct from shared libraries. Moved `packages/vscode` →
`apps/vscode` and `packages/dashboard` → `apps/web` (with a package rename
`@cluesmith/codev-dashboard` → `@cluesmith/codev-web`), added `apps/*` to the
workspace glob, and fixed every operational reference to the old paths. Two
consistency fixes landed alongside at the reviewer's request: the package rename
above, and `@cluesmith/config` → `@cluesmith/codev-config` (the lone workspace
member that broke the `@cluesmith/codev-*` convention). The five shared libraries
(`codev`, `core`, `types`, `config`, `artifact-canvas`) stay in `packages/`.

## Files Changed

283 files changed (+507 / -189). The bulk (**257**) are pure `git mv` renames of
the two package trees (history preserved — `git log --follow` works across the
rename). The substantive edits:

**Content-modified (23):**
- `pnpm-workspace.yaml` (+2) — add `apps/*`
- `pnpm-lock.yaml` — regenerated importer keys
- `packages/codev/package.json` (+3/-3) — `build:dashboard`/`dev:dashboard` paths → `../../apps/web`; `@cluesmith/codev-web` dep
- `packages/config/package.json` (+1/-1) — name → `@cluesmith/codev-config`
- `apps/web/package.json`, `apps/vscode/package.json` — name / `repository.directory`
- `apps/vscode/tsconfig.json`, `apps/vscode/tsconfig.webview.json` — `extends` → `../../packages/config/...`
- `apps/vscode/scripts/publish.sh` — self-referential usage paths
- `packages/codev/src/__tests__/filePathLinkProvider.test.ts`, `.../open-files-shells-section.test.ts` — `@cluesmith/codev-web/lib/*` import specifiers
- `packages/codev/src/lib/default-branch.ts`, `.../e2e/architect-pane-layout.test.ts`, `packages/core/src/review-markers.ts` — comment path refs
- `.github/workflows/test.yml` — `working-directory` → `apps/web`, `apps/vscode`
- `scripts/bump-vscode.sh`, `scripts/bump-all.sh` — vscode paths
- `.vscode/launch.json`, `.vscode/tasks.json`, `.vscode/settings.json`, `.gitignore` — build-output paths
- `CLAUDE.md`, `AGENTS.md` (byte-identical) — `area/dashboard` label package-name citation
- `codev/resources/arch.md` — Monorepo Structure (apps/ vs packages/ + artifact-canvas row), tree, diagrams, `dashboard-dist` source path
- `codev/resources/lessons-learned.md` — new Architecture lesson (this PR)
- `codev/protocols/release/protocol.md`, `docs/releases/UNRELEASED.md` + template — release runbook vscode paths

**Added (3):** the plan, this review, and `codev/state/pir-855_thread.md`.

## Commits

- `9e2cc6b5` [PIR #855] Rename @cluesmith/config -> @cluesmith/codev-config for naming consistency
- `df1fcdba` [PIR #855] Update remaining path refs: release runbook, publish script, doc comments
- `c4e8876e` [PIR #855] Update builder thread: implement phase log
- `a57fe07b` [PIR #855] Update arch.md + CLAUDE/AGENTS for apps/ layout
- `7f57a7ff` [PIR #855] Move vscode+dashboard to apps/; rename dashboard package to codev-web
- (plus 4 plan-phase commits: `89ae5464`, `fefa4325`, `5587aad1`, `ec65235c`)

## Test Results

- `pnpm build`: ✓ pass (full `tsc` across all packages + `build:dashboard` + skeleton copy)
- Unit suites (CI's full unit matrix): ✓ **core 41 · artifact-canvas 73 · codev 3482/48 skip · web 323/1 skip · vscode 643** (`types`/`config` have no test scripts). All skips pre-existing.
- **Embedding verification** (the load-bearing risk): from a clean state (wiped `dashboard-dist`), `pnpm build` regenerated the SPA via the corrected `cd ../../apps/web` path; `npm pack` confirmed all 4 `dashboard-dist/` files ship in the publishable tarball; runtime serve path (`tower-server.ts:301 → ../../../dashboard-dist`) is unchanged (codev never moved). `@cluesmith/codev` still embeds the web UI exactly as before.
- Manual verification (dev-approval gate): human approved after reviewing the diff + in-worktree build/test (no `worktree.devCommand` configured, so no `afx dev` server).

See **Flaky Tests** below for the integration/CLI/e2e suites.

## Architecture Updates

**COLD `codev/resources/arch.md` — updated (commit `a57fe07b`).** The Monorepo
Structure section now documents the `apps/` (end-user surfaces) vs `packages/`
(shared libraries) split, adds the missing `artifact-canvas` row, and corrects
the directory tree, architecture diagrams, and the `dashboard-dist` source path.

**HOT `codev/resources/arch-critical.md` — no change needed.** The hot tier is at
its 10-fact cap, and its map already carries "Monorepo Structure — consult when
adding a package or build wiring," which points at the updated cold section. The
apps/ split is a navigational/structural fact, not a per-decision invariant that
warrants displacing an existing hot fact.

## Lessons Learned Updates

**COLD `codev/resources/lessons-learned.md` — added one Architecture entry
`[From #855]`** capturing the non-obvious insight: in a pnpm monorepo package
move, the breakage surface is *relative filesystem paths* (build-script `cd`,
tsconfig `extends`, CI `working-directory`, gitignore globs), not the package
graph (`workspace:*`/publish key off the name, so they survive `git mv`); and a
package consumed only via a relative path has a name that is dead metadata
(pnpm-lock doesn't record it), which is both why renaming `@cluesmith/config` was
zero-risk and why its name had drifted from convention unnoticed.

**HOT `codev/resources/lessons-critical.md` — no change needed.** The existing hot
lesson "After any rename or framework change, grep the whole repo across BOTH
codev/ and codev-skeleton/ before claiming 'all fixed'" already covers the
top-level discipline; the #855 entry is a spec-narrow sharpening that belongs in
the cold reference.

## Things to Look At During PR Review

- **`packages/codev/package.json` `build:dashboard`** — the one edit with real
  runtime consequence. Only the `cd` target changed (`../dashboard` →
  `../../apps/web`); the `../../packages/codev/dashboard-dist` copy destination is
  unchanged because `apps/web` sits at the same depth-2 from root as
  `packages/dashboard` did. Verified end-to-end (see Test Results).
- **Scope beyond the approved plan:** two consistency renames were added at the
  dev-approval gate on reviewer request — the `codev-web` package rename (Decision
  2, always in-plan) and the `@cluesmith/config` → `@cluesmith/codev-config` rename
  (added mid-gate; recorded in the plan's "Files to Change" note and the thread).
- **"Dashboard" the word stays** (Decision 3): this is a directory + package-name
  change only. The `area/dashboard` label, `dashboard-dist` build identifier,
  `DashboardState` type, and product/UI copy are intentionally untouched.
  Retiring "Dashboard" → "Web" globally was explicitly deferred as a separate issue.
- **Historical records left as-is:** `codev/specs|plans|reviews|projects|state|maintain`,
  `codev/projectlist.md`, and shipped `docs/releases/v*` still reference old paths
  by design (point-in-time records); only *live* references were updated.

## Consultation (3-way review, single advisory pass)

- **Claude: APPROVE** (HIGH) — "clean mechanical restructuring; all plan items
  implemented; no stale operational references; CLAUDE.md/AGENTS.md byte-identical."
- **Codex: REQUEST_CHANGES** (HIGH) — 3 findings, all legitimate, all addressed:
  1. **`apps/vscode` compile/typecheck path never verified.** Correct and important:
     root `pnpm build` excludes vscode, and `test:unit` (vitest/esbuild) does not run
     the tsconfig project chain — so the `extends → ../../packages/config/...` fix was
     unproven. **Disposition: verified + guarded.** Ran `pnpm --filter codev-vscode
     check-types` (both `tsc --noEmit` passes) and `compile` (esbuild bundle) — both
     green from the new location, so the code was correct. Added a **`check-types` step
     to the vscode CI job** (`.github/workflows/test.yml`) so this path is guarded
     automatically. No code fix was needed.
  2. **Review's "How to Test Locally" gave commands that don't exercise the moved
     suites** (root `pnpm test`/`pnpm build` skip the apps). **Disposition: fixed** —
     the section now lists per-package commands and calls out `check-types` as the real
     proof of the tsconfig fix.
  3. **`arch.md` table cell said `codev (Marketplace)`** but the extension is
     `codev-vscode` / `cluesmith.codev-vscode`. **Disposition: fixed** — corrected the
     cell (a pre-existing inaccuracy, corrected since this PR edits that row).

  Per PIR's single-pass design, these fixes were **not** independently re-reviewed —
  the human at the `pr` gate is the remaining check.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-855` → **Review Diff**
- **What to verify** (note: root `pnpm test` runs *only* `--filter @cluesmith/codev`,
  and root `pnpm build` does *not* build `apps/vscode` — so exercise the moved
  packages explicitly):
  - `pnpm install && pnpm build` from the worktree — green; `packages/codev/dashboard-dist/`
    populates (index.html + assets) — proves the `build:dashboard` path fix + embedding
  - `pnpm --filter @cluesmith/codev-web test` — the moved web suite (323 tests)
  - `pnpm --filter codev-vscode check-types && pnpm --filter codev-vscode test:unit` —
    **`check-types` is the real proof of the `tsconfig extends` fix** (runs `tsc --noEmit`
    on both tsconfigs from the new location; vitest alone does not typecheck the project)
  - `pnpm --filter @cluesmith/codev test` — the codev suite (3482 tests)
  - `git log --follow apps/web/package.json` shows history across the rename
  - `grep -rn "packages/dashboard\|packages/vscode" <live files>` returns nothing
    outside historical records

## Flaky Tests

None *skipped* — but the environment-sensitive suites surfaced pre-existing
failures unrelated to this change (my diff's only non-test `packages/codev/src`
edit is a single comment line in `default-branch.ts`; these suites exercise PTY
spawning, network, and port-binding — code paths this PR never touches):

- **Tower integration** (`vitest.e2e.config.ts`): 3 failures, **flaky** — runs 1
  and 2 failed on *different* tests, all with `POST /api/terminals → 500`
  (node-pty/shellper failing to spawn under concurrent local load). Non-determinism
  across runs on identical code = environmental. Passes on CI's isolated runners.
- **CLI** (`vitest.cli.config.ts`): 1 failure —
  `adopt.e2e.test.ts › with existing CLAUDE.md preserves it` **times out at 30s**
  (a timeout on the network/merge-heavy adopt path in a sandboxed env, not a
  content assertion; operates on an isolated temp project, not the repo's CLAUDE.md).
- **Playwright dashboard-e2e**: not run locally — its `webServer` binds port 4100
  (`reuseExistingServer: true`) against a non-isolated `global.db`, so running it
  mid-session would risk the live Tower. CI-appropriate only.

porch's gate `tests` check (the codev unit suite) is green; these suites are not
part of the gate checks.
