# PIR Plan: Tower `/ide/` prefix forward + `afx ide` lifecycle (routing half)

## Understanding

Tower's tunnel client (`lib/tunnel-client.ts`, #1588) delivers every tunnel-borne request to exactly one place — Tower's own HTTP port. There is no way to expose a *second* local HTTP+WebSocket service (a VS Code server-web workbench serving a browser IDE) through the same tunnel without stopping Tower, which takes the dashboard offline.

This lane implements the **routing half only** (binding scope from architect main):

1. A fixed prefix (`/ide/`) on Tower forwards to a **single** local `http://127.0.0.1:<port>/…` server — plain HTTP in `tower-routes.ts handleRequest()` and WebSocket upgrades in `tower-websocket.ts` (raw bidirectional pipe; the workbench opens two WS connections under its base path with `?reconnectionToken=`). The **target workspace is chosen per browser connection** via a `?folder=<abs path>` query the workbench URL carries — one server serves any folder (confirmed by the codev-ide architect; see Decisions §D1). Tower passes the query through untouched.
2. Header hygiene on the forward: strip the leak-prone `x-forwarded-port` / `x-original-host`; stamp `x-forwarded-host` / `x-forwarded-proto` (and the external prefix) from the tunnel's public authority when the request is tunnel-borne; strip Tower-internal auth/attribution headers before they reach the IDE server. **Preserve** the upstream's `Cache-Control` / `ETag` (the server serves its ~21 MB boot as long-lived cacheable assets — that is the whole caching win; Tower must not clobber it).
3. Origin/host guard for the forwarded prefix, composed with — never instead of — the key check. **No per-folder authorization** (see Decisions §D2).
4. `afx ide start | stop | status` lifecycle that spawns/manages the single local server. `start` takes the binary path + port as flags and registers them with Tower (which persists to `global.db`), so Tower can forward, reconcile on restart, and respawn a dead server. Live PID is discovered by port, not persisted. **No config file** (Decisions §D3).
5. **gzip/brotli is deferred** (Decisions §D5) — not built in this lane.
6. No config surface / no config file: the fixed prefix has a default, the port and binary path are `afx ide start` flags, and the registration lives in `global.db`. `/api/tunnel/*` stays local-only as today.

**Explicitly OUT of this lane:** install-on-demand (`afx ide install`, artifact download/checksum) and its `artifactBaseUrl` knob — a later sub-lane that decides its own config home.

### Auth model (settled, binding)

The forwarded prefix is **key-authenticated, not a public carve-out.** It rides Tower's existing request-auth choke point (advisory GHSA-xvjp-7748-v88v: shared local key + Host allowlist). The decisive facts, verified in the code:

- `TunnelClient.stampLocalHeaders()` (`lib/tunnel-client.ts:115`) runs on **both** the HTTP path (`proxyHttpRequest`, :857) and the WS-CONNECT path (`handleWebSocketConnect`, :793). It deletes client-owned headers (`host`, `codev-tower-key`, `codev-web-key`, `x-codev-tunnel-proxy`), sets `Host: localhost:<localPort>`, and stamps `x-codev-tunnel-proxy: 1` + `codev-tower-key: <local key>`.
- So a tunnel-borne request — HTTP or WS upgrade — reaches Tower with `Host: localhost:<port>` (passes `isAllowedHost`) and the shared local key in the `codev-tower-key` **HTTP header** (passes `isRequestAllowed`, `server-utils.ts:307`).
- The IDE workbench's own WebSockets are **vanilla browser WebSockets** (`?reconnectionToken=`) that offer **no** `Sec-WebSocket-Protocol: codev-key.<KEY>` subprotocol. The dashboard's WS auth (`isWebSocketAllowed`, `server-utils.ts:370`) reads the key only from that subprotocol offer — so it does not fit the IDE WS. The IDE WS is authenticated instead by the tunnel-stamped `codev-tower-key` **header**, which is exactly the same credential the existing HTTP choke point already validates.

