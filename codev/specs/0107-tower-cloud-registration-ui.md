# Spec 0107: Tower Cloud Connect UI

## Problem

Connecting and disconnecting a Tower to Codev Cloud currently requires the CLI (`af tower register` / `af tower deregister`). Users managing Tower via the web UI have no way to set up or tear down cloud connectivity. The cloud status indicator in the header is hidden entirely when not connected, with no affordance to connect.

Additionally, the CLI terminology ("register" / "deregister") is confusing. The user mental model is "connect to cloud" / "disconnect from cloud" — the registration details are an implementation concern.

## Goals

1. Add cloud connect/disconnect UI to the Tower homepage
2. Rename CLI commands from `af tower register`/`deregister` to `af tower connect`/`disconnect`
3. Unify the concept: **Connect** = OAuth + save credentials + open tunnel; **Disconnect** = close tunnel + delete credentials + deregister server-side
4. Smart Connect: if already connected, reconnects the tunnel; if not connected, starts the full OAuth flow
5. Retain CLI functionality (renamed commands do the same thing)

## Non-Goals

- Changing the OAuth flow on the codevos.ai side
- Adding user account management
- Mobile-specific UI (mobile is rarely the client for Tower management)

## Current State

### CLI Flow (`af tower register`)
1. Starts ephemeral HTTP server on random port for OAuth callback
2. Opens browser to `{serverUrl}/towers/register?callback={callbackUrl}`
3. User authenticates on codevos.ai
4. Callback returns token to ephemeral server
5. CLI prompts for tower name (default: hostname)
6. Exchanges token via POST `{serverUrl}/api/towers/register/redeem`
7. Writes `~/.agent-farm/cloud-config.json`
8. Signals Tower daemon to open tunnel

### Tower UI (current)
- Header shows cloud status when connected: green/yellow/gray/red dot with state
- When not connected, the status element is **hidden** — no way to connect
- Connect/Disconnect buttons exist but only manage the tunnel (not credentials)

## Desired State

### When Not Connected
The cloud status area in the header shows "Codev Cloud" with a "Connect" button. Clicking it opens a dialog with:
1. **Device name** input (default: machine hostname)
2. **Service URL** input (default: `https://codevos.ai`)
3. A "Connect" button that starts the OAuth flow

The OAuth flow navigates the current browser tab to codevos.ai. After authentication, the callback redirects back to Tower (not an ephemeral server), Tower exchanges the token, saves credentials, and connects the tunnel. The UI updates to show connected status.

### When Connected
The cloud status shows the green dot, device name, uptime, and a "Disconnect" button. Disconnect:
1. Confirms with the user ("This will disconnect from Codev Cloud. Continue?")
2. Closes the tunnel
3. Deregisters server-side (best-effort — see Error Handling)
4. Deletes local credentials
5. UI updates to show the "Connect" button again

### Smart Connect
If credentials exist but the tunnel is down (e.g., tunnel dropped, Tower restarted), Connect reconnects the tunnel without re-doing OAuth. Specifically: if `readCloudConfig()` returns a non-null config (all 4 required fields present as non-empty strings: `tower_id`, `tower_name`, `api_key`, `server_url`), POST `/api/tunnel/connect` with no body reconnects the existing tunnel. If the config file is missing, `readCloudConfig()` returns null and the full OAuth flow starts. If the config file exists but is malformed (invalid JSON or missing fields), `readCloudConfig()` returns null and the OAuth flow starts (the existing validation in `cloud-config.ts` handles this).

## Approach

### CLI Rename

Rename the commands while keeping the same behavior:
- `af tower register` → `af tower connect`
- `af tower deregister` → `af tower disconnect`
- Keep old names as hidden aliases for backwards compatibility (not shown in `--help`, but still functional)

### New Tower API Endpoints

**POST `/api/tunnel/connect`** (enhanced — replaces current behavior)
- If credentials exist and no body is provided: reconnect tunnel (current behavior)
- If no credentials: accepts `{ name: string, serverUrl?: string, origin?: string }`, generates callback URL, stores a pending registration nonce (see State Management), returns `{ authUrl: string }`
- The `origin` field allows the UI to pass `window.location.origin` so the callback URL is constructed correctly for non-localhost access (e.g., LAN IP)

