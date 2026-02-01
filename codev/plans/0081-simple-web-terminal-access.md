# Implementation Plan: Web Tower - Mobile Access to All Agent Farms

## Metadata
- **Spec**: [0081-simple-web-terminal-access.md](../specs/0081-simple-web-terminal-access.md)
- **Status**: planned
- **Estimated LOC**: ~500 lines new code

## Overview

Add reverse proxy to existing tower-server.ts so one port (4100) gives access to ALL projects' terminals. Then add auth, tunnel, and push notifications for remote/mobile access.

## Port Architecture (Clarification)

```
Tower:     localhost:4100    ← Meta-dashboard showing all projects
Project A: localhost:4200    ← AF dashboard (React) + all terminals via WebSocket
Project B: localhost:4300    ← AF dashboard (React) + all terminals via WebSocket
```

**TICK-001 update**: Spec 0085 replaced per-terminal ttyd ports with node-pty WebSocket multiplexing. Each project now uses a single port (basePort) for the React dashboard AND all terminal connections via `/ws/terminal/<id>`. Tower proxies everything to basePort.

Tower (4100) is separate from per-project AF dashboards (4200+). This spec adds a reverse proxy to Tower so that one tunneled port (4100) provides access to ALL projects.

## Pre-Implementation Checklist

- [ ] Read existing `tower-server.ts` (655 lines)
- [ ] Read existing `commands/tower.ts` (250 lines) - CLI entry point
- [ ] Understand existing `/api/status` response format
- [ ] Test current tower locally: `codev tower start`
- [ ] Verify global.db schema and data

## Phase 1: Reverse Proxy (~150 lines)

### Goal
Route `/project/<encoded-path>/*` to correct `localhost:basePort/*`

### Files to Modify
- `packages/codev/src/agent-farm/servers/tower-server.ts`
- `packages/codev/templates/tower.html`

### Implementation

#### 1.1 Add HTTP Proxy Handler

**IMPORTANT**: The tower server uses `http.createServer` with an async handler. To properly handle async operations like `getBasePortForProject()`, the request handler must be wrapped in an async IIFE or the server must use an async-compatible pattern:

```typescript
// Option A: Wrap handler in async IIFE
const server = http.createServer((req, res) => {
  void (async () => {
    try {
      await handleRequest(req, res);  // Main handler with await support
    } catch (err) {
      log('ERROR', `Request handler error: ${err}`);
      res.writeHead(500);
      res.end('Internal server error');
    }
  })();
});

// Option B: Use async function directly (Node.js ≥14 handles this)
const server = http.createServer(async (req, res) => {
  // Can use await directly
});
```

Insert before the 404 handler (around line 630):

```typescript
// Reverse proxy: /project/:base64urlPath/:terminalType/* → localhost:calculatedPort/*
// Uses Base64URL (RFC 4648) encoding to avoid issues with slashes in paths
//
// Terminal port routing:
//   /project/<path>/              → base_port (project dashboard)
//   /project/<path>/architect/    → base_port + 1 (architect terminal)
//   /project/<path>/builder/<n>/  → base_port + 2 + n (builder terminals)
if (url.pathname.startsWith('/project/')) {
  const pathParts = url.pathname.split('/');
  // ['', 'project', base64urlPath, terminalType, ...rest]
  const encodedPath = pathParts[2];
  const terminalType = pathParts[3];
  const rest = pathParts.slice(4);

  if (!encodedPath) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing project path');
    return;
  }

  // Decode Base64URL (RFC 4648) - NOT URL encoding
  // Wrap in try/catch to handle malformed Base64 input gracefully
  let projectPath: string;
  try {
    projectPath = Buffer.from(encodedPath, 'base64url').toString('utf-8');
    // Validate decoded path is reasonable (non-empty, looks like absolute path)
    // Support both POSIX (/) and Windows (C:\) paths
    if (!projectPath || (!projectPath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(projectPath))) {
      throw new Error('Invalid project path');
    }
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid project path encoding');
    return;
  }

  const basePort = await getBasePortForProject(projectPath);

  if (!basePort) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Project not found or not running');
    return;
  }

  // Calculate target port based on terminal type
  let targetPort = basePort;  // Default: project dashboard
  let proxyPath = rest.join('/');

  if (terminalType === 'architect') {
    targetPort = basePort + 1;  // Architect terminal
  } else if (terminalType === 'builder' && rest[0]) {
    const builderNum = parseInt(rest[0], 10);
    if (!isNaN(builderNum)) {
      targetPort = basePort + 2 + builderNum;  // Builder terminal
      proxyPath = rest.slice(1).join('/');  // Remove builder number from path
    }
  } else if (terminalType) {
    proxyPath = [terminalType, ...rest].join('/');  // Pass through other paths
  }

  // Proxy the request
  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: targetPort,
    path: '/' + proxyPath + (url.search || ''),
    method: req.method,
    headers: {
      ...req.headers,
      host: `localhost:${targetPort}`,
    },
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    log('ERROR', `Proxy error: ${err.message}`);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Proxy error: ' + err.message);
  });

  req.pipe(proxyReq);
  return;
}
```

#### 1.2 Add Helper Function

```typescript
/**
 * Get the base port for a project from global.db
 * Returns null if project not found or not running
 */
async function getBasePortForProject(projectPath: string): Promise<number | null> {
  try {
    const db = getGlobalDb();
    const row = db.prepare(
      'SELECT base_port FROM port_allocations WHERE project_path = ?'
    ).get(projectPath) as { base_port: number } | undefined;

    if (!row) return null;

    // Check if actually running
    const isRunning = await isPortListening(row.base_port);
    return isRunning ? row.base_port : null;
  } catch {
    return null;
  }
}
```

