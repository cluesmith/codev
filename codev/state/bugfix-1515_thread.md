# bugfix-1515 — test suite deregisters the production Tower

## INVESTIGATE (2026-08-18)

Issue premise: test-spawned Towers inherit `~/.agent-farm`, and the "two processes
writing one log" made earlier forensics diverge.

### What the evidence actually shows

Read `~/.agent-farm/tower.log` around `2026-08-17T23:49:43Z`. The tunnel lines are
**interleaved with unmistakably production lines** in the same file — mailbox
deliveries, cron ticks, the terminal partial monitor — at sub-second spacing:

```
23:49:43.099 Tunnel connect requested (remote=127.0.0.1 via=local ua="node")
23:49:43.114 [mailbox] delivered … → onboarding @ shannon
23:49:43.168 Tunnel connect requested (…)
23:49:43.252 Tunnel connect requested (…)
23:49:43.262 Tunnel disconnect requested (…)
23:49:43.650 Server-side deregister succeeded for tower 01KZRBREW12AX1BYE6Q7HBYMFF
23:49:44.163 Cloud config removed or invalid, disconnecting tunnel
```

Test-spawned Towers cannot write that file: `tower-server.ts` only appends to a log
when `--log-file` is passed (`logFilePath = opts.logFile`), and `startTower()` in
`tower-test-utils.ts` spawns with the port argument only. So this is **one process** —
the production Tower on 4100 — and the requests came in **over HTTP from outside**.

`ua="node"` is Node's global `fetch` default UA (`http.request` would log `ua="none"`),
so the caller is a Node process using `fetch`, not Playwright and not a browser.

### Root cause (working hypothesis, being confirmed)

`getTowerClient()` (`packages/codev/src/agent-farm/lib/tower-client.ts:57`) hands back a
**module-memoized** client whose `baseUrl` is `http://localhost:4100` and whose
`getAuthKey` is `ensureLocalKey` — the real `~/.agent-farm/local-key`. `signalTunnel()`
POSTs `/api/tunnel/{connect,disconnect}` through it. Any test that drives
`towerRegister()` / `towerDeregister()` without a port override therefore commands the
**live production Tower**, authenticated. Disconnect there deregisters the real tower ID
server-side and deletes the real cloud config; the production Tower's watcher then drops
the tunnel.

Two aggravating details under test:
- `TowerClient` captures `this.fetchFn = globalThis.fetch.bind(globalThis)` **at
  construction** (`packages/sdk/src/tower-client.ts:311`), and `getTowerClient` memoizes
  the instance in a module-level `defaultClient`. A `vi.spyOn(globalThis,'fetch')` +
  `mockRestore()` lifecycle therefore leaks: the memoized client keeps the mock object,
  which after restore calls straight through to the real fetch.
- The burst shape in the log — **3 connects then 1 disconnect** — matches
  `tower-cloud-cli.test.ts`'s shape (register tests that signal connect, then the
  deregister test).

`~/.agent-farm/` also literally contains `test-14150.db`, `test-14151.db`, `test-14152.db`
— proof the spawned test Towers do write into the real agent-farm dir, exactly as the
issue says. That part of the premise holds; it is just not what deregistered the Tower.

### Status
Confirming the auth/path question with a read-only probe (does `vi.mock('node:os')`
actually reach the externalized `codev-core` `AGENT_FARM_DIR`?). Per architect
instruction: no full-suite run until the isolation fix is in.

### Experiments run

1. **Read-only probe**: under `vi.mock('node:os', homedir → tmp)`, `AGENT_FARM_DIR`
   *does* resolve into the fake dir. So the cloud-config test files
   (`cloud-config.test.ts`, `tower-cloud.test.ts`, `tower-cloud-cli.test.ts`) are
   genuinely isolated — they are **not** the actor.
2. **Whole unit suite under a port-4100 socket guard**: 249 files / 4913 tests, zero
   hits. But the guard was then **self-checked and found ineffective** — Node's global
   `fetch` (undici) creates sockets through internal bindings and bypasses every
   userland patch of `node:net` (`Socket.prototype.connect`, `net.connect`,
   `net.createConnection`). The negative result is therefore worthless and is not
   being relied on.
