# Specification: SQLite for Runtime State

## Metadata
- **ID**: 0031
- **Protocol**: SPIR
- **Status**: specified
- **Created**: 2025-12-05
- **Priority**: high
- **Review**: 3-way (Gemini: APPROVE, Codex: REQUEST_CHANGES, Claude: REQUEST_CHANGES)

## Problem Statement

Agent-farm's runtime state is stored in JSON files that lack proper concurrency controls:

1. **`.agent-farm/state.json`** - Dashboard state (architect, builders, utils, annotations)
   - Multiple builders can call `upsertBuilder()` concurrently
   - Each call does `loadState()` → modify → `saveState()`
   - Race condition: two builders load same state, both modify, last write wins (data loss)

2. **`~/.agent-farm/ports.json`** - Global port registry
   - Has custom file locking (`.lock` file with timeout)
   - Lock is advisory only, not atomic
   - Stale lock detection is time-based (30s), which is fragile

### Evidence of the Problem

From `state.ts:69-80`:
```typescript
export async function upsertBuilder(builder: Builder): Promise<void> {
  const state = await loadState();  // <- Read
  const index = state.builders.findIndex((b) => b.id === builder.id);
  if (index >= 0) {
    state.builders[index] = builder;
  } else {
    state.builders.push(builder);
  }
  await saveState(state);  // <- Write (no lock between read and write!)
}
```

If Builder A and Builder B both call `upsertBuilder()` at the same time:
1. A loads state: `{builders: [X]}`
2. B loads state: `{builders: [X]}`
3. A adds itself: `{builders: [X, A]}`
4. B adds itself: `{builders: [X, B]}`
5. A saves: `{builders: [X, A]}`
6. B saves: `{builders: [X, B]}` ← A is lost!

## Current State

### Files Affected

| File | Purpose | Concurrency |
|------|---------|-------------|
| `.agent-farm/state.json` | Dashboard state | None (race conditions possible) |
| `~/.agent-farm/ports.json` | Global port registry | Advisory file lock |

### Current Implementation

- `agent-farm/src/state.ts` - Simple JSON read/write, no locking
- `agent-farm/src/utils/port-registry.ts` - File locking with `.lock` file
- Both use synchronous `JSON.parse`/`JSON.stringify` with no transactions

## Desired State

Replace JSON files with SQLite databases:
- `.agent-farm/state.db` - Local runtime state (per-project)
- `~/.agent-farm/global.db` - Global port registry (shared across projects)

### Benefits

1. **ACID transactions** - No partial writes, no race conditions
2. **WAL mode** - Concurrent reads with serialized writes (note: writers still queue)
3. **Schema constraints** - UNIQUE on ports, CHECK constraints on enums
4. **SQL queries** - `SELECT * FROM builders WHERE status='idle'` instead of jq
5. **No daemon** - SQLite is embedded, file-based
6. **Built-in** - Available on macOS/Linux, Node.js has `better-sqlite3`

## Success Criteria

- [ ] `.agent-farm/state.db` replaces `state.json`
- [ ] `~/.agent-farm/global.db` replaces `ports.json`
- [ ] All state operations use transactions
- [ ] WAL mode enabled with `busy_timeout` for contention handling
- [ ] Migration converts both local and global JSON to SQLite
- [ ] Schema versioning via `_migrations` table
- [ ] Backward compatibility: gracefully handle missing DB (fresh install)
- [ ] Tests verify concurrent access doesn't corrupt state
- [ ] Dashboard reads/writes work without race conditions
- [ ] Port allocation is atomic (uses `BEGIN IMMEDIATE`)
- [ ] `af db dump` command for debugging
- [ ] `af db query` command for ad-hoc queries

## Technical Approach

### Dependencies

Add `better-sqlite3` to agent-farm:
- Synchronous API (simpler, no callback hell)
- Native bindings (fast)
- Well-maintained, used by Electron, VS Code