#### 1.3 Add WebSocket Proxy

Add to the server setup (after `server.listen`):

```typescript
// WebSocket upgrade handler for proxying terminal connections
// Same terminal port routing as HTTP proxy
server.on('upgrade', async (req, socket, head) => {
  const reqUrl = new URL(req.url || '/', `http://localhost:${port}`);

  if (!reqUrl.pathname.startsWith('/project/')) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const pathParts = reqUrl.pathname.split('/');
  // ['', 'project', base64urlPath, terminalType, ...rest]
  const encodedPath = pathParts[2];
  const terminalType = pathParts[3];
  const rest = pathParts.slice(4);

  if (!encodedPath) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  // Decode Base64URL (RFC 4648) - NOT URL encoding
  // Wrap in try/catch to handle malformed Base64 input gracefully
  let projectPath: string;
  try {
    projectPath = Buffer.from(encodedPath, 'base64url').toString('utf-8');
    // Support both POSIX (/) and Windows (C:\) paths
    if (!projectPath || (!projectPath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(projectPath))) {
      throw new Error('Invalid project path');
    }
  } catch (err) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const basePort = await getBasePortForProject(projectPath);

  if (!basePort) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  // Calculate target port based on terminal type (same logic as HTTP proxy)
  let targetPort = basePort;  // Default: project dashboard
  let proxyPath = rest.join('/');

  if (terminalType === 'architect') {
    targetPort = basePort + 1;  // Architect terminal
  } else if (terminalType === 'builder' && rest[0]) {
    const builderNum = parseInt(rest[0], 10);
    if (!isNaN(builderNum)) {
      targetPort = basePort + 2 + builderNum;  // Builder terminal
      proxyPath = rest.slice(1).join('/');  // Remove builder number from path
    }
  } else if (terminalType) {
    proxyPath = [terminalType, ...rest].join('/');  // Pass through other paths
  }

  // Connect to target
  const proxySocket = net.connect(targetPort, '127.0.0.1', () => {
    // Rewrite Origin header for ttyd compatibility
    const headers = { ...req.headers };
    headers.origin = 'http://localhost';
    headers.host = `localhost:${targetPort}`;

    // Forward the upgrade request
    let headerStr = `${req.method} /${proxyPath}${reqUrl.search || ''} HTTP/1.1\r\n`;
    for (const [key, value] of Object.entries(headers)) {
      if (value) headerStr += `${key}: ${value}\r\n`;
    }
    headerStr += '\r\n';

    proxySocket.write(headerStr);
    if (head.length > 0) proxySocket.write(head);

    // Pipe bidirectionally
    socket.pipe(proxySocket);
    proxySocket.pipe(socket);
  });

  proxySocket.on('error', (err) => {
    log('ERROR', `WebSocket proxy error: ${err.message}`);
    socket.destroy();
  });

  socket.on('error', () => {
    proxySocket.destroy();
  });
});
```

#### 1.4 Update Dashboard Links

In `tower.html`, change direct port links to proxy URLs:

```javascript
// Before:
const dashboardUrl = `http://localhost:${instance.dashboardPort}`;

// After:
// Use Base64URL encoding (RFC 4648) to avoid slash issues in paths
// IMPORTANT: Use TextEncoder for Unicode support (btoa only handles Latin-1)
function toBase64URL(str) {
  // Encode string to UTF-8 bytes, then to Base64, then to Base64URL
  const bytes = new TextEncoder().encode(str);
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const encodedPath = toBase64URL(instance.projectPath);
const dashboardUrl = `/project/${encodedPath}/`;
```

**Note**: `btoa()` only handles Latin-1 (throws on Unicode). We use `TextEncoder` to convert to UTF-8 bytes first, matching Node's `Buffer.from(str).toString('base64url')` behavior.

### Tests
- [ ] HTTP proxy forwards GET requests
- [ ] HTTP proxy forwards POST requests with body
- [ ] WebSocket proxy connects terminals
- [ ] Proxy returns 404 for unknown projects
- [ ] Proxy returns 404 for stopped projects
- [ ] `/project/<path>/` routes to base_port (dashboard)
- [ ] `/project/<path>/architect/` routes to base_port + 1
- [ ] `/project/<path>/builder/0/` routes to base_port + 2
- [ ] `/project/<path>/builder/5/` routes to base_port + 7
- [ ] Base64URL encoding handles unicode paths (e.g., `/path/with/日本語/`)
- [ ] Base64URL encoding handles long paths (1000+ characters)
- [ ] Invalid Base64URL decoding returns 400 Bad Request
- [ ] Proxy error handling: upstream 502, connection refused, timeout
- [ ] Invalid builder index (NaN) falls through to dashboard

---

## Phase 2: Auth Layer (~100 lines)

### Goal
Protect tower from unauthorized remote access

### Files to Modify
- `packages/codev/src/agent-farm/servers/tower-server.ts`
- `packages/codev/templates/tower.html`
- `packages/codev/src/commands/codev.ts` (add `web keygen` subcommand)

### Implementation

#### 2.1 Add Timing-Safe Auth Helper

```typescript
import crypto from 'node:crypto';

/**
 * Timing-safe comparison of auth tokens to prevent timing attacks
 */
function isValidToken(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;

  // Ensure both strings are same length for timing-safe comparison
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);

  if (providedBuf.length !== expectedBuf.length) {
    // Still do a comparison to maintain constant time
    crypto.timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }

  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}
