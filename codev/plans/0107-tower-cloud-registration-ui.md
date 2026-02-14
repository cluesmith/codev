# Plan: Tower Cloud Connect UI

## Metadata
- **ID**: plan-0107
- **Status**: draft
- **Specification**: [codev/specs/0107-tower-cloud-registration-ui.md](../specs/0107-tower-cloud-registration-ui.md)
- **Created**: 2026-02-14

## Executive Summary

Move the Tower cloud registration flow from the CLI's ephemeral HTTP callback server into Tower's own HTTP server and web UI. The implementation has four phases: (1) extract shared infrastructure (nonce store, token exchange), (2) enhance Tower tunnel endpoints for OAuth initiation/callback/disconnect, (3) add connect/disconnect UI to the Tower homepage, (4) rename CLI commands with backward-compatible aliases.

## Success Metrics
- [ ] All specification success criteria met (10 criteria)
- [ ] Unit tests for nonce store, callback handler, smart connect, device name normalization, disconnect
- [ ] E2E tests for CLI aliases and UI interactions
- [ ] No regressions in existing tunnel connect/disconnect behavior

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Shared Infrastructure: Nonce Store & Token Exchange"},
    {"id": "phase_2", "title": "Enhanced Tunnel Endpoints"},
    {"id": "phase_3", "title": "Tower UI: Connect Dialog & Disconnect Confirmation"},
    {"id": "phase_4", "title": "CLI Rename & Aliases"}
  ]
}
```

## Phase Breakdown

### Phase 1: Shared Infrastructure — Nonce Store & Token Exchange
**Dependencies**: None

#### Objectives
- Create an in-memory nonce store for OAuth state management
- Extract `redeemToken()` from `tower-cloud.ts` into a shared module usable by both CLI and tunnel endpoint

#### Deliverables
- [ ] New file: `packages/codev/src/agent-farm/lib/nonce-store.ts`
- [ ] New file: `packages/codev/src/agent-farm/lib/token-exchange.ts`
- [ ] Update: `packages/codev/src/agent-farm/commands/tower-cloud.ts` (import from shared module)
- [ ] Tests for nonce store and token exchange

#### Implementation Details

**Nonce Store** (`lib/nonce-store.ts`):
- `PendingRegistration` type: `{ nonce: string, name: string, serverUrl: string, createdAt: number }`
- In-memory `Map<string, PendingRegistration>`
- `createPendingRegistration(name, serverUrl)` → generates `crypto.randomUUID()` nonce, stores entry, runs cleanup, returns nonce
- `consumePendingRegistration(nonce)` → looks up nonce, deletes it (single-use), returns entry or null
- `cleanupExpired()` → removes entries older than 5 minutes (called on each `create`)
- Module-level singleton (same as tunnel state pattern in `tower-tunnel.ts`)

**Token Exchange** (`lib/token-exchange.ts`):
- Move `redeemToken(token, name, machineId, serverUrl)` from `tower-cloud.ts` lines 59-102
- Keep same signature and behavior: POST `{serverUrl}/api/towers/register/redeem`, handle redirects, 30s timeout
- Returns `{ towerId: string, apiKey: string }`
- Update `tower-cloud.ts` to import from the new location

**Default URL constant**:
- Update `CODEVOS_URL` in `tower-cloud.ts` (line 22) from `https://codevos.ai` to `https://cloud.codevos.ai`

#### Acceptance Criteria
- [ ] Nonce store generates unique UUIDs, stores/retrieves entries, expires after 5 min, single-use
- [ ] `redeemToken()` works identically from new location (CLI registration still passes)
- [ ] Default URL is `https://cloud.codevos.ai`
- [ ] All existing tests pass

#### Test Plan
- **Unit Tests** (`__tests__/nonce-store.test.ts`): generation, lookup, expiry, single-use, cleanup
- **Unit Tests**: Verify `redeemToken()` import in `tower-cloud.ts` still resolves

#### Rollback Strategy
Revert the commit. These are pure library additions with no behavioral change to existing code.

#### Risks
- **Risk**: Moving `redeemToken()` could break imports elsewhere
  - **Mitigation**: Grep for all usages before moving; only `tower-cloud.ts` uses it currently

---

### Phase 2: Enhanced Tunnel Endpoints
**Dependencies**: Phase 1

#### Objectives
- Enhance `POST /api/tunnel/connect` to support OAuth initiation (when no credentials exist)
- Add `GET /api/tunnel/connect/callback` to handle OAuth redirect
- Enhance `POST /api/tunnel/disconnect` with server-side deregister + credential deletion

