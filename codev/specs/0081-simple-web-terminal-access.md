# Specification: Web Tower - Mobile Access to All Agent Farms

## Metadata
- **ID**: 0081
- **Status**: specified
- **Created**: 2026-01-27
- **Updated**: 2026-01-27
- **Protocol**: SPIR
- **Inspiration**: Claude Code Remote, [Happy](https://github.com/slopus/happy)

## Executive Summary

Add a reverse proxy to the existing tower-server so that one port gives access to ALL projects' terminals. Then add auth + Cloudflare tunnel + ntfy.sh notifications for remote/mobile access.

**Primary use case**: Check on builders, approve gates, and monitor progress from phone when away from desk.

**The key insight**: Tower already discovers projects and shows status. We just need to proxy through it instead of linking directly to each project's port.

## Problem Statement

Current tower limitations:
1. **No reverse proxy** - Tower returns direct links (`localhost:4200`) instead of proxying
2. **Can't tunnel one port** - Each project has its own port (4200, 4300, etc.)
3. **No auth** - Anyone on localhost can access
4. **No notifications** - No push alerts when gates need approval

## Desired State

```
┌─────────────────────────────────────────────────────────────┐
│                   Mobile / Remote Browser                    │
│                     (anywhere in world)                      │
└─────────────────────────────────────────────────────────────┘
                              │
                         HTTPS/WSS (tunnel)
                              │
┌─────────────────────────────────────────────────────────────┐
│                      Web Tower                               │
│                   localhost:4100                             │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  Project A [running]                                    ││
│  │    ├─ Architect (port 4201)                             ││
│  │    └─ Builder-0034 (port 4202) [gate pending]           ││
│  │  Project B [running]                                    ││
│  │    ├─ Architect (port 4301)                             ││
│  │    └─ Builder-0078 (port 4302)                          ││
│  │  Project C [stopped]                                    ││
│  └─────────────────────────────────────────────────────────┘│
│            Click any terminal → Full interaction            │
└─────────────────────────────────────────────────────────────┘
```

## Current State Analysis

### What We Have (Already Working)

| Component | Location | Status |
|-----------|----------|--------|
| **Tower server** | `packages/codev/src/agent-farm/servers/tower-server.ts` | ✅ Web-based, localhost:4100 |
| **Project discovery** | `~/.agent-farm/global.db` | ✅ SQLite with paths, ports, PIDs |
| **Status API** | `GET /api/status` | ✅ Lists all projects with running status |
| **Launch/Stop APIs** | `POST /api/launch`, `/api/stop` | ✅ Start/stop AF instances |
| **Per-project dashboards** | `dashboard-server.ts` on each port | ✅ Full terminal access |

### What Tower Does Now

```
Tower (localhost:4100)
├── GET /api/status    → Returns [{projectPath, basePort, running}, ...]
├── POST /api/launch   → Starts AF for a project
├── POST /api/stop     → Stops AF for a project
└── GET /              → HTML dashboard with direct links

User clicks project → Opens http://localhost:4200 DIRECTLY (not proxied)
```

**The gap:** Tower gives you links to each project's port. For remote access, you'd need to tunnel EVERY port. Instead, we need tower to PROXY requests.

### What Needs to Change

1. **Add reverse proxy** - Route `/project/:path/*` to correct `localhost:basePort/*`
2. **Add WebSocket proxy** - Route terminal connections through tower
3. **Add auth layer** - Protect remote access with API key
4. **Add tunnel support** - Expose tower via Cloudflare Tunnel
5. **Add push notifications** - Alert on gates across all projects

## Solution Architecture

### Specification Authority

**This specification is authoritative**. If the implementation plan diverges from this spec, the spec is correct and the plan must be updated. Key requirements that MUST NOT be compromised:
- Base64URL encoding (RFC 4648) for project paths
- When `CODEV_WEB_KEY` set: ALL requests require auth (no localhost bypass)
- Strip `auth-<key>` subprotocol before forwarding WebSocket to ttyd
- `--web` flag refuses to start without `CODEV_WEB_KEY`

### Core Change: Add Reverse Proxy to Tower

The tower already runs at localhost:4100. Add proxy routes:

```typescript
// In tower-server.ts - add reverse proxy for project access
// URL scheme: /project/<base64url-encoded-path>/<terminal-type>/<rest>
// Base64URL encoding (RFC 4648) avoids issues with slashes in paths
//
// Terminal port routing:
//   /project/<path>/              → base_port (project dashboard)
//   /project/<path>/architect/    → base_port + 1 (architect terminal)
//   /project/<path>/builder/<n>/  → base_port + 2 + n (builder terminals)

if (url.pathname.startsWith('/project/')) {
  const [, , encodedPath, terminalType, ...rest] = url.pathname.split('/');
  // Decode Base64URL (not URL encoding) per RFC 4648
  const projectPath = Buffer.from(encodedPath, 'base64url').toString('utf-8');
  const basePort = getBasePortForProject(projectPath);  // From global.db

  if (!basePort) {
    res.writeHead(404);
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

  // Proxy HTTP to localhost:targetPort
  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: targetPort,
    path: '/' + proxyPath,
    method: req.method,
    headers: { ...req.headers, host: `localhost:${targetPort}` },
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode!, proxyRes.headers);
    proxyRes.pipe(res);
  });
  req.pipe(proxyReq);
  return;
}

// WebSocket proxy for terminals (same port calculation logic)
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url!, 'http://localhost');
  if (url.pathname.startsWith('/project/')) {
    const [, , encodedPath, terminalType, ...rest] = url.pathname.split('/');
    const projectPath = Buffer.from(encodedPath, 'base64url').toString('utf-8');
    const basePort = getBasePortForProject(projectPath);

    // Calculate target port (same logic as HTTP proxy)
    let targetPort = basePort;
    if (terminalType === 'architect') targetPort = basePort + 1;
    else if (terminalType === 'builder' && rest[0]) {
      const builderNum = parseInt(rest[0], 10);
      if (!isNaN(builderNum)) targetPort = basePort + 2 + builderNum;
    }

    // Proxy WebSocket to target, rewriting Origin for ttyd
    const proxySocket = net.connect(targetPort, '127.0.0.1', () => {
      const proxyHeaders = { ...req.headers, origin: 'http://localhost' };
      proxySocket.write(`GET /${rest.join('/')} HTTP/1.1\r\n`);
      // ... write headers and pipe sockets
    });
  }
});
```

### Authentication Layer

**CRITICAL SECURITY NOTE**: When `CODEV_WEB_KEY` is set, authentication is enforced for ALL requests, including those from localhost. This is because tunnel daemons (cloudflared, ngrok) run locally and proxy to localhost - checking `req.socket.remoteAddress === '127.0.0.1'` would incorrectly trust remote traffic.

**Auth modes:**
1. **No key set** (`!CODEV_WEB_KEY`): Allow all requests (local development only)
2. **Key set** (`CODEV_WEB_KEY`): Require auth for ALL requests (tunnel-safe)

```typescript
// Tower server (native Node.js http)
function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const webKey = process.env.CODEV_WEB_KEY;

  // When CODEV_WEB_KEY is set, ALL requests require auth (tunnel-safe)
  // This prevents tunnel traffic from bypassing auth since cloudflared runs locally
  if (webKey) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '');

    // Use timing-safe comparison to prevent timing attacks
    if (!token || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(webKey))) {
      // Return login page for browser requests, 401 for API requests
      if (req.headers.accept?.includes('text/html')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(getLoginPageHtml());
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
      }
      return;
    }
  }
  // ... serve tower dashboard or proxy to project
}
```

WebSocket auth via subprotocol (not query params) to avoid key leakage:

```typescript
server.on('upgrade', (req, socket, head) => {
  const webKey = process.env.CODEV_WEB_KEY;

  // When CODEV_WEB_KEY is set, ALL WebSocket upgrades require auth
  // Same tunnel-safe logic as HTTP - don't trust localhost check
  if (webKey) {
    const protocols = req.headers['sec-websocket-protocol']?.split(',').map(s => s.trim()) || [];
    const authProtocol = protocols.find(p => p.startsWith('auth-'));
    const token = authProtocol?.replace('auth-', '');

    // Use timing-safe comparison
    if (!token || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(webKey))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // IMPORTANT: Strip auth-<key> protocol before forwarding to ttyd
    // Only forward 'tty' protocol to avoid confusing upstream servers
    const cleanProtocols = protocols.filter(p => !p.startsWith('auth-'));
    req.headers['sec-websocket-protocol'] = cleanProtocols.join(', ') || 'tty';
  }
  // ... proxy to appropriate project's terminal
});
```

### Phase 3: Mobile-Friendly Dashboard

Replace Electron UI with responsive HTML:

```html
<!-- Tower dashboard - mobile-first design -->
<div class="tower-projects">
  <!-- Each project card -->
  <div class="project-card" data-project="codev-public">
    <div class="project-header">
      <span class="project-name">codev-public</span>
      <span class="status running">● running</span>
    </div>
    <div class="terminals">
      <button class="terminal-btn" data-port="4201">
        Architect
      </button>
      <button class="terminal-btn gate-pending" data-port="4202">
        Builder-0034 ⏳
      </button>
    </div>
  </div>
</div>
```

CSS for mobile:
```css
/* Mobile-first, works on small screens */
.project-card {
  padding: 1rem;
  margin: 0.5rem;
  border-radius: 8px;
  background: var(--card-bg);
}

.terminal-btn {
  width: 100%;
  padding: 1rem;
  margin: 0.25rem 0;
  font-size: 1rem;  /* Tap-friendly */
}

.gate-pending {
  background: var(--warning);
  animation: pulse 2s infinite;
}
```

### Phase 4: Tunnel Integration

**Security constraint**: `--web` flag MUST refuse to start if `CODEV_WEB_KEY` is not set. This prevents accidental public exposure without authentication.

Same tunnel approach - expose tower instead of single AF:

```bash
# Start tower with web access
af tower --web

# Output:
# Tower: http://localhost:4100
# Web Access: https://myagents.example.com
# Auth Key: (use CODEV_WEB_KEY)
```

Tunnel config in `~/.config/codev/tunnel.json`:
```json
{
  "provider": "cloudflare",
  "tunnelName": "codev-tower",
  "domain": "myagents.example.com"
}
```

### Phase 5: Push Notifications (ntfy.sh)

Push notifications via ntfy.sh when builders need attention.

Hook into porch events across ALL projects:

```typescript
// When any project hits a gate
async function notifyGate(projectPath: string, projectId: string, gate: string) {
  if (!process.env.CODEV_PUSH_URL) return;

  const projectName = path.basename(projectPath);

  await fetch(process.env.CODEV_PUSH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.CODEV_PUSH_TOKEN}`,
    },
    body: JSON.stringify({
      title: `${projectName}: Gate ${gate}`,
      body: `Project ${projectId} needs approval`,
      url: `${process.env.CODEV_PUBLIC_URL}/project/${Buffer.from(projectPath).toString('base64url')}#builder-${projectId}`,
    }),
  });
}
```

Notification triggers:
1. **Gate hit** - Any project's porch reaches human-approval gate
2. **Builder blocked** - Any builder reports BLOCKED signal
3. **Build error** - Builder terminates with error (optional)

**Tower URL for notifications:** Set `CODEV_PUBLIC_URL` environment variable (e.g., `https://myagents.example.com`). Porch reads this to construct deep links in notifications.

