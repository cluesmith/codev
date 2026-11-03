# PIR Plan: Local browser access to `/ide/` (forward cookie + Open IDE link)

## Understanding

After `afx ide start`, a local browser cannot reach the workbench through Tower:

- `isRequestAllowed` (`packages/codev/src/agent-farm/utils/server-utils.ts:307-326`) accepts the
  local key only as the `codev-tower-key` / `codev-web-key` header. `/ide/` is not a public route,
  so a top-level navigation (which cannot attach a header) gets 401 at the choke point
  (`servers/tower-routes.ts:288`).
- The WebSocket path has the same gap: `tower-websocket.ts:246-251` calls `isForwardAuthorized`
  (`server-utils.ts:356-366`), which also reads only the header. The workbench's
  `?reconnectionToken=` sockets carry no header and no subprotocol.
- The cloud path works because `TunnelClient.stampLocalHeaders` stamps the header on every
  tunnel-borne request. The IDE connection token is already handled: `buildForwardHeaders`
  (`servers/ide-forward.ts:115-144`) injects `vscode-tkn` on every forwarded request.

So the gap is only: a loopback browser has no header-free way to present Tower's trust for
`/ide/*` (HTML, assets, and WebSocket upgrades).

## Proposed Change

### 1. A derived forward credential, delivered as a cookie

Add to `server-utils.ts`:

- `IDE_FORWARD_COOKIE = 'codev-ide-session'`.
- `ideForwardCookieValue(): string | null`: `HMAC-SHA256(localKey, 'codev-ide-forward/v1')`,
  hex. Returns null when the key is unavailable (fail closed). **It derives from
  `getExpectedKey()` on every call (M4)**, never a module-load constant, so it honours
  `resetExpectedKeyCache()` and the `CODEV_TOWER_KEY` override, and rotating the local key
  invalidates every outstanding cookie.

Why derived rather than the key itself or a random in-memory token:
- **Not the key.** The cookie jar never holds the Tower key, so the cookie cannot be replayed
  against Tower's API routes or inverted to the key. This narrows *which Tower routes* it opens,
  not *what its holder can do*: see the credential-power risk below (M3).
- **Stateless.** Survives a Tower restart, so an open workbench reconnects after
  `afx tower stop/start` without re-clicking. Revocation is rotating the local key; there is no
  finer per-cookie revocation, and that is accepted (M4, see Risks).
- Scope is enforced server-side: nothing outside the `/ide` prefix accepts it.

### 2. Mint endpoint: `POST /api/ide/session`

In `tower-routes.ts`, next to the `/api/ide` branch (`:317`): `POST /api/ide/session` →
`204` with

```
Set-Cookie: codev-ide-session=<hmac>; Path=/ide; HttpOnly; SameSite=Strict
```

(no `Secure`: loopback is plain HTTP; no `Max-Age`: session cookie). It is reached only after
`isRequestAllowed`, so it requires the key header; a cross-origin page cannot read the key nor
pass CORS with the custom header. The tunnel already blocks it: `BLOCKED_PATH_SEGMENT`
(`lib/tunnel-client.ts:83`) matches `api/ide/`, so the cloud side can never mint a local cookie.
Only `POST`; other methods 405. Response is `204` with no body, and the cookie value is never
logged (S1). Belt-and-braces on top of the tunnel block: the handler also refuses tunnel-borne
requests Tower-side (`x-codev-tunnel-proxy: 1` → `403`), matching the marker's stated purpose
(`lib/tunnel-client.ts:86-91`) (S1).

### 3. One authorization seam accepts the cookie

- `isForwardAuthorized` decides in a fixed order:
  1. Host guard (unchanged).
  2. **Header branch (unchanged):** a valid `codev-tower-key` / `codev-web-key` header is
     allowed with no Origin / Fetch-Metadata check. Tunnel-borne requests (header stamped by
     `TunnelClient`, `Origin` = the cloud host) are therefore unaffected.
  3. **Cookie branch:** a `codev-ide-session` cookie that constant-time-matches
     `ideForwardCookieValue()`, **and** passes the cross-port guard below (M1).
  Cookie parsing via a small `cookieValue(header, name)` helper (no new dependency).
