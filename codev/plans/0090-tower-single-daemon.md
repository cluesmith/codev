# Plan 0090: Tower as Single Daemon Architecture

## Approach

**Test-First Development**: Write comprehensive tests for current behavior BEFORE making changes. This ensures we don't break existing functionality and provides a safety net for the refactor.

## Phase 0: Baseline Tests (BEFORE ANY CHANGES)

Write E2E tests that capture current expected behavior. These tests should pass with the current implementation and continue to pass after the refactor.

### Test Suite: `packages/codev/src/agent-farm/__tests__/e2e/tower-integration.test.ts`

```typescript
// Tests to write BEFORE refactoring:

// NOTE: Phase 0 tests ONLY cover CURRENT behavior (before any changes).
// Tests for new features (auth, rate limiting, health checks) go with their implementation phases.

describe('Tower Integration - Current Behavior (Phase 0)', () => {
  describe('tower lifecycle', () => {
    it('starts tower on default port 4100')
    it('stops tower cleanly')
    it('tower survives dashboard crashes')
  });

  describe('project activation (via current dashboard)', () => {
    it('dashboard starts and shows in tower overview')
    it('creates architect terminal for project')
    it('creates shell terminals for project')
    it('multiple shells can be created for same project')
  });

  describe('terminal connectivity (via dashboard WebSocket)', () => {
    it('architect terminal is accessible via WebSocket')
    it('shell terminals are accessible via WebSocket')
    it('terminals reconnect after brief disconnect')
  });

  describe('state consistency', () => {
    it('tower shows correct project status after restart')
    it('stale PIDs are cleaned up on startup')
    it('orphaned tmux sessions are detected')
  });

  describe('multi-project', () => {
    it('multiple projects can be active simultaneously')
    it('stopping one project does not affect others')
    it('tower overview shows all active projects')
  });
});
```

### Test Helpers Needed

```typescript
// packages/codev/src/agent-farm/__tests__/helpers/tower-test-utils.ts

export async function startTower(port?: number): Promise<{ port: number; stop: () => Promise<void> }>;
export async function activateProject(projectPath: string): Promise<void>;
export async function deactivateProject(projectPath: string): Promise<void>;
export async function getTowerState(): Promise<TowerState>;
export async function createTerminal(projectPath: string, type: 'shell' | 'builder'): Promise<string>;
export async function connectTerminalWs(terminalId: string): Promise<WebSocket>;
```

## Phase 1: Tower API Layer

Add tower APIs. `af dash` becomes a thin wrapper that calls these APIs.

**No standalone mode.** Tower is the single daemon. `af dash start` = call tower API + open browser.

### Files to Modify

1. **`packages/codev/src/agent-farm/servers/tower-server.ts`**
   - Add `GET /api/projects` (list all projects for overview)
   - Add `POST /api/projects/:encodedPath/activate`
   - Add `POST /api/projects/:encodedPath/deactivate`
   - Add `GET /api/projects/:encodedPath/status`
   - Add `POST /api/projects/:encodedPath/terminals` (create terminal)
   - Add `GET /health` endpoint (moved from Phase 4 for early crash detection)
   - Serve overview UI at `/` (list all projects)
   - Add static asset serving for React dashboard at `/project/:encodedPath/`

2. **`packages/codev/src/agent-farm/db/schema.ts`**
   - Add `projects` table to GLOBAL_SCHEMA
   - Add `terminals` table (unified architect/builder/shell)
   - Add project_path foreign key support

3. **`packages/codev/src/agent-farm/state.ts`**
   - Add `activateProject()`, `deactivateProject()` functions
   - Add `getProjectState()` function
   - Add `migrateProjectFromLocalDb()` function

4. **`packages/codev/src/agent-farm/middleware/auth.ts`** (NEW)
   - Reuse existing `codev-web-key` authentication from dashboard
   - Add middleware for API routes: `validateAuth(req, res, next)`
   - Local socket detection: skip auth for connections from localhost via shared secret
   - Rate limiting: 10 activations/minute per client (deactivation not limited)

### Auth Implementation Detail

