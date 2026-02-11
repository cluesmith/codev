# Plan: Cloud Tower Client (Tunnel & Registration)

## Metadata
- **ID**: 0097-cloud-tower-client
- **Status**: draft
- **Specification**: `codev/specs/0097-cloud-tower-client.md`
- **Created**: 2026-02-11

## Executive Summary

Replace cloudflared integration with a built-in HTTP/2 role-reversal tunnel client that connects to codevos.ai. The implementation is split into 7 phases: cloud config management, cloudflared removal, tunnel client core, tower integration, CLI commands, Tower dashboard UI, and E2E tests. Each phase is independently testable and builds on the previous.

All tunnel logic uses Node.js built-in modules only (`node:http2`, `node:net`, `node:tls`, `node:http`). No third-party tunnel dependencies.

## Success Metrics
- [ ] All specification criteria met
- [ ] `af tower register` successfully registers with codevos.ai
- [ ] Tower auto-connects to codevos.ai on startup when registered
- [ ] HTTP requests proxied through tunnel reach localhost:4100
- [ ] Reconnection works after network disruption
- [ ] Circuit breaker stops retries on auth failures
- [ ] `af tower deregister` removes registration
- [ ] cloudflared code fully removed
- [ ] Tower works normally without registration (local-only mode)
- [ ] All existing tests pass; new tests cover tunnel client
- [ ] Test coverage >90% for new modules
- [ ] Tower dashboard shows cloud connection status and connect/disconnect controls
- [ ] E2E tests pass against local codevos.ai instance

## Phases (Machine Readable)

<!-- REQUIRED: porch uses this JSON to track phase progress. Update this when adding/removing phases. -->

```json
{
  "phases": [
    {"id": "phase_1", "title": "Cloud Config Management"},
    {"id": "phase_2", "title": "Remove Cloudflared Integration"},
    {"id": "phase_3", "title": "HTTP/2 Tunnel Client Core"},
    {"id": "phase_4", "title": "Tower-Tunnel Integration"},
    {"id": "phase_5", "title": "CLI Commands"},
    {"id": "phase_6", "title": "Tower Dashboard UI"},
    {"id": "phase_7", "title": "E2E Tests"}
  ]
}
```

## Phase Breakdown

### Phase 1: Cloud Config Management
**Dependencies**: None

#### Objectives
- Create a module for reading, writing, and validating `~/.agent-farm/cloud-config.json`
- Enforce 0600 file permissions
- Provide clear error handling for missing, corrupted, or partial configs

#### Deliverables
- [ ] `packages/codev/src/agent-farm/lib/cloud-config.ts`
- [ ] `packages/codev/src/agent-farm/__tests__/cloud-config.test.ts`

#### Implementation Details

**`cloud-config.ts`** — Config management module:

```typescript
interface CloudConfig {
  tower_id: string;
  tower_name: string;
  api_key: string;
  server_url: string;
}
```

Functions:
- `getCloudConfigPath(): string` — Returns `~/.agent-farm/cloud-config.json`
- `readCloudConfig(): CloudConfig | null` — Reads and validates config. Returns `null` if missing. Throws on corrupted JSON. Logs warning and returns `null` on partial config (missing required fields).
- `writeCloudConfig(config: CloudConfig): void` — Writes config with 0600 permissions. Creates parent dir if needed.
- `deleteCloudConfig(): void` — Deletes config file if it exists.
- `isRegistered(): boolean` — Returns true if valid config exists.
- `maskApiKey(key: string): string` — Returns `"ctk_****<last4>"` for logging.

#### Acceptance Criteria
- [ ] Valid config file reads correctly
- [ ] Missing file returns `null` (not an error)
- [ ] Corrupted JSON throws with clear message
- [ ] Partial config (missing fields) returns `null` with logged warning
- [ ] Written files have 0600 permissions
- [ ] API key masking works correctly

#### Test Plan
- **Unit Tests**: Config parsing (valid, missing fields, corrupted JSON, missing file), file permissions, API key masking
- **Manual Testing**: Verify file permissions on disk

#### Risks
- **Risk**: File permission handling differs across OS
  - **Mitigation**: Test on macOS (primary platform); Node.js `fs` handles mode consistently

---

