# PIR Plan: Open Codev IDE link over Codev Cloud

## Understanding

The Tower dashboard (`packages/codev/templates/tower.html`) draws the **Open IDE** row only when
`ideAvailable` is true. Two pieces of that path are local-only by design, so over Codev Cloud the
link never appears and could not open anyway:

1. **Availability.** `refreshIdeStatus()` (`templates/tower.html:1232-1244`) fetches
   `GET ./api/ide`. The tunnel client blocks the whole `api/ide` family
   (`src/agent-farm/lib/tunnel-client.ts:87`, `BLOCKED_PATH_SEGMENT`), so over the tunnel the
   fetch fails and `ideAvailable` stays false.
2. **Open.** `openIde()` (`templates/tower.html:1264-1288`) first `POST`s `./api/ide/session` to
   mint the HttpOnly `/ide` forward cookie. That path is tunnel-blocked and Tower also refuses a
   tunnel-borne mint (`src/agent-farm/servers/tower-routes.ts:339-343`, 403).

The `/ide/` forward itself is reachable over the tunnel: `TunnelClient.stampLocalHeaders`
(`tunnel-client.ts:127-142`) stamps the local key header and the `x-codev-tunnel-proxy: 1` marker
on every proxied request, so `isRequestAllowed` → `isForwardAuthorized`
(`src/agent-farm/utils/server-utils.ts:323`, `:470-490`) authorizes it via the header; the forward
then stamps the public `x-forwarded-*` authority (`ide-forward.ts:168`) and relays the IDE server's
`vscode-tkn` cookie unchanged on the tunnel path (`ide-forward.ts:395-405`). Nothing on the cloud
path needs the forward cookie.

## Proposed Change

### 1. Cloud-safe availability signal: carried in `GET /api/status`

`/api/status` is what the dashboard already polls every 5s (`refresh()`, `tower.html:1168`) and it
is not tunnel-blocked. Extend its payload (`handleStatus`, `tower-routes.ts:1355`) with:

```json
{ "instances": [...], "ide": { "available": true, "viaTunnel": false } }
```

Computed per request (handleStatus gains the `req`):

- **Local request:** `available = readIdeRecord() !== null`. This is exactly today's local
  semantic (`!!status.record`; a recorded-but-dead server still counts because the mint respawns it
  before the tab navigates). Cheap: a JSON file read, no `lsof`, so it is safe on the 5s poll.
- **Tunnel-borne request** (`x-codev-tunnel-proxy === '1'`): `available = record present AND the
  recorded port accepts a loopback TCP connect` (reuse `isPortAccepting`,
  `ide-server.ts:99`, 1s timeout; a refused connect returns immediately). Over the tunnel there is
  no mint to respawn a dead server first, and the forward would 502 the first navigation
  (`ide-forward.ts:426-435`), so the cloud only advertises a **live** server, as the issue's
  acceptance asks ("a Tower with a live IDE server shows the link").
- `viaTunnel` tells the page which open path to use. The server knows this from its own marker
  (which the tunnel client strips from inbound requests, so it cannot be forged from the cloud
  side); the page does not have to guess from its hostname. Only a yes/no and the open-path hint
  travel; no port, path, pid or token.

The lifecycle verbs (`GET/POST/DELETE /api/ide`, `POST /api/ide/session`) stay local-only and
tunnel-blocked. `BLOCKED_PATH_SEGMENT` is not touched.

### 2. Dashboard reads the signal from the status poll

- `refresh()` sets `ideAvailable = !!(data.ide && data.ide.available)` and
  `ideViaTunnel = !!(data.ide && data.ide.viaTunnel)` from the same `/api/status` response.
- `refreshIdeStatus()` and its `GET ./api/ide` call are **removed**, together with the
  load/visibility hooks in `init()` (`tower.html:1065-1073`). One source of truth instead of two
  polls that could disagree; locally the link appears on exactly the same condition as today
  (record present), just refreshed on the 5s poll instead of on load/visibility. This also removes
  the blocking `lsof` probe the dashboard used to trigger on load.
  An older Tower that does not send `ide` yields no link, as today's failed fetch does.

### 3. Tunnel-aware open path

`openIde()` keeps opening the tab synchronously (popup blockers), then:

