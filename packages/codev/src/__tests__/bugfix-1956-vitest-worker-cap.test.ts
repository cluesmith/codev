/**
 * Issue #1956: every packages/codev vitest config must cap how many test files run at once,
 * as vitest itself resolves the config.
 *
 * Vitest 4 removed `test.poolOptions`, so the old `poolOptions.forks.singleFork: true` was
 * ignored and vitest fell back to `os.availableParallelism() - 1` workers: 17 parallel forks
 * on an 18-core Mac, enough load that the suite's own process-spawning tests timed out.
 * Reading the config file's keys would not have caught it (the key was there; vitest
 * ignored it), so this resolves each config through vitest's public `resolveConfig` and
 * checks the worker count vitest will actually use.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from 'vitest/node';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** vitest's own default on GitHub's 4-vCPU runners (cores - 1); see `vitest-workers.ts`. */
const EXPECTED_MAX_WORKERS = 3;

describe('vitest worker cap (#1956)', () => {
  // `VITEST_MAX_WORKERS` is vitest's per-run override; a shell that exports it must not
  // decide what this test reads.
  let savedOverride: string | undefined;
  beforeEach(() => {
    savedOverride = process.env.VITEST_MAX_WORKERS;
    delete process.env.VITEST_MAX_WORKERS;
  });
  afterEach(() => {
    if (savedOverride === undefined) delete process.env.VITEST_MAX_WORKERS;
    else process.env.VITEST_MAX_WORKERS = savedOverride;
  });

  it.each(['vitest.config.ts', 'vitest.cli.config.ts', 'vitest.e2e.config.ts'])(
    '%s resolves to a cap of 3 workers',
    async (config) => {
      const { vitestConfig } = await resolveConfig({
        root: PACKAGE_ROOT,
        config,
        watch: false,
        run: true,
      });
      expect(vitestConfig.maxWorkers).toBe(EXPECTED_MAX_WORKERS);
    },
  );
});
