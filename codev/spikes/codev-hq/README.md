# Spike: CODEV_HQ Minimal Implementation

**Goal**: Build a minimal working implementation of the CODEV_HQ architecture from Spec 0068 to validate the core concepts.

**Time-box**: 4-6 hours
**Status**: COMPLETE
**Started**: 2026-01-16
**Completed**: 2026-01-16

## Hypothesis

A minimal CODEV_HQ implementation can demonstrate:
1. WebSocket connection between local Agent Farm and cloud HQ
2. Status file sync (local → HQ)
3. Mobile-friendly dashboard showing project status
4. Human approval gates triggered from HQ → local

## Scope (Minimal Viable HQ)

### In Scope
- Simple WebSocket server (Node.js)
- Basic authentication (API key)
- Status file sync protocol
- Minimal React dashboard
- Approval flow (HQ → Local)

### Out of Scope (for spike)
- Multi-tenant auth (Clerk/Auth0)
- PostgreSQL persistence (use in-memory)
- Production deployment
- Terminal streaming
- Full mobile PWA

## Architecture (Spike Version)

```
┌─────────────────────────────────────────┐
│         CODEV_HQ (Minimal)               │
│         localhost:4300                   │
│  ┌──────────────┐  ┌─────────────────┐  │
│  │  WebSocket   │  │  React Dashboard │  │
│  │   Server     │  │  (Vite dev)      │  │
│  └──────┬───────┘  └────────┬────────┘  │
│         │                    │           │
│         └────────┬───────────┘           │
│                  │                       │
│           In-Memory State                │
└──────────────────┼───────────────────────┘
                   │
            WebSocket (ws://)
                   │
┌──────────────────┴───────────────────────┐
│        Agent Farm (Existing)              │
│        localhost:4200                     │
│  ┌─────────────────────────────────────┐ │
│  │  HQ Connector (NEW)                  │ │
│  │  - Connect to HQ on startup          │ │
│  │  - Sync status files                 │ │
│  │  - Receive approvals                 │ │
│  └─────────────────────────────────────┘ │
└──────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: WebSocket Server (2h)
1. Create `packages/codev-hq/` directory
2. Set up Express + ws server
3. Implement message envelope (from spec)
4. Handle `register`, `ping/pong`, `status_update`
5. In-memory store for connected instances

### Phase 2: HQ Connector for Agent Farm (1.5h)
1. Add `hq-connector.ts` to agent-farm package
2. Connect on `af start` if `CODEV_HQ_URL` set
3. Send `register` with project list
4. Watch status files, send `status_update` on change
5. Handle `approval` messages, update status files

### Phase 3: Minimal Dashboard (1.5h)
1. Create `packages/codev-hq/dashboard/` (Vite + React)
2. Show connected instances
3. Show projects and status
4. "Approve" button for pending gates

### Phase 4: Integration Test (1h)
1. Start HQ server
2. Start Agent Farm with `CODEV_HQ_URL`
3. Verify registration
4. Create status file, verify sync
5. Click approve, verify local file updated

## Validated Protocol

This section documents the WebSocket protocol that was **implemented and tested** in this spike.

### Message Envelope

All messages use this JSON envelope:

```typescript
interface Message {
  type: string;      // Message type identifier
  id: string;        // Unique ID for request/response correlation
  ts: number;        // Unix timestamp (milliseconds)
  payload: object;   // Type-specific data
}

interface Response {
  type: "response";
  id: string;        // Same ID as request (correlation)
  ts: number;
  success: boolean;
  error?: string;    // If success=false
  payload?: object;
}
```

### Connection Lifecycle

```
Local Agent Farm                           HQ Server
      │                                        │
      │──── WebSocket CONNECT ────────────────→│
      │     ws://host:4300/ws?key=<api_key>    │
      │                                        │
      │←─── welcome ───────────────────────────│
      │     { message: "Connected to HQ" }     │
      │                                        │
      │──── register ─────────────────────────→│
      │     (see payload below)                │
      │                                        │
      │←─── response ──────────────────────────│
      │     { success: true, session_id }      │
      │                                        │
      │──── ping (every 30s) ─────────────────→│
      │←─── pong ──────────────────────────────│
      │                                        │