- **Cross-port guard, cookie branch only (M1).** `SameSite=Strict` separates *sites*, and ports
  are not part of a site: `http://localhost:3000` and `http://localhost:4100` are the same site,
  so a page on any other localhost port can open
  `new WebSocket('ws://localhost:4100/ide/?reconnectionToken=…')`, the browser attaches the
  cookie, CORS does not apply to WebSockets, and Tower would raw-pipe that page into the VS Code
  remote protocol (a terminal). Today that page cannot obtain the key; without this guard the
  cookie would hand it the same power. Rule, applied to HTTP and the WS upgrade alike:
  - if `Origin` is present, it must equal `http://<Host>` / `https://<Host>` (the request's own
    Host header) or exactly match an entry in `CODEV_TOWER_ALLOWED_ORIGINS`;
  - if `Sec-Fetch-Site` is present, it must be `same-origin` or `none`; `same-site` and
    `cross-site` are rejected;
  - a request with neither header passes (top-level navigation, same-origin GETs from browsers
    that omit them).
  Implemented as a pure exported helper `isSameOriginForwardRequest(req)` so it is unit-testable
  in isolation. The header branch never calls it.
- If the workbench turns out to need a legitimately cross-origin surface (webview iframes,
  service worker), allowlist that exact origin; never drop the check. Expected: none, since
  server-web with `--server-base-path /ide` serves them same-origin under `/ide`; verified in
  the test plan.
- `isRequestAllowed`: if the pathname matches the IDE prefix (`/ide` or `/ide/…`), return
  `isForwardAuthorized(req)` instead of the header-only check. This keeps one decision for the
  forward (HTTP and WS identical) and leaves every other route header-only. To avoid a
  server-utils → ide-forward import, `matchIdePrefix` moves to (or is duplicated as a pure check
  against `IDE_DEFAULT_PREFIX` from) `lib/ide-record.js`; `ide-forward.ts` re-exports it so
  existing imports keep working.
- The Host guard still runs first in both functions, so a rebound Host fails regardless of
  cookie.

### 4. Never forward Tower's cookie to the IDE server

`buildForwardHeaders` (`ide-forward.ts:115`): strip the `codev-ide-session` pair from the
incoming `Cookie` header before `mergeConnectionTokenCookie` runs (new exported pure helper
`stripCookie(header, name)`, accepting the `string | string[]` shape and matching the exact
cookie name only, so `codev-ide-session2` is not over-stripped) (S2), mirroring how the key
header is stripped. `forwardIdeWebSocket` uses the same `buildForwardHeaders`
(`ide-forward.ts` ~245, confirmed by the security review), so one strip covers HTTP and WS.

### 4b. Logging (S4)

The 401 WARN lines in `tower-routes.ts:288` and `tower-websocket.ts:247` keep logging method,
path, and reason only; neither the `Cookie` header nor the cookie value is ever logged. The
reason string distinguishes "disallowed Host", "missing or invalid credential", and "cookie
refused: cross-origin" so a broken client stays diagnosable.

### 5. Open IDE link per workspace on the local dashboard

`packages/codev/templates/tower.html`, `renderInstance` (`:1217`): add an **IDE** row (same
`port-item` shape as Overview) with an **Open** action, for running workspaces. Click handler:

1. `const tab = window.open('about:blank', '_blank')` synchronously (keeps the popup tied to the
   user gesture; Safari blocks a `window.open` after an `await`), then `tab.opener = null`
   immediately (keeps the handle, drops the back-reference) (S3).