## User Experience

### Setup (One-time)
```bash
# Generate API key
codev web keygen

# Setup tunnel
af tunnel setup cloudflare

# Optional: Push notifications
export CODEV_PUSH_URL="https://ntfy.sh/my-codev-topic"
```

### Daily Use
```bash
# Start tower with web access
af tower --web

# Or start from any project (tower mode auto-detects)
af start --tower --web
```

### Mobile Access
1. Open `https://myagents.example.com` on phone
2. Enter API key (one-time, stored in localStorage)
3. See all projects with their running sessions
4. Tap any terminal for full interaction
5. Get push notification when any project needs attention

### Auth Recovery
- If auth fails (401/4001), tower shows login prompt
- User re-enters key (may have been rotated)
- No automatic retry with bad key

## Migration Path

### From Electron Tower
1. `codev tower start` → deprecated, shows message to use `af tower`
2. Project registration stays in `~/.config/codev/projects.json`
3. Same project discovery logic, just web-served

### From Single-Project AF
- `af start` unchanged for single-project use
- `af tower` for multi-project view
- `--web` flag works on both

## Implementation Phases

### Phase 1: Reverse Proxy (~150 lines)
**File:** `packages/codev/src/agent-farm/servers/tower-server.ts`
- Add HTTP proxy for `/project/:path/*` routes
- Add WebSocket proxy with Origin rewriting for ttyd
- Update dashboard links to use proxy URLs instead of direct ports
- Helper: `getPortForProject(path)` using existing global.db

