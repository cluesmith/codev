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
  hex. Returns null when the key is unavailable (fail closed).

Why derived rather than the key itself or a random in-memory token:
- **Not the key.** The cookie jar never holds the Tower key, so a leak of the cookie (devtools,
  a misbehaving extension in the workbench reading `document.cookie` is already blocked by
  `HttpOnly`, but defense in depth) grants `/ide/*` only, never the API.
- **Stateless.** Survives a Tower restart, so an open workbench reconnects after
  `afx tower stop/start` without re-clicking. Rotates automatically when the local key rotates.
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
Only `POST`; other methods 405.

### 3. One authorization seam accepts the cookie

- `isForwardAuthorized`: after the Host guard and key load, accept either the header (unchanged)
  **or** a `codev-ide-session` cookie that constant-time-matches `ideForwardCookieValue()`.
  Cookie parsing via a small `cookieValue(header, name)` helper (no new dependency).
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
`stripCookie(header, name)`), mirroring how the key header is stripped. Applies to the WS
forward too (it uses the same header builder; will confirm in implementation).

### 5. Open IDE link per workspace on the local dashboard

`packages/codev/templates/tower.html`, `renderInstance` (`:1217`): add an **IDE** row (same
`port-item` shape as Overview) with an **Open** action, for running workspaces. Click handler:

1. `const tab = window.open('about:blank', '_blank')` synchronously (keeps the popup tied to the
   user gesture; Safari blocks a `window.open` after an `await`).
2. `await authFetch('./api/ide/session', { method: 'POST' })`.
3. `tab.location = './ide/?folder=' + encodeURIComponent(instance.workspacePath)` (relative, so
   the cookie origin `localhost` vs `127.0.0.1` always matches the dashboard's own origin).
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
the trust notes. Check `arch.md` for an IDE forward auth section and update it if present.

## Files to Change

- `packages/codev/src/agent-farm/utils/server-utils.ts:307-366` — cookie constant, derivation,
  cookie parser, `isForwardAuthorized` accepts cookie, `isRequestAllowed` delegates `/ide*`.
- `packages/codev/src/agent-farm/lib/ide-record.ts` — host `matchIdePrefix` (pure) if needed to
  avoid a cyclic import.
- `packages/codev/src/agent-farm/servers/ide-forward.ts:115-150` — strip Tower cookie before
  forwarding; re-export `matchIdePrefix`.
- `packages/codev/src/agent-farm/servers/tower-routes.ts:~317` — `POST /api/ide/session`.
- `packages/codev/src/agent-farm/servers/tower-websocket.ts:242-251` — comment update only (the
  call is unchanged; behavior comes from `isForwardAuthorized`).
- `packages/codev/templates/tower.html` — IDE row + click handler + status fetch.
- `codev/resources/commands/agent-farm.md`, `codev-skeleton/resources/commands/agent-farm.md`.
- Tests (below).

## Risks & Alternatives Considered

- **Risk: widening `/ide/` to cookie-holders broadens the attack surface.** The cookie is
  `HttpOnly; SameSite=Strict; Path=/ide`, obtainable only by a same-origin holder of the key, and
  the Host guard still runs first. A cross-site page cannot make the browser send it (Strict), so
  CSRF-style requests into the workbench from another site are refused. Net trust equals the key
  header for this one prefix, which is what the issue asks.
- **Risk: cookie leaks to the IDE server.** Stripped before forwarding (step 4); unit-tested.
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
- `isRequestAllowed`: `/ide/` with valid cookie → allowed; `/ide/` bare → rejected;
  `/api/...` (any non-`/ide` route) with valid cookie and no header → rejected; `/ideas` is not
  treated as IDE prefix.
- `buildForwardHeaders`: `codev-ide-session` removed from `Cookie`, other cookies and `vscode-tkn`
  preserved.
- Route test: `POST /api/ide/session` without key → 401; with key → 204 + `Set-Cookie` carrying
  `Path=/ide; HttpOnly; SameSite=Strict`; `GET` → 405.
- WS upgrade: `/ide/...` upgrade with the cookie and no header is authorized (integration test in
  `ide-forward-integration.test.ts` with a stub upstream, as existing tests do).

Manual (worktree Tower + installed codev-ide), recorded in the review:
- `curl -i http://127.0.0.1:4100/ide/` → 401.
- `curl -i -H 'Host: evil.example' -H 'Cookie: codev-ide-session=<valid>' …/ide/` → 401.
- `curl -i -b 'codev-ide-session=<valid>' http://127.0.0.1:4100/api/state` → 401 (cookie scoped).
- Browser (Playwright, per testing guide): load the dashboard, click **Open** on a workspace's
  IDE row → new tab opens the workbench for that folder with the Codev sidebar; network panel
  shows assets 200 and `?reconnectionToken=` WebSockets 101 through `4100/ide/`.
- Reload the workbench tab directly (no dashboard click) → still works (cookie held).
- Cloud URL through the tunnel still opens the workbench (or, if no cloud registration is
  available locally, the existing tunnel-header tests stay green and this is flagged for the
  reviewer).
