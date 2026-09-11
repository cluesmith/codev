# pir-1668 — tower: forward a sub-path to a local web IDE server + afx ide lifecycle

## Lane scope (binding, from architect main 2026-09-11)
- ROUTING half ONLY: `/ide/` prefix forward (HTTP + WS), header hygiene, origin guard, `afx ide start|stop|status`.
- Install-on-demand is OUT (later sub-lane). Artifact-base-url is a config knob with NO default (upstream host undecided).
- AUTH settled + binding: key-authenticated behind the EXISTING `isRequestAllowed` choke point, riding the #1588 tunnel key stamp. No public carve-out. Authorization behind a swappable seam for #1589. Do NOT add the prefix to the public-route list; do NOT add a parallel/looser auth check.
- TESTING: a local loopback HTTP+WS stub echo server proves the forward. Real codev-ide-server lives in a PRIVATE fork; flag at plan-approval if verification needs it; name Amr-env needs (cloud `/t/<tower>/ide/` e2e) at dev-approval. codev-cloud's prefix CSP + forwarded headers are already live in prod.
- #1674 lane-card privacy depends on tunnel-marker semantics: strip-then-restamp must hold on the new path; add a regression test for marker integrity through the forward.

## Key code facts (plan phase investigation)
- `servers/tower-routes.ts handleRequest()` — `isRequestAllowed(req)` is the single HTTP choke point (runs before route dispatch, line ~271). Pattern-prefix routes matched after exact-match table. `/ide/` forward slots in as a new prefix branch, POST-auth.
- `servers/tower-websocket.ts setupUpgradeHandler()` — `isWebSocketAllowed(req)` gates ALL upgrades at line ~241, reading the key from the `Sec-WebSocket-Protocol: codev-key.<KEY>` OFFER (subprotocol). The IDE workbench WS is a vanilla browser WS with `?reconnectionToken=` and offers NO subprotocol key — so the IDE WS auth must read the tunnel-stamped `codev-tower-key` HTTP header instead.
- `lib/tunnel-client.ts stampLocalHeaders()` — on BOTH HTTP (`proxyHttpRequest`) and WS-CONNECT (`handleWebSocketConnect`) forwards: deletes client-owned headers (host, tower-key, tunnel-proxy marker), sets `Host: localhost:<port>`, stamps `x-codev-tunnel-proxy: 1` and `codev-tower-key: <local key>`. So tunnel-borne requests reach Tower with Host=localhost (passes `isAllowedHost`) and the key in the HTTP header (passes `isRequestAllowed`). Marker `TUNNEL_PROXY_HEADER='x-codev-tunnel-proxy'`.
- `utils/server-utils.ts` — `isRequestAllowed` (host guard → public-route → header key), `isWebSocketAllowed` (host guard + subprotocol key), `isAllowedHost`, `isPublicRoute` (do NOT add /ide/ here), `presentedHttpKey`, `keysMatch`, `getExpectedKey`.
- Public authority: `lib/cloud-config.ts readCloudConfig()` gives `server_url` + `tower_name`; `servers/tower-tunnel.ts:616` builds accessUrl `${server_url}/t/${tower_name}/`. So x-forwarded-host = URL(server_url).host, proto = https, external prefix = `/t/<tower_name>/ide`.
- No x-forwarded-* handling exists in Tower today — all new.
- AGENT_FARM_DIR = ~/.agent-farm (lib/tower-client.ts). cloud-config.json lives there.

## CLI/config wiring (Explore agent findings)
- CLI is commander; `runAgentFarm` in `agent-farm/cli.ts`. tower group model cli.ts:941-943; add `ide` group near :940, import commands/ide.js near :10.
- Lifecycle model = `commands/tower.ts` (towerStart :167 detached spawn+unref; towerStop :289 SIGTERM→SIGKILL; port discovery `utils/port.ts:24`). No pidfile today.
- Config split decided: user-facing `ide?` block in `.codev/config.json` (CodevConfig `lib/config.ts:33`, add getIdeConfig() beside getWorktreeConfig utils/config.ts:335) for prefix→port + server-bin + no-default artifact-base-url; runtime record `~/.agent-farm/ide-servers.json` (new lib/ide-record.ts, model cloud-config.ts:45-126).
- Header constants: packages/types/src/websocket.ts (+ index.ts). Auto-start: wire into servers/tower-server.ts boot like codev-config-watcher/tower-cron.
- Product code in packages/codev (shipped) — NOT a protocol/template file, so no codev-skeleton mirror needed.