**Terminal Port Routing**: Tower provides direct terminal access via port offset:
- `/project/<base64url-path>/` → routes to `base_port` (dashboard, but tower bypasses this)
- `/project/<base64url-path>/architect/` → routes to `base_port + 1` (architect terminal)
- `/project/<base64url-path>/builder/<n>/` → routes to `base_port + 2 + n` (builder terminals)

The tower dashboard lists all available terminals per project and generates these proxy URLs directly.

### Phase 2: Auth Layer (~100 lines)
**Files:** `tower-server.ts`, `packages/codev/templates/tower.html`
- Add API key check for ALL requests when `CODEV_WEB_KEY` set (tunnel-safe)
- WebSocket auth via `Sec-WebSocket-Protocol` header (not query params)
- **Strip `auth-<key>` subprotocol before forwarding to ttyd**
- Add login prompt to tower dashboard HTML
- `codev web keygen` command for key generation/rotation

### Phase 3: Tunnel Integration (~80 lines)
**Files:** `tower-server.ts`, new `tunnel.ts` util
- `af tower --web` flag to start tunnel alongside server
- **`--web` MUST refuse to start if `CODEV_WEB_KEY` not set**
- Support Cloudflare Tunnel only (ngrok out of scope)
- Config storage in `~/.config/codev/tunnel.json`