2. `await authFetch('./api/ide/session', { method: 'POST' })`.
3. `tab.location = './ide/?folder=' + encodeURIComponent(instance.workspacePath)` (relative, so
   the cookie origin `localhost` vs `127.0.0.1` always matches the dashboard's own origin).
   `folder` comes only from Tower's own `instance.workspacePath`, so there is no open redirect
   (S3).
4. On failure: close the tab, toast the error.

Visibility: the row shows when the IDE server has a record. `refresh()` adds one
`authFetch('./api/ide')` (GET status, already exists) and the row renders when `record` is
non-null; when the server is recorded but not alive, the forward already respawns it on first
request, so the link still shows. No record → no row (avoids a dead link on machines without
codev-ide). The React SPA under `/workspace/<enc>/` (apps/web) is out of scope; the launcher is
the per-workspace surface the issue names.

### 6. Docs

`codev/resources/commands/agent-farm.md` and `codev-skeleton/resources/commands/agent-farm.md`,
`### afx ide` intro (`:1027-1030`): describe the dashboard's **Open IDE** link as the user path,
explain that a bare navigation to `http://localhost:4100/ide/?folder=…` works after the link has
been used once in that browser (it sets a session cookie scoped to `/ide`), and add the cookie to
the trust notes: it is a **full-trust credential for this machine**, scoped by route not by
capability (the workbench has terminals and file access), so treat it like the key (M3);
revocation is rotating the local key (`~/.agent-farm/local-key` or `CODEV_TOWER_KEY`), with no
finer revocation (M4). The trust notes also state, plainly and not as a footnote: "Tower's loopback trust boundary is the single-user machine; on a multi-user host another local user can reach Tower's listener and, via the `/ide` session cookie, can collect and replay this machine's IDE credential if you browse to their localhost port under `/ide`. Recommendation: do not use the Open IDE path on shared hosts." Check `arch.md` for an IDE forward auth section and update it if present.

## Files to Change

- `packages/codev/src/agent-farm/utils/server-utils.ts:307-366` — cookie constant, derivation,
  cookie parser, `isForwardAuthorized` accepts cookie, `isRequestAllowed` delegates `/ide*`.
- `packages/codev/src/agent-farm/lib/ide-record.ts` — host `matchIdePrefix` (pure) if needed to
  avoid a cyclic import.
- `packages/codev/src/agent-farm/servers/ide-forward.ts:115-150` — strip Tower cookie before
  forwarding; re-export `matchIdePrefix`.
- `packages/codev/src/agent-farm/servers/tower-routes.ts:~317` — `POST /api/ide/session`;
  `:265` comment pinning the no-`Access-Control-Allow-Credentials` invariant (M2).
- `packages/codev/src/agent-farm/servers/tower-websocket.ts:242-251` — comment update only (the
  call is unchanged; behavior comes from `isForwardAuthorized`).
- `packages/codev/templates/tower.html` — IDE row + click handler + status fetch.
- `codev/resources/commands/agent-farm.md`, `codev-skeleton/resources/commands/agent-farm.md`.
- Tests (below).

## Risks & Alternatives Considered

- **Risk: the credential's power (M3).** The cookie is a full-trust credential for this
  machine: the workbench it opens has terminals and file access, so holding it means running
  commands as the user. It is scoped by route (`/ide/*` on Tower only), not by capability. Treat
  it exactly like the key. It is `HttpOnly; SameSite=Strict; Path=/ide` and obtainable only by a
  same-origin holder of the key; the Host guard still runs first.
- **Risk: cross-port localhost WebSocket hijack (M1).** `SameSite=Strict` does not stop another
  localhost port (same site) from making the browser send the cookie, and WebSockets bypass CORS.
  Closed by the cookie-branch cross-port guard (step 3): `Origin` must match Host or an
  allowlisted origin, `Sec-Fetch-Site` must be `same-origin`/`none`.
- **Invariant: Tower never sets `Access-Control-Allow-Credentials` (M2).** That absence is what
  keeps a cookie-bearing cross-origin `fetch` from reading `/ide/` responses (the CORS block in
  `tower-routes.ts:265` reflects loopback origins). Recorded as a comment at the CORS block and
  pinned by a route-test assertion so a future change cannot add it silently.
- **Accepted risk: revocation granularity (M4).** Stateless HMAC means the only revocation is
  rotating the local key, which also logs out every client. Acceptable for a single-user local
  credential whose issuance already requires the key.
- **Accepted risk: replay on a multi-user host (ruled accept-and-document by the security
  review).** Tower's loopback trust boundary is the single-user machine; on a multi-user host another local user can reach Tower's listener and, via the `/ide` session cookie, can collect and replay this machine's IDE credential if you browse to their localhost port under `/ide`. Recommendation: do not use the Open IDE path on shared hosts. Mechanism: another OS user's server on some localhost port receives the
  cookie (cookies are not port-scoped) and replays it from a non-browser client, forging
  `Origin`, so M1 does not help; that user cannot read the 0600 key file today. Not mitigated in
  this change; the same sentence goes into the docs trust notes (step 6). Peer-identity
  verification for loopback connections and an independently rotatable IDE-session secret are a
  follow-up filed by the architect ("Tower loopback trust on multi-user hosts").
- **Risk: cookie leaks to the IDE server.** Stripped before forwarding (step 4); unit-tested.
- **Risk: cookies are not port-scoped.** A cookie set by `localhost:4100` with `Path=/ide` is
  also sent to any other `localhost` port on a path under `/ide`, including the IDE server at
  `:8200` (which runs with `--server-base-path /ide`) on a direct navigation, or any other local
  service that serves `/ide`. Tower's strip (step 4) covers only the forwarded path. Acceptable
  because: the value is an HMAC derived from the key, not the key, and it is accepted by Tower only
  under `/ide` (see the credential-power risk above; it cannot be inverted to the Tower key); the IDE server ignores
  unknown cookies and still requires its own `vscode-tkn` connection token; and the `__Host-`
  prefix is not an option because it forces `Path=/`, which would send the cookie to every Tower
  route instead of narrowing it.
- **Risk: popup blocking.** Pre-open the tab synchronously, then navigate it.
- **Risk: workbench sub-resources (webview iframes, service worker) on a different path or
  origin.** They load under `/ide/…` same-origin in server-web with `--server-base-path /ide`;
  `Path=/ide` covers them. Verified manually (test plan) including the Codev sidebar's webviews.
- **Risk: `BRIDGE_MODE`.** The mint endpoint is still key-gated; a LAN peer able to load the
  dashboard can already obtain the key (documented), so the cookie adds nothing new.
- **Alternative: put the key itself in the cookie.** Rejected: puts the full API credential in
  the cookie jar for a prefix-scoped need.
- **Alternative: random token held in Tower memory.** Rejected: a Tower restart would 401 every
  open workbench's reconnect and force a re-click; the HMAC gives the same scoping statelessly.
- **Out of scope, flagged for a separate hygiene issue (S3):** the dashboard shell sets no
  `X-Frame-Options` / `frame-ancestors`. A cross-site frame gains nothing for #1869 (Strict
  cookie, CORS-stripped shell), so it is not addressed here.
