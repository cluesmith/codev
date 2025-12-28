# Specification: Secure Remote Access

## Metadata
- **ID**: 0062
- **Status**: specified
- **Created**: 2025-12-23
- **Updated**: 2025-12-28
- **Protocol**: SPIDER

## Problem Statement

Agent Farm currently binds to localhost only for security. Users want to run Agent Farm on remote machines (cloud VMs, local robots/devices) and access the dashboard from their primary workstation.

**Use cases:**
1. **Cloud development** - Run Agent Farm on an EC2/GCP VM, access from laptop
2. **Local robots/devices** - Run on `tidybot@192.168.50.16`, access from Mac
3. **iPad/tablet access** - Use Agent Farm from an iPad on the same network

**Current limitations:**
- `--allow-insecure-remote` exposes dashboard without authentication (dangerous)
- Manual SSH tunneling requires multiple steps across two machines
- No seamless "just works" experience

## Solution: `af start --remote`

### User Experience

```bash
# On your Mac - one command does everything:
af start --remote tidybot@192.168.50.16

# Or with explicit project path:
af start --remote tidybot@192.168.50.16:/home/tidybot/robot-project
```

This single command:
1. SSHs into the remote machine
2. Starts Agent Farm there
3. Sets up SSH tunnel back to your local machine
4. Opens `http://localhost:4200` in your browser

