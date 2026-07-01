/**
 * SQLite Database Module
 *
 * Provides singleton database access for both local state and global registry.
 * Uses better-sqlite3 for synchronous operations with proper concurrency handling.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { AGENT_FARM_DIR } from '../lib/tower-client.js';
import { GLOBAL_SCHEMA } from './schema.js';

// Singleton instance. Issue #1118: there is now a single user-global database
// (~/.agent-farm/global.db). getDb() and getGlobalDb() both return it; the
// retired per-workspace state.db is no longer opened.
let _globalDb: Database.Database | null = null;

/**
 * Ensure a directory exists
 */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Configure database pragmas for optimal concurrency and durability
 */
function configurePragmas(db: Database.Database): void {
  // Enable WAL mode for better concurrency (readers don't block writers)
  const journalMode = db.pragma('journal_mode = WAL', { simple: true });
  if (journalMode !== 'wal') {
    console.warn('[warn] WAL mode unavailable, using DELETE mode (concurrency limited)');
  }

  // NORMAL synchronous mode balances safety and performance
  db.pragma('synchronous = NORMAL');

  // 5 second timeout when waiting for locks
  db.pragma('busy_timeout = 5000');

  // Enable foreign key constraints
  db.pragma('foreign_keys = ON');
}

/**
 * Get the database instance.
 *
 * Issue #1118: state.db is retired. getDb() now returns the single user-global
 * global.db connection — the same instance as getGlobalDb(). Per-workspace rows
 * (architect, builders) are disambiguated by their `workspace_path` column
 * within the shared file, so the connection no longer depends on Tower's
 * start-cwd. Kept as a distinct export so the many existing callsites that read
 * dashboard state (architect/builders/utils/annotations) don't churn.
 */
export function getDb(): Database.Database {
  return getGlobalDb();
}

/**
 * Get the global database instance (global.db)
 * Creates and initializes the database if it doesn't exist
 */
export function getGlobalDb(): Database.Database {
  if (!_globalDb) {
    _globalDb = ensureGlobalDatabase();
  }
  return _globalDb;
}

/**
 * Close the database connection.
 * Issue #1118: getDb() aliases the global connection, so this closes the shared
 * global.db. Kept for callsites that historically closed "the local db".
 */
export function closeDb(): void {
  closeGlobalDb();
}

/**
 * Close the global database connection
 */
export function closeGlobalDb(): void {
  if (_globalDb) {
    _globalDb.close();
    _globalDb = null;
  }
}

/**
 * Close all database connections
 */
export function closeAllDbs(): void {
  closeDb();
  closeGlobalDb();
}

/**
 * Get the path to the database.
 * Issue #1118: the local db path is now the global db path.
 */
export function getDbPath(): string {
  return getGlobalDbPath();
}

/**
 * Get the path to the global database.
 * Uses per-test isolation when NODE_ENV=test:
 *   - AF_TEST_DB env var → custom DB name (e.g., "test-14500.db")
 *   - NODE_ENV=test without AF_TEST_DB → "test.db"
 *   - Production → "global.db"
 */
export function getGlobalDbPath(): string {
  let dbName = 'global.db';
  if (process.env.NODE_ENV === 'test') {
    dbName = process.env.AF_TEST_DB || 'test.db';
  }
  return resolve(AGENT_FARM_DIR, dbName);
}

/**
 * Initialize the global database (global.db)
 */