```typescript
// middleware/auth.ts
import { rateLimit } from 'express-rate-limit';

// Rate limit: 10 activations per minute
export const activationRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many activations, try again later' },
  skip: (req) => req.path.includes('/deactivate'), // Don't limit deactivation
});

// Auth middleware - reuse web-key pattern from dashboard
export function validateAuth(req: Request, res: Response, next: NextFunction) {
  const webKey = req.headers['codev-web-key'] as string;
  const localKey = readLocalKey(); // ~/.agent-farm/local-key

  // Allow local CLI calls with shared secret
  if (req.socket.remoteAddress === '127.0.0.1' && webKey === localKey) {
    return next();
  }

  // Validate web-key for remote/browser calls
  if (!webKey || !isValidWebKey(webKey)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}
```

### Static Asset Serving Detail (Codex feedback - routing order)

```typescript
// tower-server.ts additions
import { resolve } from 'node:path';

const dashboardDist = resolve(__dirname, '../../dashboard/dist');

// IMPORTANT: API routes MUST be registered BEFORE static asset middleware
// to avoid catch-all intercepting API requests

// 1. Overview at / - list all projects
app.get('/', (req, res) => res.sendFile(resolve(dashboardDist, 'index.html')));
app.get('/api/projects', getProjectsHandler);

// 2. Project-specific API routes (BEFORE static)
app.post('/api/projects/:encodedPath/activate', activateHandler);
app.post('/api/projects/:encodedPath/deactivate', deactivateHandler);
app.get('/api/projects/:encodedPath/status', statusHandler);
app.post('/api/projects/:encodedPath/terminals', createTerminalHandler);

// 3. Health endpoint (early crash detection)
app.get('/health', healthHandler);

// 4. Static assets for project dashboard (AFTER API routes)
app.use('/project/:encodedPath', express.static(dashboardDist));
app.get('/project/:encodedPath/*', (req, res) => {
  // SPA fallback - only for non-API paths
  if (!req.path.includes('/api/')) {
    res.sendFile(resolve(dashboardDist, 'index.html'));
  }
});
```

### React Dashboard Updates (Codex feedback - concrete tasks)

The React dashboard WILL need changes for tower mode. Specific tasks:

1. **`packages/codev/dashboard/src/lib/api.ts`**
   - Update `getApiBase()` to use tower API paths
   - All dashboard access is through tower

2. **`packages/codev/dashboard/src/lib/websocket.ts`**
   - Update WebSocket URL construction for flat `/ws/terminal/:id` route
   - Remove project path prefix from WebSocket URLs in tower mode
   - Add connection retry with exponential backoff

3. **`packages/codev/dashboard/src/pages/Overview.tsx`** (NEW or modify tower overview)
   - Fetch project list from tower API: `GET /api/projects`
   - Display all active projects with links to `/project/:encodedPath/`
   - Show terminal counts and status for each project

4. **`packages/codev/dashboard/src/hooks/useTerminal.ts`**
   - Update to use flat WebSocket route in tower mode
   - Handle reconnection when tower restarts

### React Dashboard Tests (Playwright)

```typescript
describe('React Dashboard - Tower Mode', () => {
  it('getApiBase returns correct prefix in tower mode')
  it('WebSocket connects to /ws/terminal/:id (flat route)')
  it('overview page lists all projects')
  it('project page loads at /project/:encodedPath/')
  it('handles tower restart gracefully')
});
```

### Tests for Phase 1

```typescript
describe('Tower API (Phase 1)', () => {
  // Happy path
  it('GET /api/projects returns list of all projects')
  it('POST /api/projects/:path/activate creates project entry')
  it('POST /api/projects/:path/deactivate marks project inactive')
  it('GET /api/projects/:path/status returns project state')
  it('overview at / serves React app')
  it('React dashboard served at /project/:path/')
  it('API routes take precedence over static catch-all')
  it('GET /health returns 200 with metrics')

  // Auth (tests for NEW behavior introduced in Phase 1)
  describe('authentication', () => {
    it('rejects requests without codev-web-key header')
    it('rejects requests with invalid web-key')
    it('accepts requests with valid web-key')
    it('accepts local requests with local-key from ~/.agent-farm/local-key')
  });

  // Rate limiting (tests for NEW behavior introduced in Phase 1)
  describe('rate limiting', () => {
    it('allows 10 activations per minute')
    it('returns 429 after rate limit exceeded')
    it('does not rate-limit deactivation')
    it('rate limit resets after window')
  });

  // Error handling (tests for NEW behavior introduced in Phase 1)
  describe('error handling', () => {
    it('tower returns 503 when starting up')
    it('activation fails gracefully for non-existent project path')
    it('handles rapid activate/deactivate cycles')
  });
});
```

