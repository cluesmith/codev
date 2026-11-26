# air-1999 thread: a cheap liveness route

## 2026-11-26: implement

- Found `GET /api/version` (#983) already does no work. Kept it as is (the VS Code preflight
  reads it) and added a new route, `GET /api/liveness`, as the issue asks: a Tower without it
  answering 404 is the version check. `/api/version` predates Spec 1940, so it could not serve
  that purpose.
- Body: `{ status: 'alive', version, schemaVersion, startedAt }`. `schemaVersion` is the
  `GLOBAL_CURRENT_VERSION` constant, imported from `db/migrations.js` and not `db/index.js` so
  route tests that mock `db/index` wholesale keep working. Public like `/health`.
- The route stays behind the boot readiness gate, like `/health`: "running" still means "can
  serve". I did not change that.
- SDK `probeHealth`: asks `/api/liveness`. It falls back to `/health` only on the catch-all 404
  (an older Tower, client with the key) or a 401 (an older Tower, keyless client like VS Code
  without a key; the route is not public there). There is no fallback on timeout, reset or
  refusal, which is the point of the change. `TowerHealthProbe.running` now carries
  `liveness: TowerLiveness | null` (null = older Tower). Nothing read `.health` off it.
- `afx send` `explainNotFound`: `getLiveness()` replaces `getAddressBook()`. Route present means
  the not-found stands; unknownRoute means older Tower; unanswered means busy.
- Caveat: a dev-build Tower with Spec 1940 but without this route would be called "older". No
  release has one: v3.3.8 has neither, and both are on main for the next release.
- Messages that said "did not answer /health" now say "its liveness probe", since the route
  asked is no longer `/health`.
- Left alone, possible follow-ups: `db/tower-owner.ts` `probeTowerHealth` (raw `/health` on the
  owner-conflict path only) and the VS Code `connection-manager` connect, which calls `getHealth()`
  for uptime.
