# Implementation Plan: SQLite for Runtime State

## Metadata
- **ID**: 0031
- **Spec**: codev/specs/0031-sqlite-runtime-state.md
- **Protocol**: SPIR
- **Created**: 2025-12-05

## Overview

Replace JSON-based runtime state with SQLite for ACID guarantees and proper concurrency handling.

## Phase 1: Setup & Dependencies (1 task)

### Task 1.1: Add better-sqlite3 dependency

**Files**: `agent-farm/package.json`

```bash
cd agent-farm
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

**Verification**: `npm run build` succeeds with no type errors

---

## Phase 2: Database Layer (4 tasks)

### Task 2.1: Create database module with schemas

**Files**: `agent-farm/src/db/index.ts`, `agent-farm/src/db/schema.ts`

Create new `db/` directory with:
- Schema definitions (LOCAL_SCHEMA, GLOBAL_SCHEMA)
- Singleton DB access (`getDb()`, `getGlobalDb()`)
- `closeDb()` for cleanup
- Pragma configuration (WAL, busy_timeout, etc.)

**Key code from spec**:
- `_migrations` table for versioning
- `busy_timeout = 5000` pragma
- WAL mode with fallback warning

### Task 2.2: Create migration functions

**Files**: `agent-farm/src/db/migrate.ts`

Implement:
- `migrateLocalFromJson(db, jsonPath)` - state.json → state.db
- `migrateGlobalFromJson(db, jsonPath)` - ports.json → global.db
- Transaction-wrapped migration
- Copy-then-delete strategy (keep .bak)

### Task 2.3: Create error handling utilities

**Files**: `agent-farm/src/db/errors.ts`

Implement:
- `withRetry<T>()` for SQLITE_BUSY handling
- Clear error messages for compilation failures
- Migration failure handling

### Task 2.4: Add database types

**Files**: `agent-farm/src/db/types.ts`

TypeScript interfaces matching SQLite schema:
- `DbArchitect`, `DbBuilder`, `DbUtil`, `DbAnnotation`
- `DbPortAllocation`
- Conversion functions to/from existing types

---

## Phase 3: State Module Refactor (4 tasks)

### Task 3.1: Refactor state.ts to use SQLite

**Files**: `agent-farm/src/state.ts`

Replace JSON operations with SQLite:
- `loadState()` → `SELECT` queries
- `saveState()` → removed (direct operations)
- `upsertBuilder()` → `INSERT ... ON CONFLICT`
- `removeBuilder()` → `DELETE`
- `setArchitect()` → `INSERT OR REPLACE`
- All functions become **sync** (remove `async/await`)

**Critical**: Update all callsites to remove `await`

### Task 3.2: Refactor port-registry.ts to use SQLite

**Files**: `agent-farm/src/utils/port-registry.ts`

Replace file-based locking with SQLite:
- `getPortBlock()` → `BEGIN IMMEDIATE` transaction
- `listAllocations()` → `SELECT` query
- `cleanupStaleEntries()` → `DELETE` with PID check
- Remove `.lock` file logic entirely

### Task 3.3: Update type definitions

**Files**: `agent-farm/src/types.ts`

Ensure types match new schema:
- `Builder.status` must match CHECK constraint values
- Add any missing fields

### Task 3.4: Update all callsites (async → sync)

**Files**: Multiple files that call state functions

Search and update:
```bash
grep -r "await.*loadState\|await.*saveState\|await.*upsertBuilder" agent-farm/src/
```

Remove `await` from all state function calls.

---

## Phase 4: CLI Commands (3 tasks)

### Task 4.1: Add `af db dump` command

**Files**: `agent-farm/src/commands/db.ts`, `agent-farm/src/index.ts`

Implement command to export all tables to JSON:
- `--global` flag for global.db
- Excludes `_migrations` table
- JSON output to stdout

### Task 4.2: Add `af db query` command

**Files**: `agent-farm/src/commands/db.ts`

Implement command for ad-hoc queries:
- Only allows SELECT queries (safety)
- `--global` flag
- JSON output

### Task 4.3: Add `af db reset` command

**Files**: `agent-farm/src/commands/db.ts`

Implement command to reset database:
- Confirmation prompt (unless `--force`)
- Removes .db, .db-wal, .db-shm files
- `--global` flag

---

## Phase 5: Testing (5 tasks)

### Task 5.1: Unit tests for database layer

**Files**: `agent-farm/src/__tests__/db.test.ts`

Tests:
1. Fresh DB creates all tables with correct schema
2. `_migrations` table tracks versions
3. Singleton pattern works correctly
4. `closeDb()` properly closes connection

### Task 5.2: Unit tests for state operations

**Files**: `agent-farm/src/__tests__/state.test.ts` (update existing)

Tests:
1. `upsertBuilder()` creates new builder
2. `upsertBuilder()` updates existing builder
3. `removeBuilder()` deletes builder
4. `setArchitect()` enforces singleton
5. UNIQUE constraint on ports throws
6. CHECK constraint on status throws for invalid values

### Task 5.3: Unit tests for migration

**Files**: `agent-farm/src/__tests__/migrate.test.ts`

Tests:
1. JSON → SQLite migration preserves all data
2. Migration creates .bak file
3. Migration removes original JSON
4. Migration idempotent (doesn't re-migrate)
5. Corrupt JSON fails gracefully (transaction rollback)

### Task 5.4: Concurrency tests

**Files**: `agent-farm/src/__tests__/concurrency.test.ts`

Tests:
1. **Parallel upserts**: Spawn 10 concurrent `upsertBuilder()`, verify all 10 builders exist
2. **Port allocation race**: Spawn 5 processes allocating ports, verify no duplicate ports
3. **Read during write**: One process holds transaction, another reads, no blocking beyond timeout

**Implementation approach**:
```typescript
// Use worker_threads or child_process to spawn parallel operations
import { Worker } from 'worker_threads';