- **Local (`!ideViaTunnel`):** unchanged: `POST ./api/ide/session`, then navigate (#1869).
- **Tunnel (`ideViaTunnel`):** skip the mint and navigate the tab directly to
  `new URL('./ide/?folder=' + encodeURIComponent(ideFolderUriPath(path)), location.href)`, which
  resolves under the prefix the browser is already on (`<server_url>/t/<slug>/ide/?folder=…`).
  If the tab cannot be opened or navigated, a plain error toast, as the local branch has today.

Two properties are explicit, and pinned by template assertions:

- **(a) The link is always relative to `location.href`.** The slug is never stored, persisted or
  computed in the page; `openIde()` contains no literal `/t/` construction. A cloud-side Tower
  rename (old slugs 410/404) therefore cannot strand the link: it follows whatever slug the
  browser used to reach the dashboard. Both branches build the URL through one helper
  (`ideTargetUrl(workspacePath)`).
- **(b) The tunnel branch carries no Tower key and no forward cookie.** It is a plain top-level
  navigation; the cloud browser session cookie is the authorization (the relay requires it on
  `/t/<tower>/ide/*`), and the tunnel client stamps the local key on the Tower side as it does for
  every proxied request. No `authFetch`, no `codev-tower-key` header, no mint on that branch.

### 4. Scope the relayed `vscode-tkn` cookie to the tenant prefix (tunnel-borne only)

The Codev Cloud relay passes `Set-Cookie: vscode-tkn=…` through untouched (confirmed on #1914), so
its scope is whatever the IDE server sets; today that is the RFC 6265 default path, which happens
to be `/t/<tower>/ide`. A future `Path=/` from the IDE server would collide across towers on the
shared cloud origin. Tower guarantees the scope itself:

- **Tunnel-borne responses:** every `vscode-tkn` Set-Cookie the IDE server emits is rewritten to
  carry `Path=<publicAuthority.prefix>` (that is, `/t/<tower-name>/ide`, the same prefix Tower
  already stamps in `x-forwarded-prefix`, `ide-forward.ts:139`). Any existing `Path` attribute is
  replaced; every other attribute (`Max-Age`, `Expires`, `SameSite`, `HttpOnly`, `Secure`, …) and
  every other cookie are relayed as-is. With no public authority (a tunnel-borne request on a
  tower with no cloud config, which should not occur) the cookie is stripped, failing closed: the
  browser never needs it, because Tower injects the token on every forwarded request
  (`buildForwardHeaders`, `ide-forward.ts:190-197`).
- **Local responses:** unchanged, the cookie is still stripped (#1869).
- Applies on both relay paths: HTTP (`copyResponseHeaders`, including the workbench-HTML path) and
  the WebSocket 101 (`rebuildUpgradeResponse`). The current `stripTokenCookie: boolean` parameter
  becomes a small policy value (`{ kind: 'strip' } | { kind: 'scope', path }`) chosen once per
  request by one function, so the two relay paths cannot disagree.

Note: the relay itself also stamps `x-forwarded-*` on the IDE prefix and overwrites Tower's
values if they differ, so Tower's stamp is consistency, not authority. The cookie Path uses
Tower's own `tower_name`; if that ever drifted from the slug the browser used, the effect is only
that the browser does not send the cookie back, which is harmless because Tower injects the token
itself.

## Files to Change

- `packages/codev/src/agent-farm/servers/tower-routes.ts:224,1355-1359` — `handleStatus(req, res)`
  adds the `ide` block; the route entry passes `req`.
- `packages/codev/src/agent-farm/servers/ide-server.ts` — new exported
  `ideAvailability(viaTunnel: boolean): Promise<boolean>` (record check, plus `isPortAccepting`
  for tunnel-borne). Lives beside `ideServerStatus` so the IDE-record logic stays in one module.
- `packages/codev/templates/tower.html:991-994,1065-1073,1168-1186,1229-1288` — `ideViaTunnel`
  state, read both flags in `refresh()`, drop `refreshIdeStatus()` + its hooks, branch `openIde()`.
- `packages/codev/src/agent-farm/servers/ide-forward.ts:205-245,340-360,395-407,477,517-535` —
  new exported `scopeConnectionTokenSetCookie(value, path)`; `copyResponseHeaders` and
  `rebuildUpgradeResponse` take the cookie policy instead of a boolean; `forwardIdeHttp` and the
  upgrade path pick the policy from `isTunnelBorne` + `getPublicAuthority()`.
- `packages/codev/src/agent-farm/__tests__/ide-forward.test.ts:237-330` — existing callers of
  `copyResponseHeaders(…, true/false)` / `rebuildUpgradeResponse(…, bool)` move to the policy form;
  the "tunnel path relays the cookie unchanged" assertions become "tunnel path scopes it".
- `packages/codev/src/agent-farm/__tests__/pir-1914-ide-cloud-availability.test.ts` — new unit tests
  (below).
- Existing pinning tests left as-is and re-run: `tunnel-client` `isBlockedPath` tests for
  `api/ide` / `api/ide/session`, `pir-1869-ide-forward-cookie.test.ts` (mint 403 over tunnel,
  cookie gate), `ide-forward-auth.test.ts`. Update any test that asserted the dashboard fetches
  `./api/ide` (e.g. `spec-1658-ide-folder-uri.test.ts` if it touches `refreshIdeStatus`).

No `codev-skeleton/` change (runtime code and the shipped template only).

## Risks & Alternatives Considered

- **Risk: per-poll TCP probe over the tunnel.** One loopback connect every 5s per cloud-viewing
  tab, only when a record exists. Negligible; refused connects return at once, the timeout is 1s.
  Local polls do no probe.
- **Risk: link shows locally for a recorded-but-dead server.** Same as today, intentional (#1869):
  the mint respawns it.
- **Risk: an unauthenticated request with a forged tunnel marker.** A local process adding
  `x-codev-tunnel-proxy: 1` without the key still fails `isForwardAuthorized` (no header key, no
  cookie) → 401. A test pins this. The marker only changes the *open path hint* and the `/ide`
  response hygiene, never authorization.
- **Alternative: a read-only route outside `api/ide` (e.g. `/api/ide-availability`).** Rejected:
  a second poll for one boolean, plus a new route near a blocked family that a future regex edit
  could accidentally expose or block. The status payload is already polled and relayed.
- **Alternative: `isCloudServed()` hostname check for the open branch.** Rejected: it only knows
  `codevos.ai`; the server's tunnel marker is authoritative for any `server_url`.
- **Alternative: keep `refreshIdeStatus()` locally and use the status field only over the tunnel.**
  Rejected: two sources for the same yes/no would drift; the status field covers both.
- **Alternative: try the mint and fall back to direct navigation on 403.** Rejected: opaque
  error-driven control flow, and it pays a blocked request on every cloud click.

## Test Plan

- **Unit (new `pir-1914-…test.ts`):**
  - `ideAvailability(false)` → true with a record (even if the port is dead), false without.
  - `ideAvailability(true)` → true only with a record AND a listening port; false with a record
    whose port refuses; false without a record.
  - `GET /api/status` carries `ide: { available, viaTunnel:false }` locally and
    `viaTunnel:true` with the tunnel marker.
  - Forward auth: a request to `/ide/` with `x-codev-tunnel-proxy: 1` and no key/cookie is refused;
    with the key header (what the tunnel client stamps) it is allowed.
  - Template source assertions (bugfix-1599 pattern): `openIde()` branches on `ideViaTunnel`; the
    tunnel branch contains no `api/ide/session`, no `authFetch` and no key header; the local branch
    still mints before navigating; `openIde()`/`ideTargetUrl()` contain no literal `/t/` and build
    from `location.href`; `refresh()` reads `data.ide`; the template no longer fetches `./api/ide`.
  - Cookie scoping (`ide-forward.test.ts`): tunnel policy rewrites `vscode-tkn=T; Max-Age=604800;
    SameSite=Lax` to carry `Path=/t/<name>/ide` with `Max-Age`/`SameSite` preserved; an existing
    `Path=/` is replaced, not duplicated; other cookies untouched; `vscode-tkn2=` untouched; same on
    the WebSocket 101 rebuild; tunnel-borne with no public authority strips; local still strips.
  - Integration (`ide-forward-integration.test.ts` style, stub IDE server emitting `Set-Cookie:
    vscode-tkn=T`): a tunnel-marked request through `forwardIdeHttp` with a cloud config gets the
    scoped cookie; a local request gets none.
  - Existing: `isBlockedPath('/api/ide')`, `('/api/ide/session')` stay true; tunnel-borne mint stays
    403.
- **Playwright (per testing guide):** load the dashboard against a test Tower with a stubbed IDE
  record: (a) local → Open IDE visible, click → mint request then `/ide/?folder=` tab;
  (b) the same page with the `/api/status` response intercepted to `viaTunnel:true` → link visible,
  click opens `/ide/?folder=…` with **no** `api/ide/session` request; (c) `available:false` → no row.
- **Manual (dev-approval), local:** run the worktree Tower; confirm Open IDE behaves as before
  (link shown with a recorded server, mint request, workbench opens).
- **Manual (dev-approval), cloud — stated dependency:** the cloud path can only be exercised by a
  Tower that is **registered to Codev Cloud and running this branch's build**. A worktree Tower on
  another port is not cloud-registered, and the owner's live Tower is not restarted without the
  owner's word. So this check **needs the owner's live Tower on this build, or a second
  cloud-registered Tower**; that is the explicit question for the dev-approval gate. When available:
  open `<server_url>/t/<tower>/` with an IDE server running → link visible; click opens a working
  workbench (no `api/ide/session` request in devtools, both remote WebSockets connect, the
  `vscode-tkn` cookie shows `Path=/t/<tower>/ide`); stop the IDE server → link gone within one
  poll; a Tower with no IDE server → no link.
