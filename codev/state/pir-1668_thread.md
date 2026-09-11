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
- 2026-09-11: PLAN drafted → codev/plans/1668-tower-forward-a-sub-path-to-a-.md. Covers HTTP+WS forward, auth seam (isForwardAuthorized, #1589-swappable), header hygiene + x-forwarded stamping from cloud config, marker integrity (#1674), afx ide lifecycle, config split, test plan (stub loopback + flagged real-server/cloud-e2e needs). 4 open questions for reviewer. Committing + awaiting plan-approval gate.