test('parallel upserts all succeed', async () => {
  const workers = Array(10).fill(null).map((_, i) =>
    new Worker('./upsert-worker.js', { workerData: { builderId: `builder-${i}` }})
  );
  await Promise.all(workers.map(w => new Promise(r => w.on('exit', r))));

  const builders = db.prepare('SELECT COUNT(*) as count FROM builders').get();
  expect(builders.count).toBe(10);
});
```

### Task 5.5: Integration tests

**Files**: `agent-farm/src/__tests__/integration.test.ts`

Tests:
1. Full workflow: `af start` → `af spawn` → `af status` → `af cleanup`
2. Dashboard API reads builders correctly
3. Fresh install (no JSON, no DB) works
4. `af db dump` outputs valid JSON
5. `af db query "SELECT * FROM builders"` works

---

## Phase 6: Cleanup & Documentation (2 tasks)

### Task 6.1: Remove dead code

**Files**: Multiple

Remove:
- File locking code from port-registry.ts (`.lock` file logic)
- JSON read/write helpers if no longer used
- Any unused async wrappers

### Task 6.2: Update documentation

**Files**: `CHANGELOG.md`, `codev/DEPENDENCIES.md`

- Add entry to CHANGELOG for SQLite migration
- Add better-sqlite3 to DEPENDENCIES.md
- Note about .json.bak files being preserved

---

## Verification Checklist

Before marking complete:

- [ ] `npm run build` passes with no errors
- [ ] `npm test` passes all tests (including new ones)
- [ ] Manual test: `af start` works with fresh install (no JSON)
- [ ] Manual test: `af start` migrates existing JSON correctly
- [ ] Manual test: `af spawn` multiple builders, all appear in `af status`
- [ ] Manual test: `af db dump` shows all state
- [ ] Manual test: Kill process, restart, state preserved
- [ ] No race conditions in parallel builder spawns

---

## File Summary

### New Files
- `agent-farm/src/db/index.ts`
- `agent-farm/src/db/schema.ts`
- `agent-farm/src/db/migrate.ts`
- `agent-farm/src/db/errors.ts`
- `agent-farm/src/db/types.ts`
- `agent-farm/src/commands/db.ts`
- `agent-farm/src/__tests__/db.test.ts`
- `agent-farm/src/__tests__/migrate.test.ts`
- `agent-farm/src/__tests__/concurrency.test.ts`
- `agent-farm/src/__tests__/integration.test.ts`

### Modified Files
- `agent-farm/package.json` (add better-sqlite3)
- `agent-farm/src/state.ts` (refactor to SQLite)
- `agent-farm/src/utils/port-registry.ts` (refactor to SQLite)
- `agent-farm/src/types.ts` (update types)
- `agent-farm/src/index.ts` (add db commands)
- `agent-farm/src/__tests__/state.test.ts` (update tests)
- `CHANGELOG.md`
- `codev/DEPENDENCIES.md`

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| better-sqlite3 compilation fails | Provide clear error message with rebuild instructions |
| Tests are flaky on CI | Use in-memory DB for unit tests, file DB for integration |
| Migration breaks existing installs | JSON preserved as .bak, manual recovery documented |
| Async → sync refactor misses callsites | Use grep to find all usages, TypeScript will error on `await` of non-Promise |

---

## Estimated Complexity

- **Phase 1**: Low (dependency install)
- **Phase 2**: Medium (new module, but spec has code samples)
- **Phase 3**: Medium-High (refactor with many callsites)
- **Phase 4**: Low (simple CLI commands)
- **Phase 5**: High (concurrency tests are tricky)
- **Phase 6**: Low (cleanup)

**Total**: ~400-500 lines of new code, ~200 lines modified
