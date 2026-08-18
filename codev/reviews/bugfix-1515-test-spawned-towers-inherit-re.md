# Bugfix #1515: test runs deregister the developer's real Tower

## Summary

A `pnpm test` run could deregister the user's Tower from Codev Cloud and delete its local
credentials, dropping the live tunnel until a human reconnected by hand. One incident took
the tunnel down for 6.5 hours overnight and broke everything downstream of it.

## Root Cause

**Not the one the issue diagnosed.** The issue's own framing — "test-spawned Towers inherit
real `~/.agent-farm` cloud identity" — describes a real leak, but not the one that
deregistered the Tower.

The actor is `packages/codev/src/agent-farm/__tests__/tower-cloud-cli.test.ts`, a **unit**
test in the **default** suite. `towerRegister()` / `towerDeregister()` take an optional
`port`; the test passes none, so `signalTower()` → `getTowerClient()` →
`http://localhost:4100` — the developer's live Tower, authenticated with the real
`~/.agent-farm/local-key`. The register tests signal `connect`, the deregister test signals
`disconnect`, and the Tower obediently deregisters itself server-side and deletes its
credentials. The shape in the log — three connects ~60ms apart, then a disconnect 3ms later
— reproduces the incident byte for byte.

Two of the issue's stated mechanisms are wrong, and both matter:

1. *"Writes to the shared `~/.agent-farm/tower.log`, interleaving test-tower lines with
   production lines — which is why the earlier forensics never converged."* No.
   `tower-server.ts` writes a log file **only** when `--log-file` is passed
   (`logFilePath = opts.logFile`), and no test spawner passes it. The tunnel lines
   interleave with production mailbox and cron lines **inside a single process**, at
   sub-second spacing. There was never a second writer; the evidence was always one Tower
   receiving external HTTP.
2. *"A test exercising `/api/tunnel/connect`/`disconnect` acts as the user's registered
   Tower."* Right conclusion, wrong actor — it was not a spawned test Tower reading an
   inherited config, it was a test **client** commanding the real Tower over HTTP.

The consequence of (2) is the important one: **prescribed fix #2 would not have prevented
any of this.** A server-side "under `NODE_ENV=test`, refuse cloud side effects" guard
protects a *test-spawned* Tower. The Tower being commanded here is the developer's,
running with neither `VITEST` nor `NODE_ENV=test`, so it would have served the disconnect
exactly as before. That gap is why this fix adds a client-side guard the issue did not ask
for.

The directory-inheritance leak the issue *does* describe is real and independent —
`~/.agent-farm/` still holds `test-14150.db`, `test-14151.db`, `test-14152.db` from past
runs, and a spawned test Tower reads the real cloud config and local key at boot — so it is
fixed too.

## Fix

| File | Change |
|------|--------|
| `packages/core/src/constants.ts` | `AGENT_FARM_DIR` honours `CODEV_AGENT_FARM_DIR`. There was **no** override of any kind, which is why no spawned test Tower could be isolated. |
| `__tests__/helpers/tower-test-utils.ts` | `startTower()` gives each Tower a throwaway agent-farm dir, exposes it on `TowerHandle`, removes it in `stop()`. Only the shared local key is copied in, so both sides still agree on request auth. |
| `packages/codev/src/lib/test-env.ts` | `isUnderTest()`, `cloudMutationOptIn()`, `cloudMutationBlocked()`, `assertTunnelMutationAllowedUnderTest()` — following the #1323 precedent already in that file. |
| `agent-farm/lib/tower-client.ts` | The CLI client overrides `request()` and refuses tunnel connect/disconnect against the **default** Tower port under a test runner. |
| `servers/tower-tunnel.ts` | Disconnect returns 403 under a test runner unless a test opts in (defence in depth, issue item 2). |
| `__tests__/tower-cloud-cli.test.ts` | Pins an unused port — fixes it at the source. |
| `send-integration` / `bridge-mode` / `tower-reconnect` e2e | Sweep of the other `{ ...process.env }` Tower spawn sites (issue item 4). |

`VITEST` is used alongside `NODE_ENV` because children inherit it through
`{ ...process.env }`, so it covers spawned Towers even where a suite forgets `NODE_ENV`.

The guard is scoped as narrowly as it can be: only `/api/tunnel/{connect,disconnect}`, only
on the default port. A test that spawns its own Tower uses an ephemeral port and is
unaffected; `/api/tunnel/status` is a read and stays allowed.

## Testing

Both layers were verified **independently against the live Tower's log**, with the cloud
config already absent so a disconnect was a no-op:

| Configuration | Tunnel lines in the production `tower.log` |
|---|---|
| Guard disabled, test unpinned (pre-fix) | 4 — 3× connect, 1× disconnect |
| Guard enabled | 0 |
| Guard **disabled**, test port pinned | 0 |

- `bugfix-1515-tower-isolation.e2e.test.ts` — the issue's item-3 scenario: a canary cloud
  config at the real-shaped `$HOME/.agent-farm/cloud-config.json`, a different one in the
  isolated dir, a real spawned Tower, a real disconnect. Asserts the isolated config was
  consumed, the canary is byte-identical, and `test-<port>.db` landed in the isolated dir.
  **Confirmed to fail without the fix** (reverted `constants.ts`, rebuilt, re-ran):
  `expected 'canary-real-tower-id' to be 'isolated-test-tower-id'` — the Tower read the
  canary, exactly the production failure.