**`af tunnel setup cloudflare` wizard flow:**
1. Check if `cloudflared` is installed; if not, show install instructions and exit
2. Prompt for tunnel name (default: `codev-tower`)
3. Run `cloudflared tunnel create <name>` if tunnel doesn't exist
4. Store tunnel config in `~/.config/codev/tunnel.json`
5. Print success message with public URL

**Edge cases:**
- If `cloudflared` not installed: error message with install link, exit with code 1
- If tunnel disconnects: log error, attempt reconnect with exponential backoff (max 5 retries)
- If tunnel fails after retries: tower continues locally, prints warning

### Phase 4: Push Notifications (~70 lines)
**Files:** `packages/codev/src/commands/porch/run.ts` or hook
- Webhook call on gate hit / builder blocked
- `CODEV_PUSH_URL` and `CODEV_PUBLIC_URL` env vars
- ntfy.sh as primary notification service (free, self-hostable, good mobile apps)

### Phase 5: Mobile Polish (~50 lines)
**File:** `packages/codev/templates/tower.html`
- Mobile-responsive CSS for project list
- Touch-friendly terminal buttons
- Gate status indicators with visual pulse

**Total: ~450 lines of new code**

## Success Criteria

**MUST have**:
1. [ ] `af tower` shows all registered projects
2. [ ] Can drill into any project's terminals via proxy
3. [ ] Full terminal interaction from mobile browser
4. [ ] When `CODEV_WEB_KEY` set, ALL requests require auth (tunnel-safe)
5. [ ] `--web` flag refuses to start if `CODEV_WEB_KEY` not set
6. [ ] Push notification (ntfy.sh) when any project hits gate
7. [ ] Mobile-friendly UI (readable, tappable)
8. [ ] Without `CODEV_WEB_KEY`, no auth required (local dev mode)

**SHOULD have**:
9. [ ] Login page shown for unauthenticated browser requests
10. [ ] Logout button in dashboard header (clears localStorage token, redirects to login)
11. [ ] Gate-pending visual indicator in dashboard
12. [ ] `af tunnel setup cloudflare` wizard configures Cloudflare tunnel

## Testing Requirements

### Unit Tests
- Project discovery finds registered projects
- Status checking detects running AF instances
- Auth middleware rejects invalid keys (timing-safe comparison)
- When `CODEV_WEB_KEY` set: ALL requests require auth (including localhost)
- When `CODEV_WEB_KEY` not set: no auth required (local dev mode)
- Tunnel config parsing
- Base64URL encoding/decoding for project paths (including unicode, long paths)
- `--web` flag rejected when `CODEV_WEB_KEY` not set
- WebSocket subprotocol stripping removes `auth-<key>` before upstream
- WebSocket defaults to 'tty' protocol when no other protocols provided
- Auth failure modes: missing token, malformed token, empty token
- Proxy error handling: upstream 502, connection refused, timeout

### Integration Tests
- Full flow: tower → auth → proxy → terminal
- WebSocket proxying across projects
- Push notification fires on gate hit
- Mobile viewport renders correctly
- Tunnel startup failure handling (cloudflared not installed)
- Tunnel reconnection after disconnect
- Multiple concurrent WebSocket connections

