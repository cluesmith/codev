# PIR Plan: Tower `/ide/` prefix forward + `afx ide` lifecycle (routing half)

## Understanding

Tower's tunnel client (`lib/tunnel-client.ts`, #1588) delivers every tunnel-borne request to exactly one place — Tower's own HTTP port. There is no way to expose a *second* local HTTP+WebSocket service (a VS Code server-web workbench serving a browser IDE) through the same tunnel without stopping Tower, which takes the dashboard offline.

This lane implements the **routing half only** (binding scope from architect main):

1. A configured prefix (`/ide/`) on Tower forwards to a local `http://127.0.0.1:<port>/…` service — plain HTTP in `tower-routes.ts handleRequest()` and WebSocket upgrades in `tower-websocket.ts` (raw bidirectional pipe; the workbench opens two WS connections under its base path with `?reconnectionToken=`).
2. Header hygiene on the forward: strip the leak-prone `x-forwarded-port` / `x-original-host`; stamp `x-forwarded-host` / `x-forwarded-proto` (and the external prefix) from the tunnel's public authority when the request is tunnel-borne; strip Tower-internal auth/attribution headers before they reach the IDE server.
3. Origin/host guard for the forwarded prefix, composed with — never instead of — the key check.
4. `afx ide start | stop | status [--workspace <path>]` lifecycle that spawns the local server, records port+PID, and lets Tower auto-start it when the prefix is hit (if configured).
5. Optional cheap gzip/brotli on the forward for text responses (the workbench boot is ~21 MB uncompressed and the VS Code server sends no compression).
6. A config surface for the prefix→port mapping (and an optional, **no-default** artifact-base-url knob reserved for the future install lane). `/api/tunnel/*` stays local-only as today.

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

## Proposed Change

### 1. HTTP forward — `tower-routes.ts`

Add a new pattern-prefix branch inside `handleRequest()` (after the exact-match table, alongside the existing `/api/tunnel/`, `/workspace/` prefix checks), reached **only after** `isRequestAllowed(req)` has passed (the existing choke point at ~:271). When `url.pathname` starts with the configured prefix (default `/ide/`) **and** the prefix→port mapping is configured:

- Resolve the target `127.0.0.1:<idePort>` from config (or the running IDE record).
- Build forward headers from the incoming request: drop hop-by-hop headers, **strip** `x-forwarded-port` and `x-original-host`, and **strip Tower-internal** `codev-tower-key` / `codev-web-key` / `x-codev-tunnel-proxy` (the IDE server must not see Tower's auth/attribution; this also preserves marker integrity by never forwarding it).
- When tunnel-borne (`x-codev-tunnel-proxy` present on the *incoming* request), **stamp** `x-forwarded-host` / `x-forwarded-proto` / external `x-forwarded-prefix` derived from the tunnel's public authority (`readCloudConfig()` → `server_url` host + `https` + `/t/<tower_name>/ide`, matching `tower-tunnel.ts:616`'s `accessUrl`). codev-cloud already sets these in production; Tower stamping them authoritatively means the workbench builds correct `remoteAuthority` / base-path URLs even if an intermediate hop drops them, and never sees a stale upstream port.
- Forward the request path **unchanged** (keeping `/ide/…`) to the IDE server, which is started with `--server-base-path <prefix>` and therefore expects the prefix present. (Alternative — strip the prefix and run the server with an empty base path — is rejected below.)
- Pipe request/response bodies. Optionally gzip/brotli text responses when the client `Accept-Encoding` allows and the upstream sent none (see §5).

New helper module `servers/ide-forward.ts` holds the target resolution, header hygiene, and the HTTP proxy so `tower-routes.ts` stays a thin dispatch (it already notes its size). WebSocket forwarding lives in the same module and is called from `tower-websocket.ts`.

### 2. WebSocket forward — `tower-websocket.ts`