### Phase 2: Remove Cloudflared Integration
**Dependencies**: None (can be done in parallel with Phase 1)

#### Objectives
- Remove all cloudflared-related code from tower-server.ts
- Remove cloudflared API endpoints
- Update graceful shutdown to remove tunnel stop
- Ensure all existing tests still pass

#### Deliverables
- [ ] Modified `packages/codev/src/agent-farm/servers/tower-server.ts`
- [ ] All existing tests pass

#### Implementation Details

**Remove from `tower-server.ts`:**
- Lines 928-1001: `tunnelProcess`, `tunnelUrl` globals, `isCloudflaredInstalled()`, `getTunnelStatus()`, `startTunnel()`, `stopTunnel()`
- Lines 2271-2292: API endpoints `/api/tunnel/status` (GET), `/api/tunnel/start` (POST), `/api/tunnel/stop` (POST)
- Line 800: `stopTunnel()` call in `gracefulShutdown()`

**Note**: The `/api/tunnel/*` path namespace will be reused in Phase 4 for the new tunnel management endpoints (`/api/tunnel/connect`, `/api/tunnel/disconnect`, `/api/tunnel/status`).

**Check for any tower-client.ts references** to tunnel endpoints and update if needed.

#### Acceptance Criteria
- [ ] No cloudflared references remain in tower-server.ts
- [ ] Graceful shutdown no longer calls `stopTunnel()`
- [ ] All existing tests pass (tower-baseline, tower-api, tower-terminals, tower-proxy)
- [ ] Tower starts and serves local requests normally

#### Test Plan
- **Unit Tests**: Existing test suite passes
- **Manual Testing**: `af tower start` works, local dashboard accessible

#### Rollback Strategy
Revert the single commit touching tower-server.ts

---

### Phase 3: HTTP/2 Tunnel Client Core
**Dependencies**: Phase 1 (needs cloud config)

#### Objectives
- Implement the HTTP/2 role-reversal tunnel client as a standalone module
- Handle outbound TCP/TLS connection, authentication, H2 server, and request proxying
- Implement reconnection logic (exponential backoff with jitter, circuit breaker)
- Blocklist `/api/tunnel/*` paths from tunnel-proxied requests

#### Deliverables
- [ ] `packages/codev/src/agent-farm/lib/tunnel-client.ts`
- [ ] `packages/codev/src/agent-farm/__tests__/tunnel-client.test.ts`

#### Implementation Details

**`tunnel-client.ts`** — Core tunnel module:

```typescript
interface TunnelClientOptions {
  serverUrl: string;      // codevos.ai URL
  apiKey: string;         // Tower API key
  towerId: string;        // Tower ID
  localPort: number;      // localhost port to proxy to (4100)
}

type TunnelState = 'disconnected' | 'connecting' | 'connected' | 'auth_failed';
```

**Class `TunnelClient`:**
- `constructor(options: TunnelClientOptions)`
- `connect(): void` — Opens outbound TLS connection to server, sends auth, starts H2 server
- `disconnect(): void` — Closes tunnel gracefully
- `getState(): TunnelState` — Returns current state
- `getUptime(): number | null` — Returns ms since connected, or null
- `onStateChange(callback): void` — State change listener
- `sendMetadata(metadata): void` — Send project/terminal lists to server

**Connection flow (matches codevos.ai tunnel server protocol):**
1. Open TCP connection to tunnel server (port 4200, or from config). If TLS certs configured on server, use TLS; otherwise plain TCP.
2. Send auth frame: `AUTH <apiKey>\n` (max 256 bytes, 5s timeout on server side)
3. Wait for response:
   - Success: `OK <towerId>\n` — server confirms tower identity
   - Failure: `ERR <reason>\n` where reason is `invalid_api_key`, `rate_limited`, `invalid_auth_frame`, or `internal_error`
4. On `OK`: Create `http2.createServer()`, emit `'connection'` with the socket
5. H2 stream handler: for each incoming request:
   a. Check path against blocklist (`/api/tunnel/*`) → 403
   b. Proxy to `http://localhost:<localPort>` via `node:http`
   c. Pipe response back, filtering hop-by-hop headers