3. `grep` for tunnel-endpoint callers across this repo, `apps/*`, the Stream Deck
   daemon, and the adopter workspace on this machine: no in-repo caller drives
   `/api/tunnel/{connect,disconnect}` against port 4100.

### Conclusion

The exact process that sent last night's `ua="node"` bursts was **not identified from
source**. What *is* established, and is enough to fix:

- `AGENT_FARM_DIR = resolve(homedir(), '.agent-farm')` (`packages/core/src/constants.ts:4`)
  has **no override of any kind**. `startTower()` isolates only the DB *name* and the
  shellper socket dir, so the DB still lands in the real directory —
  `~/.agent-farm/test-14150.db`, `test-14151.db`, `test-14152.db` are sitting there
  right now. `tower-reconnect.e2e.test.ts` additionally mkdtemps workspaces under
  `~/.agent-farm/test-workspaces`.
- A spawned test Tower therefore runs `initTunnel` → `readCloudConfig()` → **the owner's
  real credentials** → `connectTunnel()`, and watches the real config directory.
- `vitest-e2e-setup.ts` injects the **real** `~/.agent-farm/local-key` into *every*
  loopback `fetch`, so any e2e request that lands on 4100 is authenticated as the owner.
  There are no 401s anywhere in the incident window — the actor was authenticated.
- `e2e/global-setup.ts:22` defaults `TOWER_PORT` to **4100**: the Playwright lane
  deliberately drives the production Tower.
- The disconnect handler (`tower-tunnel.ts:519-560`) does a server-side DELETE of the
  tower ID and then `deleteCloudConfig()`, with **no test-mode guard at all**.

### Gap in the issue's prescribed fix

Prescription #2 ("under NODE_ENV=test, tower-server refuses cloud side effects") guards a
*test-spawned* Tower. It does **not** guard the production Tower against a test-suite
*client* — and that is the shape of the observed incident, since the production Tower runs
with no `VITEST`/`NODE_ENV=test`. So the fix adds a **client-side** guard as well: under a
test runner, the CLI's `TowerClient` refuses `/api/tunnel/*` against the default Tower
port. No in-repo test does that today, so blast radius is nil — and if the unnamed actor
recurs it now fails loudly with a stack trace instead of deregistering a human.

Guard style follows the existing #1323 precedent in `packages/codev/src/lib/test-env.ts`
(`isUnderTestRunner()` + named opt-in + loud throw at the chokepoint). `VITEST` is
inherited by children through `{ ...process.env }`, so it covers spawned Towers too —
which `NODE_ENV=test` alone would not.

### Scope
Well under the BUGFIX ceiling. Proceeding to fix.

## FIX (2026-08-18)

Five changes, ~110 lines of production code:

1. **`packages/core/src/constants.ts`** — `AGENT_FARM_DIR` now honours
   `CODEV_AGENT_FARM_DIR`. There was previously *no* override of any kind, which is
   why no test Tower could be isolated.
2. **`helpers/tower-test-utils.ts`** — `startTower()` mkdtemps a throwaway agent-farm
   dir per Tower, points the child at it, exposes it on `TowerHandle`, and removes it in
   `stop()`. The shared local key is copied in: the test process authenticates its own
   HTTP/WS calls with the key from the real dir (`vitest-e2e-setup.ts`,
   `towerWsProtocols()`), so both sides must present the same value or everything 401s.
   Nothing else is carried over.
3. **`packages/codev/src/lib/test-env.ts`** — `isUnderTest()`, `cloudMutationOptIn()`,
   `cloudMutationBlocked()`, `assertTunnelMutationAllowedUnderTest()`, following the
   #1323 precedent already in that file.
4. **`servers/tower-tunnel.ts`** — disconnect returns 403 under a test runner unless
   `CODEV_ALLOW_TEST_CLOUD_MUTATION=1`. Defence in depth (issue item 2).
5. **`agent-farm/lib/tower-client.ts`** — the CLI client overrides `request()` and
   refuses tunnel connect/disconnect against the **default** Tower port under a test
   runner. This is the piece the issue's prescription was missing: the server-side guard
   cannot help, because a developer's real Tower on :4100 runs with neither `VITEST` nor
   `NODE_ENV=test` and will happily serve the disconnect.