**Consequences:**
- The forward is a **post-auth** handler on both paths. For HTTP, `isRequestAllowed(req)` already runs before route dispatch, so the forward handler is only ever reached after the key check — nothing new. For the WS upgrade, we gate the IDE branch with the *same choke-point logic* applied to the upgrade request (host guard + header key check), not a new looser path.
- Authorization sits behind **one swappable seam** — `isForwardAuthorized(req)` in `server-utils.ts`, reusing `isAllowedHost` + `getExpectedKey` + `keysMatch` + `presentedHttpKey`. #1589 (per-session remote credential) can later swap this function's body from the local-key stamp to a per-session credential without touching the proxying code. Header stripping/stamping happens strictly *after* this seam.
- `/ide/` is **never** added to `isPublicRoute` (`server-utils.ts:148`). The only sanctioned public carve-out precedent is the nonce-authenticated OAuth callback (#1571); the IDE path has no equivalent one-shot secret.
- The origin/host guard remains in addition to the key check.

### Tunnel-marker integrity (#1674 dependency)

The #1674 lane-card privacy rule keys off `x-codev-tunnel-proxy` semantics: the marker means "this request came in over the tunnel" and cannot be forged (any inbound copy is stripped before Tower's own is stamped). The forward **must not weaken this**: strip-then-restamp holds on the new path (the tunnel client already strips a cloud-forged marker on the CONNECT/HTTP forward before stamping its own), and Tower must not leak or trust a forge-able marker through the IDE forward. A regression test asserts marker integrity end-to-end through the forward.

## Decisions

Recording these so the *why* survives — the caching-vs-isolation trade below is exactly the kind of choice a later reader is tempted to reverse.

- **§D1 — URL shape: a SINGLE server on a FIXED `/ide/`, workspace via `?folder=`.** *Decided* (codev-ide architect, relayed via main). One `codev-ide-server` process serves any folder on the machine; the browser picks the folder per connection with `?folder=<URL-encoded absolute path>` (or `?workspace=<x>.code-workspace`). Tower runs it with `--server-base-path /ide` and maps its known workspace paths straight onto `?folder=`. The "Open IDE" link is `<base>/ide/?folder=` + `encodeURIComponent(absPath)`.
  - **Rejected alternative — workspace-scoped `/workspace/<enc>/ide/`, one server per workspace.** *Why rejected:* (1) its only real advantage would be per-workspace isolation, and **that isolation does not exist at the server level** — a single server has no per-folder isolation and any authenticated connection can open any path the server's OS user can read (§D2), so a per-workspace URL would be *false comfort*; (2) it busts the asset cache — the fixed URL caches the ~21 MB boot **once per server version** (assets served under `<base>/<quality>-<commit>/static/…` with `Cache-Control: public, max-age=31536000` + ETag; the commit segment busts on upgrade; only the small HTML document varies per folder; `reconnectionToken` is a per-connection UUID, never cached), whereas per-workspace base paths would re-fetch it per workspace; (3) it would require a codev-cloud CSP + forwarded-header change (prod is already live for the bare `/t/<tower>/ide/`).
- **§D2 — Auth: Tower's key check is the WHOLE trust boundary; no per-folder authorization.** *Decided/binding.* The IDE server offers no per-folder isolation — any authenticated connection reads anything the server's OS user can (same trust as a terminal). So the forward does **not** build per-folder authz on top; `isForwardAuthorized(req)` (the #1589 seam) is a single key+Host decision with zero folder logic. The IDE server's own connection token is an inner layer, not a substitute.
- **§D3 — No config file. `afx ide start` registers with Tower; the registration lives in `global.db`.** *Decided (Amr, at the gate).* A single server whose only no-default input is the binary path does not need a config file. `afx ide start --server-path <bin> [--port] [--prefix]` supplies those as flags and **registers `{prefix, port, serverPath}` with the running Tower** via a key-authed local call; Tower persists it in `global.db` — the single source of truth for Tower runtime state (arch invariant) — so a restart *reconciles* (re-adopt the live server by port; respawn if dead) instead of orphaning. No `.codev/config.json` `ide` block, no machine-global `~/.codev` file, no `ide-servers.json`.
  - *Why not a config file:* (1) for a single global server, a per-repo `.codev/config.json` block is ambiguous (which repo's block wins?), and a machine-global `~/.codev` file is a hand-edited file for what is really runtime state; (2) Tower state already has one home — `global.db` — and a second store (file) would violate single-source-of-truth; (3) the only thing a file buys is not retyping `--server-path`, a convenience we can add later as an *optional* override without needing it now.
  - *Scope note:* the reserved `artifactBaseUrl` knob is dropped from this lane entirely — the future install sub-lane decides its own home.
- **§D4 — PID-by-port discovery** (builder discretion): `afx ide status`/`stop` and Tower's restart reconcile find the live server via `getProcessesOnPort(port)`; the persisted registration supplies the port and `serverPath` for respawn.
- **§D5 — gzip/brotli: DEFERRED** (Amr, at the gate; matches main's routing-first recommendation). Not built in this lane. If a later measurement shows the cloud leg is slow, add it then — and it must preserve `ETag`/`Cache-Control` (a naive re-encode dropping the validators would defeat §D1's caching). The routing/auth core is written so it can be added without disturbance.

## Proposed Change

### 1. HTTP forward — `tower-routes.ts`

Add a new pattern-prefix branch inside `handleRequest()` (after the exact-match table, alongside the existing `/api/tunnel/`, `/workspace/` prefix checks), reached **only after** `isRequestAllowed(req)` has passed (the existing choke point at ~:271). When `url.pathname` starts with the configured prefix (default `/ide/`) **and** an IDE server is registered:

- Resolve the target `127.0.0.1:<port>` from the Tower registration (single server; §D3). No registration ⇒ 404/502.
- Forward the path **and query unchanged** (keeping `/ide/…?folder=…`) to the IDE server, which runs with `--server-base-path /ide` and selects the workspace from `?folder=`. Tower never rewrites the folder.
- Build forward headers from the incoming request: drop hop-by-hop headers, **strip** `x-forwarded-port` and `x-original-host`, and **strip Tower-internal** `codev-tower-key` / `codev-web-key` / `x-codev-tunnel-proxy` (the IDE server must not see Tower's auth/attribution; this also preserves marker integrity by never forwarding it).
- When tunnel-borne (`x-codev-tunnel-proxy` present on the *incoming* request), **stamp** `x-forwarded-host` / `x-forwarded-proto` / external `x-forwarded-prefix` derived from the tunnel's public authority (`readCloudConfig()` → `server_url` host + `https` + `/t/<tower_name>/ide`, matching `tower-tunnel.ts:616`'s `accessUrl`). codev-cloud already sets these in production; Tower stamping them authoritatively means the workbench builds correct `remoteAuthority` / base-path URLs even if an intermediate hop drops them, and never sees a stale upstream port.
- Pipe request/response bodies, **preserving the upstream's `Cache-Control` / `ETag`** (§D1's cacheable assets). Optional gzip/brotli (§D5) applies here only if it keeps those validators intact.

New helper module `servers/ide-forward.ts` holds the target resolution, header hygiene, and the HTTP proxy so `tower-routes.ts` stays a thin dispatch (it already notes its size). WebSocket forwarding lives in the same module and is called from `tower-websocket.ts`.

### 2. WebSocket forward — `tower-websocket.ts`

In `setupUpgradeHandler()`, add an IDE-prefix branch. Because the existing `isWebSocketAllowed(req)` at :241 requires the subprotocol key (which the IDE workbench never offers), the IDE branch is checked **before** that generic gate and is authorized by the swappable seam `isForwardAuthorized(req)` (host guard + tunnel-stamped header key). On success, open an HTTP/1.1 upgrade request to `127.0.0.1:<idePort>` with the same header hygiene as the HTTP path, and raw-pipe `socket ↔ upstream socket` bidirectionally (mirroring `tunnel-client.ts handleWebSocketConnect`'s pipe, :814-821). No PTY, no frame protocol — the workbench speaks its own WS protocol.

### 3. Auth seam — `server-utils.ts`

Add `isForwardAuthorized(req)`: `isAllowedHost(req.headers.host) && keysMatch(presentedHttpKey(req) ?? '', getExpectedKey() ?? <fail-closed>)`. This is the single authorization decision for the forward (HTTP path already enforces the equivalent via `isRequestAllowed`; the WS branch calls this). Documented as the #1589 swap point. **No per-folder logic** (§D2): the IDE server has no per-folder isolation, so authorization is a whole-boundary key+Host check and nothing finer.

### 4. `afx ide` lifecycle (no config file — §D3)

The CLI is **commander**-based (`agent-farm/cli.ts`, built in `runAgentFarm`). Add an `ide` command group next to the `tower` group (model at `cli.ts:941-943`), with `start`/`stop`/`status` subcommands, delegating to a new `commands/ide.ts` (modeled on `commands/tower.ts`). There is **one** server (§D1).

- `afx ide start --server-path <bin> [--port 8200] [--prefix /ide/] [--default-folder <path>]` spawns the server detached — mirroring `towerStart` (`commands/tower.ts:167`): `spawn(bin, args, { detached: true, stdio: 'ignore' })` + `unref()`. Args: `--host 127.0.0.1 --port <p> --server-base-path <prefix> --connection-token-file <tower-owned file> --accept-server-license-terms` (+ `--default-folder` for what opens when a URL carries no `?folder=`). Then **registers `{prefix, port, serverPath}` with Tower** (key-authed local call → persisted in `global.db`). `--server-path` is required (no default — the real build lives in a private fork); missing ⇒ clear error. Idempotent: no-op if already live on the port.
- `afx ide stop` reads the registration, discovers the live pid **by port** (`getProcessesOnPort` from `utils/port.ts:24`), SIGTERMs it (poll `process.kill(pid,0)` → SIGKILL escalation, as `towerStop` does at `tower.ts:355-383`), and clears the registration.
- `afx ide status` reads the registration from Tower, discovers the live pid by port, and reports prefix + port + PID + liveness. **Doc note:** each open browser window spawns its own extension host (~100–300 MB); N windows = N hosts — surfaced here so the memory cost is visible.
- **Restart reconcile / respawn (§D4):** on boot Tower reads the registration from `global.db`; if a server is still live on the port it re-adopts it (no orphan), and if the port is dead it best-effort respawns from the persisted `serverPath` (bounded readiness wait before the first forward, like `towerStart`, so the first `/ide/` hit doesn't 502 on startup latency). Wire the launcher into `servers/tower-server.ts` boot beside the other background services (`codev-config-watcher.ts`, `tower-cron.ts`). The connection-token-file is Tower-owned; that token is the IDE server's own inner layer, **not** a substitute for the key check.

### 5. gzip/brotli on the forward — DEFERRED (§D5)

Not built in this lane (Amr's call at the gate; matches main's routing-first recommendation). The forward passes responses through as-is. If a later measurement shows the cloud leg is slow, compression can be added to the HTTP forward without touching the routing/auth core — preserving `ETag`/`Cache-Control` (§D1).

## Files to Change

- `packages/codev/src/agent-farm/servers/ide-forward.ts` — **new.** Target resolution from the Tower registration, header hygiene (strip `x-forwarded-port`/`x-original-host`/Tower-internal; stamp `x-forwarded-*` when tunnel-borne; preserve `Cache-Control`/`ETag`; pass `?folder=` through), HTTP proxy, WS raw-pipe. Unit-testable pure helpers for header transformation. (No compression — §D5 deferred.)
- `packages/codev/src/agent-farm/servers/tower-routes.ts:293-363` — add the `/ide/` prefix branch in `handleRequest()` after the exact-match table, post-`isRequestAllowed`. Delegates to `ide-forward.ts`.
- `packages/codev/src/agent-farm/servers/tower-websocket.ts:235-297` — add the IDE-prefix upgrade branch gated by `isForwardAuthorized`, before the generic `isWebSocketAllowed` gate; delegates the raw pipe to `ide-forward.ts`.
- `packages/codev/src/agent-farm/utils/server-utils.ts:298-329` — add `isForwardAuthorized(req)` (the swappable #1589 seam) reusing existing primitives. Do **not** touch `isPublicRoute`.
- `packages/codev/src/agent-farm/commands/ide.ts` — **new.** `ideStart` / `ideStop` / `ideStatus`, modeled on `commands/tower.ts`.
- `packages/codev/src/agent-farm/cli.ts` — register the `ide` group near `:940`; import from `./commands/ide.js` near `:10`.
- **IDE registration in `global.db`** — a small store (row/table) holding `{prefix, port, serverPath}`, written by `afx ide start` and read by the forward + restart reconcile. Follow the existing `global.db` access pattern (`agent-farm/db/`); no hand-edited config file (§D3).
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (or a small `tower-ide.ts`) — a key-authed local endpoint for register/deregister/status (e.g. `POST/DELETE/GET /api/ide`), the seam `afx ide` calls. Blocked from the tunnel like `/api/tunnel/*` (local-only management).
- `packages/codev/src/agent-farm/servers/tower-server.ts` — boot-time reconcile/respawn wiring (beside the other background services); an IDE launcher may live in `servers/` for `serversDir` resolution.
- `packages/types/src/websocket.ts` (+ `index.ts` barrel) — shared IDE default-prefix / forward-header constant(s) if warranted.
- **"Open IDE" link builder** — a small helper producing `<base>/ide/?folder=` + `encodeURIComponent(absPath)` for a workspace's absolute path; home TBD (dashboard/VSCode workspace UI or `afx ide status` output). Small; may land as a follow-up if it reaches into the dashboard.
- **Tests** (see Test Plan) — new: `ide-forward.test.ts`, forward auth + marker-integrity cases, WS pipe. Existing suites to extend: `server-utils.test.ts`, `tower-routes.test.ts`, `tower-websocket.test.ts`, `tunnel-edge-cases.test.ts` / `bugfix-1586-tunnel-auth.test.ts` (marker integrity through the forward).

> Note: this is product code in `packages/codev` (the shipped package), not a protocol/template file, so the `codev/` ↔ `codev-skeleton/` mirror rule does **not** apply here.

## Risks & Alternatives Considered

- **Risk — WS auth divergence.** The IDE WS can't use the subprotocol-key path. *Mitigation:* authorize via the same header-key credential the HTTP choke point uses, factored into `isForwardAuthorized` (chosen shape (a); §D2); add explicit tests that a keyless/forged upgrade is rejected and a tunnel-stamped one is accepted.
- **Risk — single server has no per-folder isolation.** Any authenticated connection can open any path the server's OS user reads. *Accepted, not mitigated away:* this is the same trust model as a Tower terminal, and Tower's key check is the whole boundary (§D2). Documented so it's a conscious posture, not a surprise; per-folder authz is explicitly *not* built (it would be false comfort — §D1).
- **Risk — leaked upstream port breaks the browser WS dial.** *Mitigation:* strip `x-forwarded-port` / `x-original-host`; stamp `x-forwarded-host`/`proto` authoritatively from cloud config for tunnel-borne requests.
- **Risk — marker forgery / #1674 regression.** *Mitigation:* never forward `x-codev-tunnel-proxy` to the IDE server; rely on the tunnel client's existing strip-then-restamp; add a regression test.
- **Risk — orphaned IDE server on Tower restart.** *Mitigation:* no record to go stale — `afx ide stop` and auto-start both discover the server by port (`getProcessesOnPort`); a Tower restart re-discovers or best-effort respawns. Acceptance requires "Tower restart does not orphan it" — verified in the test plan.
- **Risk — compression defeats caching.** If §D5 is included, a re-encode that drops `ETag`/`Cache-Control` would bust §D1's per-version asset cache. *Mitigation:* preserve validators, or don't compress that response — covered by a test if included.
- **Alternative — workspace-scoped `/workspace/<enc>/ide/`.** Rejected — see §D1 (no server-side isolation to gain, busts the cache, needs a cloud CSP change).
- **Alternative — add `/ide/` to the public route allowlist.** Rejected outright by the binding auth model (reopens the GHSA hole).

## Test Plan

**Unit (self-contained, no real IDE server):**
- `ide-forward.ts` header hygiene: strips `x-forwarded-port` / `x-original-host` / Tower-internal headers; stamps `x-forwarded-host`/`proto`/external-prefix from a mock cloud config only when tunnel-borne; leaves local requests unstamped.
- `isForwardAuthorized`: accepts a request with a valid `codev-tower-key` header + allowed Host; rejects missing/forged key; rejects disallowed Host; fails closed when no local key is readable.
- Marker integrity: a request forged with `x-codev-tunnel-proxy` from the cloud side does not survive into the forwarded request; a genuine tunnel-borne request is honestly marked. (Extend `bugfix-1586-tunnel-auth.test.ts` / `tunnel-edge-cases.test.ts` patterns via `mock-tunnel-server`.)

**Integration (stub loopback server — architect-sanctioned dev path):**
- Stand up a stub HTTP+WS echo server on `127.0.0.1:<p>`; configure the `ide` block; assert `GET /ide/…?folder=…` through Tower reaches it with the sanitized headers, the **`?folder=` query intact**, and the upstream **`Cache-Control`/`ETag` preserved** on the response; a WS upgrade to `/ide/…` raw-pipes bytes both ways.
- Auth: keyless `/ide/…` HTTP and WS are 401; keyed pass. (No per-folder distinction — §D2.)
- Lifecycle: `afx ide start` spawns + registers in `global.db`; `afx ide status` reports port+PID by discovery; `afx ide stop` tears down + clears the registration; a simulated Tower restart reads the registration, re-adopts a live server by port (no orphan), and respawns a dead one.

**Local real-server (private fork — accessible locally per Amr):**
- Run the real codev-ide server-web build locally and drive the full workbench boot through Tower's forward (`http://localhost:4100/ide/?folder=…`): assets load, the two remote WebSockets connect, an editor session opens against the chosen folder. This is the real end-user path, not just the stub.

**Cloud leg — needs Amr's env (name at dev-approval):**
- Full `https://<relay>/t/<tower>/ide/`: needs Amr's registered Tower + codev-cloud (prefix CSP + forwarded headers already live in prod). Acceptance to confirm there: workbench boots while `/t/<tower>/` dashboard keeps working; both remote WebSockets connect with `remoteAuthority` = relay host; **no `ws://localhost` attempts**.

## Open Questions for the reviewer

All prior questions are resolved and recorded in Decisions:
- §D1 URL shape — fixed `/ide/` + `?folder=`, single server (rejected alt documented).
- §D2 auth — Tower key check is the whole boundary; no per-folder authz.
- §D3 config — **no config file**; `afx ide start` flags + registration in `global.db`.
- §D4 — PID/port discovery + restart reconcile.
- §D5 gzip/brotli — **deferred**.
- Verification — the private fork is locally accessible, so dev-approval exercises the **real** server locally; only the cloud `/t/<tower>/ide/` leg needs Amr's env.

Nothing blocking remains from the builder side. Ready for the plan-approval decision.
