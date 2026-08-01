# bugfix-1323 — Test-suite consult runs escape isolation

Issue #1323: test suites spawn the real `agy` binary (login-window burst) and write
into the user-global consult metrics DB.

## Investigate — root cause

Two **independent** escapes. Both are "unsafe by omission": nothing in the harness
pins anything, so a test that simply *doesn't* set an env var reaches the real world.

### 1. Real `agy` spawn (the login-window burst)

- None of the three vitest configs (`vitest.config.ts`, `vitest.cli.config.ts`,
  `vitest.e2e.config.ts`) declares `setupFiles`. **There is no global test harness at all.**
- `resolveAgyBin()` (`commands/consult/index.ts:743`) falls back to `~/.local/bin/agy`
  and then PATH when `CODEV_AGY_BIN` is unset. A test that reaches the gemini lane
  without pinning therefore resolves the developer's real binary.
- `src/__tests__/cli/agy-integration.e2e.test.ts` does exactly this **by design** — it
  deliberately does not mock `node:child_process`, calls `resolveAgyBin()` and
  `_runAgyConsultation()` directly (2 tests), and spawns the built `consult` CLI as a
  subprocess (1 test). That is the CLI-integration lane the issue points at.
- The #1250 burst protection is inert here: `agyAuthCacheDisabled()`
  (`agy-auth-cache.ts:113`) returns true whenever `VITEST` is set and
  `CODEV_AGY_AUTH_CACHE_DIR` is not. Child `consult` processes inherit `VITEST`
  (`helpers.ts:setupCliEnv` spreads `process.env`), so they are inert too.
  Pre-flight off + real binary = unconditional spawn = one browser tab per spawn.

### 2. Metrics-DB pollution (a *separate* bug, same timestamp window)

- `MetricsDB`'s path is hardcoded: `join(homedir(), '.codev', 'metrics.db')`
  (`metrics.ts:14-15`), **no env override**.
- Unit tests run in-process under the developer's real `HOME`, so every
  `recordMetrics()` call lands in the real user-global DB.
- The junk rows map exactly: `codev-consult-test-<ts>` → `src/__tests__/consult.test.ts`
  (the gemini rows), `codex-test-XXXXXX` →
  `commands/consult/__tests__/codex-sdk.test.ts` (the codex rows).

**Correction to the issue's reading:** the 0.0s gemini rows — including the one carrying
`error_message: "agy timed out producing the review"` — come from `consult.test.ts`,
which mocks `node:child_process` at module scope. That message is emitted by the test's
own fake process, not by a real agy spawn. So the fingerprint in `consult stats` is
evidence of escape #2, not escape #1; escape #1 is real but lives in the CLI-integration
lane and leaves no metrics rows (its subprocesses run under a sandboxed `HOME`). Both
bugs are real, they just aren't the same event.

`preflightAgyAuth()` itself never spawns agy — it only reads the cache and takes a lock —
so enabling the auth cache under test (with a sandboxed dir) is safe.

## Fix shape (est. well under 300 LOC)

1. New shared vitest `setupFiles` harness wired into all three configs: unconditionally
   pin `CODEV_AGY_BIN` to a generated fake, `CODEV_AGY_AUTH_CACHE_DIR`, and a new
   `CODEV_METRICS_DB`, all inside a per-run temp dir. Subprocess helpers inherit these
   for free via `...process.env`.
2. Belt-and-braces guard in `runAgyConsultation`: under a test runner, with no pinned
   `CODEV_AGY_BIN` and no explicit opt-in, **throw** instead of spawning.
3. `CODEV_METRICS_DB` override in `metrics.ts`; refuse the user-global path under a
   test runner.
4. `CODEV_ALLOW_REAL_AGY=1` opt-in for deliberate real-agy runs; gate
   `agy-integration.e2e.test.ts` behind it.

Order of work follows the architect's instruction: **pin first**, verify with the canary,
then iterate. agy is authenticated right now but that is not something to rely on.

## Fix — progress

Pin landed first, as instructed, before running any suite.

