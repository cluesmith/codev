# PIR Review: open-architect must not substitute a different architect while claiming to be `main`

Fixes #1497

## Summary

`codev.openArchitectTerminal` resolved a non-live `main` to `architects[0]` (a different architect) while flowing the requested name `'main'` onward, so in `terminal-manager.ts` — where the architect name is an address twice over (the `architect:${name}` terminal-cache key and the `injectArchitectText` lookup) — the wrong architect's terminal was cached under `architect:main`, wore the unqualified "Codev: Architect" label, and captured any text later injected at `'main'`. This fix removes the `|| 'main'` fallback so a non-live `main` refuses with the existing warning, and flows the resolved occupant's *own* name onward so the cache key, label, and injection always address the real occupant.

## Files Changed

- `apps/vscode/src/open-architect.ts` (+83 / -0) — new module: `resolveArchitectTarget` (exact-name, no fallback) + `openResolvedArchitect` (opens under the occupant's own name, or refuses)
- `apps/vscode/src/extension.ts` (+11 / -9) — the command delegates to `openResolvedArchitect`
- `apps/vscode/src/terminal-manager.ts` (+6 / -0) — invariant comment at the `openArchitect` cache-key line
- `apps/vscode/src/__tests__/open-architect-not-live-main.test.ts` (+163 / -0) — new regression tests
- `apps/vscode/src/__tests__/extension-architect-commands.test.ts` (+8 / -1) — source guard updated for the delegation
- `codev/resources/lessons-learned.md` (+2 / -0) — name-as-address lesson + vitest-needs-built-dist lesson

## Commits

- `bb9314444` [PIR #1497] Refuse non-live 'main' in open-architect instead of substituting architects[0]
- `6bba74ee8` [PIR #1497] Regression tests for not-live-'main' resolution and injection routing
- `6d04d3dbf` [PIR #1497] Update builder thread: implement phase
- (+ this review commit)

## Test Results

- `pnpm check-types`: ✓ pass (after building `codev-types`, `codev-sdk`, `artifact-canvas` — see below)
- `pnpm test:unit` (vitest): ✓ pass — 856 tests, 73 files (10 new in this PR)
- `pnpm lint`: ✓ clean on changed files
- `node esbuild.js`: ✓ bundles
- Porch phase checks (`build`, `tests`): ✓ pass
- Manual verification (dev-approval gate): approved by the human on their machine — the live round-trip (real Tower pty + VSCode UI) is what the builder shell cannot run; see "How to Test Locally".

## Architecture Updates

No HOT arch change (`arch-critical.md` untouched): this is a localized bug fix inside `apps/vscode`, adding one small helper module without changing a module boundary, a system-shape invariant, or any cross-package contract. The one new file (`open-architect.ts`) is an extraction of a single command's resolution step for testability, not a new subsystem — below the threshold for an `arch.md` entry.

## Lessons Learned Updates

Routed two entries to COLD `codev/resources/lessons-learned.md` (HOT `lessons-critical.md` is at its 10-entry cap and neither entry is universal enough to justify displacing an existing hot lesson):

- **Architecture** — the `|| 'main'`-as-address pattern: a name that is only a caption can carry a convenience fallback safely, but the moment it keys an action (cache key, lookup, routing target) the fallback becomes a misdelivery bug. Records the two structural defenses (flow the occupant's own name; drop a fallback whose entire realized behaviour is the failure window) and the deliberate non-divergence from pir-1494 (both refuse). Sibling to the existing #1139 lesson on the same command.
- **Testing** — a vitest test that value-imports a workspace package needs that package's `dist` built first; companion to the #907 esbuild lesson, on the vitest side.

## Things to Look At During PR Review

- **The design decision (refuse vs substitute).** The plan flagged that sibling lane pir-1494 answers the same "fall back to `main`?" question by refusing, and the architect asked for the choice here to be deliberate. This lane also **refuses** (removes the fallback), argued on: the fallback has no healthy execution path (only ever consulted when `main` is absent), caller intent (a request for `main` wants `main`), convention-convergence with pir-1494, and the issue thread's stated deck preference. **Option B** (open the substitute under its own name/label) was considered and is a one-line change in `resolveArchitectTarget` — because `openResolvedArchitect` already flows `target.name`, switching to B needs no other change. If a reviewer prefers B, it is a trivial, safe switch.
- **The injection-capture test imports the real `TerminalManager`.** It is the first vscode unit test to do so, and only resolves because CI's `test.yml` runs `pnpm build` before vitest (so `codev-types`/`codev-sdk` `dist` exist). Porch's own `tests` check passed, confirming the ordering holds in this harness. If you run `vitest` in isolation without a prior build, this file will fail to load — build the workspace first.
- **Structural safeguard vs policy.** `openResolvedArchitect` passing `target.name` (not the requested `targetName`) is what holds the invariant "no terminal is cached under `architect:<name>` while hosting a different architect" under *any* policy — worth a look to confirm it reads clearly.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1497` → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1497`
- **What to verify** (needs a real workspace — a live `openArchitect` dials a Tower pty, so this cannot run headless):
  - Workspace with a named architect (e.g. `web`) plus `main`. Stop/restart so `main` is momentarily absent → invoke **Open Architect Terminal** for `main` (or the #1463 deck key set to Main). Expect: the "No 'main' architect found — is the workspace activated?" warning and **no terminal opens**. Then trigger **Reference Issue in Architect** on a backlog row → the reference text appears in **no terminal**, and specifically not in `web`'s. (Pre-fix: `web`'s terminal opened under the bare "Codev: Architect" label and received the text.)
  - With `main` live: the same two actions open `main`'s terminal and land the reference text there.

## Flaky Tests

None. One pre-existing, unrelated `check-types` failure (`src/markdown-preview/webview/main.ts` cannot resolve `@cluesmith/codev-artifact-canvas`) is a missing-build-artifact, not a flake and not caused by this diff — it clears once `artifact-canvas` is built, which CI does in a dedicated step. Untouched file; noted here rather than fixed (out of scope).