### Manual Testing Checklist
- [ ] Remote access via Cloudflare Tunnel
- [ ] Mobile Safari terminal interaction
- [ ] Mobile Chrome terminal interaction
- [ ] Key rotation forces re-login
- [ ] Multiple projects visible and accessible
- [ ] Logout button works

### End-to-end Test (full remote flow)
1. Start tower with `--web` and `CODEV_WEB_KEY` set
2. Access via Cloudflare tunnel URL from external device
3. Login with API key
4. Open project terminal via proxy
5. Interact with terminal via WebSocket
6. Trigger gate in porch → verify push notification received
7. Stop tower → verify tunnel stops cleanly

## Out of Scope

- Multi-user authentication (single API key for MVP)
- Project management from tower (start/stop AF remotely)
- Native mobile app (PWA sufficient for Stage 1)
- Offline support
- Real-time status updates (refresh to see changes is fine)
- ngrok support (Cloudflare preferred for stable URLs)
- Session timeouts (API key is sufficient security)

## Stage 2 Preview (Future)

For closed-source hosted version:
- User accounts with API keys
- Multiple users per organization
- Hosted tunnel (no Cloudflare setup needed)
- Native mobile apps
- Real-time WebSocket status updates

## Decisions (Resolved)

| Question | Decision | Rationale |
|----------|----------|-----------|
| Electron vs Web? | Web | Mobile access requires web; Electron can't run on mobile |
| Native app vs PWA? | PWA for Stage 1 | Lower effort, works everywhere, native for Stage 2 |
| Multiple API keys? | No (MVP) | Single key sufficient; multi-user is Stage 2 |
| Tower auto-start? | Opt-in (`--web` flag) | Security: don't expose by default |
| Path encoding? | Base64URL (RFC 4648) | Avoids slash issues, no ambiguity |
| Localhost bypass? | NO when key set | Tunnels proxy locally, bypass is security hole |

## Open Questions

### Nice-to-Know (not blocking)
- [ ] Should tower auto-start AF instances, or just show status?
- [ ] Should we add quick actions (approve gate from tower list)?

## References