**GET `/api/tunnel/connect/callback?token=...&nonce=...`**
- Validates the `nonce` against the pending registration store (rejects if missing/expired/already-used)
- Retrieves device name and serverUrl from the pending registration
- Exchanges token for API key via POST `{serverUrl}/api/towers/register/redeem`
- Writes cloud config
- Connects tunnel
- On success: returns HTML page "Connected to Codev Cloud" with auto-redirect to Tower homepage
- On failure: returns HTML error page with description and a "Try Again" link to Tower homepage
- Consumes the nonce (single-use)

**POST `/api/tunnel/disconnect`** (enhanced — replaces current behavior)
- Closes tunnel
- Deregisters server-side (DELETE to cloud API) — best-effort
- Deletes local credentials
- Returns `{ success: true }` (even if server-side deregister failed — includes `warning` field if so)

### OAuth State Management

The OAuth flow has a gap between initiating (POST `/api/tunnel/connect`) and completing (GET callback). To bridge this without server-side persistence across restarts:

1. **Initiation**: Server generates a random nonce (crypto.randomUUID), stores `{ nonce, name, serverUrl, createdAt }` in an in-memory Map
2. **Callback URL**: `{origin}/api/tunnel/connect/callback?token={token}&nonce={nonce}` — the nonce is embedded in the OAuth redirect URL (via the `callback` query parameter to codevos.ai)
3. **Completion**: Callback handler looks up the nonce, retrieves name/serverUrl, completes registration
4. **TTL**: Pending registrations expire after 5 minutes. A cleanup runs on each new registration.
5. **Single-use**: Nonce is deleted after successful use (replay protection)
6. **Tower restart**: If Tower restarts between initiation and callback, the in-memory store is lost. The callback returns an error page telling the user to try again. This is acceptable — the OAuth token is short-lived anyway.
7. **Concurrent attempts**: Multiple connect initiations are allowed (each gets its own nonce). The first callback to complete wins and writes the config. Subsequent callbacks with valid nonces will also succeed — last writer wins. This is acceptable since both callbacks produce valid credentials from the same user's OAuth session.

### UI Changes (tower.html)

1. **When not connected**: Cloud status shows "Codev Cloud" with a "Connect" button (replacing the current empty/hidden state)
2. Clicking "Connect" opens a modal dialog with:
   - Device name input (default: machine hostname from `/api/status`, validated: 1-63 chars, lowercase alphanumeric + hyphens, must start/end with letter or digit)
   - Service URL input (default: `https://codevos.ai`)
   - "Connect" and "Cancel" buttons
3. On submit: auto-normalize device name (trim, lowercase, replace spaces/underscores with hyphens, strip invalid chars). If the normalized result is empty or still fails validation (e.g., starts/ends with hyphen, exceeds 63 chars, all-hyphens), show inline error: "Invalid device name. Use letters, numbers, and hyphens (must start and end with a letter or number)."
4. POST to `/api/tunnel/connect` with `{ name, serverUrl, origin: window.location.origin }`, receive `{ authUrl }`
5. Navigate current tab to `authUrl` (`window.location.href = authUrl`)
6. After OAuth completes, callback redirects back to Tower homepage
7. **When connected**: Show device name + uptime + "Disconnect" button (with confirmation dialog)
8. **During OAuth** (user navigates away then returns before callback): The 5-second status poll detects that the tunnel is still disconnected. No special UI state needed — the Connect button remains available for retry.

### Existing Code to Reuse

- `cloud-config.ts`: `readCloudConfig()`, `writeCloudConfig()`, `deleteCloudConfig()`, `getOrCreateMachineId()`
- `tower-cloud.ts`: Token exchange logic (POST to `/api/towers/register/redeem`) — extract `redeemToken()` into shared lib
- `tower-tunnel.ts`: `handleTunnelEndpoint()` for routing `/api/tunnel/*`
- `tower.html`: Existing `renderCloudStatus()`, `cloudConnect()`, `cloudDisconnect()`

## Error Handling

