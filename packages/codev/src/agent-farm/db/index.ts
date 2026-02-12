/**
 * SQLite Database Module
 *
 * Provides singleton database access for both local state and global registry.
 * Uses better-sqlite3 for synchronous operations with proper concurrency handling.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { LOCAL_SCHEMA, GLOBAL_SCHEMA } from './schema.js';
import { migrateLocalFromJson } from './migrate.js';
import { getConfig } from '../utils/index.js';

// Singleton instances
let _localDb: Database.Database | null = null;
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
 * Get the local database instance (state.db)
 * Creates and initializes the database if it doesn't exist
 */
export function getDb(): Database.Database {
  if (!_localDb) {
    _localDb = ensureLocalDatabase();
  }
  return _localDb;
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
 * Close the local database connection
 */
export function closeDb(): void {
  if (_localDb) {
    _localDb.close();
    _localDb = null;
  }
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
 * Get the path to the local database
 */
export function getDbPath(): string {
  const config = getConfig();
  return resolve(config.stateDir, 'state.db');
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
  return resolve(homedir(), '.agent-farm', dbName);
}

/**
 * Initialize the local database (state.db)
 */
function ensureLocalDatabase(): Database.Database {
  const config = getConfig();
  const dbPath = resolve(config.stateDir, 'state.db');
  const jsonPath = resolve(config.stateDir, 'state.json');

  // Ensure directory exists
  ensureDir(config.stateDir);

  // Create/open database
  const db = new Database(dbPath);
  configurePragmas(db);

  // Run schema (creates tables if they don't exist)
  db.exec(LOCAL_SCHEMA);

  // Check if migration is needed
  const migrated = db.prepare('SELECT version FROM _migrations WHERE version = 1').get();

  if (!migrated && existsSync(jsonPath)) {
    // Migrate from JSON
    migrateLocalFromJson(db, jsonPath);

    // Record migration
    db.prepare('INSERT INTO _migrations (version) VALUES (1)').run();

    // Backup original JSON and remove it
    copyFileSync(jsonPath, jsonPath + '.bak');
    unlinkSync(jsonPath);

    console.log('[info] Migrated state.json to state.db (backup at state.json.bak)');
  } else if (!migrated) {
    // Fresh install, just mark migration as done
    db.prepare('INSERT OR IGNORE INTO _migrations (version) VALUES (1)').run();
    console.log('[info] Created new state.db at', dbPath);
  }

  // Migration v2: Add terminal_id columns (node-pty rewrite)
  const v2 = db.prepare('SELECT version FROM _migrations WHERE version = 2').get();
  if (!v2) {
    // Add terminal_id to tables that may already exist without it
    const tables = ['architect', 'builders', 'utils'];
    for (const table of tables) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN terminal_id TEXT`);
      } catch {
        // Column already exists (fresh install ran full schema)
      }
    }
    db.prepare('INSERT INTO _migrations (version) VALUES (2)').run();
  }

  // Migration v3: Remove UNIQUE constraint from utils.port (node-pty shells use port=0)
  const v3 = db.prepare('SELECT version FROM _migrations WHERE version = 3').get();
  if (!v3) {
    // Check if utils table has the UNIQUE constraint on port
    const tableInfo = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='utils'")
      .get() as { sql: string } | undefined;

    if (tableInfo?.sql?.includes('port INTEGER NOT NULL UNIQUE')) {
      // SQLite can't drop constraints, so recreate table
      db.exec(`
        CREATE TABLE utils_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          port INTEGER NOT NULL DEFAULT 0,
          pid INTEGER NOT NULL DEFAULT 0,
          tmux_session TEXT,
          terminal_id TEXT,
          started_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO utils_new SELECT id, name, port, pid, tmux_session, terminal_id, started_at FROM utils;
        DROP TABLE utils;
        ALTER TABLE utils_new RENAME TO utils;
      `);
      console.log('[info] Migrated utils table: removed UNIQUE constraint from port');
    }
    db.prepare('INSERT INTO _migrations (version) VALUES (3)').run();
  }

  // Migration v4: Remove UNIQUE constraint from builders.port (PTY-backed builders use port=0)
  const v4 = db.prepare('SELECT version FROM _migrations WHERE version = 4').get();
  if (!v4) {
    const tableInfo = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='builders'")
      .get() as { sql: string } | undefined;

    if (tableInfo?.sql?.includes('port INTEGER NOT NULL UNIQUE')) {
      // SQLite can't drop constraints, so recreate table
      db.exec(`
        CREATE TABLE builders_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          port INTEGER NOT NULL DEFAULT 0,
          pid INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'spawning'
            CHECK(status IN ('spawning', 'implementing', 'blocked', 'pr-ready', 'complete')),
          phase TEXT NOT NULL DEFAULT '',
          worktree TEXT NOT NULL,
          branch TEXT NOT NULL,
          tmux_session TEXT,
          type TEXT NOT NULL DEFAULT 'spec'
            CHECK(type IN ('spec', 'task', 'protocol', 'shell', 'worktree', 'bugfix')),
          task_text TEXT,
          protocol_name TEXT,
          issue_number INTEGER,
          terminal_id TEXT,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO builders_new SELECT * FROM builders;
        DROP TABLE builders;
        ALTER TABLE builders_new RENAME TO builders;
        CREATE INDEX IF NOT EXISTS idx_builders_status ON builders(status);
        CREATE INDEX IF NOT EXISTS idx_builders_port ON builders(port);
        CREATE TRIGGER IF NOT EXISTS builders_updated_at
          AFTER UPDATE ON builders
          FOR EACH ROW
          BEGIN
            UPDATE builders SET updated_at = datetime('now') WHERE id = NEW.id;
          END;
      `);
      console.log('[info] Migrated builders table: removed UNIQUE constraint from port');
    }
    db.prepare('INSERT INTO _migrations (version) VALUES (4)').run();
  }

  return db;
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

  // Run schema (creates tables if they don't exist)
  db.exec(GLOBAL_SCHEMA);

  // Check if migration is needed
  const migrated = db.prepare('SELECT version FROM _migrations WHERE version = 1').get();

  if (!migrated) {
    // Fresh install, just mark migration as done
    db.prepare('INSERT OR IGNORE INTO _migrations (version) VALUES (1)').run();
    console.log('[info] Created new global.db at', dbPath);
  }

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