## Phase 2: PtyManager in Tower

Move terminal management into tower. Dashboard-server becomes optional.

### Files to Modify

1. **`packages/codev/src/agent-farm/servers/tower-server.ts`**
   - Import and instantiate PtyManager (one per active project)
   - Add WebSocket handler for `/ws/terminal/:id` (flat route per spec, NOT project-prefixed)
   - Route terminal connections through tower
   - Add graceful shutdown handler (SIGTERM): save state, kill all PTYs, exit cleanly
   - Add process supervision hooks (log restart metrics)

2. **`packages/codev/src/agent-farm/commands/start.ts`**
   - Remove dashboard-server spawning entirely
   - Call tower API to activate project

3. **`packages/codev/src/terminal/pty-manager.ts`**
   - Add project scoping to sessions (`projectPath` field)
   - Add `getSessionsByProject(path)` method
   - Add `cleanupProject(path)` method
   - Add `reconnectToTmux(sessionName)` for crash recovery

### PTY Lifecycle in Tower

```typescript
// Project activation flow
async function activateProject(projectPath: string) {
  // 1. Register project in global.db
  db.prepare('INSERT OR REPLACE INTO projects ...').run({ path: projectPath });

  // 2. Create PtyManager for project (lazy - only when first terminal requested)
  projectPtyManagers.set(projectPath, new PtyManager());

  // 3. Check for existing tmux sessions and reconnect
  const existingSessions = await findTmuxSessions(`af-*-${basePort}`);
  for (const session of existingSessions) {
    await ptyManager.attachToExisting(session);
  }

  // 4. Start architect if configured and not already running
  if (config.autoStartArchitect && !hasArchitect(projectPath)) {
    await createArchitectTerminal(projectPath);
  }
}

// Crash recovery on tower restart
async function recoverActiveProjects() {
  const activeProjects = db.prepare('SELECT * FROM projects WHERE active = 1').all();
  for (const project of activeProjects) {
    await activateProject(project.path);  // Reconnects to existing tmux
  }
}
```

4. **`packages/codev/src/agent-farm/commands/tower.ts`** (tower stop behavior)
   - `af tower stop` sends SIGTERM to tower process
   - Tower handles SIGTERM: kill all PTY sessions, save state, exit
   - Add `--force` flag to send SIGKILL if SIGTERM times out (10s)
   - Update state.db to mark all terminals as stopped

### Tests for Phase 2

```typescript
describe('Tower Terminal Management (Phase 2)', () => {
  // Happy path
  it('tower creates architect terminal via API')
  it('tower creates shell terminal via API')
  it('WebSocket connection at /ws/terminal/:id works (flat route)')
  it('terminal output is streamed correctly')
  it('terminal input is echoed correctly')
  it('multiple terminals for same project work')

  // Edge cases
  it('tower reconnects to existing tmux sessions on restart')
  it('tower cleans up orphaned PTY sessions')
  it('terminal creation fails gracefully if tmux unavailable')
  it('WebSocket reconnection works after brief disconnect')

  // Tower stop (Codex feedback)
  describe('af tower stop', () => {
    it('SIGTERM triggers graceful shutdown')
    it('all PTY sessions killed on shutdown')
    it('all tmux sessions killed on shutdown')
    it('state saved to database before exit')
    it('--force sends SIGKILL after timeout')
    it('WebSocket clients receive close event')
  });
});
```

## Phase 3: Migrate CLI Commands

Change `af dash start`, `af dash stop`, and `af status` to use tower API.