- `bugfix-1515-test-tower-isolation.test.ts` — 14 unit tests: the override (resolved in a
  child process, since the constant lives in an externalised module) and every branch of
  the client guard.
- `tower-tunnel.test.ts` — new case: disconnect 403s and runs **neither** irreversible half
  without an opt-in. Existing disconnect tests opt in explicitly; they mock cloud-config, so
  they own their cloud state.
- Unit suite green. All **fourteen** Tower-spawning e2e files re-run green — the twelve that
  use the shared `startTower()` helper, plus `tower-reconnect` and the new regression — which
  is what proves the isolated-dir key handoff works. TypeScript compiles clean. No isolated
  agent-farm dirs are left behind after a run.

## CMAP Review

| Model | Verdict |
|---|---|
| Gemini | APPROVE — no issues |
| Codex | COMMENT — one real issue (below) |
| Claude | REQUEST_CHANGES — one **blocking** issue (below) |

**Claude, blocking — accepted and fixed.** Isolating the DB into the throwaway dir broke
`tower-routes-husks.e2e.test.ts` and `shellper-husk-sweep.e2e.test.ts`: both open the Tower's
SQLite DB directly at `resolve(homedir(), '.agent-farm', 'test-<port>.db')`, which no longer
exists, so they threw `SqliteError: no such table: terminal_sessions`. Both now read
`tower.agentFarmDir`. This is exactly the kind of miss the reviewer was right to insist on:
my "all tests pass" claim rested on **five** Tower-spawning e2e files when **twelve** use the
shared `startTower()` helper. All fourteen (those twelve plus `tower-reconnect` and the new
regression) are now run.

**Codex, non-blocking — accepted and fixed.** The three direct callers of
`createIsolatedAgentFarmDir()` never removed their dirs, each holding a copy of the real
local key. Added `removeIsolatedAgentFarmDir()` and wired it into all three teardowns, plus a
process-exit backstop. Verified: a run that previously left dirs behind now leaves zero.
(The exit handler alone was **not** sufficient — vitest's pooled workers do not reliably run
`process.on('exit')`, so the explicit teardown is the primary mechanism and the handler is
only a net. Worth knowing before relying on `exit` in a vitest helper.)

**Claude, non-blocking — considered, declined with reasons.**

- *`isUnderTest()` adds `NODE_ENV === 'test'`, which `test-env.ts`'s own #1323 comment argues
  against.* Correct reading, but the trade is inverted here. #1323's guard makes a real
  consultation **throw**, so a false positive is expensive. This guard's false positive costs
  a user running Tower with `NODE_ENV=test` a 403 that names the override; its false negative
  deregisters their Tower. Kept, with that asymmetry documented at the call site.
- *`packages/sdk/src/node/local-key.ts` doesn't honour `CODEV_AGENT_FARM_DIR`, leaving the
  isolation partial.* That module is the read-only key reader for **external Node clients**
  (the VS Code host, the Stream Deck plugin), not the Tower. It intentionally reads the real
  key — which is the same value `createIsolatedAgentFarmDir()` copies in, so those clients
  still authenticate correctly and the isolation is not partial in any path this bug touches.
  Making it honour the override would also require duplicating the env handling, since the sdk
  cannot import `codev-core` at runtime (server/client isolation, #1189). Out of scope.

## Lessons Learned

- **A guard that has not been shown to fire proves nothing.** The first attempt to catch the
  actor patched `net.Socket.prototype.connect`, ran the whole unit suite clean, and briefly
  looked like proof the suite was innocent. A self-check showed Node's global `fetch`
  (undici) creates sockets through internal bindings and ignores every userland patch of
  `node:net` — `Socket.prototype.connect`, `net.connect`, `net.createConnection`. The
  negative result was worthless. Always assert that instrumentation triggers on a known
  positive before trusting its silence.
- **An issue's root-cause section is a hypothesis, not a finding.** This one was written
  from real evidence and was still wrong about the mechanism in a way that would have left
  the bug live: the prescribed server-side guard cannot protect a process that is not itself
  under test. Re-derive the causal chain from the evidence before implementing a prescribed
  fix.
- **"Two processes wrote one log" is a claim you can check.** It was falsified by a single
  grep for `--log-file`, and the sub-second interleaving with mailbox and cron lines said
  "one process" plainly.
- **"All tests pass" is a claim about what you ran, not what exists.** I ran five
  Tower-spawning e2e files and wrote "all tests pass"; twelve use the helper I changed, and
  two of the seven I skipped were broken by the change. Enumerate the call sites of anything
  you modify and run *those*, rather than the ones that came to mind.
- **A default port is an ambient dependency on someone's live system.** `getTowerClient()`
  with no argument silently means "whatever Tower is running on this machine". Any test
  helper that can reach a default-port service should be assumed to reach production until
  proven otherwise.

## Flaky Tests

None encountered.

## Follow-ups

- `~/.agent-farm/` holds `test-141*.db` leftovers from before this fix. Harmless; not
  deleted here, since cleaning the owner's directory is their call.
- `tower-reconnect.e2e.test.ts` still creates workspaces under
  `~/.agent-farm/test-workspaces` because terminal reconciliation filters `/tmp` and
  `/var/folders`. Not a credential leak, so left alone — but it is the remaining write into
  the real directory.
- `e2e/global-setup.ts` defaults `TOWER_PORT` to `4100`, i.e. the Playwright lane
  deliberately drives the production Tower. Out of scope here (that lane is opt-in and not
  what caused this incident), but worth a separate issue.
