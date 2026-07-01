/**
 * Database CLI commands
 *
 * Commands for debugging and managing the SQLite databases:
 * - afx db dump: Export all tables to JSON
 * - afx db query: Run arbitrary SELECT queries
 * - afx db reset: Delete database and start fresh
 */

import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { getDb, getGlobalDb, getDbPath, getGlobalDbPath, closeDb, closeGlobalDb } from '../db/index.js';
import { planMigration, applyMigration } from '../db/consolidate.js';
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

/**
 * Consolidate a legacy state.db into global.db (Issue #1118).
 *
 * Pulls a satellite `state.db` — one missed by the automatic boot one-off —
 * into the shared global.db (upsert-if-newer), then renames the source. Dry-run
 * by default; `--apply` commits. Safe with Tower running.
 */
export function dbConsolidate(stateDbPath: string, options: { apply?: boolean } = {}): void {
  const sourcePath = resolve(stateDbPath);

  // Idempotent repeat-runs (Issue #1118, codex review): re-running the same
  // command after a successful `--apply` renamed the source is a friendly no-op,
  // not a hard error — the work is already done.
  if (!existsSync(sourcePath)) {
    logger.info(`Nothing to consolidate — no state.db at ${sourcePath} (already migrated?).`);
    return;
  }
  // Guard against re-consolidating a file this command already archived, which
  // would migrate it again (harmlessly, all rows skipped) and double-rename it.
  if (/\.pre-merge-/.test(sourcePath)) {
    logger.info(`Skipping ${sourcePath} — it is already a consolidated archive (*.pre-merge-*).`);
    return;
  }

  const globalDbPath = getGlobalDbPath();

  // Dry-run must be side-effect-free (codex review): open global.db READ-ONLY so
  // the preview can't create or migrate the target DB (getGlobalDb() eagerly runs
  // migration v14). Fall back to an in-memory DB if global.db doesn't exist yet —
  // its empty tables make every source row read as "new", the correct preview.
  // The `--apply` path uses the real getGlobalDb() connection.
  let db: Database.Database;
  let closeAfter = false;
  if (options.apply) {
    db = getGlobalDb();
  } else if (existsSync(globalDbPath)) {
    db = new Database(globalDbPath, { readonly: true });
    closeAfter = true;
  } else {
    db = new Database(':memory:');
    closeAfter = true;
  }

  try {
    const plan = planMigration(db, sourcePath);

    let mode = '(dry-run)';
    if (options.apply) mode = '(apply)';
    logger.header(`Consolidate ${mode}`);
    logger.kv('Source', sourcePath);
    logger.kv('Target', globalDbPath);
    logger.blank();

    if (plan.total === 0) {
      logger.info('Nothing to migrate (source has no rows in architect/builders/utils/annotations).');
      return;
    }

    for (const s of plan.stats) {
      logger.kv(`  ${s.table}`, `${s.inserted} new, ${s.updated} newer (replace), ${s.skipped} older (skip)`);
    }
    logger.blank();

    if (!options.apply) {
      logger.info('Dry-run only. Re-run with --apply to migrate and rename the source.');
      return;
    }

    const result = applyMigration(db, sourcePath);
    const moved = result.stats.reduce((n, s) => n + s.inserted + s.updated, 0);
    logger.success(`Migrated ${moved} row(s) into global.db.`);
    if (result.renamedTo) {
      logger.kv('Source renamed to', result.renamedTo);
    }
  } finally {
    if (closeAfter) db.close();
  }
}