### Files to Modify

1. **`packages/codev/src/agent-farm/commands/start.ts`**
   - Check if tower is running (try connect to port)
   - If tower not running: start tower first
   - Call `POST /api/projects/:path/activate`
   - Open browser to `http://localhost:4100/project/<encoded-path>/`
   - Remove dashboard-server spawning entirely

2. **`packages/codev/src/agent-farm/commands/stop.ts`**
   - Call `POST /api/projects/:path/deactivate`
   - Don't kill tower (other projects may be using it)
   - Add `--force` to kill all terminals without confirmation

3. **`packages/codev/src/agent-farm/commands/status.ts`**
   - If tower running: `GET /api/projects/:path/status`
   - If tower not running: print "Tower not running" and exit
   - Update output format to show tower-managed state

4. **`packages/codev/src/agent-farm/commands/start.ts`** (remote workflow)
   - Update `--remote` to work with tower architecture
   - SSH to remote, ensure tower running (`af tower start`)
   - Set up SSH tunnel: `ssh -L 4100:localhost:4100 user@host`
   - Open browser to `http://localhost:4100/project/<encoded-path>/`
   - Handle Ctrl+C to clean up tunnel

5. **`packages/codev/src/agent-farm/lib/tower-client.ts`** (NEW - CLI auth integration)
   - Create tower API client for CLI commands
   - Read local key from `~/.agent-farm/local-key`
   - Auto-create local key if missing (random 32-byte hex)
   - Include `codev-web-key` header in all requests
   - Reuse client across `af dash start|stop|status` commands

### CLI Auth Integration Detail (Codex feedback)

```typescript
// lib/tower-client.ts
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { randomBytes } from 'crypto';

const LOCAL_KEY_PATH = resolve(process.env.HOME!, '.agent-farm/local-key');

function getLocalKey(): string {
  if (!existsSync(LOCAL_KEY_PATH)) {
    const key = randomBytes(32).toString('hex');
    writeFileSync(LOCAL_KEY_PATH, key, { mode: 0o600 });
    return key;
  }
  return readFileSync(LOCAL_KEY_PATH, 'utf-8').trim();
}

export async function towerRequest(path: string, options: RequestInit = {}) {
  const localKey = getLocalKey();
  return fetch(`http://localhost:4100${path}`, {
    ...options,
    headers: {
      ...options.headers,
      'codev-web-key': localKey,
    },
  });
}
```

### CLI Unit Tests

```typescript
// packages/codev/src/agent-farm/__tests__/cli-tower-mode.test.ts

describe('CLI Tower Mode', () => {
  describe('af dash start', () => {
    it('starts tower if not running')
    it('calls activate API')
    it('opens browser to tower URL')
    it('respects --no-browser flag')
  });

  describe('af dash stop', () => {
    it('calls deactivate API')
    it('does not stop tower')
    it('handles tower not running gracefully')
  });

  describe('af status', () => {
    it('queries tower API when tower running')
    it('shows "Tower not running" when tower down')
    it('shows all active projects and terminals')
  });

  // Remote workflow (Codex feedback)
  describe('af dash start --remote', () => {
    it('SSHs to remote host and starts tower')
    it('sets up SSH tunnel to tower port')
    it('opens local browser to tunneled port')
    it('handles SSH connection failure gracefully')
    it('handles remote tower already running')
    it('respects --port flag for tunnel')
    it('cleans up tunnel on Ctrl+C')
  });

  // CLI auth integration (Codex feedback)
  describe('tower-client auth', () => {
    it('creates local-key file if missing')
    it('reads existing local-key file')
    it('includes codev-web-key header in requests')
    it('handles 401 response with clear error message')
  });
});
```

### Tests for Phase 3

```typescript
describe('af dash via Tower (Phase 3)', () => {
  it('af dash start calls tower API when tower running')
  it('af dash start starts tower if not running')
  it('af dash stop deactivates project via tower')
  it('af dash stop does not stop tower')
  it('browser opens to tower URL with project path')
  it('af status shows tower-managed state')
});
```

## Phase 4: Cleanup and Migration

Migrate any existing state.db files to global.db for projects that existed before tower architecture.

**Migration execution:** Runs automatically on first `af tower start` after upgrade. Safe to run multiple times (idempotent).

### Files to Delete

- `packages/codev/src/agent-farm/servers/dashboard-server.ts` - No longer needed

### Migration Script

```typescript
// packages/codev/src/agent-farm/db/migrate-to-global.ts

