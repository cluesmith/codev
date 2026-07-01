/**
 * Issue #1118 — tests for the state.db → global.db consolidation engine.
 *
 * Covers: clean one-off copy into an empty target, defensive reads of legacy
 * (pre-#1118) state.db shapes with workspace_path synthesis, upsert-if-newer
 * conflict resolution for satellite imports, cross-workspace builder isolation,
 * and source-rename / marker idempotency.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import {
  planMigration,
  applyMigration,
  isConsolidationDone,
  runBootConsolidation,
} from '../db/consolidate.js';

const testDir = resolve(process.cwd(), '.test-consolidate');

/** A fresh global.db (in a temp dir) with the production GLOBAL_SCHEMA. */
function makeGlobalDb(): Database.Database {
  const db = new Database(join(testDir, 'global.db'));
  db.exec(GLOBAL_SCHEMA);
  return db;
}

/**
 * Build a legacy state.db at `<workspace>/.agent-farm/state.db`. `shape` selects
 * the historical schema: 'current' = post-#826 architect (workspace_path) +
 * id-PK builders; 'pre-v11' = integer-id architect with NO workspace_path.
 */
function makeLegacyStateDb(
  workspace: string,
  shape: 'current' | 'pre-v11',
  seed: (db: Database.Database) => void,
): string {
  const dir = join(workspace, '.agent-farm');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'state.db');
  const db = new Database(path);
  if (shape === 'current') {
    db.exec(`
      CREATE TABLE architect (
        workspace_path TEXT NOT NULL, id TEXT NOT NULL, pid INTEGER NOT NULL,
        port INTEGER NOT NULL, cmd TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        terminal_id TEXT, session_id TEXT, PRIMARY KEY (workspace_path, id)
      );
      CREATE TABLE builders (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 0,
        pid INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'spawning',
        phase TEXT NOT NULL DEFAULT '', worktree TEXT NOT NULL, branch TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'spec', task_text TEXT, protocol_name TEXT,
        issue_number TEXT, terminal_id TEXT, spawned_by_architect TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE utils (id TEXT PRIMARY KEY, name TEXT NOT NULL, port INTEGER, pid INTEGER, terminal_id TEXT, started_at TEXT);
      CREATE TABLE annotations (id TEXT PRIMARY KEY, file TEXT NOT NULL, port INTEGER, pid INTEGER, parent_type TEXT, parent_id TEXT, started_at TEXT);
    `);
  } else {
    // Pre-v11: architect is the integer-id singleton with no workspace_path.
    db.exec(`
      CREATE TABLE architect (
        id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, port INTEGER NOT NULL,
        cmd TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT (datetime('now')), terminal_id TEXT
      );
      CREATE TABLE builders (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 0,
        pid INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'spawning',
        phase TEXT NOT NULL DEFAULT '', worktree TEXT NOT NULL, branch TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'spec', task_text TEXT, protocol_name TEXT,
        issue_number TEXT, started_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
  seed(db);
  db.close();
  return path;
}

describe('Issue #1118 — consolidation engine', () => {
  let globalDb: Database.Database;
  const wsA = join(testDir, 'ws-a');
  const wsB = join(testDir, 'ws-b');

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(wsA, { recursive: true });
    mkdirSync(wsB, { recursive: true });
    globalDb = makeGlobalDb();
  });

  afterEach(() => {
    globalDb.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it('migrates a current-shape state.db into an empty global.db (clean copy)', () => {
    const src = makeLegacyStateDb(wsA, 'current', (db) => {
      db.prepare(
        "INSERT INTO architect (workspace_path, id, pid, port, cmd, started_at) VALUES (?, 'main', 1, 0, 'claude', '2026-06-01 10:00:00')",
      ).run(realpathSync(wsA));
      db.prepare(
        "INSERT INTO builders (id, name, worktree, branch, spawned_by_architect, started_at) VALUES ('pir-100', 'b', ?, 'main', 'main', '2026-06-01 10:00:00')",
      ).run(join(wsA, '.builders', 'pir-100'));
    });

    const result = applyMigration(globalDb, src);

    expect(result.migrated).toBe(true);
    expect(result.renamedTo).toMatch(/\.pre-merge-/);
    expect(existsSync(src)).toBe(false); // source renamed, not deleted
    expect(existsSync(result.renamedTo!)).toBe(true);

    const arch = globalDb
      .prepare("SELECT * FROM architect WHERE workspace_path = ? AND id = 'main'")
      .get(realpathSync(wsA)) as { cmd: string } | undefined;
    expect(arch?.cmd).toBe('claude');

    const builder = globalDb
      .prepare('SELECT * FROM builders WHERE workspace_path = ? AND id = ?')
      .get(realpathSync(wsA), 'pir-100') as { spawned_by_architect: string } | undefined;
    expect(builder?.spawned_by_architect).toBe('main');
  });

  it('synthesizes workspace_path for a pre-v11 (no workspace_path) state.db', () => {
    const src = makeLegacyStateDb(wsA, 'pre-v11', (db) => {
      db.prepare(
        "INSERT INTO architect (id, pid, port, cmd, started_at) VALUES (1, 1, 0, 'legacy-claude', '2026-06-01 10:00:00')",
      ).run();
      db.prepare(
        "INSERT INTO builders (id, name, worktree, branch, started_at) VALUES ('bugfix-7', 'b', ?, 'main', '2026-06-01 10:00:00')",
      ).run(join(wsA, '.builders', 'bugfix-7'));
    });

    applyMigration(globalDb, src);

    // Integer id=1 → 'main'; workspace_path synthesized from the file's directory.
    const arch = globalDb
      .prepare("SELECT * FROM architect WHERE workspace_path = ? AND id = 'main'")
      .get(realpathSync(wsA)) as { cmd: string } | undefined;
    expect(arch?.cmd).toBe('legacy-claude');

    // Builder workspace_path derived from its worktree (<ws>/.builders/<id>).
    const builder = globalDb
      .prepare('SELECT * FROM builders WHERE workspace_path = ? AND id = ?')
      .get(realpathSync(wsA), 'bugfix-7') as object | undefined;
    expect(builder).toBeDefined();
  });

  it('keeps same-id builders in different workspaces distinct', () => {
    const srcA = makeLegacyStateDb(wsA, 'current', (db) => {
      db.prepare(
        "INSERT INTO builders (id, name, worktree, branch, spawned_by_architect, started_at) VALUES ('bugfix-100', 'a', ?, 'main', 'sibling', '2026-06-01 10:00:00')",
      ).run(join(wsA, '.builders', 'bugfix-100'));
    });
    const srcB = makeLegacyStateDb(wsB, 'current', (db) => {
      db.prepare(
        "INSERT INTO builders (id, name, worktree, branch, spawned_by_architect, started_at) VALUES ('bugfix-100', 'b', ?, 'main', 'main', '2026-06-01 10:00:00')",
      ).run(join(wsB, '.builders', 'bugfix-100'));
    });

    applyMigration(globalDb, srcA);
    applyMigration(globalDb, srcB);

    const both = globalDb
      .prepare("SELECT workspace_path, spawned_by_architect FROM builders WHERE id = 'bugfix-100' ORDER BY workspace_path")
      .all() as Array<{ workspace_path: string; spawned_by_architect: string }>;
    expect(both).toHaveLength(2);
    const byWs = Object.fromEntries(both.map((r) => [r.workspace_path, r.spawned_by_architect]));
    expect(byWs[realpathSync(wsA)]).toBe('sibling');
    expect(byWs[realpathSync(wsB)]).toBe('main');
  });

  it('resolves conflicts by latest started_at (upsert-if-newer) on satellite import', () => {
    // global.db already has a FRESH architect row for wsA.
    globalDb
      .prepare(
        "INSERT INTO architect (workspace_path, id, pid, port, cmd, started_at) VALUES (?, 'main', 1, 0, 'fresh', '2026-06-10 10:00:00')",
      )
      .run(realpathSync(wsA));

    // A satellite state.db carries an OLDER copy of the same row.
    const src = makeLegacyStateDb(wsB, 'current', (db) => {
      db.prepare(
        "INSERT INTO architect (workspace_path, id, pid, port, cmd, started_at) VALUES (?, 'main', 1, 0, 'stale', '2026-06-01 10:00:00')",
      ).run(realpathSync(wsA));
    });

    const result = applyMigration(globalDb, src);

    // Fresh row survives; stale satellite copy skipped.
    const arch = globalDb
      .prepare("SELECT cmd FROM architect WHERE workspace_path = ? AND id = 'main'")
      .get(realpathSync(wsA)) as { cmd: string };
    expect(arch.cmd).toBe('fresh');
    expect(result.stats.find((s) => s.table === 'architect')?.skipped).toBe(1);
  });

  it('planMigration is a pure preview — counts rows, writes nothing, no rename', () => {
    const src = makeLegacyStateDb(wsA, 'current', (db) => {
      db.prepare(
        "INSERT INTO architect (workspace_path, id, pid, port, cmd, started_at) VALUES (?, 'main', 1, 0, 'claude', '2026-06-01 10:00:00')",
      ).run(realpathSync(wsA));
    });

    const plan = planMigration(globalDb, src);

    expect(plan.exists).toBe(true);
    expect(plan.total).toBe(1);
    expect(plan.stats.find((s) => s.table === 'architect')?.inserted).toBe(1);
    expect(existsSync(src)).toBe(true); // not renamed
    expect(globalDb.prepare('SELECT COUNT(*) AS n FROM architect').get()).toEqual({ n: 0 }); // no writes
  });

  it('marker idempotency: isConsolidationDone flips after the marker is written', () => {
    expect(isConsolidationDone(globalDb)).toBe(false);
    globalDb
      .prepare('INSERT INTO _consolidation (id, source_path, rows_migrated) VALUES (1, ?, 0)')
      .run('/some/state.db');
    expect(isConsolidationDone(globalDb)).toBe(true);
  });

  it('re-applying a satellite is a no-op (source already renamed, rows already newest)', () => {
    const src = makeLegacyStateDb(wsA, 'current', (db) => {
      db.prepare(
        "INSERT INTO architect (workspace_path, id, pid, port, cmd, started_at) VALUES (?, 'main', 1, 0, 'claude', '2026-06-01 10:00:00')",
      ).run(realpathSync(wsA));
    });

    applyMigration(globalDb, src);
    // Source is gone; a second apply on the same path is a clean no-op.
    const second = applyMigration(globalDb, src);
    expect(second.migrated).toBe(false);

    // Only one pre-merge file, one architect row.
    const renamed = readdirSync(join(wsA, '.agent-farm')).filter((f) => f.includes('.pre-merge-'));
    expect(renamed).toHaveLength(1);
    expect(globalDb.prepare('SELECT COUNT(*) AS n FROM architect').get()).toEqual({ n: 1 });
  });
});

// The actual boot path (wired into tower-server.ts). Exercises the real
// activeStateDbPath() (getConfig().stateDir resolved from cwd) + strict marker.
describe('Issue #1118 — runBootConsolidation (strict boot one-off)', () => {
  const origCwd = process.cwd();
  let bootDir: string;
  let globalDb: Database.Database;

  beforeEach(() => {
    bootDir = mkdtempSync(join(tmpdir(), 'boot-consolidation-'));
    mkdirSync(join(bootDir, 'codev'), { recursive: true }); // findWorkspaceRoot marker
    mkdirSync(join(bootDir, '.agent-farm'), { recursive: true });
    process.chdir(bootDir);
    globalDb = new Database(':memory:');
    globalDb.exec(GLOBAL_SCHEMA);
  });

  afterEach(() => {
    process.chdir(origCwd);
    globalDb.close();
    rmSync(bootDir, { recursive: true, force: true });
  });

  /** Seed the active state.db (the file activeStateDbPath() resolves to). */
  function seedActiveStateDb(): string {
    const p = join(bootDir, '.agent-farm', 'state.db');
    const s = new Database(p);
    s.exec(GLOBAL_SCHEMA);
    s.prepare(
      "INSERT INTO architect (workspace_path, id, pid, port, cmd, started_at) VALUES (?, 'main', 1, 0, 'claude', '2026-06-01 10:00:00')",
    ).run(realpathSync(bootDir));
    s.close();
    return p;
  }

  it('first boot migrates the active state.db, sets the marker, and renames the source', () => {
    const src = seedActiveStateDb();
    const result = runBootConsolidation(globalDb);

    expect(result?.migrated).toBe(true);
    expect(isConsolidationDone(globalDb)).toBe(true);
    expect(existsSync(src)).toBe(false); // renamed to *.pre-merge-*
    expect(globalDb.prepare('SELECT COUNT(*) AS n FROM architect').get()).toEqual({ n: 1 });
  });

  it('is a no-op once the marker is set — does not reopen/re-migrate state.db', () => {
    seedActiveStateDb();
    runBootConsolidation(globalDb); // first boot sets the marker

    // A new active state.db appears; the marker means it is NOT touched.
    const src2 = seedActiveStateDb();
    expect(runBootConsolidation(globalDb)).toBeNull();
    expect(existsSync(src2)).toBe(true); // untouched
    expect(globalDb.prepare('SELECT COUNT(*) AS n FROM architect').get()).toEqual({ n: 1 });
  });

  it('strict: marks done even when the active state.db is absent (then no-ops)', () => {
    // No state.db seeded at all.
    const result = runBootConsolidation(globalDb);

    expect(result?.migrated).toBe(false);
    expect(isConsolidationDone(globalDb)).toBe(true); // marked done regardless
    expect(runBootConsolidation(globalDb)).toBeNull(); // subsequent boots no-op
  });
});
