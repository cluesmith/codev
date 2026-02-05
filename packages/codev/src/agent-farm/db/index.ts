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
import { migrateLocalFromJson, migrateGlobalFromJson } from './migrate.js';
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
 * Get the path to the global database
 */
export function getGlobalDbPath(): string {
  return resolve(homedir(), '.agent-farm', 'global.db');
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

  return db;
}

/**
 * Initialize the global database (global.db)
 */
function ensureGlobalDatabase(): Database.Database {
  const globalDir = resolve(homedir(), '.agent-farm');
  const dbPath = resolve(globalDir, 'global.db');
  const jsonPath = resolve(globalDir, 'ports.json');

  // Ensure directory exists
  ensureDir(globalDir);

  // Create/open database
  const db = new Database(dbPath);
  configurePragmas(db);

  // Run schema (creates tables if they don't exist)
  db.exec(GLOBAL_SCHEMA);

  // Check if migration is needed
  const migrated = db.prepare('SELECT version FROM _migrations WHERE version = 1').get();

  if (!migrated && existsSync(jsonPath)) {
    // Migrate from JSON
    migrateGlobalFromJson(db, jsonPath);

    // Record migration
    db.prepare('INSERT INTO _migrations (version) VALUES (1)').run();

    // Backup original JSON and remove it
    copyFileSync(jsonPath, jsonPath + '.bak');
    unlinkSync(jsonPath);

    console.log('[info] Migrated ports.json to global.db (backup at ports.json.bak)');
  } else if (!migrated) {
    // Fresh install, just mark migration as done
    db.prepare('INSERT OR IGNORE INTO _migrations (version) VALUES (1)').run();
    console.log('[info] Created new global.db at', dbPath);
  }

  // Migration v2: Add project_name and created_at columns to port_allocations
  const v2 = db.prepare('SELECT version FROM _migrations WHERE version = 2').get();
  if (!v2) {
    try {
      db.exec('ALTER TABLE port_allocations ADD COLUMN project_name TEXT');
    } catch {
      // Column already exists
    }
    try {
      db.exec('ALTER TABLE port_allocations ADD COLUMN created_at TEXT NOT NULL DEFAULT (datetime("now"))');
    } catch {
      // Column already exists
    }
    db.prepare('INSERT INTO _migrations (version) VALUES (2)').run();
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
  DbPortAllocation,
} from './types.js';