function ensureGlobalDatabase(): Database.Database {
  const dbPath = getGlobalDbPath();
  const globalDir = dirname(dbPath);

  // Ensure directory exists
  ensureDir(globalDir);

  // Create/open database
  const db = new Database(dbPath);
  configurePragmas(db);

  // Current migration version — bump when adding new migrations
  const GLOBAL_CURRENT_VERSION = 14;

  // Detect fresh vs existing database by checking if content tables exist.
  // On existing databases, GLOBAL_SCHEMA must NOT run because it references column names
  // (workspace_path) that don't exist until migration v9 renames them from project_path.
  // We check terminal_sessions (not _migrations) because _migrations could exist but be empty
  // in a partially-initialized legacy DB — running GLOBAL_SCHEMA on such a DB would fail
  // since CREATE INDEX on workspace_path would reference a non-existent column.
  const tableCheck = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='terminal_sessions'"
  ).get();
  const isFresh = !tableCheck;

  if (isFresh) {
    // Fresh install: create all tables at their latest state
    db.exec(GLOBAL_SCHEMA);
    // Mark all migrations as done — schema already reflects final state
    for (let v = 1; v <= GLOBAL_CURRENT_VERSION; v++) {
      db.prepare('INSERT OR IGNORE INTO _migrations (version) VALUES (?)').run(v);
    }
    console.log('[info] Created new global.db at', dbPath);
    return db;
  }

  // Existing database: only run migrations (skip GLOBAL_SCHEMA to avoid column name conflicts)
  // Ensure _migrations table exists for tracking
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Migration v2: No-op (previously added columns to port_allocations, now removed by Spec 0098)
  const v2 = db.prepare('SELECT version FROM _migrations WHERE version = 2').get();
  if (!v2) {
    db.prepare('INSERT INTO _migrations (version) VALUES (2)').run();
  }

  // Migration v3: Add terminal_sessions table (Spec 0090 TICK-001)
  const v3 = db.prepare('SELECT version FROM _migrations WHERE version = 3').get();
  if (!v3) {
    // Create terminal_sessions table if it doesn't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS terminal_sessions (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('architect', 'builder', 'shell')),
        role_id TEXT,
        pid INTEGER,
        tmux_session TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_terminal_sessions_project ON terminal_sessions(project_path);
      CREATE INDEX IF NOT EXISTS idx_terminal_sessions_type ON terminal_sessions(type);
    `);
    db.prepare('INSERT INTO _migrations (version) VALUES (3)').run();
    console.log('[info] Created terminal_sessions table (Spec 0090 TICK-001)');
  }

  // Migration v4: Add file_tabs table (Spec 0099 Phase 4)
  const v4 = db.prepare('SELECT version FROM _migrations WHERE version = 4').get();
  if (!v4) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_tabs (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_file_tabs_project ON file_tabs(project_path);
    `);
    db.prepare('INSERT INTO _migrations (version) VALUES (4)').run();
    console.log('[info] Created file_tabs table (Spec 0099 Phase 4)');
  }

  // Migration v5: Add known_projects table for persistent project registry
  const v5 = db.prepare('SELECT version FROM _migrations WHERE version = 5').get();
  if (!v5) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS known_projects (
        project_path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        last_launched_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Seed from existing terminal_sessions so current projects appear immediately
    db.exec(`
      INSERT OR IGNORE INTO known_projects (project_path, name, last_launched_at)
      SELECT DISTINCT project_path, '', datetime('now') FROM terminal_sessions;
    `);
    db.prepare('INSERT INTO _migrations (version) VALUES (5)').run();
    console.log('[info] Created known_projects table');
  }

  // Migration v6: Add shepherd columns to terminal_sessions (Spec 0104)
  const v6 = db.prepare('SELECT version FROM _migrations WHERE version = 6').get();
  if (!v6) {
    const cols = ['shepherd_socket TEXT', 'shepherd_pid INTEGER', 'shepherd_start_time INTEGER'];
    for (const col of cols) {
      try {
        db.exec(`ALTER TABLE terminal_sessions ADD COLUMN ${col}`);
      } catch {
        // Column already exists (fresh install ran updated schema)
      }
    }
    db.prepare('INSERT INTO _migrations (version) VALUES (6)').run();
    console.log('[info] Added shepherd columns to terminal_sessions (Spec 0104)');
  }

  // Migration v7: Drop tmux_session column from terminal_sessions (Spec 0104 Phase 4)
  const v7 = db.prepare('SELECT version FROM _migrations WHERE version = 7').get();
  if (!v7) {
    // SQLite table-rebuild pattern to drop the tmux_session column
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS terminal_sessions_new (
          id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('architect', 'builder', 'shell')),
          role_id TEXT,
          pid INTEGER,
          shepherd_socket TEXT,
          shepherd_pid INTEGER,
          shepherd_start_time INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO terminal_sessions_new
          SELECT id, project_path, type, role_id, pid, shepherd_socket, shepherd_pid, shepherd_start_time, created_at
          FROM terminal_sessions;
        DROP TABLE terminal_sessions;
        ALTER TABLE terminal_sessions_new RENAME TO terminal_sessions;
        CREATE INDEX IF NOT EXISTS idx_terminal_sessions_project ON terminal_sessions(project_path);
        CREATE INDEX IF NOT EXISTS idx_terminal_sessions_type ON terminal_sessions(type);
      `);
    } catch {
      // Table may already be in the correct schema (fresh install)
    }
    db.prepare('INSERT INTO _migrations (version) VALUES (7)').run();
    console.log('[info] Dropped tmux_session column from terminal_sessions (Spec 0104)');
  }

  // Migration v8: Rename shepherd_* columns to shellper_* (Spec 0106)
  const v8 = db.prepare('SELECT version FROM _migrations WHERE version = 8').get();
  if (!v8) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS terminal_sessions_new (
          id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('architect', 'builder', 'shell')),
          role_id TEXT,
          pid INTEGER,
          shellper_socket TEXT,
          shellper_pid INTEGER,
          shellper_start_time INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO terminal_sessions_new
          SELECT id, project_path, type, role_id, pid, shepherd_socket, shepherd_pid, shepherd_start_time, created_at
          FROM terminal_sessions;
        DROP TABLE terminal_sessions;
        ALTER TABLE terminal_sessions_new RENAME TO terminal_sessions;
        CREATE INDEX IF NOT EXISTS idx_terminal_sessions_project ON terminal_sessions(project_path);
        CREATE INDEX IF NOT EXISTS idx_terminal_sessions_type ON terminal_sessions(type);
        UPDATE terminal_sessions SET shellper_socket = REPLACE(shellper_socket, 'shepherd-', 'shellper-')
          WHERE shellper_socket LIKE '%shepherd-%';
      `);
    } catch {
      // Table may already be in the correct schema (fresh install)
    }
    // Rename physical socket files on disk
    try {
      const runDir = join(homedir(), '.codev', 'run');
      if (existsSync(runDir)) {
        const files = readdirSync(runDir);
        for (const file of files) {
          if (file.startsWith('shepherd-') && file.endsWith('.sock')) {
            const newName = file.replace('shepherd-', 'shellper-');
            try {
              renameSync(join(runDir, file), join(runDir, newName));
            } catch {
              // Skip files that can't be renamed (missing, permissions, etc.)
            }
          }
        }
      }
    } catch {
      // Skip if run directory doesn't exist or can't be read
    }
    db.prepare('INSERT INTO _migrations (version) VALUES (8)').run();
    console.log('[info] Renamed shepherd columns to shellper in terminal_sessions (Spec 0106)');
  }

  // Migration v9: Rename project_path → workspace_path in all tables (Spec 0112)
  // Note: Fresh installs never reach here (handled above), so old column names are guaranteed.
  // Wrapped in a transaction for atomicity — all three renames succeed or none do.
  const v9 = db.prepare('SELECT version FROM _migrations WHERE version = 9').get();
  if (!v9) {
    const migrate = db.transaction(() => {
      // 1. Rename terminal_sessions.project_path → workspace_path
      db.exec(`
        CREATE TABLE IF NOT EXISTS terminal_sessions_new (
          id TEXT PRIMARY KEY,
          workspace_path TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('architect', 'builder', 'shell')),
          role_id TEXT,
          pid INTEGER,
          shellper_socket TEXT,
          shellper_pid INTEGER,
          shellper_start_time INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO terminal_sessions_new
          SELECT id, project_path, type, role_id, pid, shellper_socket, shellper_pid, shellper_start_time, created_at
          FROM terminal_sessions;
        DROP TABLE terminal_sessions;
        ALTER TABLE terminal_sessions_new RENAME TO terminal_sessions;
        CREATE INDEX IF NOT EXISTS idx_terminal_sessions_workspace ON terminal_sessions(workspace_path);
        CREATE INDEX IF NOT EXISTS idx_terminal_sessions_type ON terminal_sessions(type);
      `);

      // 2. Rename file_tabs.project_path → workspace_path
      db.exec(`
        CREATE TABLE IF NOT EXISTS file_tabs_new (
          id TEXT PRIMARY KEY,
          workspace_path TEXT NOT NULL,
          file_path TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO file_tabs_new
          SELECT id, project_path, file_path, created_at
          FROM file_tabs;
        DROP TABLE file_tabs;
        ALTER TABLE file_tabs_new RENAME TO file_tabs;
        CREATE INDEX IF NOT EXISTS idx_file_tabs_workspace ON file_tabs(workspace_path);
      `);

      // 3. Rename known_projects → known_workspaces with project_path → workspace_path
      db.exec(`
        CREATE TABLE IF NOT EXISTS known_workspaces (
          workspace_path TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          last_launched_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO known_workspaces (workspace_path, name, last_launched_at)
          SELECT project_path, name, last_launched_at FROM known_projects;
        DROP TABLE IF EXISTS known_projects;
      `);

      db.prepare('INSERT INTO _migrations (version) VALUES (9)').run();
    });
    migrate();
    console.log('[info] Renamed project_path → workspace_path in global tables (Spec 0112)');
  }

  // Migration v10: Add cron_tasks table (Spec 399)
  const v10 = db.prepare('SELECT version FROM _migrations WHERE version = 10').get();
  if (!v10) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cron_tasks (
        id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        task_name TEXT NOT NULL,
        last_run INTEGER,
        last_result TEXT,
        last_output TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        UNIQUE(workspace_path, task_name)
      );
    `);
    db.prepare('INSERT INTO _migrations (version) VALUES (10)').run();
    console.log('[info] Created cron_tasks table (Spec 399)');
  }

  // Migration v11: Add label column to terminal_sessions (Spec 468)
  const v11 = db.prepare('SELECT version FROM _migrations WHERE version = 11').get();
  if (!v11) {
    try {
      db.exec(`ALTER TABLE terminal_sessions ADD COLUMN label TEXT`);
    } catch {
      // Column may already exist from a fresh install
    }
    db.prepare('INSERT INTO _migrations (version) VALUES (11)').run();
    console.log('[info] Added label column to terminal_sessions (Spec 468)');
  }

  // Migration v12: Add cwd column to terminal_sessions (Bugfix #506)
  const v12 = db.prepare('SELECT version FROM _migrations WHERE version = 12').get();
  if (!v12) {
    try {
      db.exec(`ALTER TABLE terminal_sessions ADD COLUMN cwd TEXT`);
    } catch {
      // Column may already exist from a fresh install
    }
    db.prepare('INSERT INTO _migrations (version) VALUES (12)').run();
    console.log('[info] Added cwd column to terminal_sessions (Bugfix #506)');
  }

  // Migration v13: Backfill terminal_sessions.role_id for legacy architect rows (Spec 755)
  // Pre-v13 rows for architects always stored role_id as NULL because there was only
  // ever one architect per workspace. Multi-architect support requires the name to be
  // present in role_id so reconnect can re-key the in-memory map. The idempotent
  // backfill sets role_id = 'main' for legacy rows; subsequent architect rows write
  // their explicit name and are unaffected.
  const v13 = db.prepare('SELECT version FROM _migrations WHERE version = 13').get();
  if (!v13) {
    db.prepare(`
      UPDATE terminal_sessions
         SET role_id = 'main'
       WHERE type = 'architect' AND role_id IS NULL
    `).run();
    db.prepare('INSERT INTO _migrations (version) VALUES (13)').run();
    console.log('[info] Backfilled architect role_id with \'main\' (Spec 755)');
  }

  // Migration v14: Absorb the retired state.db tables (Issue #1118).
  // Creates architect/builders/utils/annotations in global.db at their final
  // shape. architect/utils/annotations move as-is; builders is RESHAPED with a
  // workspace_path column + composite PK (workspace_path, id) so the same
  // builder id can exist in multiple workspaces. Idempotent via
  // `CREATE TABLE IF NOT EXISTS`. The one-time data migration of legacy
  // state.db files is a separate, marker-gated step run at Tower boot
  // (db/consolidate.ts) — NOT here — so opening global.db never moves data.
  const v14 = db.prepare('SELECT version FROM _migrations WHERE version = 14').get();
  if (!v14) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS architect (
        workspace_path TEXT NOT NULL,
        id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        port INTEGER NOT NULL,
        cmd TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        terminal_id TEXT,
        session_id TEXT,
        PRIMARY KEY (workspace_path, id)
      );
      CREATE INDEX IF NOT EXISTS idx_architect_workspace ON architect(workspace_path);

      CREATE TABLE IF NOT EXISTS builders (
        workspace_path TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 0,
        pid INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'spawning'
          CHECK(status IN ('spawning', 'implementing', 'blocked', 'pr', 'complete')),
        phase TEXT NOT NULL DEFAULT '',
        worktree TEXT NOT NULL,
        branch TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'spec'
          CHECK(type IN ('spec', 'task', 'protocol', 'shell', 'worktree', 'bugfix', 'pir')),
        task_text TEXT,
        protocol_name TEXT,
        issue_number TEXT,
        terminal_id TEXT,
        spawned_by_architect TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (workspace_path, id)
      );
      CREATE INDEX IF NOT EXISTS idx_builders_status ON builders(status);
      CREATE INDEX IF NOT EXISTS idx_builders_port ON builders(port);
      CREATE TRIGGER IF NOT EXISTS builders_updated_at
        AFTER UPDATE ON builders
        FOR EACH ROW
        BEGIN
          UPDATE builders SET updated_at = datetime('now')
            WHERE workspace_path = NEW.workspace_path AND id = NEW.id;
        END;

      CREATE TABLE IF NOT EXISTS utils (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 0,
        pid INTEGER NOT NULL DEFAULT 0,
        terminal_id TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY,
        file TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 0,
        pid INTEGER NOT NULL DEFAULT 0,
        parent_type TEXT NOT NULL CHECK(parent_type IN ('architect', 'builder', 'util')),
        parent_id TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare('INSERT INTO _migrations (version) VALUES (14)').run();
    console.log('[info] Absorbed state.db tables into global.db (Issue #1118)');
  }

  return db;
}

// Re-export types and utilities
export { LOCAL_SCHEMA, GLOBAL_SCHEMA } from './schema.js';
export { withRetry } from './errors.js';
export type {
  DbArchitect,
  DbBuilder,
  DbUtil,
  DbAnnotation,
} from './types.js';