**Reconnection:**
- `calculateBackoff(attempt: number): number` — Exponential with jitter: `min(1000 * 2^attempt + jitter, 60000)`. After 10 consecutive failures: 300000ms (5 min).
- Circuit breaker: On `ERR invalid_api_key`, set state to `auth_failed`, stop retrying, log: `"Cloud connection failed: API key is invalid or revoked. Run 'af tower register --reauth' to update credentials."`
- On transient failure (`ERR rate_limited`, `ERR internal_error`, connection reset, timeout): schedule reconnect with backoff.

**Hop-by-hop headers to filter:**
`connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailers`, `transfer-encoding`, `upgrade`

**Path blocklist:**
Any path starting with `/api/tunnel/` returns HTTP 403 `{"error": "Forbidden: tunnel management endpoints are local-only"}`.

#### Acceptance Criteria
- [ ] TLS connection opens to server
- [ ] Auth handshake succeeds with valid key
- [ ] H2 server runs over outbound socket
- [ ] HTTP requests proxied to localhost correctly
- [ ] `/api/tunnel/*` paths return 403
- [ ] Exponential backoff calculated correctly
- [ ] Circuit breaker activates on auth failure
- [ ] Reconnection works after transient disconnect
- [ ] Hop-by-hop headers filtered from proxied requests

#### Test Plan
- **Unit Tests**: Backoff calculation (values, jitter, cap, 5-min fallback), circuit breaker state transitions (closed→open on auth fail, reset), path blocklist matching, hop-by-hop header filtering
- **Integration Tests**: Deferred to Phase 6 (requires mock tunnel server)

#### Risks
- **Risk**: HTTP/2 role reversal edge cases
  - **Mitigation**: Technique validated in spike; same approach used by cloudflared; Node.js `node:http2` supports this via `createServer` + manual socket emission

---

### Phase 4: Tower-Tunnel Integration
**Dependencies**: Phase 2 (cloudflared removed), Phase 3 (tunnel client exists)

#### Objectives
- Wire the tunnel client into the tower server lifecycle
- Add local management endpoints (`/api/tunnel/connect`, `/api/tunnel/disconnect`, `/api/tunnel/status`)
- Auto-connect on startup when registered
- Graceful shutdown disconnects tunnel
- Send metadata (project list, terminals) after connection

#### Deliverables
- [ ] Modified `packages/codev/src/agent-farm/servers/tower-server.ts`
- [ ] `packages/codev/src/agent-farm/__tests__/tunnel-integration.test.ts`

#### Implementation Details

**Tower server changes:**

1. **Startup** (after server binds): If `isRegistered()`, create `TunnelClient` and call `connect()`. Log connection state changes.

2. **New API endpoints:**
   - `POST /api/tunnel/connect` — Read config, create/reconnect tunnel client. Response: `{success, state}`.
   - `POST /api/tunnel/disconnect` — Disconnect tunnel client. Response: `{success}`.
   - `GET /api/tunnel/status` — Return `{registered, state, uptime, towerId, towerName, serverUrl, accessUrl}`.

3. **Graceful shutdown** (add after terminal manager shutdown): Call `tunnelClient.disconnect()`.

4. **Metadata reporting**: After tunnel connects, gather project list and terminal list from existing APIs and send via `tunnelClient.sendMetadata()`.

5. **Config file watch**: Use `fs.watch()` on `cloud-config.json` to detect config changes (e.g., after `--reauth`). On change, reconnect with new credentials. On delete, disconnect.

#### Acceptance Criteria
- [ ] Tower auto-connects when config exists on startup
- [ ] Tower starts normally without config (local-only mode)
- [ ] `POST /api/tunnel/connect` triggers tunnel connection
- [ ] `POST /api/tunnel/disconnect` closes tunnel
- [ ] `GET /api/tunnel/status` returns correct state
- [ ] Graceful shutdown disconnects tunnel
- [ ] Config file deletion triggers disconnect
- [ ] Config file change triggers reconnect

#### Test Plan
- **Unit Tests**: Endpoint responses, auto-connect logic
- **Integration Tests**: Deferred to Phase 6

#### Risks
- **Risk**: `fs.watch()` behavior varies across OS
  - **Mitigation**: Debounce watch events (500ms); fallback: manual `POST /api/tunnel/connect` always works

---

### Phase 5: CLI Commands
**Dependencies**: Phase 1 (cloud config), Phase 4 (tunnel endpoints exist)