#### Deliverables
- [ ] Update: `packages/codev/src/agent-farm/servers/tower-tunnel.ts`
- [ ] Tests for new endpoint behaviors

#### Implementation Details

**Enhanced `handleTunnelEndpoint()`** in `tower-tunnel.ts`:

**IMPORTANT — Route ordering**: The `connect/callback` handler MUST be checked BEFORE the existing `connect` handler. When the URL is `/api/tunnel/connect/callback`, `tunnelSub` will be `connect/callback`. The existing check `tunnelSub === 'connect'` won't match, but adding the callback check after could lead to confusion. Insert the GET handler first:

```
if (req.method === 'GET' && tunnelSub === 'connect/callback') { ... }
else if (req.method === 'POST' && tunnelSub === 'connect') { ... }
```

1. **GET `/api/tunnel/connect/callback`** (new sub-route — add BEFORE existing connect handler):
   - Set response header `Content-Type: text/html`
   - Parse query params: `token`, `nonce`
   - Look up nonce via `consumePendingRegistration(nonce)` → if null, return error HTML
   - Get machine ID via `getOrCreateMachineId()`
   - Call `redeemToken(token, name, machineId, serverUrl)` from shared module — use `maskApiKey()` when logging (tokens must not appear in server logs per spec)
   - Call `writeCloudConfig({ tower_id, tower_name: name, api_key, server_url })`
   - Connect tunnel (same as existing connect logic)
   - On success: return HTML page with "Connected to Codev Cloud" + meta refresh to `/`
   - On failure: return HTML error page per spec's error table + link to Tower homepage
   - Note: `readCloudConfig()` throws on invalid JSON (not returns null as spec simplifies). Wrap in try/catch in all call sites — the existing connect handler at line 275 has implicit coverage via the `handleTunnelEndpoint` try/catch, but the callback handler needs explicit handling.

2. **POST `/api/tunnel/connect`** (lines 267-291):
   - Parse request body as JSON
   - If body contains `name`: OAuth initiation flow
     - Validate `name` (1-63 chars, lowercase alphanumeric + hyphens, start/end with letter/digit)
     - Extract `serverUrl` (default `https://cloud.codevos.ai`)
     - Extract `origin` (default `http://localhost:${port}`), validate as well-formed URL via `new URL(origin)` — reject with 400 if malformed
     - Validate `serverUrl` is HTTPS (or localhost)
     - Create pending registration via nonce store
     - Build `authUrl`: `{serverUrl}/towers/register?callback={encodeURIComponent(callbackUrl)}`
       where `callbackUrl = {origin}/api/tunnel/connect/callback`
     - Return 200 `{ authUrl }`
   - If no body (or empty body): existing reconnect behavior (no change)

3. **POST `/api/tunnel/disconnect`** (lines 294-302):
   - Read config FIRST (need `tower_id`, `api_key`, `server_url` for deregister)
   - Disconnect tunnel
   - Server-side deregister: DELETE `{serverUrl}/api/towers/{towerId}` with `Authorization: Bearer {apiKey}` — best-effort, catch errors
   - Delete local config via `deleteCloudConfig()` LAST (order matters: read first, delete last)
   - Return `{ success: true }` with optional `warning` field if server-side deregister failed
   - If `deleteCloudConfig()` fails: return `{ success: false, error: "..." }`

4. **Update error message** on line 278: `"Not registered. Run 'af tower register' first."` → `"Not registered. Run 'af tower connect' or use the Connect button in the Tower UI."`

5. **Add `hostname` to `/api/tunnel/status` response**: Add `hostname: os.hostname()` to the status response JSON so the UI can use it as the device name default. This avoids the UI needing a separate endpoint.

#### Acceptance Criteria
- [ ] POST `/api/tunnel/connect` with body `{ name, serverUrl }` returns `{ authUrl }`
- [ ] POST `/api/tunnel/connect` with malformed `origin` returns 400
- [ ] POST `/api/tunnel/connect` with no body still reconnects (existing behavior)
- [ ] GET `/api/tunnel/connect/callback` with valid nonce completes registration
- [ ] GET `/api/tunnel/connect/callback` with invalid/expired nonce returns error HTML (Content-Type: text/html)
- [ ] POST `/api/tunnel/disconnect` deregisters server-side, deletes config, disconnects tunnel
- [ ] Disconnect returns warning (not error) when server-side deregister fails
- [ ] `/api/tunnel/status` includes `hostname` field
- [ ] Tokens are masked in all log output (use `maskApiKey()`)

