# Spec 0090: Tower as Single Daemon Architecture

## Problem Statement

The current Agent Farm architecture has multiple independent processes that can get out of sync:

1. **Tower server** (port 4100) - global overview of all projects
2. **Dashboard server per project** (ports 4200+) - manages architect, builders, shells for one project
3. **Each dashboard has its own SQLite database** (state.db) that can become stale

This leads to several issues:
- Dashboard processes started with old code don't pick up migrations
- Stale PID references in databases when processes die
- "No terminal session" errors when database state doesn't match reality
- Multiple processes to start/stop/monitor
- Race conditions between tower and dashboard state

## Proposed Solution

**Make tower the single daemon that owns everything:**

1. **Tower is the only long-running server** - starts on port 4100 (or configured port)
2. **`afx dash` becomes an API client** - tells tower to start/manage a project, doesn't spawn its own server
3. **Single SQLite database** - tower owns global.db which tracks ALL state (projects, architects, builders, terminals)
4. **Tower manages all PTY sessions** - PtyManager lives in tower, not per-project dashboards
5. **Web UI served from tower** - React dashboard is served by tower with project routing

## Architecture

### Current (Multiple Daemons)

```
┌─────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Tower     │    │  Dashboard A    │    │  Dashboard B    │
│  :4100      │    │  :4200          │    │  :4300          │
│             │    │  state.db       │    │  state.db       │
│  global.db  │    │  PtyManager     │    │  PtyManager     │
└─────────────┘    └─────────────────┘    └─────────────────┘
      ↓                    ↓                      ↓
   Overview           Project A              Project B
```

### Proposed (Single Daemon)

```
┌────────────────────────────────────────────────────────────┐
│                         Tower                               │
│                        :4100                                │
│                                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │  Project A   │  │  Project B   │  │  Project C   │     │
│  │  PtyManager  │  │  PtyManager  │  │  PtyManager  │     │
│  │  terminals   │  │  terminals   │  │  terminals   │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│                                                            │
│  global.db (all state)                                     │
│  React Dashboard (all projects)                            │
└────────────────────────────────────────────────────────────┘
```

## API Changes

### `afx tower start`
- Starts the single daemon (unchanged)
- Now also initializes PtyManagers for known projects

### `afx tower stop`
- Stops the single daemon and all managed terminals

### `afx dash start` (CHANGED)
- No longer spawns a separate server
- Sends API request to tower: `POST /api/projects/:projectPath/activate`
- Tower creates PtyManager for project, starts architect if configured
- Opens browser to `http://localhost:4100/project/<encoded-path>/`

### `afx dash stop` (CHANGED)
- Sends API request to tower: `POST /api/projects/:projectPath/deactivate`
- Tower cleans up terminals for that project

### `afx status` (CHANGED)
- Queries tower API instead of reading local state.db
- `GET /api/projects/:projectPath/status`

## Database Schema Changes

Migrate from per-project `state.db` to single `global.db`:

```sql
-- Projects table (new)
CREATE TABLE projects (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER DEFAULT 0,
  base_port INTEGER,
  activated_at TEXT,
  config_json TEXT
);

-- Architect table (moved from state.db, add project_path)
CREATE TABLE architect (
  project_path TEXT PRIMARY KEY REFERENCES projects(path),
  pid INTEGER,
  terminal_id TEXT,
  tmux_session TEXT,
  started_at TEXT
);

-- Builders table (moved, add project_path)
CREATE TABLE builders (
  id TEXT PRIMARY KEY,
  project_path TEXT REFERENCES projects(path),
  name TEXT NOT NULL,
  worktree TEXT,
  branch TEXT,
  pid INTEGER,
  terminal_id TEXT,
  tmux_session TEXT,
  started_at TEXT
);

-- Utils/shells table (moved, add project_path)
CREATE TABLE terminals (
  id TEXT PRIMARY KEY,
  project_path TEXT REFERENCES projects(path),
  type TEXT NOT NULL, -- 'architect', 'builder', 'shell'
  name TEXT NOT NULL,
  terminal_id TEXT,
  tmux_session TEXT,
  started_at TEXT
);
```

## WebSocket Routing

Tower handles all WebSocket connections:

- `/ws/terminal/<terminal-id>` - connects to any terminal by ID
- Terminal IDs are globally unique (UUIDs)
- No need for project-specific routing at WebSocket level

## Web UI Routing

Tower serves the React dashboard for all projects:

- `/` - Overview (list of all projects)
- `/project/<encoded-path>/` - Project dashboard
- `/project/<encoded-path>/?tab=architect` - Specific tab

The React app uses `getApiBase()` to determine API prefix based on URL path.

## Migration Path

**Clean break**: No backward compatibility mode. Tower is THE daemon from day one.

1. **Phase 1: Tower API + Dashboard serving**
   - Tower serves React dashboard and exposes project APIs
   - `afx dash start` calls tower API (no more dashboard-server spawning)