Implemented: `vitest-setup.ts` harness wired into all three configs; `src/lib/test-env.ts`
guards; `CODEV_METRICS_DB` in `metrics.ts`; guard at both real-spawn sites
(`runAgyConsultation` **and** `doctor.ts:verifyAgy` — doctor is a second way into
agy that the issue didn't mention); `agy-integration.e2e.test.ts` gated behind
`CODEV_ALLOW_REAL_AGY=1`.

### What the guard caught

First guarded run failed 11 tests in `doctor.test.ts`. Cause: `delete
process.env.CODEV_AGY_BIN` in `finally` blocks wiped the harness pin for the rest of
the file, so later `doctor()` calls reached `verifyAgy()` unpinned. **Not** real spawns
— that file mocks `node:child_process` wholesale — so it was safe *by accident* (the
module mock, not the pin, was doing the work). Fixed by restoring the captured value
instead of deleting; same antipattern fixed in `consult.test.ts`.

### Resolved: the "intermittent metrics leak" was a confounded measurement

Full run #2 added 0 rows; run #3 added **21** (hermes/claude/gemini shaped like
`consult.test.ts`, codex like `codex-sdk.test.ts`), which looked like my fix failing
intermittently. It wasn't.

Row-count delta on `~/.codev/metrics.db` is **not** a valid instrument on this machine:
the DB is user-global and shared, `ls ../` shows ~34 sibling builder worktrees, and
`ps` showed **101 vitest processes** running concurrently. Sibling builders on
un-fixed branches were writing exactly those rows while my suite ran. Between run #4
and run #5 the count rose by 64 with **no test run of mine in between** — proof the
instrument was measuring other agents.

The correct instrument is "did *my* suite ever open the user-global DB", answered by
logging every `MetricsDB` path in the constructor. Result on a full unit run: **19
opens, all to the sandbox; zero to `~/.codev/metrics.db`.** Same run, row delta 0.

Lesson worth keeping: on a shared machine, a global counter is evidence about the
machine, not about your change. Instrument the code path, not the side effect.

## Canary result (acceptance criterion 1)

Temporarily instrumented `resolveAgyBin()` to log every resolution, and the
`MetricsDB` constructor to log every path, then ran the full unit + CLI-integration
suites. Instrumentation removed afterwards; the permanent equivalents are the guards
plus `test-isolation.test.ts`.

- **Every** `resolveAgyBin()` call across both suites had `override=` set to a
  temp-dir fake. Zero calls with no override — and no override is the only way to
  reach `~/.local/bin/agy` or PATH. Three distinct pids, all `VITEST=true`.
- **Zero** `MetricsDB` opens against `~/.codev/metrics.db`; 19 opens, all sandbox
  or explicit test paths.
- Unit: 205 files / 4085 tests pass. CLI-integration: 8 files / 91 tests pass.

`spec-1280-measurement-instrument.test.ts` failed intermittently along the way. Not
mine: it shells out to `measure-prompt-surface.sh` (~2.0s per call, 2-3 calls per test,
5s default timeout) and the machine was running 100+ concurrent vitest processes. A
back-to-back A/B against a clean clone of `main` had both trees pass with identical
duration (23.79s vs 23.71s), and the script itself times the same in both. Left alone.

## Architect instruction (2026-08-01T13:20Z)

PR #1324 is a stopgap that `describe.skip`s `agy-integration.e2e.test.ts`. Once it
merges: merge main into this branch and **re-enable that suite** under the fake-agy pin
/ no-browser guard, so the coverage comes back. Added to acceptance criteria.

## Late correction (2026-08-01T13:31Z)

Architect reverted the machine-wide agy rename; agy is back on PATH. No effect on this
work — the canary above shows every resolution goes through a pinned fake regardless of
whether a real agy exists, and the real-agy suite needs `CODEV_ALLOW_REAL_AGY=1`.

Also renamed the non-vitest detection knob `CODEV_TEST` → `CODEV_TEST_ISOLATION`. These
guards make `consult` *throw*, so a false positive breaks a real consultation; a generic
name an adopter might already export is not worth that blast radius.

## Note on PR #1324

The merge conflict in `agy-integration.e2e.test.ts` was resolved by **re-enabling** the
suite (`describe`, not `describe.skip`), per the architect's 13:20Z instruction to make
restoring that coverage part of this fix. #1324's stated re-enable condition — "once the
suite pins a fake agy (or an equivalent no-browser guard)" — is exactly what landed here.
Flagging it explicitly since the merge undoes a hotfix that is only minutes old.
