# Specification: Cloud Tower Client (Tunnel & Registration)

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.

DO NOT include in this spec:
- Implementation phases or steps
- File paths to modify
- Code examples or pseudocode
- "First we will... then we will..."

These belong in codev/plans/0097-*.md
-->

## Metadata
- **ID**: 0097-cloud-tower-client
- **Status**: draft
- **Created**: 2026-02-10
- **Updated**: 2026-02-11 (TICK-001: WebSocket tunnel transport)
- **Companion Spec**: `codevos.ai/codev/specs/0001-cloud-tower-registration.md` (server side)

## Problem Statement

The tower server (Spec 0090) currently relies on cloudflared for remote access. Users must install cloudflared separately, manually start tunnels, scan QR codes, and deal with ephemeral URLs that change on every restart. There is no centralized way to discover or manage towers remotely.

The codevos.ai service (companion spec 0001) is being built as a centralized hub for tower management with an embedded tunnel server. **This spec defines the tower-side (client) changes** needed to connect to codevos.ai, eliminating the cloudflared dependency entirely.

## Current State

**Remote Access (cloudflared-based):**
- Tower server has built-in cloudflared integration (`startTunnel()` / `stopTunnel()` functions)
- `cloudflared tunnel --url http://localhost:4100` creates an ephemeral trycloudflare.com URL
- API key authentication via `af web keygen` protects tunnel endpoints
- QR code generation for mobile access
- Tunnel is spawned as a child process; managed during graceful shutdown

**Tower Architecture (Spec 0090 — Single Daemon):**
- Single daemon on port 4100, all projects multiplexed
- Terminals multiplexed over WebSocket at `/ws/terminal/<terminal-id>`
- Global state in `~/.agent-farm/global.db` (SQLite)
- React dashboard served from tower

## Desired State

**Tower connects directly to codevos.ai — no cloudflared required:**

1. **Registration CLI**
   - `af tower register` initiates one-time registration with codevos.ai
   - Opens browser for authentication, receives a token, stores credentials locally
   - Tower gets a unique ID tied to the user's account
   - Credentials stored in `~/.agent-farm/cloud-config.json`

2. **Built-in Tunnel Client (HTTP/2 Role Reversal over WebSocket)**
   - On tower startup, if registered, tower opens a **WebSocket** connection to `wss://codevos.ai/tunnel` and authenticates with a JSON message containing its API key (TICK-001)
   - After auth, the WebSocket is converted to a duplex stream. The tower runs an HTTP/2 **server** over it (roles are reversed)
   - codevos.ai acts as the HTTP/2 **client**, making requests to the tower through the reversed connection
   - The tower's H2 handler proxies incoming requests to `localhost:4100` via standard `node:http`
   - HTTP/2 provides multiplexing, flow control, and streaming natively — no external tunnel software needed

3. **Automatic Reconnection**
   - Exponential backoff with jitter (1s → 60s cap) for transient failures
   - Circuit breaker for auth failures (stop retrying, log clear error)
   - No re-registration required for transient failures

4. **Deregistration CLI**
   - `af tower deregister` removes the tower from codevos.ai and deletes local credentials

5. **Status Visibility**
   - Tower reports its project list and active terminals to codevos.ai over the tunnel connection

6. **Removal of cloudflared Integration**
   - Remove `startTunnel()`, `stopTunnel()`, `isCloudflaredInstalled()` from tower-server
   - Remove cloudflared child process management and QR code generation
   - Remove `af web keygen` (API keys are now managed by codevos.ai)

## Stakeholders
- **Primary Users**: Developers using Codev who want remote tower access
- **Secondary Users**: Mobile users accessing dashboards on the go
- **Technical Team**: Codev development team

## Success Criteria
- [ ] `af tower register` successfully registers a tower with codevos.ai
- [ ] Tower automatically connects to codevos.ai on startup (when registered)
- [ ] HTTP requests proxied through the tunnel reach localhost:4100 and return correct responses
- [ ] WebSocket connections (xterm.js terminals) work through the tunnel
- [ ] Tower reconnects automatically after network disruption or machine sleep/wake
- [ ] Tower stops retrying on authentication failures (circuit breaker)
- [ ] `af tower deregister` removes registration and stops connection attempts
- [ ] cloudflared integration code is removed from tower-server
- [ ] Tower operates normally without registration (local-only mode)
- [ ] All existing tests pass; new tests cover tunnel client behavior
- [ ] Documentation updated

## Constraints