2. **Phase 2: PtyManager in tower**
   - Tower owns all terminal sessions
   - Single WebSocket endpoint for all terminals

3. **Phase 3: CLI commands via tower**
   - All `afx` commands communicate via tower API
   - Delete dashboard-server.ts

4. **Phase 4: Cleanup**
   - Migrate any legacy state.db files to global.db

## Benefits

1. **Single source of truth** - no stale state across multiple databases
2. **Simpler operations** - one process to start/stop/monitor
3. **Consistent state** - tower always knows what's running
4. **Easier debugging** - all logs in one place
5. **Resource efficiency** - one Node.js process instead of N+1
6. **Automatic cleanup** - tower can detect and clean orphaned terminals

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Tower crash affects all projects | Add process supervision, auto-restart |
| Higher memory usage in tower | Lazy-load PtyManagers, only active projects |
| Breaking existing workflows | Keep `afx dash start` command semantics (just calls tower instead of spawning) |

## Success Criteria

1. `afx tower start` is the only daemon needed
2. `afx dash start/stop` work via tower API
3. No more "No terminal session" errors from stale state
4. All terminals accessible through single port (4100)
5. Clean shutdown with `afx tower stop` kills all terminals

## CLI Behavior Changes

### `afx dash start` Blocking Behavior

**Current**: Spawns dashboard-server, opens browser, returns immediately.

**New**: Calls tower API, opens browser, returns immediately.

The command remains non-blocking. If the user wants to see logs:
```bash
afx tower log  # Follow tower logs
```

### `afx dash start --remote` (Remote Workflows)

Remote access continues to work through tower:
```bash
# On remote machine
afx tower start

# On local machine
ssh -L 4100:localhost:4100 user@remote
# Then open http://localhost:4100
```

The `--remote` flag on `afx dash` becomes a convenience wrapper:
```bash
afx dash start --remote user@host
# Equivalent to: ssh user@host 'cd <project> && afx tower start' + tunnel setup
```

### `afx status` Output

Changes from reading local state.db to querying tower:
```bash
# If tower running: query tower API
# If tower not running: show "Tower not running" message
```

## Security Model

### API Authentication

Tower already has web-key authentication (`codev-web-key` in localStorage/header). The new project APIs use the same auth:

- `POST /api/projects/:path/activate` - requires auth
- `POST /api/projects/:path/deactivate` - requires auth
- `GET /api/projects/:path/status` - requires auth

Local CLI calls (from same machine) can use a local socket or shared secret file (`~/.agent-farm/local-key`) to authenticate without user interaction.

### Rate Limiting

Project activation is rate-limited to prevent abuse:
- Max 10 activations per minute per client
- Deactivation not rate-limited (always allow cleanup)

## Edge Cases & Error Handling

### Tower Restart While Terminals Active

1. Tower saves active terminal state to `global.db` on shutdown (SIGTERM)
2. On restart, tower reads `global.db` and reconnects to existing tmux sessions
3. If tmux session exists but PTY connection lost, tower recreates PTY attachment
4. Dashboard clients auto-reconnect via WebSocket reconnection logic

### Partial Migration / Stale Data

