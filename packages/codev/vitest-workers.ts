/**
 * How many test files run at once, shared by every packages/codev vitest config (#1956).
 *
 * Without a cap, vitest runs `os.availableParallelism() - 1` files at once: 17 on an
 * 18-core Mac. The suite's process-spawning tests then load the machine past their own
 * 5 s timeouts. (Vitest 4 removed `poolOptions`, so the `singleFork` this replaces had been
 * ignored since the upgrade.)
 *
 * 3 is what vitest already picks on GitHub's 4-vCPU runners (ubuntu-latest and
 * windows-latest), so CI keeps its parallelism and a developer machine runs the suite the
 * way CI does. For one run, vitest's own `VITEST_MAX_WORKERS` overrides it.
 */
export const MAX_WORKERS = 3;
