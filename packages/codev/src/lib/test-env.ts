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
 * Guard the gemini (agy) lane against reaching the real binary from a test.
 *
 * Throws when running under a test runner with neither an explicit
 * `CODEV_AGY_BIN` pin nor the real-agy opt-in. Deliberately louder than the
 * lane's usual non-blocking skip: a misconfigured test must fail the suite, not
 * quietly degrade to a COMMENT verdict (which would hide the misconfiguration
 * on a machine where agy simply isn't installed).
 *
 * **Where this is called, and why there.** There is exactly one call site:
 * `resolveAgyBin()`, in the branch taken when `CODEV_AGY_BIN` is unset. That is
 * the chokepoint — every route to the real binary passes through it, and there
 * is more than one route:
 *
 *   - `runAgyConsultation()` — the consult lane (`consult -m gemini`)
 *   - `doctor.ts:verifyAgy()` — `codev doctor`'s OAuth probe, a second spawn
 *     site that issue #1323 did not mention
 *   - `doctor.ts:checkAgy()` — presence check; does not spawn, but resolution
 *     itself is not passive
 *
 * That last point is the reason the guard sits at resolution rather than at the
 * spawn sites: the unpinned lookup runs `agyRespondsToVersion()`, which
 * *executes* the candidate binary with `--version`. Guarding only the spawns
 * would leave a suite executing the developer's real agy — no browser window
 * from a version print, but a violation of the invariant all the same.
 *
 * Guarding here is safe for the resolution tests because they all pin
 * `CODEV_AGY_BIN` before calling (they are testing override handling), and
 * `agy-integration.e2e.test.ts` short-circuits on the opt-in before resolving.
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

/**
 * True when cloud-mutating side effects must be refused because we are running
 * under a test (#1515).
 *
 * "Cloud-mutating" means the two irreversible halves of tunnel disconnect:
 * the server-side deregister of the tower ID, and the deletion of the local
 * cloud credentials. Both act on whatever `~/.agent-farm/cloud-config.json`
 * happens to be visible — which, before the agent-farm dir became isolatable,
 * was the developer's real one.
 *
 * `NODE_ENV` is checked alongside `VITEST` because the tower-test helpers set
 * `NODE_ENV=test` explicitly on the Towers they spawn, and `VITEST` is checked
 * alongside `NODE_ENV` because children inherit it through `{ ...process.env }`
 * even when a suite forgets to set `NODE_ENV`. Either marker is enough.
 */
export function isUnderTest(): boolean {
  return isUnderTestRunner() || process.env.NODE_ENV === 'test';
}

/**
 * Explicit opt-in for a test that genuinely means to exercise the cloud
 * disconnect path — necessarily one that owns a fake cloud config in an
 * isolated `CODEV_AGENT_FARM_DIR`. Unset by default, so no suite can deregister
 * a real Tower by omission.
 */
export function cloudMutationOptIn(): boolean {
  const raw = process.env.CODEV_ALLOW_TEST_CLOUD_MUTATION;
  return raw === '1' || raw === 'true';
}

/**
 * True when a cloud-mutating operation should be refused right now.
 */
export function cloudMutationBlocked(): boolean {
  return isUnderTest() && !cloudMutationOptIn();
}

/** The `/api/tunnel/` subpaths that mutate cloud state. */
const TUNNEL_MUTATION_PATH = /^\/api\/tunnel\/(connect|disconnect)(?:[/?#]|$)/;

/**
 * Guard the *client* half of #1515: refuse to drive tunnel connect/disconnect
 * against the **default** Tower port from under a test runner.
 *
 * The server-side guard cannot cover this case. A developer's real Tower on
 * :4100 runs with neither `VITEST` nor `NODE_ENV=test`, so it will happily
 * serve a disconnect — and `vitest-e2e-setup.ts` hands every loopback `fetch`
 * the real `~/.agent-farm/local-key`, so such a request arrives fully
 * authenticated. That is how a suite run deregistered a live Tower and left its
 * tunnel down for hours.
 *
 * Scoped as narrowly as it can be: only the two mutating subpaths, only on the
 * default port. A test that spawns its own Tower talks to an ephemeral port and
 * is unaffected; `/api/tunnel/status` is a read and stays allowed.
 */
export function assertTunnelMutationAllowedUnderTest(
  path: string,
  targetsDefaultTowerPort: boolean,
): void {
  if (!targetsDefaultTowerPort) return;
  if (!TUNNEL_MUTATION_PATH.test(path)) return;
  if (!cloudMutationBlocked()) return;

  const message =
    `Refusing to POST ${path} to the default Tower port from under a test ` +
    'runner (#1515). That port is the developer\'s real Tower, and the request ' +
    'would carry their real local key: a disconnect there deregisters their ' +
    'Tower server-side and deletes their cloud credentials. Point the client at ' +
    'a test Tower\'s port, or set CODEV_ALLOW_TEST_CLOUD_MUTATION=1 if this test ' +
    'genuinely means to mutate real cloud state.';
  // signalTunnel() swallows its errors, so make sure the reason is visible even
  // when the throw is caught and discarded.
  console.error(new Error(message).stack);
  throw new Error(message);
}