### Callback Errors
| Scenario | Behavior |
|----------|----------|
| Invalid/expired/missing nonce | HTML error page: "Registration session expired. Please try again." with link to Tower homepage |
| Token exchange fails (network) | HTML error page: "Could not reach Codev Cloud. Please check your connection and try again." |
| Token invalid/expired | HTML error page: "Authentication expired. Please try again." |
| Config write fails | HTML error page: "Could not save credentials. Check file permissions." |

### Disconnect Errors
| Scenario | Behavior |
|----------|----------|
| Server-side deregister fails (network) | Local cleanup proceeds. Response includes `{ success: true, warning: "Could not reach Codev Cloud to deregister. Local credentials removed." }` |
| Server-side deregister fails (API error) | Same as above — best-effort. Local cleanup always happens. |
| Local credential deletion fails | Return `{ success: false, error: "..." }` — this is a real failure |

### UI Error Display
- Connect dialog: inline error below the form (e.g., "Invalid device name")
- Disconnect: toast/banner warning if server-side deregister failed
- Callback page errors: full-page HTML with description and retry link

## Success Criteria

- [ ] Tower homepage shows "Connect" when not connected to Codev Cloud
- [ ] User can connect from the web UI: dialog with device name + service URL, OAuth flow, auto-connect
- [ ] OAuth callback handled by Tower server (no ephemeral port) with nonce validation
- [ ] Connected state shows device name + "Disconnect" button
- [ ] Disconnect fully cleans up: tunnel, server-side registration (best-effort), local credentials
- [ ] Smart connect: reconnects tunnel if credentials exist without re-doing OAuth
- [ ] CLI commands renamed to `af tower connect` / `af tower disconnect`
- [ ] Old CLI names (`register`/`deregister`) work as hidden aliases
- [ ] Existing tunnel connect/disconnect behavior preserved
- [ ] Callback error pages rendered for all failure modes

## Testing Requirements

### Unit Tests
- **Nonce store**: generation, lookup, expiry after 5 minutes, single-use consumption, cleanup of expired entries
- **Callback handler**: valid nonce → success, expired nonce → error, missing nonce → error, already-used nonce → error
- **Smart Connect logic**: config exists → reconnect (no OAuth), config missing → initiate OAuth, config malformed → initiate OAuth
- **Device name normalization**: spaces → hyphens, uppercase → lowercase, strip invalid chars, empty result → error, all-hyphens → error
- **Disconnect**: successful full cleanup, server-side deregister failure → warning (local cleanup still proceeds), local credential deletion failure → error

### Integration/E2E Tests
- **CLI aliases**: `af tower connect` and `af tower disconnect` execute correctly; `af tower register` and `af tower deregister` still work as hidden aliases
- **Connect dialog UI**: renders when not connected, device name defaults to hostname, service URL defaults to `https://codevos.ai`, validation errors display inline
- **Disconnect UI**: confirmation dialog appears, connected status updates to disconnected after successful disconnect

### Not Tested (intentional)
- Full OAuth round-trip (requires live codevos.ai interaction — tested manually)
- Token exchange with real server (mock the POST to `/api/towers/register/redeem` in tests)

## Constraints

- OAuth callback must come to Tower's own HTTP server (port 4100 default)
- Device name: 1-63 characters, lowercase alphanumeric + hyphens, must start and end with a letter or digit
- Default service URL: `https://codevos.ai`
- Cloud config permissions (0o600) must be maintained
- Callback URL constructed from UI-provided origin (supports LAN access). The `origin` is not a security boundary — nonce validation provides security. Origin is validated as a well-formed URL but not allowlisted (Tower is a local-first tool accessed from trusted networks).

## Security Considerations

- Cloud config contains API key — file permissions (0o600) must be preserved
- OAuth token is single-use and short-lived (managed by codevos.ai)
- Callback nonce: random UUID, single-use, 5-minute TTL, in-memory only
- Service URL must use HTTPS (reject non-HTTPS URLs except localhost for development)
- Disconnect confirmation prevents accidental credential deletion
- Tokens must not appear in server logs (use masked format: `ctk_****XXXX`)