#### Objectives
- Implement `af tower register`, `af tower register --reauth`, `af tower deregister`
- Extend `af tower status` with cloud connection info
- Handle browser-based and manual token entry registration flows

#### Deliverables
- [ ] `packages/codev/src/agent-farm/commands/tower-cloud.ts`
- [ ] Modified `packages/codev/src/agent-farm/cli.ts` (add subcommands)
- [ ] Modified `packages/codev/src/agent-farm/commands/tower.ts` (extend status)

#### Implementation Details

**`tower-cloud.ts`** — Registration commands:

**`towerRegister(options: { reauth?: boolean })`**:
1. Check existing registration. If registered and not `--reauth`, prompt: `"This tower is already registered as '<name>'. Re-register? (y/N)"`.
2. Start ephemeral HTTP server on random port for callback.
3. Open browser to `https://codevos.ai/towers/register?callback=http://localhost:<port>/callback` (or reauth URL).
4. Set 2-minute timeout. If callback received → proceed. If timeout → prompt `"Paste registration token from browser:"`.
5. Prompt for tower name: `"Tower name (e.g. my-macbook):"` (default: `os.hostname()`). Skip for `--reauth`.
6. Exchange token + tower name for API key and tower ID via `POST https://codevos.ai/api/towers/register`.
7. Write `cloud-config.json` via `writeCloudConfig()`.
8. If tower daemon running, signal: `POST localhost:4100/api/tunnel/connect`.
9. Print success: `"Tower '<name>' registered successfully. Access URL: https://codevos.ai/t/<name>/"`.

**`towerDeregister()`**:
1. Check registration. If not registered, print error and exit.
2. Prompt confirmation: `"Deregister tower '<name>' from codevos.ai? (y/N)"`.
3. Call `DELETE https://codevos.ai/api/towers/<towerId>` with API key.
4. Delete `cloud-config.json` via `deleteCloudConfig()`.
5. If tower daemon running, signal: `POST localhost:4100/api/tunnel/disconnect`.
6. Print: `"Tower deregistered successfully."`.

**`af tower status` extension:**
- After existing output (daemon status, projects, terminals), add cloud section.
- If registered: show registration status, tower name, tower ID, connection state (via `GET /api/tunnel/status`), uptime, access URL.
- If not registered: `"Cloud Registration: not registered. Run 'af tower register' to connect to codevos.ai."`.

**CLI registration in `cli.ts`:**
- Add `towerCmd.command('register')` with `--reauth` option
- Add `towerCmd.command('deregister')`
- Add `towerCmd.command('status')` — new subcommand that shows daemon info + cloud connection status, matching the spec's output format exactly

#### Acceptance Criteria
- [ ] `af tower register` opens browser and completes registration
- [ ] `af tower register --reauth` updates API key without changing tower ID/name
- [ ] `af tower deregister` removes registration after confirmation
- [ ] `af tower status` shows cloud info when registered
- [ ] `af tower status` shows "not registered" message when not registered
- [ ] Manual token paste works when browser callback fails
- [ ] Already-registered prompt works correctly

#### Test Plan
- **Unit Tests**: Config flow (existing registration check, token exchange mock)
- **Integration Tests**: Deferred to Phase 6

#### Risks
- **Risk**: Browser opening fails in headless environments
  - **Mitigation**: 2-minute timeout with manual token paste fallback

---

### Phase 6: Tower Dashboard UI
**Dependencies**: Phase 4 (tunnel endpoints exist)

#### Objectives
- Add cloud connection controls to the Tower React dashboard (connect/disconnect buttons)
- Show real-time tunnel connection status (disconnected/connecting/connected/auth_failed)
- Display what's being accessed remotely (tower name, access URL, connection uptime)

#### Deliverables
- [ ] `packages/codev/dashboard/src/components/CloudStatus.tsx`
- [ ] Modified `packages/codev/dashboard/src/lib/api.ts` (add tunnel API functions)
- [ ] Modified `packages/codev/dashboard/src/hooks/useBuilderStatus.ts` (poll tunnel status)
- [ ] Modified `packages/codev/dashboard/src/components/App.tsx` (render CloudStatus)
- [ ] Modified `packages/codev/dashboard/src/index.css` (cloud status styling)