```

#### 2.2 Add Auth Check to Request Handler

At the top of the request handler:

```typescript
// CRITICAL: When CODEV_WEB_KEY is set, ALL requests require auth
// NO localhost bypass - tunnel daemons (cloudflared) run locally and proxy
// to localhost, so checking remoteAddress would incorrectly trust remote traffic
const webKey = process.env.CODEV_WEB_KEY;

if (webKey) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');

  if (!isValidToken(token, webKey)) {
    // Return login page for HTML requests, 401 for API
    if (req.headers.accept?.includes('text/html')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getLoginPageHtml());
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
}
// When CODEV_WEB_KEY is NOT set: no auth required (local dev mode only)
```

#### 2.3 Add Auth Check to WebSocket Upgrade

```typescript
// In the upgrade handler, after parsing the URL:
// CRITICAL: When CODEV_WEB_KEY is set, ALL WebSocket upgrades require auth
// NO localhost bypass - tunnel daemons run locally, so remoteAddress is unreliable
const webKey = process.env.CODEV_WEB_KEY;

if (webKey) {
  // Check Sec-WebSocket-Protocol for auth token
  const protocols = req.headers['sec-websocket-protocol']?.split(',').map(s => s.trim()) || [];
  const authProtocol = protocols.find(p => p.startsWith('auth-'));
  const token = authProtocol?.replace('auth-', '');

  if (!isValidToken(token, webKey)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  // IMPORTANT: Strip auth-<key> protocol before forwarding to ttyd
  // Only forward 'tty' protocol to avoid confusing upstream servers
  const cleanProtocols = protocols.filter(p => !p.startsWith('auth-'));
  req.headers['sec-websocket-protocol'] = cleanProtocols.join(', ') || 'tty';
}
// When CODEV_WEB_KEY is NOT set: no auth required (local dev mode only)
```

#### 2.3 Add Login Page to Dashboard

```typescript
function getLoginPageHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Tower Login</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui; background: #1a1a2e; color: #eee;
           display: flex; justify-content: center; align-items: center;
           min-height: 100vh; margin: 0; }
    .login { background: #16213e; padding: 2rem; border-radius: 8px;
             max-width: 400px; width: 90%; }
    h1 { margin-top: 0; }
    input { width: 100%; padding: 0.75rem; margin: 0.5rem 0;
            border: 1px solid #444; border-radius: 4px;
            background: #0f0f23; color: #eee; font-size: 1rem; }
    button { width: 100%; padding: 0.75rem; margin-top: 1rem;
             background: #4a7c59; color: white; border: none;
             border-radius: 4px; font-size: 1rem; cursor: pointer; }
    button:hover { background: #5a9c69; }
  </style>
</head>
<body>
  <div class="login">
    <h1>Tower Login</h1>
    <p>Enter your API key to access Agent Farm.</p>
    <input type="password" id="key" placeholder="API Key" autofocus>
    <button onclick="login()">Login</button>
  </div>
  <script>
    function login() {
      const key = document.getElementById('key').value;
      localStorage.setItem('codev_web_key', key);
      location.reload();
    }
    document.getElementById('key').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') login();
    });
  </script>
</body>
</html>`;
}
```

**Auth Workflow Clarification**:
1. User accesses tower URL → server returns login page (HTML with form)
2. User enters API key → JavaScript saves to localStorage and calls `location.reload()`
3. Dashboard HTML is a single-page app that reads key from localStorage
4. All API calls include `Authorization: Bearer <key>` header from localStorage
5. Server validates header on each request; returns 401 if invalid
6. If 401 received, frontend clears localStorage and redirects to login

The login page is served as the "unauthenticated" version of the dashboard; after storing the key, the same HTML becomes the authenticated dashboard by including the header in all subsequent fetches.

#### 2.4 Update Dashboard to Send Auth

In `tower.html`, add auth header to fetch calls:

```javascript
const key = localStorage.getItem('codev_web_key');
const headers = key ? { 'Authorization': `Bearer ${key}` } : {};

fetch('/api/status', { headers })
  .then(r => r.json())
  .then(data => { ... });
```

For WebSocket connections:

```javascript
const key = localStorage.getItem('codev_web_key');
const protocols = key ? ['tty', `auth-${key}`] : ['tty'];
const ws = new WebSocket(url, protocols);
```

#### 2.5 Add Logout Button to Dashboard

In `tower.html`, add a logout button to the header that clears localStorage and redirects to login:

```html
<!-- Add to dashboard header -->
<button id="logout-btn" onclick="logout()" style="display: none;">Logout</button>

<script>
// Show logout button if authenticated
const key = localStorage.getItem('codev_web_key');
if (key) {
  document.getElementById('logout-btn').style.display = 'block';
}

function logout() {
  localStorage.removeItem('codev_web_key');
  // Redirect to root, which will show login page when auth required
  window.location.href = '/';
}
</script>
```

#### 2.6 Add `codev web keygen` Command

```typescript
// In codev.ts, add subcommand
program
  .command('web')
  .description('Web access management')
  .command('keygen')
  .option('--rotate', 'Rotate existing key')
  .action(async (opts) => {
    const crypto = await import('crypto');
    const key = crypto.randomBytes(32).toString('hex');

    console.log('Generated API key:');
    console.log(`  CODEV_WEB_KEY=${key}`);
    console.log('');
    console.log('Add to your shell profile or .env file.');
    if (opts.rotate) {
      console.log('Note: Old key is now invalid.');
    }
  });
```

