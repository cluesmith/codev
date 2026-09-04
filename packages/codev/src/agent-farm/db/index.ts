/**
 * SQLite Database Module
 *
 * Provides singleton database access for both local state and global registry.
 * Uses better-sqlite3 for synchronous operations with proper concurrency handling.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { AGENT_FARM_DIR } from '../lib/tower-client.js';
import { GLOBAL_SCHEMA } from './schema.js';
import { GLOBAL_CURRENT_VERSION, runGlobalMigrations } from './migrations.js';

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

  // FULL synchronous mode: fsync the WAL on every commit. Under NORMAL, a
  // commit is acknowledged before the WAL reaches disk, so an OS crash or
  // power loss can silently roll back recently committed transactions. For a
  // registry of desired state (architect rows drive respawn-on-launch, Issue
  // #1150) a lost delete resurrects an agent the user removed. Write rate on
  // this DB is lifecycle events only, so the per-commit fsync cost is
  // negligible next to that durability guarantee.
  db.pragma('synchronous = FULL');

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

  // Existing database: only run migrations (skip GLOBAL_SCHEMA to avoid column
  // name conflicts). The migration sequence itself lives in db/migrations.ts so
  // production init and the migration tests drive the same runner (Issue #1476).
  runGlobalMigrations(db);

  return db;
}

// Re-export types and utilities
export { LOCAL_SCHEMA, GLOBAL_SCHEMA } from './schema.js';
export { withRetry } from './errors.js';
export { GLOBAL_CURRENT_VERSION, runGlobalMigrations } from './migrations.js';
export type { GlobalMigrationOptions } from './migrations.js';
export type {
  DbArchitect,
  DbBuilder,
  DbUtil,
  DbAnnotation,
  DbMailbox,
  MailboxStatus,
  MailboxReason,
  MailboxGateDetail,
} from './types.js';