#### Implementation Details

**API functions** (`api.ts`):
- `getTunnelStatus(): Promise<TunnelStatus>` — calls `GET /api/tunnel/status`
- `connectTunnel(): Promise<void>` — calls `POST /api/tunnel/connect`
- `disconnectTunnel(): Promise<void>` — calls `POST /api/tunnel/disconnect`

**Polling** (`useBuilderStatus.ts`):
- Extend the existing 1-second poll to also fetch `/api/tunnel/status`
- Add `tunnelStatus` to the hook's return value

**`CloudStatus.tsx`** component:
- Renders in the dashboard header area (alongside existing builder count)
- **Not registered**: Shows "Cloud: not registered" in muted text
- **Disconnected**: Shows "Cloud: disconnected" with a "Connect" button
- **Connecting**: Shows "Cloud: connecting..." with a spinner
- **Connected**: Shows "Cloud: connected" with a green indicator, tower name, access URL (clickable link), uptime. Shows a "Disconnect" button.
- **Auth failed**: Shows "Cloud: auth failed" in red with message to run `--reauth`
- Connect/Disconnect buttons call the tunnel API endpoints

**Styling**:
- Connection status indicator: colored dot (green=connected, yellow=connecting, red=auth_failed, gray=disconnected)
- Compact layout in header — doesn't take significant space
- Access URL shown as a clickable external link

#### Acceptance Criteria
- [ ] CloudStatus component renders correctly in all states
- [ ] Connect button triggers tunnel connection
- [ ] Disconnect button closes tunnel
- [ ] Status updates in real-time via polling
- [ ] Access URL is clickable and opens in new tab
- [ ] Component gracefully handles API errors
- [ ] Dashboard works normally when not registered (no visual clutter)

#### Test Plan
- **Manual Testing**: Visual verification of all states, button interactions
- **Unit Tests**: Component renders correct state for each tunnel status

#### Risks
- **Risk**: Polling frequency adds load
  - **Mitigation**: Tunnel status piggybacked on existing 1s poll; single extra field in response

---

### Phase 7: E2E Tests
**Dependencies**: Phases 1-6

#### Objectives
- Create a mock tunnel server for unit/integration testing of the tunnel client
- Write E2E tests against a real local codevos.ai instance for full-stack validation
- Cover edge cases and negative scenarios
- Ensure all existing tests still pass

#### Deliverables
- [ ] `packages/codev/src/agent-farm/__tests__/helpers/mock-tunnel-server.ts`
- [ ] `packages/codev/src/agent-farm/__tests__/tunnel-client.integration.test.ts`
- [ ] `packages/codev/src/agent-farm/__tests__/tunnel-e2e.test.ts`
- [ ] All existing tests pass

#### Implementation Details

**Mock tunnel server** (`mock-tunnel-server.ts`):
- Lightweight TCP server implementing the codevos.ai tunnel protocol (`AUTH <key>\n` → `OK <id>\n`)
- Configurable behaviors: accept auth, reject auth, timeout, disconnect after N requests
- Runs H2 client over the connection to send requests to the tower
- Used for fast, isolated unit/integration tests that don't need a database

**Integration tests** (using mock server):
- Full auth handshake → tunnel connected
- HTTP GET/POST proxied correctly (status codes, headers, body)
- Streaming response (chunked) flows correctly
- Tower reconnects after simulated disconnect
- Auth failure triggers circuit breaker (`ERR invalid_api_key` → state `auth_failed`)
- Path blocklist enforced (`/api/tunnel/disconnect` → 403)

**E2E tests against local codevos.ai** (`tunnel-e2e.test.ts`):
- Uses the real codevos.ai server from `../codevos.ai` (relative to project root)
- codevos.ai server: Next.js on port 3000, tunnel server on port 4200
- Test setup: start local codevos.ai instance, create test user, generate registration token
- Leverages existing codevos.ai test helpers (`tests/e2e/helpers/test-server.ts`, `db-setup.ts`)
- Test scenarios:
  - Register tower via API → tower connects via tunnel → proxy HTTP request → verify response
  - Tower reconnects after server restart
  - Deregister tower → tunnel disconnects
  - Rate limiting behavior
  - WebSocket/terminal proxy through tunnel