#### Test Plan
- **Unit Tests** (`__tests__/tower-tunnel.test.ts`):
  - Connect initiation: valid body → authUrl, missing name → 400, invalid serverUrl → 400, malformed origin → 400
  - Callback: valid nonce → success HTML, expired nonce → error HTML, missing nonce → error HTML, already-used nonce → error HTML
  - Callback: verify response Content-Type is text/html
  - Disconnect: full cleanup, server-side failure → warning, local failure → error
  - Smart connect: config exists → reconnect, config missing → 400 with new message
  - Status: response includes hostname field
- **Manual Testing**: Full OAuth round-trip with cloud.codevos.ai

#### Rollback Strategy
Revert the commit. Existing connect/disconnect behavior is preserved for the no-body case.

#### Risks
- **Risk**: `redeemToken()` could fail with different error format when called from tunnel context
  - **Mitigation**: Error handling wraps all outcomes into HTML error pages
- **Risk**: Routing for `connect/callback` sub-path might not match cleanly
  - **Mitigation**: `tunnelSub` in `handleTunnelEndpoint` is the path after `/api/tunnel/`, so `connect/callback` will be the value when the URL is `/api/tunnel/connect/callback`. Add explicit check for this before the existing `connect` check.

---

### Phase 3: Tower UI — Connect Dialog & Disconnect Confirmation
**Dependencies**: Phase 2

#### Objectives
- Show "Connect" button when not registered (instead of hiding the cloud status area)
- Add modal dialog for connect with device name + service URL inputs
- Add disconnect confirmation dialog with warning display
- Implement device name normalization and validation on the client side

#### Deliverables
- [ ] Update: `packages/codev/templates/tower.html`

#### Implementation Details

**renderCloudStatus()** (lines 1773-1824):
- When `!status.registered`: render "Codev Cloud" label + "Connect" button (instead of returning empty HTML)
- Keep existing behavior for registered states (connected/connecting/disconnected/auth_failed)
- When registered but disconnected: show "Connect" button (for smart reconnect)

**Connect Dialog**:
- HTML `<dialog>` element with:
  - Device name `<input>` (default from `/api/tunnel/status` `hostname` field, added in Phase 2)
  - Service URL `<input>` (default `https://cloud.codevos.ai`)
  - Inline error `<div>` (hidden by default, styled with red text)
  - "Connect" and "Cancel" buttons
- CSS styling consistent with existing Tower dialogs (reuse patterns from the existing create-project dialog at lines ~990-1006)
- Use existing `showToast()` function for disconnect warnings

**cloudConnect()** (lines 1826-1838):
- If registered (smart connect): POST to `./api/tunnel/connect` with no body (existing behavior)
- If not registered: open the connect dialog
- New `normalizeDeviceName(raw)` function (pure logic, testable):
  - trim, lowercase, replace spaces/underscores with hyphens, strip invalid chars
  - Return normalized string
- New `validateDeviceName(name)` function (pure logic, testable):
  - Check: non-empty, 1-63 chars, starts/ends with letter or digit, not all hyphens
  - Return `{ valid: boolean, error?: string }`
- New `submitConnect()` function:
  - Call `normalizeDeviceName()` then `validateDeviceName()`
  - If invalid: show inline error, return
  - POST to `./api/tunnel/connect` with `{ name, serverUrl, origin: window.location.origin }`
  - Navigate to `authUrl` via `window.location.href`

**cloudDisconnect()** (lines 1840-1850):
- Show confirmation: `confirm("This will disconnect from Codev Cloud. Continue?")`
- If confirmed: POST to `./api/tunnel/disconnect`
- Check response for `warning` field → show as toast/banner
- Refresh UI

**Status endpoint update**:
- Use `hostname` field from `/api/tunnel/status` (added in Phase 2) for device name default.

#### Acceptance Criteria
- [ ] Cloud status area visible when not registered (shows "Connect" button)
- [ ] Connect dialog opens with correct defaults
- [ ] Device name normalization works (spaces → hyphens, uppercase → lowercase)
- [ ] Invalid device names show inline error
- [ ] Submit navigates to OAuth URL
- [ ] Disconnect shows confirmation dialog
- [ ] Disconnect warning displayed as toast when server-side deregister fails
- [ ] Smart connect (registered but disconnected) reconnects without dialog

