# bugfix-1956 — the packages/codev unit suite loads an 18-core Mac to 59

Scope is the issue's last architect comment (2026-11-24): replace the dead `poolOptions` block
with Vitest 4 top-level options, choose a cap deliberately, check the other vitest configs,
add a test asserting the resolved cap, and one owner-approved full local run as verification.

## Investigate (2026-11-23)

Verified against the installed vitest 4.1.4 (not memory):

- `test.poolOptions` is ignored. `dist/chunks/coverage.*.js` resolveConfig only logs the
  deprecation for it; nothing in `dist/` reads `singleFork`.
- With no `maxWorkers`, `resolveMaxWorkers()` in `dist/chunks/cli-api.*.js` returns
  `availableParallelism() - 1` in run mode and `floor(n/2)` in watch mode. So 17 files at
  once on the 18-core Mac. GitHub's ubuntu-latest has 4 vCPUs (the repo is public), so 3 there.
- The v4 migration guide (v4.vitest.dev/guide/migration, "Pool Rework"): `maxThreads`/
  `maxForks` → `maxWorkers`; `singleFork` → `maxWorkers: 1, isolate: false`;
  `VITEST_MAX_FORKS`/`VITEST_MAX_THREADS` → `VITEST_MAX_WORKERS`. The installed resolveConfig
  reads `VITEST_MAX_WORKERS` natively, so an env override needs no code of ours.
- Types: `maxWorkers?: number | string` is top-level on `test`.

Other configs: no other `poolOptions` anywhere. `vitest.cli.config.ts` and
`vitest.e2e.config.ts` (same package, spawn-heavy: built binary / real Tower servers) have no
cap either. `vitest.e2e.config.ts` sets `maxConcurrency: 1` with the comment "Run
sequentially", but `maxConcurrency` only limits `test.concurrent` tests inside one file. It
does not stop files running in parallel.

Reproduced without a full run:

- `resolveConfig()` from `vitest/node` on the current `vitest.config.ts` prints the
  deprecation and gives `maxWorkers: undefined`, `isolate: true`, effective 17 on this Mac.
  Same for the cli and e2e configs (no deprecation, also uncapped).
- 8 small pure test files under the current config: peak 9 live node children of the vitest
  process (8 forks + esbuild). With a single fork it would be 2.

Also learned: under `isolate: true` (the default, kept) every file gets a fresh fork that ends
after the file. Porch's tests check has a 5-minute default timeout and no internal retry. One
`porch done` is one suite run. GitHub runs the suite in 2m13s at 3 workers with coverage on.

Cap decision: vitest's default on GitHub's 4-vCPU runners (ubuntu-latest and windows-latest,
public repo) is `cpus - 1 = 3`, not 4. A cap of 3 means CI keeps its current parallelism; a
cap of 4 would raise it on both. Told the architect I'm going with 3 unless they say 4.

## Fix (2026-11-23)

- `packages/codev/vitest-workers.ts`: `MAX_WORKERS = 3`, used by `vitest.config.ts` (replacing
  the dead `poolOptions` block), `vitest.cli.config.ts` and `vitest.e2e.config.ts`. The
  architect agreed to 3 over 4 because it is CI's existing parallelism.
- Comment fixes: `vitest-setup.ts` (no longer claims singleFork shares one process) and the
  e2e config's `maxConcurrency: 1 // Run sequentially` (it never did that).
- Regression test `src/__tests__/bugfix-1956-vitest-worker-cap.test.ts`: `resolveConfig()` on
  each of the three configs must give `maxWorkers === 3`. Failed 3/3 before, passes 3/3 after.

Targeted (before the full run): the 8-file probe peaks at 3 forks (was 8);
`VITEST_MAX_WORKERS=1` gives 1. The issue's 10 spawn-heavy files run together: 239 tests in
36 s, peak load 4.4.

## The one full verification run (owner-approved), via `porch done` (2026-11-23 17:15 PST)

- Green: build check 18.5 s, tests check 137.1 s. All 429 files pass, 0 failures.
- One-minute load: 4.55 when vitest started, **peak 8.14** during the tests, 6.29 at the end
  (was 30 to 59 uncapped). Live descendants of vitest: peak 14, median 7.
- Not a quiet machine: other worktrees' vitest runs (spir-1940, bugfix-1853, targeted) were
  alive in 107 of 118 test-phase samples, up to 2 at once.
- Per-file (vitest results cache): slowest are spec-1280-measurement-instrument 35 s,
  session-manager 28 s, pir-1233-session-launch-loop 22.5 s, tunnel-e2e 19.5 s,
  claude-cli-lane 18.3 s. The issue's 10 spawn-heavy files total 73 s in the full run against
  89 s alone at the cap, so their times are normal for them, not load-inflated.