interface MigrationResult {
  success: boolean;
  projectPath: string;
  recordsMigrated: number;
  error?: string;
}

async function migrateProjectState(projectPath: string): Promise<MigrationResult> {
  const localDbPath = resolve(projectPath, '.agent-farm/state.db');

  // Check if already migrated
  const migrated = globalDb.prepare(
    'SELECT 1 FROM project_migrations WHERE path = ?'
  ).get(projectPath);
  if (migrated) {
    return { success: true, projectPath, recordsMigrated: 0 };
  }

  // Check if local db exists
  if (!existsSync(localDbPath)) {
    return { success: true, projectPath, recordsMigrated: 0 };
  }

  const localDb = new Database(localDbPath, { readonly: true });

  try {
    // Begin transaction for atomicity
    globalDb.exec('BEGIN TRANSACTION');

    // Migrate architect
    const architect = localDb.prepare('SELECT * FROM architect').get();
    if (architect) {
      globalDb.prepare(`
        INSERT OR REPLACE INTO architects (project_path, pid, terminal_id, tmux_session, started_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(projectPath, architect.pid, architect.terminal_id, architect.tmux_session, architect.started_at);
    }

    // Migrate builders
    const builders = localDb.prepare('SELECT * FROM builders').all();
    for (const builder of builders) {
      globalDb.prepare(`
        INSERT OR REPLACE INTO builders (id, project_path, name, worktree, branch, pid, terminal_id, tmux_session, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(builder.id, projectPath, builder.name, builder.worktree, builder.branch,
             builder.pid, builder.terminal_id, builder.tmux_session, builder.started_at);
    }

    // Migrate utils/shells
    const utils = localDb.prepare('SELECT * FROM utils').all();
    for (const util of utils) {
      globalDb.prepare(`
        INSERT OR REPLACE INTO terminals (id, project_path, type, name, terminal_id, tmux_session, started_at)
        VALUES (?, ?, 'shell', ?, ?, ?, ?)
      `).run(util.id, projectPath, util.name, util.terminal_id, util.tmux_session, util.started_at);
    }

    // Mark migration complete
    globalDb.prepare(
      'INSERT INTO project_migrations (path, migrated_at) VALUES (?, datetime("now"))'
    ).run(projectPath);

    globalDb.exec('COMMIT');

    const total = (architect ? 1 : 0) + builders.length + utils.length;
    return { success: true, projectPath, recordsMigrated: total };

  } catch (error) {
    globalDb.exec('ROLLBACK');
    return { success: false, projectPath, recordsMigrated: 0, error: String(error) };
  } finally {
    localDb.close();
  }
}

// Run migration for all known projects
async function migrateAllProjects(): Promise<MigrationResult[]> {
  const projects = globalDb.prepare('SELECT path FROM port_allocations').all();
  const results: MigrationResult[] = [];

  for (const project of projects) {
    const result = await migrateProjectState(project.path);
    results.push(result);
    if (result.success) {
      console.log(`[ok] Migrated ${project.path}: ${result.recordsMigrated} records`);
    } else {
      console.error(`[error] Failed to migrate ${project.path}: ${result.error}`);
    }
  }

  return results;
}
```

### Migration Tests

```typescript
// packages/codev/src/agent-farm/__tests__/migration.test.ts

describe('State Migration (Phase 4)', () => {
  describe('migrateProjectState', () => {
    it('migrates architect record to global.db')
    it('migrates builders to global.db with project_path')
    it('migrates shells to terminals table')
    it('skips already-migrated projects')
    it('handles missing state.db gracefully')
    it('rolls back on partial failure')
    it('preserves original state.db as backup')
  });

  describe('migrateAllProjects', () => {
    it('migrates all known projects')
    it('continues after individual project failures')
    it('reports summary of successes and failures')
  });

  describe('edge cases', () => {
    it('handles corrupted state.db')
    it('handles concurrent migration attempts')
    it('handles disk full during migration')
  });
});
```

### Tests for Phase 4

```typescript
describe('Tower-Only Mode (Phase 4)', () => {
  it('all baseline tests still pass')
  it('no dashboard-server processes spawned')
  it('all state in global.db')
  it('project state survives tower restart')
  it('migration runs automatically on first tower start')
  it('old state.db files preserved as backup')
});
```

## Rollback Plan

Each phase can be rolled back to the previous phase if issues found:
- Phase 1 → revert to pre-tower (git revert)
- Phase 2 → Phase 1 (remove PTY management from tower)
- Phase 3 → Phase 2 (revert CLI changes)
- Phase 4 → Phase 3 (keep dashboard-server.ts, don't run migration)

## Timeline

| Phase | Description | Estimated LOC | Tests |
|-------|-------------|---------------|-------|
| 0 | Baseline tests (current behavior ONLY) | ~200 | E2E baseline |
| 1 | API layer + static serving + auth + rate limit + React updates + /health | ~550 | API + auth + rate limit + Playwright |
| 2 | PtyManager in tower + tower stop + crash recovery | ~550 | Terminal + shutdown + hardening tests |
| 3 | Migrate CLI commands + remote workflow + tower-client auth | ~400 | CLI unit + remote + auth tests |
| 4 | Cleanup + migration + observability docs | ~350 | Migration tests |

Total: ~2,050 lines of new/changed code

## Test Summary

| Category | Count | Location |
|----------|-------|----------|
| E2E Baseline (current behavior only) | ~17 | `__tests__/e2e/tower-integration.test.ts` |
| API Unit (+ auth + rate limit + errors) | ~22 | `__tests__/tower-api.test.ts` |
| Terminal (+ tower stop) | ~18 | `__tests__/tower-terminals.test.ts` |
| CLI Unit (+ remote + auth) | ~23 | `__tests__/cli-tower-mode.test.ts` |
| React Dashboard (Playwright) | ~5 | `dashboard/__tests__/tower-mode.spec.ts` |
| Migration | ~12 | `__tests__/migration.test.ts` |
| Operational Hardening | ~5 | `__tests__/tower-health.test.ts` |

Total: ~102 new tests (baseline tests verify current behavior; new feature tests paired with implementation phases)

## Operational Hardening

**Phase ownership:**
- `/health` endpoint is in **Phase 1** (basic API layer)
- Crash recovery is in **Phase 2** (alongside PTY management)
- Process supervision docs are in **Phase 4**

### Phase 2 Hardening (alongside PTY management)

1. **Crash recovery**
   - On startup, detect orphaned tmux sessions and reconnect
   - Log restart count and previous crash reason if available
   - Mark stale terminals in database for cleanup

### Phase 4 Hardening (documentation and observability)

1. **Process supervision docs**
   - Document launchd plist for macOS
   - Document systemd unit for Linux

2. **Observability**
   - Emit structured logs for monitoring integration
   - Expose stale terminal list via `GET /api/stale-terminals`

### Tests for Hardening (Phase 2)

```typescript
describe('Operational Hardening (Phase 2)', () => {
  it('GET /health returns 200 when healthy')
  it('GET /health returns 503 during startup')
  it('GET /health returns metrics (terminals, memory, uptime)')
  it('tower logs restart count on startup')
  it('tower reconnects to orphaned tmux sessions')
});
```

## Dependencies

- Spec 0085 (node-pty rewrite) - DONE
- Existing tower-server.ts infrastructure
- Existing PtyManager implementation
- Existing React dashboard (verify project list renders from tower API)

## Success Metrics

1. All Phase 0 baseline tests pass after refactor
2. `af tower start && af dash start` works
3. No more "No terminal session" errors from stale state
4. Single process manages all terminals
5. Clean `af tower stop` kills all terminals
6. `af status` shows consistent state from tower
7. Migration completes without data loss
