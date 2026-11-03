# PIR Review: Local browser access to /ide/ on Tower

Fixes #1869

## Summary

A local browser can now open the Codev IDE through Tower. Each workspace card on the Tower dashboard has an **Open IDE** row, first on the card. It calls the key-gated `POST /api/ide/session`, which sets a `codev-ide-session` cookie: HttpOnly, SameSite=Strict, `Path=/ide`, with its value derived from the local key by HMAC. It then opens `/ide/?folder=<workspace>` in a new tab. The forward's single authorization check (`decideForwardAuthorization`) accepts that cookie only behind a cross-port `Origin` / `Sec-Fetch-Site` check; every other Tower route stays header-only.

The live browser run then showed that the workbench was bypassing Tower. Its sockets dialed the IDE server's own port, and the IDE token sat in a cookie that every localhost port could read. Amendment 1 fixed both, for local requests only:
- The forward stamps `x-forwarded-host` with Tower's own Host, so the workbench connects through Tower.
- It strips the IDE server's `vscode-tkn` Set-Cookie and injects the token into the workbench's configuration instead.
- Tower's token replaces any browser-held copy.
- Client-supplied `x-forwarded-*` headers are stripped.
- The token is regenerated on every IDE server spawn.

## Files Changed

- `codev-skeleton/resources/commands/agent-farm.md` (+31 / -4)
- `codev/plans/1869-local-browser-access-to-ide-on.md` (+395 / -0)
- `codev/projects/1869-local-browser-access-to-ide-on/status.yaml` (+22 / -0)
- `codev/resources/arch.md` (+1 / -1)
- `codev/resources/commands/agent-farm.md` (+31 / -4)
- `codev/resources/lessons-learned.md` (+6 / -0)
- `codev/state/pir-1869_thread.md` (+29 / -0)
- `packages/codev/src/agent-farm/__tests__/ide-forward-integration.test.ts` (+85 / -0)
- `packages/codev/src/agent-farm/__tests__/ide-forward.test.ts` (+168 / -8)
- `packages/codev/src/agent-farm/__tests__/ide-server-preflight.test.ts` (+32 / -1)
- `packages/codev/src/agent-farm/__tests__/pir-1869-ide-cookie-ws.test.ts` (+185 / -0)
- `packages/codev/src/agent-farm/__tests__/pir-1869-ide-forward-cookie.test.ts` (+215 / -0)
- `packages/codev/src/agent-farm/__tests__/tower-routes.test.ts` (+127 / -0)
- `packages/codev/src/agent-farm/lib/ide-record.ts` (+29 / -0)
- `packages/codev/src/agent-farm/servers/ide-forward.ts` (+248 / -30)
- `packages/codev/src/agent-farm/servers/ide-server.ts` (+4 / -2)
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (+87 / -5)
- `packages/codev/src/agent-farm/servers/tower-websocket.ts` (+11 / -7)
- `packages/codev/src/agent-farm/utils/server-utils.ts` (+150 / -25)
- `packages/codev/templates/tower.html` (+66 / -4)

## Commits