```

### Message Types: Local → HQ

**register** - Initial registration after welcome
```typescript
{
  type: "register",
  id: "1705412345-abc123",
  ts: 1705412345000,
  payload: {
    instance_id: "uuid-generated-on-startup",
    instance_name: "hostname-agent-farm",  // Human-readable
    version: "1.6.1",                       // Codev version
    projects: [{
      path: "/Users/dev/myproject",         // Absolute local path
      name: "myproject",                    // Directory name
      git_remote: "git@github.com:..."      // Optional
    }]
  }
}
```

**status_update** - Status file changed locally
```typescript
{
  type: "status_update",
  id: "...",
  ts: 1705412345000,
  payload: {
    project_path: "/Users/dev/myproject",
    status_file: "codev/status/0068-feature.md",  // Relative path
    content: "---\nid: \"0068\"\ngates:\n  human_approval: { status: pending }\n---\n",
    git_sha: "abc123def"  // Optional, commit SHA of file
  }
}
```

**builder_update** - Builder status changed
```typescript
{
  type: "builder_update",
  id: "...",
  ts: 1705412345000,
  payload: {
    project_path: "/Users/dev/myproject",
    builder_id: "0068",
    status: "implementing",  // spawning|implementing|blocked|pr-ready|complete
    phase: "phase-1",        // Optional
    branch: "builder/0068-feature"  // Optional
  }
}
```

**ping** - Heartbeat (every 30 seconds)
```typescript
{
  type: "ping",
  id: "...",
  ts: 1705412345000,
  payload: { ts: 1705412345000 }
}
```

### Message Types: HQ → Local

**welcome** - Sent immediately after WebSocket connects
```typescript
{
  type: "welcome",
  id: "server-welcome",
  ts: 1705412345000,
  payload: { message: "Connected to CODEV_HQ" }
}
```

**pong** - Response to ping
```typescript
{
  type: "pong",
  id: "...",
  ts: 1705412345000,
  payload: { ts: 1705412345000 }  // Echo back client's timestamp
}
```

**approval** - Human approved a gate (from dashboard)
```typescript
{
  type: "approval",
  id: "...",
  ts: 1705412345000,
  payload: {
    project_path: "/Users/dev/myproject",
    project_id: "0068",
    gate: "human_approval",           // Gate identifier
    approved_by: "waleed",            // Who approved
    approved_at: "2026-01-16T06:15:12.348Z",
    comment: "Looks good"             // Optional
  }
}
```

**response** - Generic response to any request
```typescript
{
  type: "response",
  id: "same-as-request-id",
  ts: 1705412345000,
  success: true,  // or false
  error: "Error message if success=false",
  payload: { /* request-specific data */ }
}
```

### REST API Endpoints

**GET /api/state** - Get current HQ state snapshot
```json
{
  "instances": [{
    "instance_id": "uuid",
    "instance_name": "hostname-agent-farm",
    "version": "1.6.1",
    "connected_at": "2026-01-16T06:00:00Z",
    "last_ping": "2026-01-16T06:15:00Z",
    "projects": [{ "path": "...", "name": "..." }],
    "status_files": [{ "path": "...", "content": "..." }],
    "builders": [{ "builder_id": "...", "status": "..." }]
  }],
  "timestamp": "2026-01-16T06:15:30Z"
}
```

**POST /api/approve** - Send approval to connected instance
```json
// Request
{
  "instance_id": "uuid",
  "project_path": "/Users/dev/myproject",
  "project_id": "0068",
  "gate": "human_approval",
  "approved_by": "dashboard-user",
  "comment": "Optional comment"
}

// Response
{ "success": true, "message": "Approval sent" }
// or
{ "error": "Failed to send approval" }
```

**GET /health** - Health check
```json
{ "status": "ok", "timestamp": "2026-01-16T06:15:30Z" }
```

### Authentication

For this spike, authentication is a simple API key:
- Pass via query param: `ws://host:4300/ws?key=dev-key-spike`
- Or header: `Authorization: Bearer dev-key-spike`

Production would use proper API keys with user/team scoping.

### Error Handling

Connection errors trigger automatic reconnection with exponential backoff:
- Initial delay: 1 second
- Multiplier: 2x per attempt
- Maximum delay: 60 seconds

### What Was Validated

