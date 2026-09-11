# PIR Plan: Tower `/ide/` prefix forward + `afx ide` lifecycle (routing half)

## Understanding

Tower's tunnel client (`lib/tunnel-client.ts`, #1588) delivers every tunnel-borne request to exactly one place — Tower's own HTTP port. There is no way to expose a *second* local HTTP+WebSocket service (a VS Code server-web workbench serving a browser IDE) through the same tunnel without stopping Tower, which takes the dashboard offline.

This lane implements the **routing half only** (binding scope from architect main):

1. A fixed prefix (`/ide/`) on Tower forwards to a **single** local `http://127.0.0.1:<port>/…` server — plain HTTP in `tower-routes.ts handleRequest()` and WebSocket upgrades in `tower-websocket.ts` (raw bidirectional pipe; the workbench opens two WS connections under its base path with `?reconnectionToken=`). The **target workspace is chosen per browser connection** via a `?folder=<abs path>` query the workbench URL carries — one server serves any folder (confirmed by the codev-ide architect; see Decisions §D1). Tower passes the query through untouched.
2. Header hygiene on the forward: strip the leak-prone `x-forwarded-port` / `x-original-host`; stamp `x-forwarded-host` / `x-forwarded-proto` (and the external prefix) from the tunnel's public authority when the request is tunnel-borne; strip Tower-internal auth/attribution headers before they reach the IDE server. **Preserve** the upstream's `Cache-Control` / `ETag` (the server serves its ~21 MB boot as long-lived cacheable assets — that is the whole caching win; Tower must not clobber it).
3. Origin/host guard for the forwarded prefix, composed with — never instead of — the key check. **No per-folder authorization** (see Decisions §D2).
4. `afx ide start | stop | status` lifecycle that spawns/manages the single local server and lets Tower auto-start it when the prefix is hit (if configured). Runtime PID is discovered by port, not persisted.
5. gzip/brotli on the forward for text responses (the workbench boot is ~21 MB uncompressed and the VS Code server sends no compression). **Open at the gate** — see Decisions §D5.
6. A config surface (one `ide` block in `.codev/config.json`) for the fixed prefix, the server port + binary path, and an optional **no-default** artifact-base-url knob reserved for the future install lane. `/api/tunnel/*` stays local-only as today.