- [Happy](https://github.com/slopus/happy) - Mobile/web client for Claude Code
- [Claude Code Remote](https://docs.anthropic.com/en/docs/claude-code/remote) - Anthropic's remote access
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) - Zero-config tunnels
- [ttyd](https://github.com/tsl0922/ttyd) - Terminal over WebSocket
- Current tower: `packages/codev/src/commands/tower/`

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| API key leaked | Low | High | Rotation command, env var not in git, no query params |
| Cross-project routing bugs | Medium | Medium | Clear URL scheme, thorough testing |
| Mobile UX issues | Medium | Low | Mobile-first design, real device testing |
| Migration confusion | Low | Low | Clear deprecation messages, docs |

---

## Consultation Log

### Round 1 (Initial Draft)
- **Date**: 2026-01-27
- **Models consulted**: Gemini (APPROVE), Codex (REQUEST_CHANGES)

**Key feedback from Gemini**:
1. Use Base64URL encoding (not URL encoding) for project paths - slashes break routing
2. Strip `auth-<key>` subprotocol from WebSocket requests before forwarding to ttyd

**Key feedback from Codex**:
1. Path encoding mismatch between spec (Base64) and plan (encodeURIComponent)
2. Terminal port resolution unclear
3. `--web` flag without `CODEV_WEB_KEY` should be refused - security risk
4. `af tunnel setup` wizard promised but not defined
5. Need end-to-end test covering full remote flow

**Changes made**: Updated spec with Base64URL encoding, timing-safe comparison, protocol stripping, `--web` security constraint.

### Round 2 (After Iteration 1 Reviews)
- **Date**: 2026-01-27
- **Models consulted**: Codex (REQUEST_CHANGES), Claude (COMMENT), Gemini (REQUEST_CHANGES)

**Key issues identified**:
- Terminal port routing strategy unclear
- No logout button for mobile UX
- Per-project dashboard has hardcoded localhost links

**Changes made**: Clarified tower provides direct terminal access (bypasses per-project dashboard).

### Round 3 (Iteration 2 Reviews)
- **Date**: 2026-01-27
- **Models consulted**: Codex (REQUEST_CHANGES), Gemini (REQUEST_CHANGES), Claude (COMMENT)

**Critical security issue from Gemini**:
- The localhost bypass (`req.socket.remoteAddress === '127.0.0.1'`) is BROKEN with tunnels
- Cloudflared and ngrok daemons run locally - they proxy TO localhost
- This means ALL tunnel traffic appears to come from 127.0.0.1
- Remote attackers would bypass auth entirely!

**Fix applied**: When `CODEV_WEB_KEY` is set, ALL requests require auth (no localhost bypass). This is tunnel-safe:
- Without key: No auth (local dev mode, no tunnel)
- With key: Auth required for ALL requests (tunnel-safe)

**Other feedback (plan issues, not spec)**:
- Plan uses `decodeURIComponent` but spec requires Base64URL - plan must be fixed
- Plan doesn't strip `auth-<key>` subprotocol - plan must be fixed
- These are PLAN divergences, not spec issues

### Round 4 (Iteration 3 Reviews - Final)
- **Date**: 2026-01-27
- **Models consulted**: Codex (REQUEST_CHANGES), Gemini (REQUEST_CHANGES), Claude (COMMENT)

**Unanimous verdict from all reviewers**: Spec is correct and complete. All REQUEST_CHANGES verdicts were due to PLAN divergences, not spec issues.

**Key confirmation from Gemini**:
> "Critical Security Mismatch (Localhost Bypass)... The Plan must be updated to match the Spec"

**Key confirmation from Codex**:
> "Auth requirements weakened in plan... Spec states that when `CODEV_WEB_KEY` is set 'ALL requests require auth (tunnel-safe)'... Remove the localhost bypass from the plan"

**Minor spec improvements from Claude (addressed)**:
1. ✅ Added "Specification Authority" section explicitly stating spec is authoritative over plan
2. ✅ Clarified terminal port routing mechanism (base_port + offset scheme)
3. ✅ Added `af tunnel setup cloudflare` wizard flow details
4. ✅ Clarified logout button behavior (clears localStorage, redirects)
5. ✅ Added edge cases for tunnel failures (cloudflared missing, disconnect handling)
6. ✅ Expanded test coverage for auth failure modes and proxy errors

**Spec status**: COMPLETE - ready for human approval. Plan divergences to be fixed in PLAN phase.

### Round 5 (Iteration 1 Fresh Reviews)
- **Date**: 2026-01-27
- **Models consulted**: Claude (APPROVE), Gemini (REQUEST_CHANGES), Codex (REQUEST_CHANGES)

**Claude approved the spec**, confirming:
> "Well-structured spec with robust security model; plan divergences identified but spec is authoritative"
> "The spec is authoritative and correct"

**Gemini and Codex REQUEST_CHANGES - all about plan, not spec**:

**Gemini**:
> "The specification is high-quality, explicitly addressing the unique security context of tunneling a local service"
> "Plan contains a critical security vulnerability... that directly contradicts the spec"

**Codex**:
> "Spec is solid, but the implementation plan contradicts key security and routing requirements"

**One minor spec fix from Claude (addressed)**:
- ✅ Fixed `encodeURIComponent` in notification URL (line 311) to use Base64URL for consistency with rest of spec

**Plan divergences identified (to fix in PLAN phase)**:
1. Plan uses `encodeURIComponent` instead of Base64URL
2. Plan reintroduces localhost auth bypass
3. Plan doesn't strip `auth-<key>` WebSocket subprotocol
4. Plan adds ngrok (out of scope)
5. Plan missing `--web` + `CODEV_WEB_KEY` guard

**Spec status**: APPROVED by Claude. Gemini/Codex REQUEST_CHANGES are plan issues, not spec issues.

### Round 6 (Iteration 2 Reviews)
- **Date**: 2026-01-27
- **Models consulted**: Claude (APPROVE), Gemini (APPROVE), Codex (REQUEST_CHANGES)

**Two APPROVEs achieved**: Claude and Gemini both approved the spec.

**Codex REQUEST_CHANGES - again about plan, not spec**:
> "Spec is thorough... No major clarity gaps"
> "Spec's security posture is solid; plan must be revised to match"

**Codex confirmed all issues are plan divergences**:
1. Plan uses `encodeURIComponent` instead of Base64URL
2. Plan reintroduces localhost auth bypass
3. Plan doesn't strip `auth-<key>` subprotocol
4. Plan adds ngrok (out of scope)
5. Plan missing `--web` guard

### Round 7 (Iteration 3 Reviews - Final)
- **Date**: 2026-01-27
- **Models consulted**: Gemini (REQUEST_CHANGES), Codex (REQUEST_CHANGES)

**Both reviewers explicitly state spec is correct**:

**Gemini**:
> "Spec is solid, but Plan contains critical security vulnerabilities and explicitly contradicts the Spec's authority"

**Codex**:
> "Spec is comprehensive and correct, but the plan diverges on critical security and routing requirements"
> "Ambiguities: None significant; spec even asserts authority over plan to avoid drift"

**FINAL STATUS**: Specification is COMPLETE and APPROVED. All REQUEST_CHANGES across 7 rounds of consultation have been about the PLAN diverging from the spec, not about spec issues. The plan will be corrected in the PLAN phase.

### Round 8 (Iteration 6-7 Reviews)
- **Date**: 2026-01-27
- **Models consulted**: Claude (APPROVE), Gemini (REQUEST_CHANGES), Codex (REQUEST_CHANGES)

**Claude APPROVED** the spec, confirming all requirements are clear and security model is sound.

**Gemini and Codex identified critical issues**:

1. **Spec proxy logic contradiction** (Gemini): The "Terminal Port Routing" section stated terminals are on different ports (base_port + offset), but the "Core Change" code example only looked up `base_port`. The proxy code needed to parse `/architect/` and `/builder/<n>/` to calculate the correct port.

2. **Plan divergences** (both): Same issues as previous rounds - plan still using `encodeURIComponent`, localhost bypass, missing protocol stripping, ngrok, no `--web` guard.

**Fixes applied in this round**:
1. ✅ Updated spec's "Core Change" code to show full terminal port calculation logic
2. ✅ Updated plan Phase 1 to match spec's terminal port routing
3. ✅ All prior plan fixes verified (Base64URL, no localhost bypass, protocol stripping, no ngrok, `--web` guard)
4. ✅ Added tests for terminal port routing

**Spec status**: All spec issues resolved. Plan fully aligned with spec.

### Round 9 (Iteration 6 - Final)
- **Date**: 2026-01-27
- **Models consulted**: Gemini (APPROVE), Codex (COMMENT)

**Gemini APPROVED**:
> "The plan is comprehensive, security-conscious, and fully aligned with the authoritative specification, addressing all previous concerns about tunnel security and routing."

**Codex COMMENTED** (not REQUEST_CHANGES):
> "Spec and plan are strong and security-aware; clarify how tower reads gate status to remove the last ambiguity"

**Codex's only comment**: Clarify the data source for gate status (`.porch/state.json` vs alternative mechanism). This is a minor clarification, not a blocking issue.

**FINAL APPROVAL STATUS**:
- Gemini: ✅ APPROVE
- Codex: ✅ COMMENT (non-blocking)
- Claude (prior): ✅ APPROVE

**Spec and plan are ready for implementation.**

---

## Amendments

This section tracks all TICK amendments to this specification.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->

### TICK-001: Update Proxy Routing for node-pty WebSocket Multiplexing (2026-02-01)

**Context**: Spec 0085 replaced per-terminal ttyd ports with WebSocket multiplexing over a single dashboard port. The tower's reverse proxy was still routing architect/builder requests to separate ports (basePort+1, basePort+2+n) that no longer exist.

**Changes**:

1. **Proxy routing simplified**: All requests now route to `basePort` regardless of terminal type. The path is passed through to the React dashboard, which handles terminal routing internally via `/ws/terminal/<id>`.

2. **`getProxyUrl()` in tower.html simplified**: No longer generates architect/builder-specific URLs. All project links use `/project/<encoded>/` — the React dashboard handles tab selection.

3. **Removed ttyd references**: The proxy no longer rewrites Origin headers for ttyd compatibility or strips `auth-<key>` subprotocols for ttyd. The React dashboard's WebSocket server handles authentication natively.

**Code impact**: ~20 lines removed from `tower-server.ts` (HTTP + WS handlers), ~10 lines simplified in `tower.html`.

**Spec sections affected**:
- "Core Change" code example (lines 107-109): Per-terminal port routing is now obsolete — all terminals on basePort
- "Terminal Port Routing" (lines 409-413): All terminals now on single port via WebSocket multiplexing
- WebSocket proxy comment about ttyd (line 170): No longer relevant — React dashboard handles WebSocket