| Protocol Element | Tested | Result |
|-----------------|--------|--------|
| WebSocket connection with auth | ✅ | Works |
| Welcome → Register flow | ✅ | Works |
| Ping/Pong heartbeat | ✅ | Works |
| Status file sync | ✅ | Works |
| Approval message delivery | ✅ | Works |
| REST API /api/state | ✅ | Works |
| REST API /api/approve | ✅ | Works |
| Reconnection on disconnect | ✅ | Works |

## File Structure

```
packages/
├── codev-hq/                    # NEW
│   ├── src/
│   │   ├── server.ts           # Express + WebSocket
│   │   ├── state.ts            # In-memory state
│   │   └── handlers.ts         # Message handlers
│   ├── dashboard/
│   │   ├── src/
│   │   │   ├── App.tsx
│   │   │   └── main.tsx
│   │   └── vite.config.ts
│   └── package.json
│
├── codev/                       # MODIFY
│   └── src/
│       └── hq-connector.ts     # NEW - connects to HQ
```

## Success Criteria

1. **PASS**: Agent Farm connects to HQ on startup
2. **PASS**: Status files sync to HQ within 1s of change
3. **PASS**: Dashboard shows project status in real-time
4. **PASS**: Clicking "Approve" updates local status file
5. **PASS**: Local git commit created for approval

## Testing Commands

```bash
# Start HQ server
cd packages/codev-hq && npm run dev

# In another terminal - start Agent Farm with HQ
export CODEV_HQ_URL="ws://localhost:4300/ws"
af start

# Open HQ dashboard
open http://localhost:4300

# Create a test status file
mkdir -p codev/status
cat > codev/status/test-project.md << 'EOF'
---
id: "test"
protocol: SPIR
current_phase: specify
gates:
  specify_to_plan:
    human_approval: { status: pending }
---
## Log
- Started
EOF

# Watch for approval in HQ dashboard
# Click approve
# Verify local file updated
```

## Implementation Notes

### What was built

1. **HQ Server** (`packages/codev-hq/`)
   - Express + ws WebSocket server on port 4300
   - In-memory state management with event subscription
   - Message handlers for register, ping/pong, status_update, builder_update
   - REST API endpoints: `/api/state`, `/api/approve`

2. **HQ Connector** (`packages/codev/src/agent-farm/hq-connector.ts`)
   - Connects to HQ when `CODEV_HQ_URL` env var is set
   - Registers on connect with project info
   - Watches `codev/status/` directory for changes
   - Syncs status files to HQ in real-time
   - Handles approval messages, updates local files, creates git commits

3. **React Dashboard** (`packages/codev-hq/dashboard/`)
   - Vite + React 19 with TypeScript
   - Shows connected instances, projects, builders
   - Parses status file YAML frontmatter to display gates
   - "Approve" button for pending gates
   - Real-time updates via WebSocket + polling fallback

### Dependencies added

- `packages/codev-hq/`: express, ws, chalk
- `packages/codev/`: ws, glob (for status file pattern matching)

### Design decisions

- Start with ws:// not wss:// for spike simplicity
- Skip auth complexity - single hardcoded API key (`dev-key-spike`)
- Use Vite's built-in HMR for dashboard development
- Keep state in-memory, restart loses everything (fine for spike)
- Use glob pattern matching for status file discovery
- Simple regex-based YAML parsing (not a full YAML parser)

### Known limitations

- Dashboard WebSocket doesn't proxy through Vite in production build
- Gate parsing is simplistic (regex, not full YAML parser)
- No TLS/authentication beyond simple API key
- Single project per instance assumed

## Spike Results

The spike successfully demonstrated all core concepts from Spec 0068:

| Criterion | Result |
|-----------|--------|
| Agent Farm connects to HQ on startup | PASS |
| Status files sync to HQ within 1s | PASS |
| Dashboard shows project status real-time | PASS |
| Clicking "Approve" updates local status file | PASS |
| Git commit created for approval | PASS |

### Recommendation

The architecture is viable. Key learnings for full implementation:
1. Use a proper YAML parser (js-yaml) instead of regex
2. Need proper WebSocket proxy for production dashboard
3. Consider using SSE instead of WebSocket for dashboard (simpler)
4. Status file format works well - no changes needed

## References

- [Spec 0068: Codev 2.0](../../specs/0068-codev-2.0.md) - Full HQ protocol
- [ws npm package](https://www.npmjs.com/package/ws) - WebSocket server
