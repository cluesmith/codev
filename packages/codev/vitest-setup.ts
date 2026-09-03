/**
 * Global test harness — sandboxes every user-global side effect a suite can
 * reach (#1323). Wired into all three vitest configs via `setupFiles`.
 *
 * Two escapes motivated this file:
 *
 *  1. Any test that reached the gemini consult lane without pinning
 *     `CODEV_AGY_BIN` resolved the developer's REAL `agy` binary and spawned it.
 *     With agy's login lapsed that is one browser window per spawn — the #1077
 *     forkbomb, back through the test path that PR #1250 explicitly scoped out.
 *  2. In-process tests ran under the developer's real `HOME`, so every
 *     `recordMetrics()` call appended junk rows (with temp-dir workspace paths)
 *     to the real `~/.codev/metrics.db`, silently skewing `consult stats`.
 *
 * Both are failures of *omission*: safety depended on each test remembering to
 * opt out. This harness inverts that — the sandbox is on by default and a test
 * must opt in, explicitly and by name, to touch the real thing.
 *
 * Subprocess coverage is free: the CLI helpers spawn `codev` / `consult` with
 * `{ ...process.env }`, so children inherit these pins. The complementary guards
 * in `src/lib/test-env.ts` catch anything that still slips past.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realAgyOptIn } from './src/lib/test-env.js';

/**
 * Stand-in for the Antigravity CLI: no network, no browser tab, no OAuth. It
 * answers `--version` (so `agyRespondsToVersion` accepts it) and appends its
 * argv to `$CODEV_TEST_AGY_LOG` when set — the hook the isolation canary uses to
 * prove that no suite invoked the real binary.
 */
const FAKE_AGY = `#!/bin/sh
# Fake agy installed by the Codev vitest harness (#1323). See vitest-setup.ts.
if [ -n "$CODEV_TEST_AGY_LOG" ]; then
  printf '%s\\n' "fake-agy $*" >> "$CODEV_TEST_AGY_LOG"
fi
case "$1" in
  --version) echo "codev-fake-agy 0.0.0" ;;
  *) echo "VERDICT: COMMENT" ;;
esac
exit 0
`;

/**
 * setupFiles re-executes for every test file, but with `singleFork` all ~200 unit
 * files share one process. Creating a sandbox (and registering an exit hook) per
 * file would mean ~200 temp dirs and ~200 listeners on the same emitter — enough
 * to trip Node's MaxListenersExceededWarning. Cache on globalThis so the setup is
 * genuinely one-shot per process.
 */
const SANDBOX_KEY = '__codevTestSandbox1323';
const g = globalThis as Record<string, unknown>;
const firstRun = typeof g[SANDBOX_KEY] !== 'string';
if (firstRun) g[SANDBOX_KEY] = mkdtempSync(join(tmpdir(), 'codev-test-sandbox-'));
const sandbox = g[SANDBOX_KEY] as string;

// Pin the gemini lane to a fake binary. Unconditional by design: a shell that
// already exports CODEV_AGY_BIN must not be able to feed the real CLI back into
// the suites. CODEV_ALLOW_REAL_AGY is the single, named way through.
if (!realAgyOptIn()) {
  const fakeAgy = join(sandbox, 'agy');
  writeFileSync(fakeAgy, FAKE_AGY, { mode: 0o755 });
  process.env.CODEV_AGY_BIN = fakeAgy;
}

// Keep the #1077 auth cache ACTIVE but sandboxed. `agyAuthCacheDisabled()` turns
// itself off under VITEST unless a directory is named, which is what left burst
// protection inert for tests; naming one here restores it without writing into
// the developer's real ~/.cache/codev.
if (!process.env.CODEV_AGY_AUTH_CACHE_DIR) {
  process.env.CODEV_AGY_AUTH_CACHE_DIR = join(sandbox, 'agy-auth-cache');
}

// Mirror the real `~/.codev/metrics.db` layout inside the sandbox so metrics
// writes land here instead of the user-global database.
if (!process.env.CODEV_METRICS_DB) {
  const metricsDir = join(sandbox, '.codev');
  mkdirSync(metricsDir, { recursive: true, mode: 0o700 });
  process.env.CODEV_METRICS_DB = join(metricsDir, 'metrics.db');
}

// Point the whole user-global Agent Farm tree (cloud credentials, `local-key`,
// `global.db`) into the sandbox (#1597). Without this, `ensureLocalKey()` —
// reached in-process via the e2e fetch patch and `towerWsProtocols()`, and by
// any suite touching core auth — read AND created the developer's real
// `~/.agent-farm/local-key`. Auth stays consistent end-to-end because both
// sides derive from the same call: `createIsolatedAgentFarmDir()` seeds each
// spawned test Tower with a copy of whatever key `ensureLocalKey()` resolves
// here. The env var must be set before `@cluesmith/codev-core` is first
// imported (its key path is a module-load const); `setupFiles` order guarantees
// that for `vitest-e2e-setup.ts`. A pre-set value is respected — exporting
// `CODEV_AGENT_FARM_DIR` is the one named way to point suites elsewhere.
if (!process.env.CODEV_AGENT_FARM_DIR) {
  const agentFarmDir = join(sandbox, '.agent-farm');
  mkdirSync(agentFarmDir, { recursive: true, mode: 0o700 });
  process.env.CODEV_AGENT_FARM_DIR = agentFarmDir;
}

if (firstRun) {
  process.on('exit', () => {
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // A sandbox we cannot remove is temp-dir litter, never a failed test run.
    }
  });
}