### Technical Constraints
- Tower server is a single Node.js process (Spec 0090) — tunnel client must not block the event loop
- Must work behind NAT, corporate firewalls, and HTTP proxies (outbound HTTPS/WSS only)
- `~/.agent-farm/cloud-config.json` permissions must be owner-only (0600)
- **SSRF Prevention**: Tunnel client ONLY proxies to `localhost:4100`. Target host/port is hardcoded, never derived from incoming tunnel messages.
- **Tunnel Path Blocking**: The H2 handler MUST reject requests to `/api/tunnel/*` before proxying to localhost:4100. These are local-only management endpoints (connect, disconnect, status). Without this blocklist, a remote user hitting `codevos.ai/t/<tower>/api/tunnel/disconnect` could kill the tunnel.

### Business Constraints
- Tower must remain fully functional without registration (local-only mode is the default)
- No breaking changes to existing `af` CLI commands
- cloudflared support removed entirely (not deprecated)

## Assumptions
- codevos.ai tunnel server is operational
- Node.js `node:http2` module supports role reversal over any duplex stream (spiked and validated — see `codevos.ai/codev/resources/tunnel-architecture.md`)
- Users have internet access for the tunnel (offline use remains local-only)

## Solution Approach

### Tunnel Client (HTTP/2 Role Reversal over WebSocket)

The tunnel uses HTTP/2 with reversed roles — the same technique used by cloudflared. **TICK-001**: Transport changed from raw TCP (`node:net`) to **WebSocket** (`ws` library), enabling the server to run on a single port. No external tunnel software required.

