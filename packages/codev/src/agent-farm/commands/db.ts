/**
 * Database CLI commands
 *
 * Commands for debugging and managing the SQLite databases:
 * - afx db dump: Export all tables to JSON
 * - afx db query: Run arbitrary SELECT queries
 * - afx db reset: Delete database and start fresh
 */

import { existsSync, unlinkSync } from 'node:fs';
import { getDb, getGlobalDb, getDbPath, getGlobalDbPath, closeDb, closeGlobalDb } from '../db/index.js';
import { logger, fatal } from '../utils/logger.js';

interface DumpOptions {
  global?: boolean;
}

interface QueryOptions {
  global?: boolean;
}

interface ResetOptions {
  global?: boolean;
  force?: boolean;
}

/**
 * Export all tables to JSON
 */
export function dbDump(options: DumpOptions = {}): void {
  const db = options.global ? getGlobalDb() : getDb();

  // Get all table names (excluding internal sqlite tables and _migrations)
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations'
    ORDER BY name
  `).all() as Array<{ name: string }>;

  const dump: Record<string, unknown[]> = {};

  for (const { name } of tables) {
    dump[name] = db.prepare(`SELECT * FROM ${name}`).all();
  }

  console.log(JSON.stringify(dump, null, 2));
}

/**
 * Run a SELECT query against the database
 */
export function dbQuery(sql: string, options: QueryOptions = {}): void {
  // Safety check: only allow SELECT queries
  const normalizedSql = sql.trim().toLowerCase();
  if (!normalizedSql.startsWith('select')) {
    fatal('Only SELECT queries are allowed for safety. Use "afx db reset" to modify data.');
  }

  const db = options.global ? getGlobalDb() : getDb();

  try {
    const results = db.prepare(sql).all();
    console.log(JSON.stringify(results, null, 2));
  } catch (err: unknown) {
    const error = err as Error;
    fatal(`Query failed: ${error.message}`);
  }
}

/**
 * Delete database and start fresh
 */
export function dbReset(options: ResetOptions = {}): void {
  const dbPath = options.global ? getGlobalDbPath() : getDbPath();
  const dbType = options.global ? 'global' : 'local';

  if (!existsSync(dbPath)) {
    logger.info(`No ${dbType} database found at ${dbPath}`);
    return;
  }

  if (!options.force) {
    logger.warn(`This will delete the ${dbType} database at ${dbPath}`);
    logger.warn('Use --force to confirm.');
    return;
  }

  // Close the database connection first
  if (options.global) {
    closeGlobalDb();
  } else {
    closeDb();
  }

  // Delete main database file
  try {
    unlinkSync(dbPath);
    logger.info(`Deleted ${dbPath}`);
  } catch {
    // File might not exist or be locked
  }

  // Delete WAL files if they exist
  const walPath = dbPath + '-wal';
  const shmPath = dbPath + '-shm';

  try {
    if (existsSync(walPath)) {
      unlinkSync(walPath);
      logger.info(`Deleted ${walPath}`);
    }
  } catch {
    // File might not exist
  }

  try {
    if (existsSync(shmPath)) {
      unlinkSync(shmPath);
      logger.info(`Deleted ${shmPath}`);
    }
  } catch {
    // File might not exist
  }

  logger.success(`${dbType.charAt(0).toUpperCase() + dbType.slice(1)} database reset complete`);
}

/**
 * Show database statistics
 */
export function dbStats(options: { global?: boolean } = {}): void {
  const db = options.global ? getGlobalDb() : getDb();
  const dbPath = options.global ? getGlobalDbPath() : getDbPath();
  const dbType = options.global ? 'Global' : 'Local';

  logger.header(`${dbType} Database Statistics`);
  logger.kv('Path', dbPath);

  // Get table row counts
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>;

  logger.blank();
  logger.info('Table row counts:');

  for (const { name } of tables) {
    const result = db.prepare(`SELECT COUNT(*) as count FROM ${name}`).get() as { count: number };
    logger.kv(`  ${name}`, String(result.count));
  }

  // Get database page info
  const pageCount = db.pragma('page_count', { simple: true }) as number;
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  const journalMode = db.pragma('journal_mode', { simple: true }) as string;

  logger.blank();
  logger.info('Database info:');
  logger.kv('  Journal mode', journalMode.toUpperCase());
  logger.kv('  Page size', `${pageSize} bytes`);
  logger.kv('  Page count', String(pageCount));
  logger.kv('  Total size', `${Math.round(pageCount * pageSize / 1024)} KB`);
}