The dashboard and terminals work identically to local development.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Your Mac (local)                                           │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  af start --remote tidybot@192.168.50.16            │    │
│  │                                                     │    │
│  │  1. Spawns: ssh -L 4200:localhost:4200 tidybot@...  │    │
│  │  2. Runs: cd /project && af start (on remote)       │    │
│  │  3. Opens: http://localhost:4200 (local browser)    │    │
│  └─────────────────────────────────────────────────────┘    │
│                          │                                  │
│                     Port 4200                               │
│                          ▼                                  │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Browser → http://localhost:4200                    │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                           │
                      SSH Tunnel
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  tidybot (remote)                                           │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Dashboard Server (port 4200)                       │    │
│  │                                                     │    │
│  │  GET /              → Dashboard UI                  │    │
│  │  GET /api/*         → REST API                      │    │
│  │  /terminal/:id      → Reverse Proxy → ttyd          │    │
│  └─────────────────────────────────────────────────────┘    │
│            │                    │                    │      │
│            ▼                    ▼                    ▼      │
│     ┌───────────┐        ┌───────────┐        ┌───────────┐ │
│     │ttyd :4201 │        │ttyd :4210 │        │ttyd :4230 │ │
│     │(architect)│        │(builder)  │        │(util)     │ │
│     └───────────┘        └───────────┘        └───────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## Scope

### In Scope (MVP)

1. **`--remote` flag for `af start`** - Single command to start remote Agent Farm
2. **Reverse proxy** - Routes `/terminal/:id` to correct ttyd instance
3. **Dashboard UI update** - Change iframes to use proxied URLs
4. **Documentation** - README, CLAUDE.md, AGENTS.md updates

### Out of Scope (Future)

- `af stop --remote` to tear down remote sessions
- Multiple simultaneous remote connections
- Remote project discovery/selection UI
- Tailscale/WireGuard integration

### Non-Goals

- Building a new authentication system (SSH handles this)
- TLS/certificate management (SSH handles this)
- Token-based authentication

---

## Component 1: `af start --remote`

### Usage

```bash
# Basic - uses current directory name to find project on remote
af start --remote user@host

# Explicit path
af start --remote user@host:/path/to/project

# With custom port
af start --remote user@host --port 4300
```

### Implementation

```typescript
// packages/codev/src/agent-farm/commands/start.ts

interface StartOptions {
  remote?: string;  // user@host or user@host:/path
  port?: number;
  // ... existing options
}

export async function start(options: StartOptions): Promise<void> {
  if (options.remote) {
    return startRemote(options);
  }
  // ... existing local start logic
}

async function startRemote(options: StartOptions): Promise<void> {
  const { user, host, remotePath } = parseRemote(options.remote!);
  const localPort = options.port || 4200;

  logger.header('Starting Remote Agent Farm');
  logger.kv('Host', `${user}@${host}`);
  if (remotePath) logger.kv('Path', remotePath);
  logger.kv('Local Port', localPort);

  // Build the remote command
  const cdCommand = remotePath ? `cd ${remotePath} && ` : '';
  const remoteCommand = `${cdCommand}af start --port ${localPort}`;

  // Spawn SSH with port forwarding
  const ssh = spawn('ssh', [
    '-L', `${localPort}:localhost:${localPort}`,
    '-t',  // Force TTY for remote af start
    `${user}@${host}`,
    remoteCommand
  ], {
    stdio: ['inherit', 'pipe', 'inherit']
  });

  // Wait for Agent Farm to start (look for "Dashboard:" in output)
  await waitForRemoteStart(ssh);

  // Open local browser
  await openBrowser(`http://localhost:${localPort}`);

  logger.success('Remote Agent Farm connected!');
  logger.kv('Dashboard', `http://localhost:${localPort}`);

  // Keep SSH connection alive
  ssh.on('exit', (code) => {
    logger.info('Remote session ended');
    process.exit(code || 0);
  });
}

function parseRemote(remote: string): { user: string; host: string; remotePath?: string } {
  // user@host:/path or user@host
  const match = remote.match(/^([^@]+)@([^:]+)(?::(.+))?$/);
  if (!match) {
    throw new Error(`Invalid remote format: ${remote}. Use user@host or user@host:/path`);
  }
  return { user: match[1], host: match[2], remotePath: match[3] };
}
```

### Connection Lifecycle

1. **Start**: `af start --remote` spawns SSH subprocess
2. **Running**: SSH keeps tunnel open, Ctrl+C in local terminal ends session
3. **Stop**: SSH exit triggers local cleanup

---

## Component 2: Reverse Proxy

### URL Routing

```
/                       → Dashboard UI (static files)
/api/*                  → Dashboard REST API
/terminal/architect     → ttyd on port 4201
/terminal/builder-0055  → ttyd on port 4210
/terminal/util-abc123   → ttyd on port 4230
```

### Implementation

```typescript
// packages/codev/src/agent-farm/servers/dashboard-server.ts

import httpProxy from 'http-proxy';

const terminalProxy = httpProxy.createProxyServer({ ws: true });

terminalProxy.on('error', (err, req, res) => {
  console.error('Terminal proxy error:', err.message);
  if (res && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Terminal unavailable' }));
  }
});

// HTTP routing
app.use('/terminal/:id', (req, res) => {
  const port = getPortForTerminal(req.params.id);
  if (!port) {
    res.status(404).json({ error: `Terminal not found: ${req.params.id}` });
    return;
  }
  req.url = req.url.replace(/^\/terminal\/[^/]+/, '') || '/';
  terminalProxy.web(req, res, { target: `http://localhost:${port}` });
});

// WebSocket upgrade
server.on('upgrade', (req, socket, head) => {
  const match = req.url?.match(/^\/terminal\/([^/]+)/);
  if (match) {
    const port = getPortForTerminal(match[1]);
    if (port) {
      req.url = req.url.replace(/^\/terminal\/[^/]+/, '') || '/';
      terminalProxy.ws(req, socket, head, { target: `http://localhost:${port}` });
    } else {
      socket.destroy();
    }
  }
});
```

---

## Component 3: Dashboard UI Changes

### Before (Direct ttyd URLs)

```javascript
content.innerHTML = `<iframe src="http://localhost:4201"></iframe>`;
```

### After (Proxied URLs)

```javascript
function getTerminalUrl(tab) {
  if (tab.type === 'architect') return '/terminal/architect';
  if (tab.type === 'builder') return `/terminal/builder-${tab.projectId}`;
  if (tab.type === 'shell') return `/terminal/util-${tab.utilId}`;
  // File tabs still use direct port (open-server)
  if (tab.type === 'file') return `http://${window.location.hostname}:${tab.port}`;
  return null;
}

content.innerHTML = `<iframe src="${getTerminalUrl(tab)}"></iframe>`;
```

---

## Error Handling

### `af start --remote` Errors

| Condition | Behavior |
|-----------|----------|
| SSH connection fails | Exit with error: "Could not connect to user@host" |
| Remote `af` not found | Exit with error: "Agent Farm not installed on remote" |
| Remote path not found | Exit with error: "Directory not found: /path" |
| Port already in use | Exit with error: "Port 4200 already in use locally" |
| SSH disconnects | Exit and show "Remote session ended" |

### Reverse Proxy Errors

| Condition | HTTP Response |
|-----------|---------------|
| Unknown terminal ID | 404: `{"error": "Terminal not found: xyz"}` |
| ttyd not responding | 502: `{"error": "Terminal unavailable"}` |

---

## Acceptance Criteria

### `af start --remote`

- [ ] Parses `user@host` and `user@host:/path` formats
- [ ] Establishes SSH connection with port forwarding
- [ ] Runs `af start` on remote machine
- [ ] Waits for remote Agent Farm to be ready
- [ ] Opens local browser to `http://localhost:4200`
- [ ] Keeps connection alive until Ctrl+C
- [ ] Clean exit on SSH disconnect
- [ ] Shows helpful errors for common failures

### Reverse Proxy

- [ ] Routes `/terminal/architect` to architect ttyd port
- [ ] Routes `/terminal/builder-XXXX` to correct builder port
- [ ] Routes `/terminal/util-XXXX` to correct utility port
- [ ] Proxies WebSocket connections bidirectionally
- [ ] Returns 404 for unknown terminal IDs
- [ ] Returns 502 when target ttyd is unavailable

### Dashboard UI

- [ ] All terminal iframes use `/terminal/:id` URLs
- [ ] Terminals work identically via local and remote access
- [ ] File tabs still work (note: won't load through tunnel)

---

## Deprecation

### `--allow-insecure-remote`

This flag is deprecated. On use:
1. Print warning: "DEPRECATED: Use `af start --remote user@host` for secure remote access"
2. Continue to function for backward compatibility
3. Remove in a future version

### `af tunnel` (if implemented)

The `af tunnel` command from the original design is not needed. Remove if present.

---

## Test Scenarios

### Unit Tests

1. **Remote string parsing**
   - `user@host` → { user: 'user', host: 'host', remotePath: undefined }
   - `user@host:/path` → { user: 'user', host: 'host', remotePath: '/path' }
   - Invalid format → throws error

2. **Port lookup**
   - `architect` → architect port
   - `builder-0055` → correct builder port
   - Unknown ID → null

### Integration Tests

3. **Reverse proxy routing**
   - HTTP GET `/terminal/architect` → 200
   - HTTP GET `/terminal/unknown` → 404
   - WebSocket to `/terminal/architect` → connects

### Manual Tests

4. **End-to-end remote access**
   - Run `af start --remote user@remote-host`
   - Verify dashboard opens locally
   - Interact with architect terminal
   - Spawn builder, verify it works
   - Ctrl+C to end session

---

## Dependencies

- **New npm packages**: `http-proxy` (lightweight, no express dependency)
- **No external services required**
- **Requires SSH client on local machine** (standard on macOS/Linux)

---

## References

- [SSH Port Forwarding](https://www.ssh.com/academy/ssh/tunneling/example)
- [http-proxy docs](https://github.com/http-party/node-http-proxy)