### Tests
- [ ] When CODEV_WEB_KEY NOT set: all requests work (no auth required)
- [ ] When CODEV_WEB_KEY set: ALL requests require auth (including localhost)
- [ ] When CODEV_WEB_KEY set: requests without valid key get login page (HTML) or 401 (API)
- [ ] When CODEV_WEB_KEY set: requests with valid Bearer token succeed
- [ ] Auth middleware uses timing-safe comparison (verify via code review)
- [ ] Auth failure modes: missing token returns 401
- [ ] Auth failure modes: malformed token (non-hex chars) returns 401
- [ ] Auth failure modes: empty token returns 401
- [ ] WebSocket auth via subprotocol works
- [ ] WebSocket auth strips `auth-<key>` protocol before forwarding to ttyd
- [ ] WebSocket defaults to 'tty' protocol when only auth protocol provided
- [ ] `codev web keygen` generates valid 64-char hex key
- [ ] Logout button clears localStorage and redirects to login page

---

## Phase 3: Tunnel Integration (~100 lines)

### Goal
Expose tower via Cloudflare Tunnel (ngrok explicitly out of scope per spec)

### Files to Modify
- `packages/codev/src/agent-farm/commands/tower.ts` (CLI entry point)
- `packages/codev/src/agent-farm/servers/tower-server.ts` (server)
- New: `packages/codev/src/agent-farm/utils/tunnel.ts`

### CLI Flag Propagation Path

```
User runs: af tower --web
    ↓
packages/codev/src/agent-farm/commands/tower.ts
  → towerStart({ web: true })
    ↓
Spawns tower-server.ts with args: [port, '--web', '--log-file', LOG_FILE]
    ↓
tower-server.ts parses --web flag via Commander
  → Starts tunnel after server is listening
```

### Implementation

#### 3.1 Update CLI Entry Point

In `packages/codev/src/agent-farm/commands/tower.ts`:

```typescript
export interface TowerStartOptions {
  port?: number;
  web?: boolean;  // NEW
}

export async function towerStart(options: TowerStartOptions = {}): Promise<void> {
  const port = options.port || DEFAULT_TOWER_PORT;
  const web = options.web || false;

  // ... existing code ...

  // Build args
  const args = [tsScript, String(port), '--log-file', LOG_FILE];
  if (web) {
    args.push('--web');
  }

  // ... spawn server ...
}
```

#### 3.2 Add Tunnel Utility