- **Alternative: `__Host-` cookie prefix.** Rejected: it forces `Path=/`, sending the credential
  to every Tower route.
- **Alternative: make `/ide/` a public route and rely on the IDE's own connection token.**
  Rejected by the issue's non-goals (Tower injects `vscode-tkn`, so that would open the IDE to any
  loopback request).
- **Alternative: a query-param credential (`?ctkn=`) on the first URL.** Rejected: leaks into
  history/referrers and still needs a cookie for assets and sockets.

## Test Plan

Unit (`__tests__/server-utils.test.ts`, `ide-forward-auth.test.ts`, `ide-forward.test.ts`,
`request-auth.test.ts`):
- `isForwardAuthorized`: header still accepted; valid cookie accepted; wrong/empty cookie
  rejected; valid cookie + rebound Host rejected; key unavailable → rejected; cookie among other
  cookies parsed.
- Cross-port guard (M1), HTTP and WS upgrade:
  - cookie + `Origin: http://localhost:3000` on the WS upgrade → 401;
  - cookie + `Sec-Fetch-Site: same-site` → 401; `cross-site` → 401;
  - cookie + `Origin` == `http://<Host>` → allowed; cookie + `Sec-Fetch-Site: same-origin` or
    `none` → allowed; cookie with neither header → allowed;
  - cookie + `Origin` in `CODEV_TOWER_ALLOWED_ORIGINS` → allowed.