**Explicitly OUT of this lane:** install-on-demand (`afx ide install`, artifact download/checksum) — a later sub-lane. The artifact-base-url is only reserved in the config schema with no default and no behaviour.

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
- **§D3 — Config: one `ide` block in `.codev/config.json`, no runtime record file.** *Decided.* Single server ⇒ a single declarative block (naturally the machine-global `~/.codev/config.json` layer of the five-layer merge — see §4). Runtime PID is discovered by the configured port (Tower's own pattern), never persisted.
- **§D4 — PID-by-port discovery** (builder discretion): `afx ide status`/`stop` and Tower auto-start find the live server via `getProcessesOnPort(ide.port)`; no `ide-servers.json`.
- **§D5 — gzip/brotli: OPEN at the human gate.** Amr indicated *include* in-session; main recommends *defer* (routing-first — add only if the cloud leg measures slow). If included, it must preserve `ETag`/`Cache-Control` semantics (a naive re-encode that drops the validators would defeat §D1's caching). Amr rules at the gate.

## Proposed Change

### 1. HTTP forward — `tower-routes.ts`

Add a new pattern-prefix branch inside `handleRequest()` (after the exact-match table, alongside the existing `/api/tunnel/`, `/workspace/` prefix checks), reached **only after** `isRequestAllowed(req)` has passed (the existing choke point at ~:271). When `url.pathname` starts with the configured prefix (default `/ide/`) **and** the `ide` block is configured:

- Resolve the target `127.0.0.1:<ide.port>` from config (single server; §D3).
- Forward the path **and query unchanged** (keeping `/ide/…?folder=…`) to the IDE server, which runs with `--server-base-path /ide` and selects the workspace from `?folder=`. Tower never rewrites the folder.
- Build forward headers from the incoming request: drop hop-by-hop headers, **strip** `x-forwarded-port` and `x-original-host`, and **strip Tower-internal** `codev-tower-key` / `codev-web-key` / `x-codev-tunnel-proxy` (the IDE server must not see Tower's auth/attribution; this also preserves marker integrity by never forwarding it).
- When tunnel-borne (`x-codev-tunnel-proxy` present on the *incoming* request), **stamp** `x-forwarded-host` / `x-forwarded-proto` / external `x-forwarded-prefix` derived from the tunnel's public authority (`readCloudConfig()` → `server_url` host + `https` + `/t/<tower_name>/ide`, matching `tower-tunnel.ts:616`'s `accessUrl`). codev-cloud already sets these in production; Tower stamping them authoritatively means the workbench builds correct `remoteAuthority` / base-path URLs even if an intermediate hop drops them, and never sees a stale upstream port.
- Pipe request/response bodies, **preserving the upstream's `Cache-Control` / `ETag`** (§D1's cacheable assets). Optional gzip/brotli (§D5) applies here only if it keeps those validators intact.

New helper module `servers/ide-forward.ts` holds the target resolution, header hygiene, and the HTTP proxy so `tower-routes.ts` stays a thin dispatch (it already notes its size). WebSocket forwarding lives in the same module and is called from `tower-websocket.ts`.

### 2. WebSocket forward — `tower-websocket.ts`

In `setupUpgradeHandler()`, add an IDE-prefix branch. Because the existing `isWebSocketAllowed(req)` at :241 requires the subprotocol key (which the IDE workbench never offers), the IDE branch is checked **before** that generic gate and is authorized by the swappable seam `isForwardAuthorized(req)` (host guard + tunnel-stamped header key). On success, open an HTTP/1.1 upgrade request to `127.0.0.1:<idePort>` with the same header hygiene as the HTTP path, and raw-pipe `socket ↔ upstream socket` bidirectionally (mirroring `tunnel-client.ts handleWebSocketConnect`'s pipe, :814-821). No PTY, no frame protocol — the workbench speaks its own WS protocol.

### 3. Auth seam — `server-utils.ts`

Add `isForwardAuthorized(req)`: `isAllowedHost(req.headers.host) && keysMatch(presentedHttpKey(req) ?? '', getExpectedKey() ?? <fail-closed>)`. This is the single authorization decision for the forward (HTTP path already enforces the equivalent via `isRequestAllowed`; the WS branch calls this). Documented as the #1589 swap point. **No per-folder logic** (§D2): the IDE server has no per-folder isolation, so authorization is a whole-boundary key+Host check and nothing finer.

### 4. `afx ide` lifecycle + config surface

The CLI is **commander**-based (`agent-farm/cli.ts`, built in `runAgentFarm`). Add an `ide` command group next to the `tower` group (model at `cli.ts:941-943`), with `start`/`stop`/`status` subcommands, delegating to a new `commands/ide.ts` (modeled on `commands/tower.ts`). There is **one** server (§D1), so the commands manage that single instance.

- `afx ide start [--port <p>] [--prefix </ide/>] [--default-folder <path>]` spawns the server detached — mirroring `towerStart` (`commands/tower.ts:167`): `spawn(bin, args, { detached: true, stdio: 'ignore' })` + `unref()`. Args: `--host 127.0.0.1 --port <p> --server-base-path <prefix> --connection-token-file <tower-owned file> --accept-server-license-terms` (+ `--default-folder` for what opens when a URL carries no `?folder=`). Idempotent: no-op if already live on the port.
- `afx ide stop` discovers the live pid **by the configured port** (`getProcessesOnPort` from `utils/port.ts:24`), SIGTERMs it (poll `process.kill(pid,0)` → SIGKILL escalation, as `towerStop` does at `tower.ts:355-383`).
- `afx ide status` reads `ide.port` from config, discovers the live pid by port, and reports port + PID + prefix + configured artifact-base-url (loud if non-default, per contract-seat note) + liveness. **Doc note:** each open browser window spawns its own extension host (~100–300 MB); N windows = N hosts — surfaced here so the memory cost is visible.
- **No runtime record file** (§D4): the live PID is *derived* from the configured port — the same way Tower finds its own process — so there is no `~/.agent-farm/ide-servers.json`. The connection-token file on disk is the token's own persistence.
- **Tower auto-start:** wire an IDE launcher into `servers/tower-server.ts` boot the way other background services are (`codev-config-watcher.ts`, `tower-cron.ts`). When the prefix is hit, the `ide` block is configured, and no live server is found on the port, best-effort start (a miss returns 502, never a crash), then wait briefly for the server's port/health before forwarding (bounded, like `towerStart`'s readiness poll) so the first request doesn't 502 on startup latency. The connection-token-file is Tower-owned; that token is the IDE server's own inner layer, **not** a substitute for the key check.
- The server binary path is **configured, with no default** (the real build lives in a private fork), modeled on `worktree.devCommand` resolving to `null` when unset. If unset, `afx ide start` errors clearly and Tower auto-start is a no-op.

**Config — one `ide` block in `.codev/config.json`** (`CodevConfig`, `packages/codev/src/lib/config.ts:33`), read via a `getIdeConfig()` helper in `utils/config.ts` beside `getWorktreeConfig` (`:335`); user-facing, `codev doctor`-visible, five-layer merge. Because the server is single/Tower-wide (§D1), its natural home is the **machine-global `~/.codev/config.json`** layer (still the same `ide` block and helper). Fields:

```jsonc
"ide": {
  "prefix": "/ide/",          // fixed Tower path that triggers the forward (default)
  "port": 8200,               // local server port — also the forward target AND the status/stop discovery key
  "serverPath": "…",          // codev-ide server-web binary — NO default (private fork); unset ⇒ start errors, auto-start no-op
  "connectionTokenFile": "…", // optional; default to a Tower-owned ~/.agent-farm/ide-connection-token
  "autoStart": true,          // optional; Tower spawns on first /ide/ hit if not already live on `port`
  "artifactBaseUrl": null     // reserved, no default, inert this lane (the future install sub-lane's trust knob)
}
```

**Security:** if the artifact-base-url is ever auto-fetched (a later lane), read it only from trusted layers (`~/.codev/config.json` global + `.codev/config.local.json`), never the committed project config — the `getActivityHooks` precedent (`config.ts:377`). For this lane the knob is inert, so a committed-layer read is acceptable, but `getIdeConfig()` is shaped for the trusted-layer split from the start.

### 5. gzip/brotli on the forward (OPEN — see §D5)

On the HTTP forward only, for `Content-Type` text/* + JS/JSON responses that arrive uncompressed, when the client offered `Accept-Encoding: br|gzip`. Use `node:zlib`. Guarded so a mismatch never corrupts a binary response, and **must preserve `ETag`/`Cache-Control`** so it doesn't defeat §D1's caching. Amr leaned *include* in-session; main recommends *defer* (routing-first, add only if the cloud leg measures slow). Amr rules at the gate; the plan is written so this can be included or dropped without touching the routing/auth core.

## Files to Change

- `packages/codev/src/agent-farm/servers/ide-forward.ts` — **new.** Target resolution from the `ide` config block, header hygiene (strip `x-forwarded-port`/`x-original-host`/Tower-internal; stamp `x-forwarded-*` when tunnel-borne; preserve `Cache-Control`/`ETag`; pass `?folder=` through), HTTP proxy, WS raw-pipe, optional compression (§D5). Unit-testable pure helpers for header transformation.
- `packages/codev/src/agent-farm/servers/tower-routes.ts:293-363` — add the `/ide/` prefix branch in `handleRequest()` after the exact-match table, post-`isRequestAllowed`. Delegates to `ide-forward.ts`.
- `packages/codev/src/agent-farm/servers/tower-websocket.ts:235-297` — add the IDE-prefix upgrade branch gated by `isForwardAuthorized`, before the generic `isWebSocketAllowed` gate; delegates the raw pipe to `ide-forward.ts`.
- `packages/codev/src/agent-farm/utils/server-utils.ts:298-329` — add `isForwardAuthorized(req)` (the swappable #1589 seam) reusing existing primitives. Do **not** touch `isPublicRoute`.
- `packages/codev/src/agent-farm/commands/ide.ts` — **new.** `ideStart` / `ideStop` / `ideStatus`, modeled on `commands/tower.ts`.
- `packages/codev/src/agent-farm/cli.ts` — register the `ide` group near `:940`; import from `./commands/ide.js` near `:10`.
- `packages/codev/src/lib/config.ts:33` (`CodevConfig`) + `packages/codev/src/agent-farm/utils/config.ts` (new `getIdeConfig()` beside `getWorktreeConfig` `:335`) — `ide?` block: prefix + port + server-bin + optional connection-token-file + autoStart + reserved no-default artifact-base-url.
- `packages/codev/src/agent-farm/servers/tower-server.ts` — boot-time wiring for IDE auto-start (beside the other background services); an IDE launcher may live in `servers/` for `serversDir` resolution.
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
- Lifecycle: `afx ide start` spawns; `afx ide status` reports port+PID by discovery; `afx ide stop` tears down; a simulated Tower restart re-discovers the running server by port and does not leave an orphan.

**Manual / needs-Amr-env (name at dev-approval):**
- Real codev-ide server-web build: lives in a **private fork** — flagging now at plan-approval. If verification needs the real server, main to arrange access or a tarball via Amr.
- Full cloud leg `https://<relay>/t/<tower>/ide/`: needs Amr's registered Tower + codev-cloud (prefix CSP + forwarded headers already live in prod). Acceptance to confirm there: workbench boots while `/t/<tower>/` dashboard keeps working; both remote WebSockets connect with `remoteAuthority` = relay host; **no `ws://localhost` attempts**.

## Open Questions for the reviewer

*Resolved and moved to Decisions: URL shape (§D1), auth/no-per-folder (§D2), config home (§D3), PID-by-port (§D4). Still open:*

1. **gzip/brotli (§D5):** include in this lane, or defer (routing-first, add only if the cloud leg measures slow)? Amr leaned *include* in-session; main recommends *defer*. Your call at the gate.
2. **Verification access:** the real codev-ide server-web build lives in a private fork. Should dev-approval exercise the real server (needs a tarball / access via Amr) or is it satisfied by the stub loopback server, with the cloud e2e leg (`/t/<tower>/ide/`) deferred to a follow-up?