**How it works on the tower side:**
1. Tower opens a **WebSocket** connection to `wss://codevos.ai/tunnel` (works through NAT, firewalls, and HTTP proxies — it's a standard HTTPS upgrade)
2. Tower sends a JSON auth message: `{ "type": "auth", "apiKey": "ctk_..." }`
3. Server responds with `{ "type": "auth_ok", "towerId": "..." }` or `{ "type": "auth_error", "reason": "..." }`
4. After auth, the WebSocket is converted to a duplex stream. Tower runs an HTTP/2 **server** over it: `h2server.emit('connection', wsStream)`
5. codevos.ai runs an HTTP/2 **client** over its end of the same stream
6. When codevos.ai receives a browser request for this tower, it makes an H2 request through the tunnel
7. The tower's H2 stream handler proxies the request to `localhost:4100` via standard `node:http` and pipes the response back

**What HTTP/2 gives us for free:**
- Multiplexing (many concurrent requests over one WebSocket connection)
- Flow control (backpressure — prevents OOM)
- Bidirectional streaming (for terminal I/O)
- Header compression

**The tower's responsibility is:**
- Reading credentials from `cloud-config.json`
- Opening and maintaining the WebSocket connection to `wss://<server_url>/tunnel`
- Converting the WebSocket to a duplex stream after auth
- Running the H2 server over the stream
- Proxying H2 requests to `localhost:4100` (filtering hop-by-hop headers)
- Reconnection logic (exponential backoff, circuit breaker)
- Sending metadata (project list, terminal list) after connection

### Reconnection Strategy

**Transient failures** (network timeout, connection reset, server 503):
- Exponential backoff with jitter: 1s, 2s, 4s, 8s... capped at 60s
- After 10 consecutive failures, reduce to every 5 minutes
- Retry indefinitely until connection succeeds or tower is stopped

**Authentication failures** (invalid/revoked key):
- **Circuit breaker**: Stop retrying immediately
- Log: `"Cloud connection failed: API key is invalid or revoked. Run 'af tower register --reauth' to update credentials."`
- Do NOT retry until config file changes or tower is restarted

**Rate limited**:
- Wait 60 seconds, then retry
- If rate limited again, back off to 5-minute intervals

### CLI Commands

**`af tower register`**
- Starts a local ephemeral HTTP server on a random port for the callback
- Opens browser to `https://codevos.ai/towers/register?callback=http://localhost:<port>/callback`
- If callback received within 2 minutes → proceed automatically
- If callback fails (headless env, firewall) → prompt: `"Paste registration token from browser:"`
- Prompts for a human-friendly tower name: `"Tower name (e.g. my-macbook):"` — defaults to hostname
- Exchanges token + tower name for API key and tower ID via codevos.ai API
- Stores in `~/.agent-farm/cloud-config.json` (0600 permissions):
  ```
  {
    "tower_id": "uuid",
    "tower_name": "my-macbook",
    "api_key": "ctk_...",
    "server_url": "https://codevos.ai"
  }
  ```
- If tower daemon is running, signals it to connect via `POST localhost:4100/api/tunnel/connect`
- If already registered, prompts: `"This tower is already registered as '<tower_name>'. Re-register? (y/N)"`

**`af tower register --reauth`**
- For when the API key has been rotated from the dashboard
- Opens browser to codevos.ai reauth flow
- Updates `cloud-config.json` with new API key (preserves tower_id and tower_name)
- Signals running tower daemon to reconnect

**`af tower deregister`**
- Prompts for confirmation
- Calls codevos.ai API to deregister
- Deletes `cloud-config.json`
- Signals running daemon to disconnect via `POST localhost:4100/api/tunnel/disconnect`

**`af tower status`**
- **Extends** the existing `af tower status` output (which shows daemon running/stopped, port, PID). Cloud info is appended as a new section — existing local output is preserved.
  ```
  Tower Daemon:      running (PID 12345, port 4100)
  Projects:          3 active
  Terminals:         5 active

  Cloud Registration: registered
  Tower Name:        my-macbook (from cloud-config.json)
  Tower ID:          a1b2c3d4-...
  Connection:        connected (uptime: 2h 15m)
  Access URL:        https://codevos.ai/t/my-macbook/
  ```
- If not registered, the cloud section shows: `"Cloud Registration: not registered. Run 'af tower register' to connect to codevos.ai."`

### Signaling the Running Daemon

CLI commands communicate with the running tower via existing localhost HTTP API:
- `POST /api/tunnel/connect` — initiate/retry tunnel connection
- `POST /api/tunnel/disconnect` — close tunnel connection
- `GET /api/tunnel/status` — return tunnel state

These are localhost-only management endpoints. The tower's H2 stream handler MUST blocklist `/api/tunnel/*` paths and return 403 before proxying to localhost:4100. Without this, remote requests through the tunnel could reach these endpoints and disrupt the tunnel connection.

### Graceful Degradation

- **Not registered** (no `cloud-config.json`): Local-only mode. No tunnel. All local functionality works.
- **Config corrupted/invalid**: Log warning, local-only mode. Fix with `af tower register`.
- **Partial config** (missing fields): Log warning, local-only mode.
- **Registered but offline**: Retry with backoff. Local functionality unaffected.
- **Connected**: Serves both local and remote requests.
- **API key revoked**: Circuit breaker stops retries. Clear error log. User runs `--reauth`.
- **Multiple OS users on same machine**: Each user has their own `~/.agent-farm/cloud-config.json`. No interference.
- **Multiple towers per user**: A user can register towers from multiple machines. Each machine has its own `cloud-config.json` with a unique `tower_id`. codevos.ai routes to the correct tower by ID.

## Performance Requirements
- **Tunnel overhead**: <100ms added latency per proxied request
- **Connection startup**: <5s from tower start to tunnel online
- **Reconnection**: <10s after transient failure
- **Memory**: <50MB additional for tunnel client
- **CPU**: Negligible impact on tower's primary function

## Security Considerations
- **API Key Storage**: `cloud-config.json` with 0600 permissions. Keys masked in logs (show last 4 chars only).
- **Transport Security**: WebSocket over HTTPS (WSS). TLS handled by the HTTPS upgrade — tower validates codevos.ai server certificate automatically.
- **SSRF Prevention**: Proxy target hardcoded to `localhost:4100`. Never derived from tunnel messages.
- **Local Auth Unchanged**: localhost:4100 remains unauthenticated (same as current). Auth handled by codevos.ai.
- **Tunnel Isolation**: No new listening ports opened. Tower only accepts proxied requests from its authenticated tunnel connection.
- **Tunnel Path Blocking**: H2 handler blocklists `/api/tunnel/*` paths (returns 403) before proxying. Prevents remote access to local management endpoints (connect/disconnect/status).
- **Compromised Config**: Attacker with `cloud-config.json` can impersonate the tower (not the user's account). Mitigation: file permissions, key revocation from dashboard.

## Test Scenarios

### Unit Tests
- Config file parsing: valid, missing fields, corrupted JSON, missing file
- Reconnection backoff calculation: exponential, jitter, cap
- Circuit breaker state transitions: closed → open on auth fail, reset on config change

### Integration Tests (with mock tunnel server)
- Full auth handshake → tunnel live
- HTTP GET/POST proxied correctly
- WebSocket (terminal) bidirectional through tunnel
- Streaming response (SSE, chunked) flows correctly
- Tower reconnects after simulated disconnect
- Auth failure triggers circuit breaker
- `af tower register/deregister/status` CLI flows

### Negative / Edge Case Tests
- Malformed messages from server (drop, log, no crash)
- Connection close mid-request (clean up gracefully)
- Expired registration token → clear error
- Already registered → confirmation prompt
- Config deleted while running → local-only mode on next reconnect
- Config with missing fields → local-only mode with warning
- Request to `/api/tunnel/disconnect` through tunnel → 403 (path blocklist enforced)

### Non-Functional Tests
- Tunnel latency p50/p95/p99
- Terminal keystroke-to-echo overhead (<50ms p95)
- 50 concurrent proxied connections without degradation
- Memory within bounds under sustained traffic
- Long-lived connection stability (24h, no leaks)

### Test Infrastructure
- **Mock tunnel server**: Lightweight server for integration tests. Does not require real codevos.ai.
- **Network simulation**: Use network link conditioner to test degraded conditions.

## Dependencies
- **External Services**: codevos.ai (tunnel server)
- **Internal Systems**: Tower server (Spec 0090), `af` CLI
- **Libraries**: `node:http2`, `node:http`, `ws` (WebSocket client — TICK-001). No external tunnel software.

## References
- Companion spec (server side): `codevos.ai/codev/specs/0001-cloud-tower-registration.md`
- Tunnel architecture: `codevos.ai/codev/resources/tunnel-architecture.md` (spike results and implementation details)
- Tower server: `packages/codev/src/agent-farm/servers/tower-server.ts`
- Current cloudflared integration: `tower-server.ts` lines 759-832
- Spec 0090: Tower Single Daemon
- Spec 0062: Secure Remote Access (superseded by this spec)
- Node.js HTTP/2 API: https://nodejs.org/api/http2.html

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| HTTP/2 role reversal edge cases in production | Low | Medium | Technique spiked and validated; same approach used by cloudflared at scale; fallback: WS control plane + connection pool |
| Terminal latency through tunnel | Low | High | HTTP/2 streams are lightweight; profile early |
| codevos.ai outage blocks remote access | Low | Medium | Tower works locally regardless |
| Config permission issues across OSes | Low | Medium | Test on macOS and Linux |
| Reconnection storms after server restart | Medium | Medium | Exponential backoff + jitter; 5-min fallback after 10 failures |

## Notes

**Migration from cloudflared:**
- No automatic migration. Existing `af web keygen` API keys and cloudflared tunnel configs are ignored.
- Users must run `af tower register` to set up the new cloud connection.
- cloudflared can remain installed on the system — it's simply no longer used by codev.

**What gets removed:**
- `startTunnel()`, `stopTunnel()`, `isCloudflaredInstalled()`, `getTunnelStatus()`
- cloudflared child process management
- QR code generation
- `af web keygen` command
- `tunnel-setup.md` documentation

**What gets added:**
- Tunnel client (HTTP/2 role reversal over WebSocket — connect to `wss://server/tunnel`, H2 server over duplex stream, proxy to localhost:4100)
- `af tower register` / `register --reauth` / `deregister` / `status` CLI commands
- Tower HTTP endpoints: `/api/tunnel/connect`, `/api/tunnel/disconnect`, `/api/tunnel/status`
- `cloud-config.json` management with validation
- Mock tunnel server for tests

---

## Amendments

This section tracks all TICK amendments to this specification.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->

### TICK-001: WebSocket Tunnel Transport (2026-02-11)

**Summary**: Change tunnel transport from raw TCP to WebSocket for compatibility with single-port PaaS deployments.

**Problem Addressed**:
The companion server (codevos.ai, spec 0001) originally used a separate TCP port for tunnel connections. Railway and most PaaS platforms only expose one port per service, making the two-port design undeployable. The server is switching to WebSocket-based tunnel connections on the same HTTP port. The tower client must match.

**Spec Changes**:
- **Desired State #2**: Transport changed from "outbound TCP connection" to "WebSocket connection to `wss://codevos.ai/tunnel`". Auth changed from line protocol to JSON messages over WebSocket.
- **Solution Approach**: Rewritten for WebSocket transport. Tower connects via `wss://server/tunnel`, authenticates with JSON message, then converts WebSocket to duplex stream for H2 role reversal. Steps updated from 6 to 7 (auth is now a separate request/response exchange).
- **Constraints**: Updated from "outbound HTTPS only" to "outbound HTTPS/WSS only".
- **Security - Transport**: Updated from "TLS over outbound TCP" to "WSS" (TLS handled by HTTPS upgrade).
- **Dependencies - Libraries**: Changed from `node:http2`, `node:net`, `node:http`, `node:tls` to `node:http2`, `node:http`, `ws`.
- **Notes - What gets added**: Updated tunnel client description.

**Rationale**:
- The H2 role reversal is transport-agnostic — it works over any duplex stream (raw TCP socket or WebSocket stream)
- WebSocket connects over HTTPS, so TLS is handled automatically (no manual `node:tls` wrapping)
- WebSocket works better through corporate HTTP proxies than raw TCP connections
- `ws` is a zero-dependency, battle-tested WebSocket library
- JSON auth messages are more debuggable and extensible than the line protocol

**Plan Changes**:
- Tunnel client: `ws.WebSocket` connection instead of `net.connect()` + `tls.connect()`
- Auth handshake: JSON messages instead of `AUTH <key>\n` / `OK <id>\n` line protocol
- Stream conversion: WebSocket → duplex stream → H2 server session
- Remove `node:net` and `node:tls` imports
- Connection URL: `wss://<server_url>/tunnel` instead of `<host>:<tunnel_port>`

**Review**: See `reviews/0097-cloud-tower-client-tick-001.md`
