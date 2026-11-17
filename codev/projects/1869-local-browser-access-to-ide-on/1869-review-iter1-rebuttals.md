# PIR #1869 review iteration 1: rebuttals and dispositions

Reviewed head: 95c01b116..68082f2ac. Fixes in 6281a82d6 (code + tests) and the review update; final head 4663ee6c5.

## Gemini: COMMENT (skipped, agy not signed in); no action

## Codex and Claude: REQUEST_CHANGES

PIR runs the consultation once, so these fixes were **not independently re-reviewed**. The reviewer at the `pr` gate is the remaining check.

- **Codex: the forward relayed an upstream `Access-Control-Allow-Credentials`** (breaks the M2 invariant). **Fixed.** `STRIP_FROM_RESPONSE` in `ide-forward.ts` drops it from HTTP responses and from the rebuilt `101`, on both the local and tunnel paths. Tests: unit tests for both functions on both paths, plus an integration test where the stub upstream sends the header and Tower does not.
- **Codex: Open IDE on a recorded-but-dead server landed on a 502**, because the forward only started an asynchronous respawn. **Fixed.** `POST /api/ide/session` now awaits `ensureIdeServerLive` before minting, so it respawns exactly as the forward would. It returns 503 ("IDE server unavailable: run afx ide start") when nothing can be made live, and the dashboard shows that as an error toast. Test: a route test asserting that the liveness check runs and that `null` returns 503 with no Set-Cookie.
- **Claude: the dashboard polled `GET /api/ide` every 5 s**, which runs a blocking `execSync lsof` on Tower's event loop. **Fixed.** `tower.html` now checks IDE status on load and when the tab becomes visible again, never on the 5 s poll. Verified in Playwright: over about 12 s, `/api/status` was requested 3 times and `/api/ide` once.
- **Claude: `ensureIdeConnectionToken` has no production callers.** **Addressed.** Its doc comment now marks it as a test seam; spawns use `rotateIdeConnectionToken`.
- **Claude: `server-utils.ts` pulled `tower-client` / `codev-sdk` in through `ide-record`.** **Fixed.** `IDE_DEFAULT_PREFIX` and `matchIdePrefix` moved to a dependency-free `lib/ide-prefix.ts`, which `ide-record.ts` re-exports.
- **Claude: the local `x-forwarded-proto` is hardcoded to `http`.** **No change.** Behind a non-tunnel HTTPS reverse proxy the workbench would build `ws://` URLs. That case was already broken before this PR, and C1 forbids trusting a client-supplied `x-forwarded-proto`. Supporting a local TLS proxy is outside #1869.
- **Claude: the cross-port guard passes a request that carries neither `Origin` nor `Sec-Fetch-Site`.** **No change; this is intended.** Top-level navigation needs it. WebSockets and cross-origin fetches always carry `Origin`, so the M1 hole stays closed. The remaining case is a cross-port subresource GET that the page cannot read.
- **Claude: Unit Tests was still pending on the reviewed head.** It was re-checked on the final head before handoff.

## Verification after the fixes

- tsc clean. vitest: 7221 passed; the only failure is the local npm-config one in `protocol-drift-audit`, which is unrelated and passes in CI.
- Playwright on the branch harness, C4 still holding:
  - the jar holds only `codev-ide-session` after Open IDE and after a reload;
  - both workbench WebSockets go to Tower's port and stay open;
  - a cross-port WebSocket gets 4401;
  - the dashboard requests `/api/ide` once at load, not every 5 s.