- `41e044819` chore(porch): 1869 review phase-transition
- `475c18e37` chore(porch): 1869 dev-approval gate-approved
- `2a9a55ae2` [PIR #1869] Show the IDE row first on each workspace card
- `a521cfcc1` chore(porch): 1869 dev-approval gate-requested
- `95c01b116` [PIR #1869] Thread: amendment 1 implemented
- `1ba1d9142` [PIR #1869] Plan amendment 1 and docs: workbench routing, token handling, never hand-build ?tkn=
- `2d96e03f0` [PIR #1869] Log the pathname only for refused /ide requests
- `b0b7f30c4` [PIR #1869] Route the local workbench through Tower and keep the IDE token out of the cookie jar
- `012f4d7ef` [PIR #1869] Rotate the IDE connection token on every IDE server spawn
- `c3a7c6ac1` [PIR #1869] Document the Open IDE path and the /ide session cookie trust notes
- `0d112d79f` [PIR #1869] Open IDE link per workspace on the Tower dashboard
- `ed71b0646` [PIR #1869] Mint endpoint POST /api/ide/session, log-safe refusals, CORS credentials invariant
- `8e23af98f` [PIR #1869] Strip the /ide session cookie before forwarding to the IDE server
- `78f39a504` [PIR #1869] Forward seam accepts the /ide session cookie behind a cross-port Origin guard
- `ba40127ef` chore(porch): 1869 implement phase-transition
- `ece7d3ac3` chore(porch): 1869 plan-approval gate-approved
- `22214ea98` [PIR #1869] Plan revised: multi-user trust wording
- `b0f461cbe` [PIR #1869] Plan revised: security review S1-S4
- `ccdfd3f7d` [PIR #1869] Plan revised: security review M1-M4
- `1b0d2ec28` [PIR #1869] Plan revised: cross-port cookie risk
- `22583e81e` chore(porch): 1869 plan-approval gate-requested
- `237806b1e` [PIR #1869] Plan draft
- `6bdd146c9` chore(porch): 1869 init pir

## Test Results

- `pnpm build`: ✓ pass
- `tsc --noEmit` (packages/codev): ✓ clean
- `vitest` (packages/codev): 7218 passed, 1 failed locally, 49 skipped. The one failure is `protocol-drift-audit.test.ts` ("registry unreachable"), caused by this machine's npm config (see Flaky Tests). It is unrelated, passes in CI, and was not skipped. New coverage:
  - `pir-1869-ide-forward-cookie.test.ts`: the seam, the cross-port guard, the derivation, and `isRequestAllowed` delegation.
  - `pir-1869-ide-cookie-ws.test.ts`: the real `setupUpgradeHandler` with real `ws` clients and a stub IDE server.
  - Additions to `ide-forward.test.ts`, `ide-forward-integration.test.ts`, `ide-server-preflight.test.ts` and `tower-routes.test.ts`.
- CI on PR #1872: 7/7 green (Unit, CLI ubuntu/macOS, CLI Integration, Tower Integration, Package Install, Artifact-Canvas Browser).
- Mutation check: with the cross-port guard disabled, the cross-port and `Sec-Fetch-Site` WebSocket tests fail.
- Manual / Playwright, against this branch's real `handleRequest` + `setupUpgradeHandler` on a :4199 harness with the real IDE server on :8200 (live Tower untouched):
  - Open IDE opens the workbench with the Codev sidebar ("Codev: Connected"), and the tab has no `opener`.
  - After Open IDE and after a direct reload, the cookie jar holds only `codev-ide-session` (127.0.0.1, `/ide`, HttpOnly, Strict). No `vscode-tkn`.
  - Both workbench WebSockets are `ws://127.0.0.1:4199/ide/…` and stay open. None target `:8200`.
  - A page on another localhost port holding the cookie: its WebSocket to Tower is closed with 4401, and its credentialed fetch is blocked.
  - curl:

    | Request | Result |
    |---|---|
    | bare `/ide/` | 401 |
    | rebound Host | 401 |
    | cookie on a non-`/ide` route | 401 |
    | cookie with `Origin: http://localhost:3000` | 401 |
    | direct `:8200` with the forward cookie | 403 |
    | key header with a cloud `Origin` | 200 |
- Security architect: approved the plan (M1-M4, S1-S4), the amendment (C1-C4, plus (a') local-only with four conditions), and the implementation at 95c01b116, re-running the six suites (252/252).
- Owner: exercised Open IDE live on the harness and approved dev-approval on 2a9a55ae2, after asking for the IDE row to move above Overview.

## Architecture Updates

COLD `codev/resources/arch.md`, invariant 9 (Tower API Authentication) now records the one ambient credential:
- `/ide` accepts `codev-ide-session` only in `decideForwardAuthorization`, in the order Host → header → cookie with its Origin check.
- Tower must never set `Access-Control-Allow-Credentials`.
- For local requests, the forward stamps `x-forwarded-host`, keeps the IDE token out of the cookie jar (it goes into the config instead), replaces any browser-held `vscode-tkn`, and rotates the token on every spawn.
- Client `x-forwarded-*` headers are stripped; the tunnel path keeps the Set-Cookie.

No HOT `arch-critical.md` change: this is a subsystem-scoped auth detail, and the hot file already points into arch.md for Tower auth.

## Lessons Learned Updates

COLD `codev/resources/lessons-learned.md`:
- **Security**:
  - An ambient credential needs an Origin check that a header never did. On loopback, ports are not part of a SameSite site.
  - Before stripping a credential that a third-party client is handed, find out how the client reads it: grep the shipped bundle.
  - A proxy that rewrites `Host` must stamp `x-forwarded-host`, or the backend's own URLs point past the proxy.
- **Testing**:
  - The browser run found what 65 unit and integration tests could not. Assert the real WebSocket targets and the cookie jar contents.
  - A scoped `@cluesmith:registry` in the user npm config makes `protocol-drift-audit` fail every time. Work around it with `NPM_CONFIG_USERCONFIG=<empty file>`; never edit `~/.npmrc`.

No HOT `lessons-critical.md` change: the existing hot lesson "verify the real user path end-to-end; derive the check from the user's action" already covers the general rule, and this PR is one more instance of it.

## Things to Look At During PR Review

- **The workbench HTML rewrite in `servers/ide-forward.ts`** (`injectWorkbenchConnectionToken`, `relayWorkbenchHtml`). Tower now rewrites one third-party HTML page.
  - It rewrites only a non-tunnel, 200, `text/html` response with no `Content-Encoding`, within 2 MB. A chunked body that outgrows the bound mid-stream is relayed unchanged.
  - The token must match `^[A-Za-z0-9-]+$`.
  - The config is decoded and must `JSON.parse` both before and after the edit, and `{}` is handled.
  - Otherwise the page is relayed unchanged and the workbench fails visibly with "auth mismatch".
  - It depends on the upstream meta tag id `vscode-workbench-web-configuration`, and on the client preferring `options.connectionToken` over the cookie, which I verified in the shipped bundle. An upstream change would surface as that visible "auth mismatch", not a silent hole.
- **The order in `decideForwardAuthorization`.** A valid key header wins without the Origin check; that is what keeps tunnel requests, which carry a cloud `Origin`, working. Only the cookie branch carries the guard.
- **`mergeConnectionTokenCookie` now REPLACES an incoming `vscode-tkn`.** Before this change it never overwrote one. The change is intentional (C2): Tower is the sole source of the token.
- **Rotation happens only on spawn, never on adopt** (`ide-server.ts`). Rotating under a live server would lock Tower out of it.
- **The tunnel path is unchanged except C1/C2.** The cloud workbench still gets the token through the server's Set-Cookie. Moving the cloud to the config-injected token is a follow-up filed by the architect.
- **Accepted residuals**, documented in `agent-farm.md`:
  - On a multi-user host, another OS user can collect and replay the `/ide` cookie. The architect filed a follow-up.
  - A browser that already holds `vscode-tkn` from a hand-built `?tkn=` URL keeps it until the next IDE server spawn.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1869 → **Review Diff**
- **Run dev**: `afx dev pir-1869`. To leave the live Tower untouched, run a harness that serves this branch's `handleRequest` / `setupUpgradeHandler` on another port, as was done for dev-approval.
- **What to verify**:
  - Once `afx ide start` has recorded a server, the dashboard shows **IDE** as the first row on each running workspace card.
  - Open IDE opens the workbench with the Codev sidebar in a new tab.
  - DevTools → Application → Cookies shows only `codev-ide-session` (`/ide`, HttpOnly, Strict), and no `vscode-tkn`.
  - DevTools → Network → WS: every socket targets Tower's port, and none target `:8200`.
  - A direct reload of the workbench tab works.
  - `curl http://127.0.0.1:4100/ide/` returns 401.

## Flaky Tests

No tests were skipped. One test fails locally because of this machine's environment; it is not flaky in the usual sense.
- `packages/codev/src/__tests__/protocol-drift-audit.test.ts:178` ("the REAL default lookup is offline-tolerant AND bounded when the registry is unreachable").
  - Cause: a scoped `@cluesmith:registry` in the user npm config overrides the test's `npm_config_registry`, so `npm view` reaches the real registry. An empty npm cache does not help.
  - It passes in CI. Porch's local checks were run with `NPM_CONFIG_USERCONFIG=<empty temp file>`, an environment-only change, with no repo change and no skip.
  - The architect is filing the test-side fix: the test should neutralize the user config itself.
