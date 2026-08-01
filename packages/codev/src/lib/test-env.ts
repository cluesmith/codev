/**
 * Test-runner detection and the escape hatches that go with it (#1323).
 *
 * Two consult side effects are *user-global*: spawning the real `agy` binary
 * (which opens a browser login window when agy is unauthenticated) and writing
 * to `~/.codev/metrics.db`. Both used to be reachable from the test suites by
 * simple omission — a test that never pinned `CODEV_AGY_BIN` resolved the
 * developer's real binary, and every in-process test recorded metrics into the
 * developer's real database.
 *
 * The vitest harness (`vitest-setup.ts`) now pins a sandbox for both. These
 * helpers are the belt-and-braces half: production code consults them so that a
 * *future* test which slips past the harness fails loudly instead of silently
 * reaching the real world.
 */

/**
 * True when this process is running under a test runner.
 *
 * `VITEST` is set by the runner and covers every suite Codev actually has;
 * CLI-integration and e2e tests spawn `codev` / `consult` children with
 * `{ ...process.env }`, so children inherit it and fall under the same guards.
 *
 * `CODEV_TEST_ISOLATION` is the opt-in for a harness that is not vitest. It is
 * deliberately a name Codev owns: these guards make `consult` *throw*, so a
 * false positive breaks a real consultation. A generic marker like `CODEV_TEST`
 * or `CI` could already be exported in an adopter's environment for unrelated
 * reasons, and inheriting someone else's variable is not worth the blast radius.
 */
export function isUnderTestRunner(): boolean {
  return Boolean(process.env.VITEST || process.env.CODEV_TEST_ISOLATION);
}

/**
 * Explicit opt-in for deliberately exercising the REAL `agy` binary from a test.
 *
 * Unset by default, so no suite can spawn the real CLI by accident. Set it to
 * run the guarded real-agy integration smoke, or a real-AI e2e benchmark:
 *
 *   CODEV_ALLOW_REAL_AGY=1 pnpm --filter @cluesmith/codev test:e2e:cli
 *
 * When set, the vitest harness leaves `CODEV_AGY_BIN` alone and the lane guard
 * stands down — you get the real binary, and the real browser tab if agy's
 * login has lapsed.
 */
export function realAgyOptIn(): boolean {
  const raw = process.env.CODEV_ALLOW_REAL_AGY;
  return raw === '1' || raw === 'true';
}

/**
 * Guard the gemini (agy) lane against spawning the real binary from a test.
 *
 * Throws when running under a test runner with neither an explicit
 * `CODEV_AGY_BIN` pin nor the real-agy opt-in. Deliberately louder than the
 * lane's usual non-blocking skip: a misconfigured test must fail the suite, not
 * quietly degrade to a COMMENT verdict (which would hide the misconfiguration
 * on a machine where agy simply isn't installed).
 */
export function assertAgyLaneAllowedUnderTest(): void {
  if (!isUnderTestRunner()) return;
  if (realAgyOptIn()) return;
  if (process.env.CODEV_AGY_BIN) return;
  throw new Error(
    'Refusing to resolve the agy binary under a test runner without a pinned ' +
    'CODEV_AGY_BIN (#1323). This test reached the gemini consult lane by ' +
    'omission and would have spawned the real Antigravity CLI — one browser ' +
    'login window per spawn when agy is unauthenticated. Pin a fake binary ' +
    '(the vitest harness in vitest-setup.ts does this for every suite), or set ' +
    'CODEV_ALLOW_REAL_AGY=1 if this test genuinely means to run the real CLI.',
  );
}