#### Test Plan
- **Unit Tests** (`__tests__/device-name.test.ts`):
  - `normalizeDeviceName()`: spaces → hyphens, uppercase → lowercase, underscores → hyphens, strip invalid chars, empty input → empty output
  - `validateDeviceName()`: valid names pass, empty → error, too long (>63) → error, starts/ends with hyphen → error, all-hyphens → error
  - Note: Extract these as standalone functions (not inline in HTML) so they can be imported and unit tested. Define in `packages/codev/src/agent-farm/lib/device-name.ts` and import in tower.html's inline script via a small helper or duplicate the logic (tower.html is a self-contained template).
- **E2E Tests** (Playwright, `tests/e2e/`):
  - Connect dialog renders when not connected; device name and service URL have correct defaults
  - Disconnect confirmation dialog appears when "Disconnect" button is clicked
  - Validation errors display inline for invalid device names
- **Manual Testing**: Full OAuth round-trip, visual inspection of UI states

#### Rollback Strategy
Revert the HTML changes. Pure UI — no server-side impact.

#### Risks
- **Risk**: Dialog styling may not match existing Tower design
  - **Mitigation**: Reuse existing CSS patterns from Tower (create-project dialog at ~lines 990-1006)

---

### Phase 4: CLI Rename & Aliases
**Dependencies**: None (can be done in parallel with Phase 2-3, but sequenced for commit clarity)

#### Objectives
- Rename `af tower register` → `af tower connect` and `af tower deregister` → `af tower disconnect`
- Keep old names as hidden aliases for backward compatibility
- Update help text and related messages

#### Deliverables
- [ ] Update: `packages/codev/src/agent-farm/cli.ts`
- [ ] Update: `packages/codev/src/agent-farm/commands/tower-cloud.ts` (error messages referencing old command names)
- [ ] Tests for CLI aliases

#### Implementation Details

**CLI rename** (`cli.ts` lines 427-455):
- Change `.command('register')` → `.command('connect')`
- Add `.alias('register')` (Commander.js supports this natively)
- Change `.command('deregister')` → `.command('disconnect')`
- Add `.alias('deregister')`
- Update `.description()` strings to reflect new naming
- Aliases are hidden from `--help` by default with Commander.js `.alias()`

**Message updates** (`tower-cloud.ts`):
- Line 166: `"Tower is already registered"` → keep (describes state, not command)
- Update any user-facing strings that say "register"/"deregister" to say "connect"/"disconnect"
- Update `CODEVOS_URL` fallback if not already done in Phase 1

#### Acceptance Criteria
- [ ] `af tower connect` works (equivalent to old `register`)
- [ ] `af tower disconnect` works (equivalent to old `deregister`)
- [ ] `af tower register` still works (hidden alias)
- [ ] `af tower deregister` still works (hidden alias)
- [ ] `af tower --help` shows `connect`/`disconnect`, not `register`/`deregister`

#### Test Plan
- **Unit Tests** (`__tests__/tower-cloud-cli.test.ts`): Verify both new names and old aliases resolve to the same handlers
- **Manual Testing**: Run `af tower connect --help` and `af tower register --help`

#### Rollback Strategy
Revert CLI changes. Command behavior is unchanged, only names differ.

#### Risks
- **Risk**: Other code or docs reference `af tower register` by string
  - **Mitigation**: Grep codebase for all references; update docs, but aliases ensure nothing breaks

---

## Dependency Map
```
Phase 1 (Shared Infrastructure) ──→ Phase 2 (Endpoints) ──→ Phase 3 (UI)

Phase 4 (CLI Rename) ── independent, sequenced last for commit clarity
```

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| OAuth callback routing conflict | Low | Medium | Check `connect/callback` BEFORE `connect` in route dispatch |
| Existing tunnel tests break | Low | High | Run full test suite after each phase |
| codevos.ai OAuth flow incompatible | Low | High | Test manually with real server; existing CLI flow proves compatibility |
| Token leak in server logs | Low | High | Use `maskApiKey()` for all token logging; verify in code review |
| Disconnect race condition | Low | Medium | Read config FIRST, delete config LAST; disconnect in between |

## Validation Checkpoints
1. **After Phase 1**: Nonce store unit tests pass; existing CLI registration still works
2. **After Phase 2**: Endpoint tests pass; manual OAuth round-trip succeeds
3. **After Phase 3**: UI visually correct; connect/disconnect flows work end-to-end
4. **After Phase 4**: CLI rename works; aliases functional; `--help` correct