```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

### Schema Design

#### Local State (`state.db`)

```sql
-- Schema versioning
CREATE TABLE IF NOT EXISTS _migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Architect session (singleton)
CREATE TABLE architect (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- Ensures singleton
  pid INTEGER NOT NULL,
  tmux_session TEXT NOT NULL,
  tmux_pane TEXT NOT NULL,
  port INTEGER NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Builder sessions
CREATE TABLE builders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  pid INTEGER,
  tmux_session TEXT NOT NULL,
  tmux_pane TEXT NOT NULL,
  port INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'initializing'
    CHECK(status IN ('initializing', 'idle', 'busy', 'blocked', 'failed', 'stopped')),
  protocol TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for common queries
CREATE INDEX idx_builders_status ON builders(status);
CREATE INDEX idx_builders_project_id ON builders(project_id);

-- Utility terminals
CREATE TABLE utils (
  id TEXT PRIMARY KEY,
  pid INTEGER,
  tmux_session TEXT NOT NULL,
  tmux_pane TEXT NOT NULL,
  port INTEGER NOT NULL UNIQUE,
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Annotations (file viewers)
CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  port INTEGER NOT NULL UNIQUE,
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Triggers for updated_at
CREATE TRIGGER builders_updated_at
  AFTER UPDATE ON builders
  BEGIN
    UPDATE builders SET updated_at = datetime('now') WHERE id = NEW.id;
  END;
```

#### Global Registry (`global.db`)

```sql
-- Schema versioning
CREATE TABLE IF NOT EXISTS _migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Port allocations
CREATE TABLE port_allocations (
  project_path TEXT PRIMARY KEY,
  base_port INTEGER NOT NULL UNIQUE
    CHECK(base_port >= 4200 AND base_port % 100 = 0),  -- Validate port blocks
  pid INTEGER,
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_port_allocations_base_port ON port_allocations(base_port);
```

### DB Handle Lifecycle

Use **singleton with lazy initialization**:

```typescript
let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    _db = ensureDatabase();
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
```

### API Changes

Replace current functions with transaction-wrapped versions:

```typescript
// Before (race condition, async)
export async function upsertBuilder(builder: Builder): Promise<void> {
  const state = await loadState();
  // ... modify ...
  await saveState(state);
}

// After (atomic, sync)
export function upsertBuilder(builder: Builder): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO builders (id, project_id, worktree_path, tmux_session, tmux_pane, port, status, protocol)
    VALUES (@id, @projectId, @worktreePath, @tmuxSession, @tmuxPane, @port, @status, @protocol)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      pid = excluded.pid,
      updated_at = datetime('now')
  `).run(builder);
}
```

### Transaction Boundaries

Multi-step operations must use explicit transactions:

```typescript
export function cleanupBuilder(builderId: string): void {
  const db = getDb();
  const cleanup = db.transaction(() => {
    db.prepare('DELETE FROM builders WHERE id = ?').run(builderId);
    // Any related cleanup...
  });
  cleanup();
}
```

### Port Allocation with BEGIN IMMEDIATE

Use `BEGIN IMMEDIATE` to serialize port allocation:

```typescript
export function allocatePortBlock(projectPath: string): number {
  const db = getGlobalDb();

  const allocate = db.transaction(() => {
    // Find next available port block
    const maxPort = db.prepare('SELECT MAX(base_port) as max FROM port_allocations').get() as { max: number | null };
    const nextPort = (maxPort.max ?? 4100) + 100;

    // Insert new allocation
    db.prepare(`
      INSERT INTO port_allocations (project_path, base_port, pid)
      VALUES (?, ?, ?)
    `).run(projectPath, nextPort, process.pid);

    return nextPort;
  });

  // BEGIN IMMEDIATE prevents race between SELECT MAX and INSERT
  return allocate.immediate();
}
```

### Migration Strategy

**Key principle**: Copy first, delete only after verification.

#### Local State Migration (`state.json` → `state.db`)

```typescript
function ensureLocalDatabase(): Database {
  const dbPath = resolve(config.stateDir, 'state.db');
  const jsonPath = resolve(config.stateDir, 'state.json');

  const db = new Database(dbPath);

  // Configure for concurrency
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');  // 5s timeout on lock
  db.pragma('foreign_keys = ON');

  // Verify WAL mode succeeded (fails on some filesystems)
  const journalMode = db.pragma('journal_mode', { simple: true });
  if (journalMode !== 'wal') {
    console.warn('[warn] WAL mode unavailable, using DELETE mode (concurrency limited)');
  }

  // Run schema
  db.exec(LOCAL_SCHEMA);

  // Check if migration needed (use DB-internal state)
  const migrated = db.prepare('SELECT version FROM _migrations WHERE version = 1').get();

  if (!migrated && existsSync(jsonPath)) {
    migrateLocalFromJson(db, jsonPath);
    db.prepare('INSERT INTO _migrations (version) VALUES (1)').run();
    // Keep .bak permanently for rollback
    copyFileSync(jsonPath, jsonPath + '.bak');
    unlinkSync(jsonPath);
  }

  return db;
}
```

#### Global State Migration (`ports.json` → `global.db`)

```typescript
function ensureGlobalDatabase(): Database {
  const dbPath = resolve(homedir(), '.agent-farm', 'global.db');
  const jsonPath = resolve(homedir(), '.agent-farm', 'ports.json');

  ensureDir(dirname(dbPath));

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  // Run schema
  db.exec(GLOBAL_SCHEMA);

  // Check if migration needed
  const migrated = db.prepare('SELECT version FROM _migrations WHERE version = 1').get();

  if (!migrated && existsSync(jsonPath)) {
    migrateGlobalFromJson(db, jsonPath);
    db.prepare('INSERT INTO _migrations (version) VALUES (1)').run();
    copyFileSync(jsonPath, jsonPath + '.bak');
    unlinkSync(jsonPath);
  }

  return db;
}
```

### Error Handling

#### Compilation Failure (`better-sqlite3`)

```typescript
try {
  const Database = require('better-sqlite3');
} catch (err) {
  console.error('[error] better-sqlite3 failed to load. Native compilation may have failed.');
  console.error('[error] Try: npm rebuild better-sqlite3');
  console.error('[error] Or install prebuilt: npm install better-sqlite3 --build-from-source=false');
  process.exit(1);
}
```

#### Lock Timeout (`SQLITE_BUSY`)

The `busy_timeout = 5000` pragma handles most cases. For extreme contention:

```typescript
function withRetry<T>(fn: () => T, maxRetries = 3): T {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return fn();
    } catch (err: any) {
      if (err.code === 'SQLITE_BUSY' && i < maxRetries - 1) {
        console.warn(`[warn] Database busy, retrying (${i + 1}/${maxRetries})...`);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}
```

#### Migration Failure

```typescript
function migrateLocalFromJson(db: Database, jsonPath: string): void {
  const jsonContent = readFileSync(jsonPath, 'utf-8');
  const state = JSON.parse(jsonContent);

  // Wrap in transaction for atomicity
  const migrate = db.transaction(() => {
    if (state.architect) {
      db.prepare('INSERT INTO architect ...').run(state.architect);
    }
    for (const builder of state.builders || []) {
      db.prepare('INSERT INTO builders ...').run(builder);
    }
    // ... utils, annotations
  });

  try {
    migrate();
  } catch (err) {
    console.error('[error] Migration failed. JSON file preserved.');
    console.error('[error] Manual recovery: delete state.db and restart');
    throw err;
  }
}
```

### Debugging Commands

Add to `agent-farm` CLI:

```typescript
// af db dump - Export all tables to JSON
program
  .command('db dump')
  .description('Export database state to JSON')
  .option('--global', 'Dump global.db instead of local state.db')
  .action((opts) => {
    const db = opts.global ? getGlobalDb() : getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_%'").all();
    const dump: Record<string, any[]> = {};
    for (const { name } of tables) {
      dump[name] = db.prepare(`SELECT * FROM ${name}`).all();
    }
    console.log(JSON.stringify(dump, null, 2));
  });

// af db query - Run arbitrary SELECT
program
  .command('db query <sql>')
  .description('Run a SELECT query against the database')
  .option('--global', 'Query global.db instead of local state.db')
  .action((sql, opts) => {
    if (!sql.trim().toLowerCase().startsWith('select')) {
      console.error('[error] Only SELECT queries allowed');
      process.exit(1);
    }
    const db = opts.global ? getGlobalDb() : getDb();
    const results = db.prepare(sql).all();
    console.log(JSON.stringify(results, null, 2));
  });

// af db reset - Delete DB and start fresh
program
  .command('db reset')
  .description('Delete database and start fresh (DESTRUCTIVE)')
  .option('--global', 'Reset global.db')
  .option('--force', 'Skip confirmation')
  .action((opts) => {
    if (!opts.force) {
      // prompt for confirmation
    }
    const dbPath = opts.global ? getGlobalDbPath() : getDbPath();
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
      unlinkSync(dbPath + '-wal');
      unlinkSync(dbPath + '-shm');
    }
    console.log('[ok] Database reset');
  });
```

## Out of Scope

- **projectlist.md** - Stays as markdown (git-versioned, human-editable)
- **Spec/plan/review files** - Stay as markdown
- **Remote/distributed access** - Single-host only for now
- **Soft deletes** - Can add later if history tracking needed

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Native dependency (`better-sqlite3`) requires compilation | Pre-built binaries available; clear error message if fails |
| DB corruption on crash | WAL mode + `synchronous=NORMAL` provides good durability |
| `SQLITE_BUSY` errors under contention | `busy_timeout=5000` + retry logic |
| Learning curve for SQL | Schema is simple, operations are CRUD |
| Debugging harder than JSON | `af db dump` and `af db query` commands |
| Migration fails mid-way | Transaction wraps migration; JSON preserved as `.bak` |
| Downgrade incompatibility | Keep `.json.bak` permanently; document in MIGRATION.md |
| WAL fails on NFS/network filesystems | Check and warn if WAL mode fails |

## Testing Requirements

### Unit Tests

1. **Schema creation** - Fresh DB creates all tables
2. **CRUD operations** - All state functions work correctly
3. **Constraint enforcement** - UNIQUE violations throw, CHECK constraints work
4. **Migration** - JSON → SQLite preserves all data

### Concurrency Tests

5. **Parallel upserts** - Spawn 10 concurrent `upsertBuilder()` calls, verify all builders appear
6. **Port allocation race** - Spawn 5 processes allocating ports simultaneously, verify no duplicates
7. **Read during write** - One process writes while another reads, no corruption

### Error Handling Tests

8. **Busy timeout** - Simulate long-running transaction, verify timeout works
9. **Migration rollback** - Corrupt JSON, verify migration fails gracefully
10. **Missing DB** - Delete DB mid-session, verify graceful recovery

### Integration Tests

11. **Full workflow** - `af start` → `af spawn` → `af status` → `af cleanup` with SQLite
12. **Dashboard reads** - Dashboard API reads from SQLite correctly
13. **Backward compatibility** - Fresh install (no JSON) works

## Decisions Made

Based on 3-way review feedback:

1. **`af db dump` command** - YES, essential for debugging (moved from Questions to Success Criteria)
2. **Auto-migration** - YES, with safeguards (copy then delete, transaction wrap)
3. **Indexes** - YES, on `builders.status` and `builders.project_id`
4. **`BEGIN IMMEDIATE`** - YES, for port allocation to prevent race
5. **`_migrations` table** - YES, for schema versioning instead of filesystem sentinel
6. **`busy_timeout`** - YES, 5000ms to handle contention
7. **Keep `.json.bak`** - YES, permanently for rollback capability

## References

- [better-sqlite3 documentation](https://github.com/WiseLibs/better-sqlite3)
- [SQLite WAL mode](https://www.sqlite.org/wal.html)
- [SQLite busy timeout](https://www.sqlite.org/pragma.html#pragma_busy_timeout)
- 3-way review: Gemini (APPROVE), Codex (REQUEST_CHANGES), Claude (REQUEST_CHANGES)
