# air-1977 thread — cheap liveness route

## 2026-11-26 — implement

**Route.** `GET /health/live`, public like `/health`, body `{ status: 'healthy', version,
startedAt, schemaVersion }`, built from `RouteContext` and the `GLOBAL_CURRENT_VERSION`
constant: no `getInstances`, no census, no `getGlobalDb`. The path lives in codev-types
(`TOWER_LIVENESS_ROUTE`); the SDK mirrors the literal, as it does `COMMAND_ROUTE`, because its
zero-runtime-deps boundary test forbids a runtime import from codev-types.

**Why a new route, not `/api/version`.** `/api/version` is already cheap, but Towers since #983
have it, v3.3.8 included. The send check needs "this Tower predates the three-part address", and
only a route newer than Spec 1940 says that by its absence.

**Probe fallback.** Measured against the live v3.3.8 Tower: `/health/live` answers **404 with
the key and 401 without** (the route is not on its public list). The probe falls back to
`/health` on either, so keyless clients (VS Code `tower-starter` with no local key) still read an
older Tower as running.

**Unresponsive messages name the route that went unanswered.** The probe's `unresponsive` state
now carries `route` (`/health/live`, or `/health` after a fallback), and "Tower did not answer
/health (…)" became "Tower did not answer ${route} (…)" in checkTower, send's retry line and
`afx tower start`.

**Send's older-Tower check** asks `getLiveness()` instead of the address book. That works
because 1940 and this change ship in the same release (1940 merged after the v3.3.8 tag). Edge
case: a Tower local-installed from main between those two merges knows the form but lacks the
route, so a typo'd three-part address there reads as "older Tower, restart". The restart fixes
it; dev-only.

**Adjacent fix:** the `/api/version` doc comment had drifted above `isLoopbackAddress`; moved
back onto `handleVersion`.

**Not changed:** `db/tower-owner.ts` still probes `/health` for the startup ownership guard
(it is not `probeHealth`, and the issue scopes item 2 to the SDK probe). `doctor` keeps
`/health` for `insideCodevSession`.

## 2026-11-26 — PR #2001, CMAP

- **codex: REQUEST_CHANGES.** `getLiveness()` read only a 404 as `unknownRoute`, but an older
  Tower answers a keyless client 401. Fixed: on a 401 it asks the public `/health`, and a healthy
  answer confirms an older Tower (a refused Host 401s both). Re-measured against the live
  v3.3.8 Tower: keyless `getLiveness()` now gives `unknownRoute`.
- **claude: APPROVE**, non-blocking items taken:
  - VS Code `terminal-manager.probeTowerHealth` used `getHealth()` for a yes/no answer; it now
    uses `isRunning()` (the liveness route).
  - The route test now positively asserts all five spies on the `/health` side.
  - `schemaVersion` documented as a constant of the running code, not read from the DB.
- Left: VS Code `connection-manager.connect()` keeps `getHealth()`. It runs once per connect
  attempt with backoff and logs the payload's uptime.

## 2026-11-27 — fix round (owner ruling: PR #2001 goes ahead after one round)

Relayed by porchless; explicitly NOT gate approval. Items, all from the integration reviews:

1. **SDK validates the whole liveness body** (`livenessProblem()`): status, non-empty version,
   parseable startedAt, positive-integer schemaVersion. A 200 with a malformed body is
   `unresponsive` from `probeHealth`, with no fallback, and a failure with neither flag from
   `getLiveness()`, so `afx send` leaves the not-found alone. 16 malformed-body tests.
   `bugfix-1901-tower-check`'s fake Tower answered a bare `{ status: 'healthy' }` and now sends
   a whole body.
2. **arch.md** `afx send` section: `getLiveness()` and `/health/live` replace the address-book
   route and the long-gone `failedForAnOlderTower` name.
3. **Public-route rationale** (server-utils.ts and arch.md): two kinds now, browser-navigation
   paths and keyless probes (`/health`, `/health/live`, `/api/version`).
4. **VS Code terminal-adapter** comments and test names: "liveness probe", not `/health`.
5. Windows workflow dispatched on the branch; run linked in the PR.