In `setupUpgradeHandler()`, add an IDE-prefix branch. Because the existing `isWebSocketAllowed(req)` at :241 requires the subprotocol key (which the IDE workbench never offers), the IDE branch is checked **before** that generic gate and is authorized by the swappable seam `isForwardAuthorized(req)` (host guard + tunnel-stamped header key). On success, open an HTTP/1.1 upgrade request to `127.0.0.1:<idePort>` with the same header hygiene as the HTTP path, and raw-pipe `socket ↔ upstream socket` bidirectionally (mirroring `tunnel-client.ts handleWebSocketConnect`'s pipe, :814-821). No PTY, no frame protocol — the workbench speaks its own WS protocol.

### 3. Auth seam — `server-utils.ts`

Add `isForwardAuthorized(req)`: `isAllowedHost(req.headers.host) && keysMatch(presentedHttpKey(req) ?? '', getExpectedKey() ?? <fail-closed>)`. This is the single authorization decision for the forward (HTTP path already enforces the equivalent via `isRequestAllowed`; the WS branch calls this). Documented as the #1589 swap point.

### 4. `afx ide` lifecycle + config surface

The CLI is **commander**-based (`agent-farm/cli.ts`, built in `runAgentFarm`). Add an `ide` command group next to the `tower` group (model at `cli.ts:941-943`), with `start`/`stop`/`status` subcommands each taking `--workspace <path>`, delegating to a new `commands/ide.ts` (modeled on `commands/tower.ts`).

- `afx ide start [--workspace <path>] [--port <p>] [--prefix </ide/>]` spawns the server detached — mirroring `towerStart` (`commands/tower.ts:167`): `spawn(bin, args, { detached: true, stdio: 'ignore' })` + `unref()`. Args: `--host 127.0.0.1 --port <p> --server-base-path <prefix> --connection-token-file <tower-owned file> --accept-server-license-terms`. Records `{ prefix, port, pid, workspace, startedAt }` in a new record file.
- `afx ide stop [--workspace <path>]` reads the record, SIGTERMs the pid (poll `process.kill(pid,0)` → SIGKILL escalation, as `towerStop` does at `tower.ts:355-383`), removes the record.
- `afx ide status [--workspace <path>]` reports port + PID + prefix + configured artifact-base-url (loud if non-default, per contract-seat note) + liveness (`process.kill(pid,0)` and/or `getProcessesOnPort` from `utils/port.ts:24` to spot a stale record).
- **Tower auto-start:** wire an IDE launcher into `servers/tower-server.ts` boot the way other background services are (`codev-config-watcher.ts`, `tower-cron.ts`). When the prefix is hit, a mapping is configured, and no live server is recorded, best-effort start (a miss returns 502, never a crash). A stale recorded pid (dead) is reconciled/respawned. The connection-token-file is Tower-owned; that token is the IDE server's own inner layer, **not** a substitute for the key check.
- The server binary path is **configured, with no default** (the real build lives in a private fork), modeled on `worktree.devCommand` resolving to `null` when unset. If unset, `afx ide start` errors clearly and Tower auto-start is a no-op.

**Config split (resolves the config-home question):**
- **`.codev/config.json` (`CodevConfig`, `packages/codev/src/lib/config.ts:33`)** — a new `ide?` block: prefix→port mapping, server-bin path, and the reserved **no-default** artifact-base-url. Add a `getIdeConfig()` helper in `utils/config.ts` beside `getWorktreeConfig` (`:335`). User-facing, `codev doctor`-visible, five-layer merge. **Security:** if the artifact-base-url is ever auto-fetched (a later lane), read it only from trusted layers (`~/.codev/config.json` global + `.codev/config.local.json`), never the committed project config — the `getActivityHooks` precedent (`config.ts:377`). For this lane the knob is inert, so committed-layer read is acceptable, but the helper is shaped for the trusted-layer split from the start.
- **`~/.agent-farm/ide-servers.json` (new `lib/ide-record.ts`)** — the runtime pid/port/prefix/workspace record, read/write/delete modeled on `lib/cloud-config.ts:45-126` (`mkdirSync 0700` + `writeFileSync 0600`). Tower has no pidfile today (it uses port discovery), so this record is new.

### 5. Optional gzip/brotli

On the HTTP forward only, for `Content-Type` text/* + JS/JSON/wasm-adjacent responses that arrive uncompressed, and only when the client offered `Accept-Encoding: br|gzip`. Use `node:zlib`. Guarded so a mismatch never corrupts a binary response. If this proves fiddly it can be deferred within this lane without blocking routing.

## Files to Change

- `packages/codev/src/agent-farm/servers/ide-forward.ts` — **new.** Target resolution from config/record, header hygiene (strip `x-forwarded-port`/`x-original-host`/Tower-internal; stamp `x-forwarded-*` when tunnel-borne), HTTP proxy, WS raw-pipe, optional compression. Unit-testable pure helpers for header transformation.
- `packages/codev/src/agent-farm/servers/tower-routes.ts:293-363` — add the `/ide/` prefix branch in `handleRequest()` after the exact-match table, post-`isRequestAllowed`. Delegates to `ide-forward.ts`.
- `packages/codev/src/agent-farm/servers/tower-websocket.ts:235-297` — add the IDE-prefix upgrade branch gated by `isForwardAuthorized`, before the generic `isWebSocketAllowed` gate; delegates the raw pipe to `ide-forward.ts`.
- `packages/codev/src/agent-farm/utils/server-utils.ts:298-329` — add `isForwardAuthorized(req)` (the swappable #1589 seam) reusing existing primitives. Do **not** touch `isPublicRoute`.
- `packages/codev/src/agent-farm/commands/ide.ts` — **new.** `ideStart` / `ideStop` / `ideStatus`, modeled on `commands/tower.ts`.
- `packages/codev/src/agent-farm/cli.ts` — register the `ide` group near `:940`; import from `./commands/ide.js` near `:10`.
- `packages/codev/src/agent-farm/lib/ide-record.ts` — **new.** pid/port/prefix/workspace record read/write/delete, modeled on `lib/cloud-config.ts`.
- `packages/codev/src/lib/config.ts:33` (`CodevConfig`) + `packages/codev/src/agent-farm/utils/config.ts` (new `getIdeConfig()` beside `getWorktreeConfig` `:335`) — `ide?` block: prefix→port + server-bin + reserved no-default artifact-base-url.
- `packages/codev/src/agent-farm/servers/tower-server.ts` — boot-time wiring for IDE auto-start (beside the other background services); an IDE launcher may live in `servers/` for `serversDir` resolution.
- `packages/types/src/websocket.ts` (+ `index.ts` barrel) — shared IDE default-prefix / forward-header constant(s) if warranted; optionally a `ResolvedIdeConfig` wire type in `api.ts` if Tower auto-start needs the shape over HTTP.
- **Tests** (see Test Plan) — new: `ide-forward.test.ts`, forward auth + marker-integrity cases, WS pipe. Existing suites to extend: `server-utils.test.ts`, `tower-routes.test.ts`, `tower-websocket.test.ts`, `tunnel-edge-cases.test.ts` / `bugfix-1586-tunnel-auth.test.ts` (marker integrity through the forward).

> Note: this is product code in `packages/codev` (the shipped package), not a protocol/template file, so the `codev/` ↔ `codev-skeleton/` mirror rule does **not** apply here.

## Risks & Alternatives Considered

- **Risk — WS auth divergence.** The IDE WS can't use the subprotocol-key path. *Mitigation:* authorize via the same header-key credential the HTTP choke point uses, factored into `isForwardAuthorized`; add explicit tests that a keyless/forged upgrade is rejected and a tunnel-stamped one is accepted. **Reviewer decision wanted:** (a) dedicated `isForwardAuthorized` seam reusing HTTP key logic *(recommended)*, vs (b) broadening `presentedWsKey` to also accept the `codev-tower-key` header (touches terminal-WS auth too — wider blast radius).
- **Risk — leaked upstream port breaks the browser WS dial.** *Mitigation:* strip `x-forwarded-port` / `x-original-host`; stamp `x-forwarded-host`/`proto` authoritatively from cloud config for tunnel-borne requests.
- **Risk — marker forgery / #1674 regression.** *Mitigation:* never forward `x-codev-tunnel-proxy` to the IDE server; rely on the tunnel client's existing strip-then-restamp; add a regression test.
- **Risk — orphaned IDE server on Tower restart.** *Mitigation:* Tower-owned record + `afx ide stop`; auto-start reconciles a stale record (dead pid → respawn). Acceptance requires "Tower restart does not orphan it" — verified in the test plan.
- **Alternative — strip the prefix, run server with empty base path.** Rejected: the workbench needs its external base path for asset/WS URL generation; keeping the prefix and letting `--server-base-path` + `x-forwarded-prefix` carry it matches how the VS Code server is designed and how codev-cloud already forwards.
- **Alternative — add `/ide/` to the public route allowlist.** Rejected outright by the binding auth model (reopens the GHSA hole).

## Test Plan

**Unit (self-contained, no real IDE server):**
- `ide-forward.ts` header hygiene: strips `x-forwarded-port` / `x-original-host` / Tower-internal headers; stamps `x-forwarded-host`/`proto`/external-prefix from a mock cloud config only when tunnel-borne; leaves local requests unstamped.
- `isForwardAuthorized`: accepts a request with a valid `codev-tower-key` header + allowed Host; rejects missing/forged key; rejects disallowed Host; fails closed when no local key is readable.
- Marker integrity: a request forged with `x-codev-tunnel-proxy` from the cloud side does not survive into the forwarded request; a genuine tunnel-borne request is honestly marked. (Extend `bugfix-1586-tunnel-auth.test.ts` / `tunnel-edge-cases.test.ts` patterns via `mock-tunnel-server`.)

**Integration (stub loopback server — architect-sanctioned dev path):**
- Stand up a stub HTTP+WS echo server on `127.0.0.1:<p>`; configure the prefix; assert `GET /ide/…` through Tower reaches it with the sanitized headers, and a WS upgrade to `/ide/…` raw-pipes bytes both ways.
- Auth: keyless `/ide/…` HTTP and WS are 401; keyed pass.
- Lifecycle: `afx ide start` spawns + records; `afx ide status` reports port+PID; `afx ide stop` tears down; a simulated Tower restart with a stale record does not leave an orphan (reconcile/respawn).

**Manual / needs-Amr-env (name at dev-approval):**
- Real codev-ide server-web build: lives in a **private fork** — flagging now at plan-approval. If verification needs the real server, main to arrange access or a tarball via Amr.
- Full cloud leg `https://<relay>/t/<tower>/ide/`: needs Amr's registered Tower + codev-cloud (prefix CSP + forwarded headers already live in prod). Acceptance to confirm there: workbench boots while `/t/<tower>/` dashboard keeps working; both remote WebSockets connect with `remoteAuthority` = relay host; **no `ws://localhost` attempts**.

## Open Questions for the reviewer
1. **Auth seam shape:** (a) dedicated `isForwardAuthorized` seam reusing the HTTP key logic for the WS branch *(recommended)*, vs (b) broadening `presentedWsKey` to also accept the `codev-tower-key` header (wider blast radius — touches terminal-WS auth).
2. **gzip/brotli:** wanted in this lane, or deferred within-lane to keep the forward minimal?
3. **Config split** (proposed, not blocking): user-facing `ide?` block in `.codev/config.json` for the prefix→port map + server-bin + reserved artifact-base-url; runtime pid/port record in `~/.agent-farm/ide-servers.json`. Confirm this is the split you want.
4. **Verification access:** the real codev-ide server-web build lives in a private fork. Confirm whether this lane's dev-approval should exercise the real server (needs a tarball / access via Amr) or is satisfied by the stub loopback server + the cloud e2e leg deferred to a follow-up.