**Negative/edge case tests:**
- Malformed auth response from server (no crash, clean error)
- Connection close mid-request (graceful cleanup)
- Config deleted while connected (disconnect on next reconnect)
- Config with missing fields (local-only with warning)
- Multiple rapid connect/disconnect cycles (no resource leaks)
- Request to `/api/tunnel/disconnect` through tunnel → 403

#### Acceptance Criteria
- [ ] Mock tunnel server works reliably in test environment
- [ ] All integration tests pass (mock server)
- [ ] All E2E tests pass (local codevos.ai)
- [ ] All edge case tests pass
- [ ] All existing tower tests pass
- [ ] No resource leaks (sockets, timers)

#### Test Plan
- **Integration Tests**: Mock server scenarios (fast, no external deps)
- **E2E Tests**: Full stack with local codevos.ai (slower, requires PostgreSQL)
- **Manual Testing**: Real connection to production codevos.ai

#### Risks
- **Risk**: E2E test setup complexity (codevos.ai + PostgreSQL)
  - **Mitigation**: Reuse existing codevos.ai test helpers; document setup clearly
- **Risk**: codevos.ai server API changes break E2E tests
  - **Mitigation**: Pin to specific codevos.ai commit or branch for tests

---

## Dependency Map
```
Phase 1 (Config) ──→ Phase 3 (Tunnel Client) ──→ Phase 4 (Tower Integration) ──→ Phase 5 (CLI) ──→ Phase 7 (Tests)
                                                        ↑                              ↓
Phase 2 (Remove Cloudflared) ──────────────────────────┘                    Phase 6 (Dashboard UI)
```

Phase 1 and Phase 2 can be done in parallel. Phase 3 depends on Phase 1. Phase 4 depends on both Phase 2 and Phase 3. Phase 5 depends on Phase 1 and Phase 4. Phase 6 depends on Phase 4 (tunnel endpoints). Phase 7 depends on all previous phases.

## Resource Requirements
### Development Resources
- **Environment**: Node.js with `node:http2`, `node:tls` support (built-in)

### Infrastructure
- No database changes (existing SQLite unchanged)
- No new services (tower server modified in-place)
- New config file: `~/.agent-farm/cloud-config.json`

## Integration Points
### External Systems
- **codevos.ai**: Registration API, tunnel server
  - **Integration Type**: HTTPS API + raw TLS/TCP
  - **Phase**: Phase 3 (tunnel), Phase 5 (registration CLI)
  - **Fallback**: Local-only mode works without codevos.ai

### Internal Systems
- **Tower server** (`tower-server.ts`): Modified to host tunnel client
  - **Phase**: Phase 2 (removal), Phase 4 (integration)
- **AF CLI** (`cli.ts`): New subcommands added
  - **Phase**: Phase 5
- **Tower Dashboard** (`packages/codev/dashboard/`): Cloud status UI
  - **Phase**: Phase 6

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| HTTP/2 role reversal edge cases | Low | Medium | Validated in spike; same as cloudflared approach |
| Terminal latency through tunnel | Low | High | H2 streams lightweight; profile in Phase 6 |
| `fs.watch()` reliability | Medium | Low | Debounce events; manual endpoint always works |
| E2E test setup complexity | Medium | Low | Reuse codevos.ai test helpers; document setup |
| codevos.ai API drift | Low | Medium | Pin to commit; auth protocol is stable |

## Validation Checkpoints
1. **After Phase 2**: Tower starts and runs with cloudflared removed; all existing tests pass
2. **After Phase 4**: Tunnel connects to mock server; requests proxied correctly
3. **After Phase 6**: Dashboard shows cloud connection status; connect/disconnect buttons work
4. **After Phase 7**: Full test suite passes; E2E tests pass against local codevos.ai

## Documentation Updates Required
- [ ] Remove `tunnel-setup.md` references
- [ ] Update tower server documentation with cloud registration info

## Notes
- No `af web keygen` command exists in current CLI — nothing to remove there
- The `codev-web-key` local auth header (in `tower-client.ts`) is unrelated to cloud auth and stays unchanged
- The spec mentions removing QR code generation — need to locate and remove if it exists in the codebase

---

## Amendment History

This section tracks all TICK amendments to this plan. TICKs modify both the spec and plan together as an atomic unit.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