## Status
- 2026-09-11: PLAN drafted → codev/plans/1668-tower-forward-a-sub-path-to-a-.md. Covers HTTP+WS forward, auth seam (isForwardAuthorized, #1589-swappable), header hygiene + x-forwarded stamping from cloud config, marker integrity (#1674), afx ide lifecycle, config, test plan (stub loopback + flagged real-server/cloud-e2e needs). 4 open questions for reviewer. Committed + awaiting plan-approval gate.

## Gate dialogue (plan-approval) — decisions taken, still open
Amr feedback in-session:
- gzip/brotli: INCLUDE in this lane (was under-committed as "optional"; issue itself calls it optional-but-cheap). Move to core forward work.
- Config: DO NOT split — reuse .codev/config.json with one `ide` block. Runtime PID is NOT config → discover live PID by port (Tower's own pattern via getProcessesOnPort), so the ~/.agent-farm/ide-servers.json record file is DROPPED. `ide` block fields: prefix (default /ide/), port, serverPath (no default), connectionTokenFile (optional, Tower-owned default), autoStart, artifactBaseUrl (reserved/null).
- Auth seam: proceeding with (a) dedicated isForwardAuthorized reusing HTTP key logic (terminal-WS path untouched) unless objected.
URL-shape question RESOLVED (codev-ide architect via main, 2026-09-11):
- FIXED /ide/ + single server; workspace via ?folder=<encodeURIComponent(absPath)> per browser connection. --server-base-path /ide. Keeps bare /t/<tower>/ide/ (codev-cloud live). Do NOT introduce /workspace/<enc>/ide/.
- Cacheability holds: assets under <base>/<quality>-<commit>/static with Cache-Control public max-age=31536000 + ETag; ~21MB boot caches once per server VERSION; only HTML doc varies per folder; reconnectionToken per-connection UUID never cached. Tower must PRESERVE Cache-Control/ETag on the forward + pass ?folder through.
- Auth: Tower key check is the WHOLE trust boundary; server has NO per-folder isolation (any authenticated conn reads any path OS user can — same trust as a terminal). Do NOT build per-folder authz. isForwardAuthorized seam (a) confirmed, zero folder logic.
- Resource: each browser window = own extension host ~100-300MB (doc note in afx ide status).
- Workspace Trust prompts per folder until codev#1669 — not routing, not my concern.

Plan REVISED (Decisions §D1-D5). ALL open questions now resolved by Amr at the gate:
- §D3 CONFIG/STORAGE: Amr challenged the config file → DROPPED, and challenged the DB → DROPPED. FINAL: no config file, NO database change. `afx ide start --server-path <bin> [--port] [--default-folder]` (serverPath required, no default; prefix is fixed /ide/ constant; port default 8200) → Tower SPAWNS it (key-authed local POST /api/ide) + records {prefix,port,serverPath,pid} in a Tower-managed ~/.agent-farm/ide-server.json (the cloud-config.json/machine-id pattern — Tower-written, NOT the rejected hand-edited config). Reconcile/respawn from the record on restart. lib/ide-record.ts models cloud-config.ts. /api/ide is local-only (blocked from tunnel). Reversal-bait why in §D3.
- §D5 gzip: DEFERRED (Amr) — matches main's routing-first rec. Not built; core written so it can be added later preserving ETag/Cache-Control.
- Verification: private fork is LOCALLY accessible (Amr) — dev-approval exercises the REAL server locally; only cloud /t/<tower>/ide/ leg needs Amr's env.
- §D1 URL shape (fixed /ide/ + ?folder, single server), §D2 auth (Tower key = whole boundary, no per-folder authz), §D4 PID-by-port — all settled.
New Files-to-Change: global.db IDE registration store (agent-farm/db/) + a local-only /api/ide register/deregister/status endpoint (blocked from tunnel like /api/tunnel/*). Dropped: lib/ide-record.ts, config.ts/getIdeConfig ide block.
Nothing blocking from builder side. Recommitting; gate stays pending for Amr's plan-approval.

## IMPLEMENT phase (2026-09-11)
plan-approval approved (Amr via main; ran porch approve myself per #1494). Advanced to implement. Branch rebased on main (0 behind) before approval.

Implemented per committed plan:
- lib/ide-record.ts — ~/.agent-farm/ide-server.json record {prefix,port,serverPath,pid,defaultFolder,startedAt} read/write/delete + connection-token; IDE_DEFAULT_PREFIX '/ide/', IDE_DEFAULT_PORT 8200. (No types-pkg change — defaults are policy not wire contract.)
- servers/ide-forward.ts — matchIdePrefix, buildForwardHeaders (strip x-forwarded-port/x-original-host/tower-key/web-key/tunnel-proxy/host; set loopback host; stamp x-forwarded-host/proto/prefix ONLY when tunnel-borne+authority; preserve Cache-Control/ETag), getPublicAuthority (from cloud-config), forwardIdeHttp, forwardIdeWebSocket (raw pipe).
- servers/ide-server.ts — spawnIdeServer (Tower spawns detached+unref, waits for port), stopIdeServer (kill by port), ideServerStatus, ensureIdeServerLive (respawn-if-dead, in-flight guard), reconcileIdeServer (boot), handleIdeApi (POST/DELETE/GET /api/ide, local-only).
- server-utils.ts — isForwardAuthorized (host + codev-tower-key header key check; #1589 swap seam; no per-folder logic).
- tower-routes.ts — /api/ide dispatch + /ide/ forward branch (post-isRequestAllowed).
- tower-websocket.ts — IDE WS branch BEFORE generic isWebSocketAllowed, gated by isForwardAuthorized.
- tower-server.ts — reconcileIdeServer at boot (post-readiness, not awaited).
- tunnel-client.ts — BLOCKED_PATH_SEGMENT now blocks /api/ide (management, local-only); /ide/ forward NOT blocked.
- commands/ide.ts + cli.ts — afx ide start|stop|status (thin client over /api/ide).

Build: full `pnpm --filter @cluesmith/codev build` (deps + tsc + assets) exit 0.
Tests: 4 new files (ide-forward, ide-forward-auth, ide-record, ide-forward-integration). Integration test CAUGHT A REAL BUG: forwardIdeWebSocket used buildForwardHeaders which strips hop-by-hop Connection/Upgrade → upstream WS upgrade failed (got 200). Fixed by re-adding Connection: Upgrade / Upgrade: websocket (as tunnel-client does), forwarding client's Sec-WebSocket-Key so Accept validates. Re-running.
