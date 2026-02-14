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

- Changing the OAuth flow on the cloud.codevos.ai side
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
2. **Service URL** input (default: `https://cloud.codevos.ai`)
3. A "Connect" button that starts the OAuth flow

The OAuth flow redirects the browser to cloud.codevos.ai. After authentication, the callback returns to Tower (not an ephemeral server), Tower exchanges the token, saves credentials, and connects the tunnel. The UI updates to show connected status.

### When Connected
The cloud status shows the green dot, device name, uptime, and a "Disconnect" button. Disconnect:
1. Confirms with the user ("This will disconnect from Codev Cloud. Continue?")
2. Closes the tunnel
3. Deregisters server-side
4. Deletes local credentials
5. UI updates to show the "Connect" button again

### Smart Connect
If already connected and the user somehow triggers Connect (e.g., tunnel dropped but credentials exist), it simply reconnects the tunnel without re-doing OAuth.

## Approach

### CLI Rename

Rename the commands while keeping the same behavior:
- `af tower register` → `af tower connect`
- `af tower deregister` → `af tower disconnect`
- Keep old names as hidden aliases for backwards compatibility

### New Tower API Endpoints

**POST `/api/tunnel/connect`** (enhanced — replaces current behavior)
- If credentials exist: reconnect tunnel (current behavior)
- If no credentials: accepts `{ name: string, serverUrl?: string }`, generates callback URL pointing to Tower, returns `{ authUrl: string }`

**GET `/api/tunnel/connect/callback?token=...`**
- Receives OAuth callback from cloud.codevos.ai
- Exchanges token for API key using device name from the initial request
- Writes cloud config
- Connects tunnel
- Returns HTML page: "Connected to Codev Cloud" with auto-redirect to Tower homepage

**POST `/api/tunnel/disconnect`** (enhanced — replaces current behavior)
- Closes tunnel
- Deregisters server-side (DELETE to cloud API)
- Deletes local credentials
- Returns `{ success: true }`

### UI Changes (tower.html)

1. **When not connected**: Cloud status shows "Codev Cloud: not connected" with a "Connect" button
2. Clicking "Connect" shows a dialog with device name + service URL inputs
3. Submitting POSTs to `/api/tunnel/connect`, gets `authUrl`, opens it in browser
4. After OAuth, callback completes at `/api/tunnel/connect/callback`, redirects to Tower homepage
5. **When connected**: Show device name + uptime + "Disconnect" button (with confirmation)

### Existing Code to Reuse

- `cloud-config.ts`: `readCloudConfig()`, `writeCloudConfig()`, `deleteCloudConfig()`, `readOrCreateMachineId()`
- `tower-cloud.ts`: Token exchange logic (POST to `/api/towers/register/redeem`)
- `tower-tunnel.ts`: `handleTunnelEndpoint()` for routing `/api/tunnel/*`
- `tower.html`: Existing `renderCloudStatus()`, `cloudConnect()`, `cloudDisconnect()`

## Success Criteria

- [ ] Tower homepage shows "Connect" when not connected to Codev Cloud
- [ ] User can connect from the web UI: dialog with device name + service URL, OAuth flow, auto-connect
- [ ] OAuth callback handled by Tower server (no ephemeral port)
- [ ] Connected state shows device name + "Disconnect" button
- [ ] Disconnect fully cleans up: tunnel, server-side registration, local credentials
- [ ] Smart connect: reconnects tunnel if credentials exist without re-doing OAuth
- [ ] CLI commands renamed to `af tower connect` / `af tower disconnect`
- [ ] Old CLI names (`register`/`deregister`) work as hidden aliases
- [ ] Existing tunnel connect/disconnect behavior preserved

## Constraints

- OAuth callback must come to Tower's own HTTP server (port 4100)
- Device name validated: lowercase, alphanumeric + hyphens
- Default service URL: `https://cloud.codevos.ai`
- Cloud config permissions (0o600) must be maintained

## Security Considerations

- Cloud config contains API key — file permissions must be preserved
- OAuth token is single-use and short-lived
- Disconnect confirmation prevents accidental credential deletion
