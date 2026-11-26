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