Migration runs on tower startup:
1. Scan for projects with `state.db` files
2. For each, check if already migrated (flag in global.db)
3. If not migrated: copy data to global.db, mark as migrated
4. Keep original `state.db` as backup (don't delete)
5. If migration fails mid-way: log error, skip project, continue

### Tower Unreachable from CLI

```bash
afx dash start  # Tower not running
# Output: "Tower not running. Starting tower..."
# Automatically starts tower, then activates project
```

### Conflicting Port Allocations

Tower owns all port allocation. If a project requests activation:
1. Check if project already has assigned port in global.db
2. If yes, reuse that port
3. If no, allocate next available from pool
4. No conflicts possible since tower is single source of truth

## Frontend Asset Serving

### Static Asset Pipeline

Tower serves the React dashboard directly:

```typescript
// In tower-server.ts
app.use('/project/:encodedPath', express.static(dashboardDistPath));
app.get('/project/:encodedPath/*', (req, res) => {
  res.sendFile(path.join(dashboardDistPath, 'index.html'));
});
```

### React Dashboard Updates

The dashboard requires updates to support tower mode:

1. **API base detection** - `getApiBase()` updated to detect tower mode from URL path
2. **WebSocket routing** - Updated to use flat `/ws/terminal/:id` route (not project-prefixed)
3. **Overview page** - Fetch project list from `GET /api/projects`
4. **Reconnection logic** - Handle tower restarts gracefully

```typescript
// Updated routing for tower mode:
// API calls: fetch(`/api/projects/${encodedPath}/status`)
// WebSocket: ws://host/ws/terminal/<id>  (flat route)
// Overview: GET /api/projects  (list all projects)
```

## Process Supervision

### Recommended Setup

For production use, run tower under a process supervisor:

**macOS (launchd)**:
```xml
<!-- ~/Library/LaunchAgents/com.codev.tower.plist -->
<plist>
  <dict>
    <key>Label</key><string>com.codev.tower</string>
    <key>ProgramArguments</key>
    <array>
      <string>/opt/homebrew/bin/node</string>
      <string>/opt/homebrew/lib/node_modules/@cluesmith/codev/dist/agent-farm/servers/tower-server.js</string>
      <string>4100</string>
    </array>
    <key>KeepAlive</key><true/>
    <key>RunAtLoad</key><true/>
  </dict>
</plist>
```

**Linux (systemd)**:
```ini
[Unit]
Description=Codev Tower
After=network.target

[Service]
ExecStart=/usr/bin/node /usr/lib/node_modules/@cluesmith/codev/dist/agent-farm/servers/tower-server.js 4100
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

### Built-in Crash Recovery

Even without external supervision, tower has basic crash recovery:
- On startup, detect orphaned tmux sessions and reconnect
- Clean up stale PID references in global.db
- Re-establish PTY connections to existing terminals

## No Backward Compatibility Mode

**This is a clean break.** There is no:
- Standalone dashboard mode
- `--use-tower` or `--standalone` flags
- `AF_USE_TOWER` environment variable
- Dual mode where both work

Tower is THE daemon. `afx dash` is just an API client. Period.

## Authentication Clarification

The spec reuses the existing `codev-web-key` authentication pattern with two additions:

1. **Local key file** (`~/.agent-farm/local-key`) - Auto-generated shared secret for CLI→tower communication. This is NOT a new auth mechanism, but an implementation detail for localhost trust.

2. **Rate limiting** - 10 activations/minute per client to prevent abuse. This is a security safeguard, not authentication.

## TICK-001: Terminal Session Persistence and Reconciliation

**Amendment Date**: 2026-02-05
**Consulted**: Gemini 3 Pro, GPT-5.2 Codex

### Problem

Phase 4 implementation has a state split:
- **SQLite (global.db)**: Port allocations persist across restarts
- **In-memory (projectTerminals Map)**: Terminal state lost on restart

This causes:
- Projects showing "inactive" after Tower restart (terminals gone but port allocation remains)
- State divergence during runtime
- Confusion about which projects are actually running

### Solution: SQLite as Single Source of Truth + Reconciliation

**Add `terminal_sessions` table to global.db:**

```sql
CREATE TABLE IF NOT EXISTS terminal_sessions (
  id TEXT PRIMARY KEY,           -- terminal UUID
  project_path TEXT NOT NULL,    -- project this belongs to
  type TEXT NOT NULL,            -- 'architect', 'builder', 'shell'
  role_id TEXT,                  -- builder ID or shell ID (null for architect)
  pid INTEGER,                   -- process ID
  tmux_session TEXT,             -- tmux session name if tmux-backed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(project_path) REFERENCES port_allocations(project_path)
);
```

**Startup Reconciliation Logic:**

```typescript
async function reconcileTerminalSessions(): Promise<void> {
  const sessions = db.prepare('SELECT * FROM terminal_sessions').all();

  for (const session of sessions) {
    let alive = false;

    // Check if tmux session exists
    if (session.tmux_session) {
      try {
        execSync(`tmux has-session -t "${session.tmux_session}" 2>/dev/null`);
        alive = true;
      } catch {
        alive = false;
      }
    }
    // Check if process still running (for non-tmux)
    else if (session.pid) {
      try {
        process.kill(session.pid, 0);  // Signal 0 = check existence
        alive = true;
      } catch {
        alive = false;
      }
    }

    if (alive) {
      // Re-attach: create PTY session and populate projectTerminals Map
      await reattachTerminal(session);
    } else {
      // Clean up dead session
      db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(session.id);
    }
  }
}
```

**Runtime Behavior:**

1. **On terminal create**: INSERT into terminal_sessions, then spawn PTY
2. **On terminal kill**: DELETE from terminal_sessions, then kill PTY
3. **On Tower startup**: Run reconciliation before accepting connections
4. **Periodic reconciliation** (optional): Every 60s, verify sessions match reality

### Changes to tower-server.ts

1. Add `terminal_sessions` table to schema
2. Add migration for existing installations
3. Modify `launchInstance()` to INSERT sessions
4. Modify terminal cleanup to DELETE sessions
5. Add `reconcileTerminalSessions()` called on startup
6. Change `getInstances()` to query SQLite instead of in-memory Map for terminal count

### Benefits

1. **Single source of truth** - SQLite is authoritative, Map is cache
2. **Survive restarts** - tmux-backed sessions (architect) can be re-attached
3. **Debuggable** - `sqlite3 ~/.agent-farm/global.db "SELECT * FROM terminal_sessions"`
4. **No phantom state** - Dead sessions cleaned up on reconciliation

### Non-Goals

- Persisting node-pty sessions (they die with process - expected)
- Full event sourcing (overkill for this use case)
- Distributed consistency (single-node tool)

---

## Out of Scope

- Cloud-hosted tower (separate spec)
- Multi-machine coordination
- OAuth/SSO or other authentication providers (use existing web-key pattern)