- Header branch unaffected: tunnel-stamped header + `Origin: https://<cloud host>` (and
  `Sec-Fetch-Site: cross-site`) → allowed, HTTP and WS; `bugfix-1586-tunnel-auth` and
  `ide-forward-auth` suites stay green.
- Derivation (M4): changing `CODEV_TOWER_KEY` then `resetExpectedKeyCache()` changes
  `ideForwardCookieValue()` and the old cookie is rejected.
- `isRequestAllowed`: `/ide/` with valid cookie → allowed; `/ide/` bare → rejected;
  `/api/...` (any non-`/ide` route) with valid cookie and no header → rejected; `/ideas` is not
  treated as IDE prefix.
- `stripCookie` / `buildForwardHeaders` (S2): `codev-ide-session` removed when it is first,
  middle, last, or the only pair, and from a `string[]` Cookie header; `codev-ide-session2`
  untouched; other cookies and `vscode-tkn` preserved, HTTP and WS.
- Route test: `POST /api/ide/session` without key → 401; with key → 204 + `Set-Cookie` carrying
  `Path=/ide; HttpOnly; SameSite=Strict`, empty body; `GET` → 405; with key +
  `x-codev-tunnel-proxy: 1` → 403 (S1).
- Logging (S4): a refused cookie request's WARN line contains neither the Cookie header nor the
  cookie value.
- CORS invariant (M2): no response (preflight, keyed route, `/ide/` forward) carries
  `Access-Control-Allow-Credentials`.
- WS upgrade: `/ide/...` upgrade with the cookie and no header is authorized (integration test in
  `ide-forward-integration.test.ts` with a stub upstream, as existing tests do).

Manual (worktree Tower + installed codev-ide), recorded in the review:
- `curl -i http://127.0.0.1:4100/ide/` → 401.
- `curl -i -H 'Host: evil.example' -H 'Cookie: codev-ide-session=<valid>' …/ide/` → 401.
- `curl -i -b 'codev-ide-session=<valid>' http://127.0.0.1:4100/api/state` → 401 (cookie scoped).
- `curl -i -b 'codev-ide-session=<valid>' http://127.0.0.1:8200/ide/` → 403 (the IDE server still
  requires `vscode-tkn`; the cross-port cookie grants nothing there).
- Browser (Playwright, per testing guide): load the dashboard, click **Open** on a workspace's
  IDE row → new tab opens the workbench for that folder with the Codev sidebar; network panel
  shows assets 200 and `?reconnectionToken=` WebSockets 101 through `4100/ide/`.
- Reload the workbench tab directly (no dashboard click) → still works (cookie held).
- Workbench surfaces (M1 follow-through): open a webview (Codev sidebar) and confirm in devtools
  that webview iframes and the service worker load from the Tower origin under `/ide`; any
  cross-origin surface gets an exact-origin allowlist entry, never a dropped check.
- Cross-port browser check: from a page served on another localhost port, `new
  WebSocket('ws://localhost:4100/ide/…')` fails (401) while the cookie is held.
- Cloud URL through the tunnel still opens the workbench (or, if no cloud registration is
  available locally, the existing tunnel-header tests stay green and this is flagged for the
  reviewer).