Sweep (issue item 4): `send-integration.e2e.test.ts`, `bridge-mode.e2e.test.ts` and
`tower-reconnect.e2e.test.ts` each spawn Towers with `{ ...process.env }` and now pass an
isolated dir too.

### Regression tests

- `bugfix-1515-tower-isolation.e2e.test.ts` — the issue's scenario: canary cloud config
  at the real-shaped `$HOME/.agent-farm/cloud-config.json`, a different one in the
  isolated dir, drive a real disconnect against a real spawned Tower. Asserts the
  isolated config was consumed, the canary is byte-identical, and `test-<port>.db` landed
  in the isolated dir. **Verified to fail without the fix** (reverted `constants.ts`,
  rebuilt, re-ran): `expected 'canary-real-tower-id' to be 'isolated-test-tower-id'` —
  the Tower read the canary, exactly the production failure.
- `bugfix-1515-test-tower-isolation.test.ts` — unit coverage for the override (resolved
  in a child process, since the constant lives in an externalised module) and for every
  branch of the client guard.
- `tower-tunnel.test.ts` — new case: disconnect 403s and runs **neither** irreversible
  half when a test has not opted in. Existing disconnect tests now opt in explicitly;
  they mock cloud-config, so they own their cloud state.

### Note for the architect
`~/.agent-farm/` still holds pre-existing `test-141*.db` leftovers from before this fix.
Harmless, and not deleted here — cleaning the owner's directory is their call.

## The actor, finally named (and a correction to the issue)

While running *targeted* test files during investigation — before the fix was in — the bug
fired again, twice: `06:29:36Z` and `06:31:15Z`. Tower `01M09R4DAMRMYHZ523475WVKVR`
(the registration the owner created at 06:14Z) was deregistered and
`~/.agent-farm/cloud-config.json` deleted. Reported to the architect.

`06:29:36Z` is `23:29:36` local — the exact start timestamp vitest printed for my run of
`tower-cloud-cli.test.ts`. So:

**The actor is `packages/codev/src/agent-farm/__tests__/tower-cloud-cli.test.ts`** — a
**unit** test in the **default** suite, not an e2e one. Its `towerRegister()` /
`towerDeregister()` calls pass no `port`, so `signalTower()` → `getTowerClient()` →
`http://localhost:4100`: the live Tower, authenticated with the real
`~/.agent-farm/local-key`. Its shape — three connects ~60ms apart, then a disconnect 3ms
later — reproduces the incident log byte for byte.

A/B, with the cloud config already absent so a disconnect was a no-op:
- guard disabled → 4 tunnel lines appear in the production `tower.log`
- guard enabled → 0
- after also pinning an unused port in the test → 0 **even with the guard disabled**

Both layers hold independently.

### Two claims in the issue that are wrong

- *"Writes to the shared `~/.agent-farm/tower.log`, interleaving test-tower lines with
  production lines"* — no. `tower-server.ts` only writes a log file when `--log-file` is
  passed, and no test spawner passes it. The lines interleave with production mailbox and
  cron lines inside a **single** process. The evidence was never two writers.
- *"A test exercising connect/disconnect acts as the user's registered Tower"* — right
  conclusion, wrong actor. It was not a *spawned test Tower* reading the inherited
  config; it was a test **client** commanding the real Tower over HTTP.

That distinction matters, because prescribed fix #2 (server-side `NODE_ENV=test` guard)
would **not** have prevented any of this: the Tower being commanded is the developer's,
running with neither `VITEST` nor `NODE_ENV=test`. Hence the client-side guard.

The directory-isolation half (#1) is still a real and separate leak — `test-141*.db` in
the real `~/.agent-farm` proves it — and is fixed too.

### An investigation note worth keeping
My first attempt to catch the actor was a `net.Socket.prototype.connect` guard. It ran
the whole unit suite clean and I briefly believed the suite was innocent. It was not: a
self-check showed Node's global `fetch` (undici) creates sockets through internal bindings
and ignores every userland patch of `node:net`. **A guard that has not been shown to fire
proves nothing.**