```typescript
// tunnel.ts
import { spawn, ChildProcess } from 'node:child_process';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

interface TunnelConfig {
  provider: 'cloudflare';  // Only Cloudflare supported per spec
  tunnelName?: string;
  domain?: string;
}

let tunnelProcess: ChildProcess | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

export function loadTunnelConfig(): TunnelConfig | null {
  const configPath = path.join(homedir(), '.config/codev/tunnel.json');
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

export function isCloudflaredInstalled(): boolean {
  try {
    execSync('which cloudflared', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function startTunnel(port: number): Promise<string | null> {
  // Check cloudflared is installed
  if (!isCloudflaredInstalled()) {
    console.error('Error: cloudflared not installed.');
    console.error('Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/');
    return null;
  }

  const config = loadTunnelConfig();
  if (!config) {
    console.error('No tunnel configured. Run: af tunnel setup cloudflare');
    return null;
  }

  return startCloudflareTunnel(port, config);
}

async function startCloudflareTunnel(port: number, config: TunnelConfig): Promise<string | null> {
  tunnelProcess = spawn('cloudflared', [
    'tunnel', 'run',
    '--url', `http://localhost:${port}`,
    config.tunnelName || 'codev-tower'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  tunnelProcess.on('exit', (code) => {
    if (code !== 0 && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      const delay = Math.pow(2, reconnectAttempts) * 1000;  // Exponential backoff
      console.error(`Tunnel disconnected. Reconnecting in ${delay/1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
      setTimeout(() => startCloudflareTunnel(port, config), delay);
    } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error('Tunnel failed after max retries. Tower continues locally.');
    }
  });

  // Return configured domain
  return config.domain ? `https://${config.domain}` : null;
}

export function stopTunnel(): void {
  if (tunnelProcess) {
    tunnelProcess.kill();
    tunnelProcess = null;
  }
}
```

#### 3.3 Add `--web` Flag to Tower Server

In `tower-server.ts`:

```typescript
// CLI setup (already uses Commander)
const program = new Command()
  .name('tower-server')
  .argument('[port]', 'Port to listen on', String(DEFAULT_PORT))
  .option('-p, --port <port>', 'Port to listen on')
  .option('-l, --log-file <path>', 'Log file path')
  .option('-w, --web', 'Enable web access via tunnel')  // NEW
  .parse(process.argv);

// CRITICAL: --web MUST refuse to start without CODEV_WEB_KEY
// This prevents accidental public exposure without authentication
if (opts.web && !process.env.CODEV_WEB_KEY) {
  console.error('Error: --web requires CODEV_WEB_KEY to be set.');
  console.error('Generate a key with: codev web keygen');
  console.error('Then set: export CODEV_WEB_KEY=<your-key>');
  process.exit(1);
}

// After server.listen callback:
if (opts.web) {
  const { startTunnel, stopTunnel } = await import('../utils/tunnel.js');
  const publicUrl = await startTunnel(port);
  if (publicUrl) {
    log('INFO', `Web access: ${publicUrl}`);
    // Prompt user to set CODEV_PUBLIC_URL for push notifications
    if (!process.env.CODEV_PUBLIC_URL) {
      log('INFO', `For push notifications with deep links, set:`);
      log('INFO', `  export CODEV_PUBLIC_URL=${publicUrl}`);
    }
  } else {
    log('WARN', 'Tunnel failed to start. Tower running locally only.');
  }

  // Cleanup tunnel on exit
  process.on('SIGTERM', () => {
    stopTunnel();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    stopTunnel();
    process.exit(0);
  });
}
```

#### 3.4 Implement `af tunnel setup cloudflare` Wizard

**File:** New `packages/codev/src/agent-farm/commands/tunnel.ts`

```typescript
// tunnel.ts - CLI wizard for setting up Cloudflare tunnel
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import readline from 'node:readline';

const CONFIG_DIR = path.join(homedir(), '.config/codev');
const CONFIG_PATH = path.join(CONFIG_DIR, 'tunnel.json');

export async function tunnelSetup(provider: string): Promise<void> {
  if (provider !== 'cloudflare') {
    console.error('Only cloudflare provider is supported');
    process.exit(1);
  }

  // Step 1: Check cloudflared is installed
  try {
    execSync('which cloudflared', { stdio: 'ignore' });
  } catch {
    console.error('Error: cloudflared not installed.');
    console.error('Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/');
    process.exit(1);
  }

  // Step 2: Check if already logged in
  try {
    execSync('cloudflared tunnel list', { stdio: 'ignore' });
  } catch {
    console.log('You need to login to Cloudflare first.');
    console.log('Running: cloudflared login');
    execSync('cloudflared login', { stdio: 'inherit' });
  }

  // Step 3: Prompt for tunnel name
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const tunnelName = await new Promise<string>((resolve) => {
    rl.question('Tunnel name [codev-tower]: ', (answer) => {
      resolve(answer.trim() || 'codev-tower');
      rl.close();
    });
  });

  // Step 4: Check if tunnel exists or create it
  let tunnelId: string;
  try {
    const listOutput = execSync(`cloudflared tunnel list --output json`, { encoding: 'utf-8' });
    const tunnels = JSON.parse(listOutput);
    const existing = tunnels.find((t: any) => t.name === tunnelName);

    if (existing) {
      console.log(`Using existing tunnel: ${tunnelName} (${existing.id})`);
      tunnelId = existing.id;
    } else {
      console.log(`Creating tunnel: ${tunnelName}`);
      const createOutput = execSync(`cloudflared tunnel create ${tunnelName}`, { encoding: 'utf-8' });
      // Parse tunnel ID from output
      const idMatch = createOutput.match(/Created tunnel ([a-f0-9-]+)/);
      tunnelId = idMatch?.[1] || '';
      if (!tunnelId) throw new Error('Could not parse tunnel ID');
    }
  } catch (err) {
    console.error('Failed to create/list tunnels:', err);
    process.exit(1);
  }

  // Step 5: Prompt for domain (optional)
  const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
  const domain = await new Promise<string>((resolve) => {
    rl2.question('Custom domain (optional, press Enter to skip): ', (answer) => {
      resolve(answer.trim());
      rl2.close();
    });
  });

  // Step 6: Save config
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const config = {
    provider: 'cloudflare',
    tunnelName,
    tunnelId,
    domain: domain || undefined,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

  console.log('');
  console.log('✓ Tunnel configured successfully!');
  console.log(`  Config saved to: ${CONFIG_PATH}`);
  if (domain) {
    console.log(`  Public URL: https://${domain}`);
    console.log('');
    console.log('  Don\'t forget to configure DNS:');
    console.log(`    cloudflared tunnel route dns ${tunnelName} ${domain}`);
  }
  console.log('');
  console.log('Start tower with: af tower --web');
}
```

**Register in CLI** (`packages/codev/src/cli.ts` or `af` entry point):

```typescript
// NOTE: Must capture the parent command before chaining subcommands
// (Commander nested chaining requires storing the parent)
const tunnelCmd = program
  .command('tunnel')
  .description('Tunnel configuration');

tunnelCmd
  .command('setup <provider>')
  .description('Configure tunnel (only cloudflare supported)')
  .action(async (provider: string) => {
    const { tunnelSetup } = await import('./agent-farm/commands/tunnel.js');
    await tunnelSetup(provider);
  });
```

### Tests
- [ ] `--web` flag starts tunnel when CODEV_WEB_KEY is set
- [ ] `--web` flag REJECTS startup when CODEV_WEB_KEY is NOT set (exit code 1)
- [ ] Cloudflare tunnel connects successfully
- [ ] Tunnel reconnects with exponential backoff on disconnect (up to 5 retries)
- [ ] Tunnel stops on server shutdown
- [ ] Missing cloudflared shows install instructions and continues locally
- [ ] `af tunnel setup cloudflare` wizard: checks cloudflared installed
- [ ] `af tunnel setup cloudflare` wizard: prompts for login if needed
- [ ] `af tunnel setup cloudflare` wizard: creates tunnel or reuses existing
- [ ] `af tunnel setup cloudflare` wizard: saves config to ~/.config/codev/tunnel.json
- [ ] `af tunnel setup <other>` exits with error (only cloudflare supported)

---

## Phase 4: Push Notifications (~100 lines)

### Goal
Send push notification when any project hits a gate, builder is blocked, or build fails

### Notification Triggers (per spec)
1. **Gate hit** - Porch reaches human-approval gate (spec-approval, plan-approval)
2. **Builder blocked** - Porch detects BLOCKED signal in output
3. **Build error** - Porch exits with non-zero code (optional, configurable)

### Files to Modify
- New: `packages/codev/src/agent-farm/utils/notifications.ts`
- `packages/codev/src/commands/porch/run.ts` (hook into events)

### Implementation

#### 4.1 Add Notification Utility

```typescript
// notifications.ts
import path from 'node:path';

export type NotificationType = 'gate' | 'blocked' | 'error';

interface NotificationPayload {
  type: NotificationType;
  projectPath: string;
  projectId: string;
  details: string;  // Gate name, block reason, or error message
}

// Track sent notifications to avoid duplicates within short window
const recentNotifications = new Map<string, number>();
const DEDUPE_WINDOW_MS = 60000;  // 1 minute

function isDuplicate(key: string): boolean {
  const lastSent = recentNotifications.get(key);
  if (lastSent && Date.now() - lastSent < DEDUPE_WINDOW_MS) {
    return true;
  }
  recentNotifications.set(key, Date.now());
  return false;
}

export async function sendPushNotification(payload: NotificationPayload): Promise<void> {
  const pushUrl = process.env.CODEV_PUSH_URL;
  const pushToken = process.env.CODEV_PUSH_TOKEN;
  const publicUrl = process.env.CODEV_PUBLIC_URL;

  if (!pushUrl) return;

  // Skip errors if not enabled
  if (payload.type === 'error' && process.env.CODEV_PUSH_ERRORS !== 'true') {
    return;
  }

  // Dedupe by project + type + details
  const dedupeKey = `${payload.projectPath}:${payload.type}:${payload.details}`;
  if (isDuplicate(dedupeKey)) {
    return;
  }

  const projectName = path.basename(payload.projectPath);
  // Use Base64URL encoding for project path (RFC 4648) to match routing
  const encodedPath = Buffer.from(payload.projectPath).toString('base64url');
  const towerUrl = publicUrl
    ? `${publicUrl}/project/${encodedPath}/#builder-${payload.projectId}`
    : undefined;

  let title: string;
  let body: string;

  switch (payload.type) {
    case 'gate':
      title = `${projectName}: Gate ${payload.details}`;
      body = `Project ${payload.projectId} needs approval`;
      break;
    case 'blocked':
      title = `${projectName}: Builder Blocked`;
      body = `${payload.projectId}: ${payload.details}`;
      break;
    case 'error':
      title = `${projectName}: Build Failed`;
      body = `${payload.projectId}: ${payload.details}`;
      break;
  }

  try {
    await fetch(pushUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(pushToken ? { 'Authorization': `Bearer ${pushToken}` } : {}),
      },
      body: JSON.stringify({
        title,
        body,
        url: towerUrl,
      }),
    });
  } catch (err) {
    console.error('Push notification failed:', err);
  }
}
```

#### 4.2 Hook into Porch Events

**File:** `packages/codev/src/commands/porch/run.ts`

**Hook locations (exact function/line guidance):**

1. **Gate detection**: In the `parseSignal()` function (around line 200-250), when a `GATE_NEEDED` or `AWAITING_INPUT` signal is detected
2. **BLOCKED detection**: In the `handleAgentOutput()` function, when output contains `BLOCKED:` or `<signal>BLOCKED`
3. **Error exit**: In the main `run()` function's finally block, when `exitCode !== 0`

```typescript
import { sendPushNotification } from '../agent-farm/utils/notifications.js';
import { getPorchConfig } from '../config.js';

// IMPORTANT: Get canonical project path from porch config, NOT process.cwd()
// Porch runs in builder worktrees (.builders/0081/...) but notifications
// must link to the canonical project path registered in tower
function getCanonicalProjectPath(): string {
  // Porch config stores the canonical project path
  const config = getPorchConfig();
  if (config?.projectPath) {
    return config.projectPath;
  }
  // Fallback: resolve worktree path to canonical
  // Builder worktrees are at: <project>/.builders/<id>/<branch>
  const cwd = process.cwd();
  const builderMatch = cwd.match(/^(.+)\/.builders\/[^/]+\/.+$/);
  if (builderMatch) {
    return builderMatch[1];  // Return canonical project root
  }
  return cwd;  // Last resort: use cwd
}

// 1. Gate detection hook (in parseSignal function after detecting gate signal)
// Called when: signal.type === 'GATE_NEEDED' || signal.type === 'AWAITING_INPUT'
async function notifyGateHit(gateName: string, projectId: string): Promise<void> {
  await sendPushNotification({
    type: 'gate',
    projectPath: getCanonicalProjectPath(),
    projectId,
    details: gateName,
  });
}

// 2. BLOCKED signal detection (add to handleAgentOutput function)
// Pattern matching: /BLOCKED:\s*(.+)/ or /<signal>BLOCKED:\s*(.+)<\/signal>/
function extractBlockReason(output: string): string | null {
  // Match BLOCKED: <reason> or <signal>BLOCKED: <reason></signal>
  const match = output.match(/BLOCKED:\s*([^\n<]+)/);
  return match?.[1]?.trim() || null;
}

async function checkForBlockedSignal(output: string, projectId: string): Promise<void> {
  if (output.includes('BLOCKED:') || output.includes('<signal>BLOCKED')) {
    const blockReason = extractBlockReason(output);
    if (blockReason) {  // Only notify if we can parse a reason
      await sendPushNotification({
        type: 'blocked',
        projectPath: getCanonicalProjectPath(),
        projectId,
        details: blockReason,
      });
    }
  }
}

// 3. Error exit notification (add to run() finally block)
// exitCode !== 0 && exitCode !== EXIT_AWAITING_INPUT (don't notify for normal gate waits)
async function notifyBuildError(exitCode: number, projectId: string): Promise<void> {
  if (exitCode !== 0 && exitCode !== EXIT_AWAITING_INPUT) {
    await sendPushNotification({
      type: 'error',
      projectPath: getCanonicalProjectPath(),
      projectId,
      details: `Exit code ${exitCode}`,
    });
  }
}
```

**Integration points in `run.ts`:**
- Line ~250 (after `parseSignal`): Call `notifyGateHit()` when gate detected
- Line ~180 (in `handleAgentOutput`): Call `checkForBlockedSignal()` on each output chunk
- Line ~350 (in `finally` block): Call `notifyBuildError()` before exiting

**Note on canonical project paths and `projectId`**:
- Porch often runs in builder worktrees (`.builders/0081/...`), but notification deep links must use the **canonical project path** registered in tower.
- The `getCanonicalProjectPath()` helper resolves worktree paths to canonical paths by:
  1. Checking porch config for explicit `projectPath`
  2. Detecting `.builders/<id>/<branch>` pattern and extracting the parent directory
  3. Falling back to `process.cwd()` only if neither applies
- `projectId` is the 4-digit ID passed to `porch run` (e.g., `porch run 0081`). In `run.ts`, this is available as `args.projectId` (parsed from CLI args).

### Tests
- [ ] Notification sends on gate hit (GATE_NEEDED signal)
- [ ] Notification sends on BLOCKED signal with parsed reason
- [ ] Notification sends on build error (when CODEV_PUSH_ERRORS=true)
- [ ] Notification NOT sent on build error (when CODEV_PUSH_ERRORS unset)
- [ ] Duplicate notifications within 1 minute are suppressed (dedupe timing)
- [ ] Dedupe key is project+type+details (not just project)
- [ ] Missing CODEV_PUSH_URL silently skips all notifications
- [ ] Notification URL uses Base64URL encoding for project path
- [ ] extractBlockReason correctly parses `BLOCKED: <reason>` format
- [ ] extractBlockReason handles `<signal>BLOCKED: <reason></signal>` format
- [ ] BLOCKED without parseable reason does NOT send notification (avoids false positives)

---

## Phase 5: Mobile Polish (~50 lines)

### Goal
Make tower.html work well on mobile, including gate-pending indicators

### Files to Modify
- `packages/codev/templates/tower.html`
- `packages/codev/src/agent-farm/servers/tower-server.ts` (extend `/api/status` response)

### Implementation

#### 5.1 Extend `/api/status` to Include Gate Status

**Modify** the existing `/api/status` endpoint in `tower-server.ts` to include gate information:

```typescript
// In GET /api/status handler
interface ProjectStatus {
  projectPath: string;
  basePort: number;
  running: boolean;
  // NEW: gate status from project's dashboard API
  gateStatus?: {
    hasGate: boolean;       // Is there a pending gate?
    gateName?: string;      // e.g., "spec-approval", "plan-approval"
    builderId?: string;     // Which builder is at the gate
    timestamp?: number;     // When gate was hit
  };
}

// Gate status is obtained by proxying to each project's dashboard API
// The per-project dashboard already exposes builder status including gates
//
// TIMEOUT/RESILIENCE: Use AbortController with 2-second timeout per project
// to prevent one hung project from stalling the entire tower status response.
// Fetch all projects in parallel with Promise.allSettled().
async function getGateStatusForProject(basePort: number): Promise<ProjectStatus['gateStatus']> {
  // Option A: Query project's dashboard API (PREFERRED - works with existing infrastructure)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);  // 2-second timeout

  try {
    const response = await fetch(`http://localhost:${basePort}/api/status`, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!response.ok) return { hasGate: false };

    const projectStatus = await response.json();
    // Check if any builder has a pending gate
    const builderWithGate = projectStatus.builders?.find(
      (b: any) => b.gateStatus?.waiting || b.status === 'gate-pending'
    );

    if (builderWithGate) {
      return {
        hasGate: true,
        gateName: builderWithGate.gateStatus?.gateName || builderWithGate.currentGate,
        builderId: builderWithGate.id,
        timestamp: builderWithGate.gateStatus?.timestamp || Date.now(),
      };
    }
  } catch {
    // Project dashboard not responding
  }
  return { hasGate: false };
}

// Alternative: If performance is a concern, check .af/session.json or porch state
// But the dashboard API is the authoritative source for builder status
```

**Data Source Hierarchy**:
1. **Primary**: Per-project dashboard `/api/status` endpoint (already exists, authoritative)
2. **Fallback**: `.af/session.json` in project directory (if dashboard unreachable)
3. **Not used**: `.porch/state.json` (this file doesn't exist in current Porch implementation)

**Performance Note**: Tower already polls project dashboards for status. Gate status can be included in the same poll without extra requests.

#### 5.2 Add Mobile CSS

```css
/* Mobile-first responsive design */
@media (max-width: 768px) {
  .project-card {
    margin: 0.5rem;
    padding: 1rem;
  }

  .project-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .terminal-btn {
    width: 100%;
    padding: 1rem;
    margin: 0.25rem 0;
    font-size: 1rem;
  }

  .status-indicator {
    font-size: 0.9rem;
  }
}

/* Gate pending animation */
.gate-pending {
  background: linear-gradient(90deg, #4a4a00, #6a6a00);
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}
```

#### 5.3 Add Touch-Friendly Buttons with Gate Indicators

```html
<!-- Project card with gate status -->
<div class="project-card ${instance.gateStatus?.hasGate ? 'gate-pending' : ''}">
  <div class="project-header">
    <span class="project-name">${instance.projectPath.split('/').pop()}</span>
    <span class="status ${instance.running ? 'running' : 'stopped'}">
      ${instance.running ? '● running' : '○ stopped'}
    </span>
  </div>

  <!-- Gate indicator if pending -->
  ${instance.gateStatus?.hasGate ? `
    <div class="gate-indicator">
      ⏳ Gate: ${instance.gateStatus.gateName}
      <span class="gate-builder">(${instance.gateStatus.builderId})</span>
    </div>
  ` : ''}

  <div class="terminals">
    <button class="terminal-btn"
            onclick="openTerminal('${encodedPath}')"
            style="touch-action: manipulation;">
      ${instance.projectName}
    </button>
  </div>
</div>
```

```css
/* Gate indicator styling */
.gate-indicator {
  padding: 0.5rem;
  margin: 0.25rem 0;
  background: rgba(255, 200, 0, 0.2);
  border-radius: 4px;
  font-size: 0.9rem;
}

.gate-builder {
  color: #888;
  font-size: 0.8rem;
}
```

#### 5.4 Add Dashboard JavaScript for Gate Polling

```javascript
// Poll /api/status every 10 seconds to update gate indicators
setInterval(async () => {
  try {
    const key = localStorage.getItem('codev_web_key');
    const headers = key ? { 'Authorization': `Bearer ${key}` } : {};
    const response = await fetch('/api/status', { headers });
    const projects = await response.json();
    updateGateIndicators(projects);
  } catch (err) {
    console.error('Failed to poll status:', err);
  }
}, 10000);

function updateGateIndicators(projects) {
  projects.forEach(project => {
    const card = document.querySelector(`[data-project="${project.projectPath}"]`);
    if (!card) return;

    // Toggle gate-pending class
    if (project.gateStatus?.hasGate) {
      card.classList.add('gate-pending');
      // Update or insert gate indicator
      let indicator = card.querySelector('.gate-indicator');
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'gate-indicator';
        card.querySelector('.project-header').after(indicator);
      }
      indicator.innerHTML = `⏳ Gate: ${project.gateStatus.gateName} <span class="gate-builder">(${project.gateStatus.builderId})</span>`;
    } else {
      card.classList.remove('gate-pending');
      card.querySelector('.gate-indicator')?.remove();
    }
  });
}
```

### Tests
- [ ] Dashboard readable on iPhone SE (375px)
- [ ] Buttons tappable without zoom
- [ ] Gate pending visible and animated
- [ ] Gate indicator shows correct gate name and builder ID
- [ ] Gate indicator auto-updates via polling
- [ ] Gate indicator removed when gate is cleared

---

## Rollout Plan

1. **Phase 1** (Proxy) - Can merge independently, no breaking changes
2. **Phase 2** (Auth) - Can merge independently, opt-in via CODEV_WEB_KEY
3. **Phase 3** (Tunnel) - Can merge independently, opt-in via --web
4. **Phase 4** (Notifications) - Can merge independently, opt-in via CODEV_PUSH_URL
5. **Phase 5** (Mobile) - Can merge independently, no breaking changes

Each phase is independently valuable and can be released separately.

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Proxy breaks existing tower | Feature flag, don't change existing routes |
| Auth locks users out | Without CODEV_WEB_KEY, no auth required (local dev mode) |
| Tunnel exposed without auth | `--web` flag refuses to start without CODEV_WEB_KEY |
| Tunnel fails to start | Clear error message, tower still works locally |
| Tunnel disconnects | Exponential backoff reconnection (max 5 retries) |
| WebSocket proxy drops connections | Proper error handling, reconnect logic in client |
| cloudflared not installed | Helpful error message with install link |

## End-to-End Remote Access Test (Mandatory)

This test validates the complete remote access workflow as specified in the spec's "Testing Requirements" section.

**Prerequisites:**
1. Cloudflare tunnel configured (`af tunnel setup cloudflare`)
2. `CODEV_WEB_KEY` environment variable set
3. `CODEV_PUSH_URL` configured (e.g., `https://ntfy.sh/my-topic`)
4. At least one project registered with tower

**Test Steps:**
1. **Start tower**: `af tower --web` (with CODEV_WEB_KEY set)
2. **Verify tunnel connects**: Output shows public URL (e.g., `Web access: https://myagents.example.com`)
3. **Access from external device**: Open public URL on phone/tablet (NOT localhost)
4. **Login**: Enter API key on login page
5. **View dashboard**: Verify projects are listed with correct status
6. **Open terminal**: Tap a terminal button → verify WebSocket connection via proxy
7. **Interact with terminal**: Type commands → verify response
8. **Trigger gate**: In project, run porch command that triggers a gate
9. **Verify notification**: Push notification received on phone within 5 seconds
10. **Verify deep link**: Tap notification → opens correct project terminal
11. **Stop tower**: Ctrl+C → verify tunnel stops cleanly (no orphan processes)

**Expected Results:**
- All 11 steps complete without errors
- Terminal interaction is responsive (< 200ms latency)
- Notifications arrive within 5 seconds of gate trigger
- Deep links open correct terminal

## Definition of Done

- [ ] All phases implemented and tested
- [ ] End-to-end remote access test passes (above)
- [ ] Manual testing on real mobile device (iPhone/Android)
- [ ] Documentation updated (CLAUDE.md commands section)
- [ ] No regressions in existing tower functionality
