/**
 * global.db migration v19 — the bounded-patience interrupt columns (Issue #1481).
 *
 * Driven through the REAL production runner (`runGlobalMigrations`), never a replica, so the
 * SQL under test is the SQL that ships. The invariant that matters is convergence: a database
 * upgraded from v18 and one created fresh from `GLOBAL_SCHEMA` must be structurally identical,
 * because everything downstream (the force claim, the alarm suppression, the restart sweep)
 * reads these columns by name and would fail silently on only one of the two shapes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import { GLOBAL_CURRENT_VERSION, runGlobalMigrations } from '../db/migrations.js';

const TEST_DIR = resolve(process.cwd(), '.test-pir-1481-migration');

/** The post-v18 mailbox shape: `not_before` and `detail`, but none of the v19 columns. */
const PRE_V19_MAILBOX_DDL = `
  CREATE TABLE IF NOT EXISTS mailbox (
    id TEXT PRIMARY KEY,
    workspace_path TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    terminal_id TEXT,
    from_agent TEXT,
    from_workspace TEXT,
    body TEXT NOT NULL,
    formatted_message TEXT NOT NULL,
    no_enter INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'held'
      CHECK(status IN ('held', 'delivered', 'superseded', 'dismissed')),
    reason TEXT CHECK(reason IN ('busy', 'no-profile', 'no-live-pty')),
    detail TEXT,
    supersede_key TEXT,
    escalated INTEGER NOT NULL DEFAULT 0,
    not_before INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_mailbox_workspace_status ON mailbox(workspace_path, status);
  CREATE INDEX IF NOT EXISTS idx_mailbox_agent_drain ON mailbox(workspace_path, to_agent, status);
  CREATE INDEX IF NOT EXISTS idx_mailbox_supersede ON mailbox(supersede_key);
`;

describe('Issue #1481 — mailbox interrupt columns (migration v19)', () => {
  let db: Database.Database;
  let logs: string[];

  const migrate = (): void => {
    runGlobalMigrations(db, { log: (m) => logs.push(m), runDir: resolve(TEST_DIR, 'run') });
  };

  const columns = (): string[] =>
    (db.prepare("SELECT name FROM pragma_table_info('mailbox')").all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();

  /** A v18-era database: markers through 18, and the mailbox shape of that era. */
  const seedV18 = (): void => {
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    for (let v = 1; v <= 18; v++) {
      db.prepare('INSERT OR IGNORE INTO _migrations (version) VALUES (?)').run(v);
    }
    db.exec(PRE_V19_MAILBOX_DDL);
  };

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(resolve(TEST_DIR, 'run'), { recursive: true });
    db = new Database(resolve(TEST_DIR, 'global.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    logs = [];
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('adds all four columns to a v18 database', () => {
    seedV18();
    expect(columns()).not.toContain('interrupt_at');

    migrate();

    expect(columns()).toEqual(
      expect.arrayContaining([
        'interrupt_at',
        'interrupt_claimed_at',
        'interrupt_outcome',
        'interrupt_prior_partial',
      ]),
    );
  });

  it('records v19 and bumps GLOBAL_CURRENT_VERSION to match', () => {
    seedV19Check();
    function seedV19Check(): void {
      seedV18();
      migrate();
    }
    const marker = db.prepare('SELECT COUNT(*) AS n FROM _migrations WHERE version = 19').get() as { n: number };
    expect(marker.n).toBe(1);
    // The runner and the fresh-install marker stamper read the same constant; a v19 step with a
    // stale constant would leave fresh installs one marker short and re-run v19 on their next open.
    expect(GLOBAL_CURRENT_VERSION).toBe(19);
  });

  it('is idempotent — a second run applies and logs nothing', () => {
    seedV18();
    migrate();
    const afterFirst = logs.length;
    expect(() => migrate()).not.toThrow();
    expect(logs.length).toBe(afterFirst);
    const marker = db.prepare('SELECT COUNT(*) AS n FROM _migrations WHERE version = 19').get() as { n: number };
    expect(marker.n).toBe(1);
  });

  it('preserves pre-existing rows and gives them ordinary-row defaults', () => {
    seedV18();
    db.prepare(
      `INSERT INTO mailbox (id, workspace_path, to_agent, body, formatted_message, status, reason, created_at, updated_at)
       VALUES ('held-1', '/ws/a', 'b1', 'raw', 'formatted', 'held', 'busy', 1000, 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO mailbox (id, workspace_path, to_agent, body, formatted_message, status, created_at, updated_at, resolved_at)
       VALUES ('done-1', '/ws/a', 'b1', 'raw', 'formatted', 'delivered', 2000, 2000, 2500)`,
    ).run();

    migrate();

    const rows = db.prepare('SELECT * FROM mailbox ORDER BY id').all() as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.id)).toEqual(['done-1', 'held-1']);
    for (const row of rows) {
      // An existing row has no force: null deadline, null outcome, and — critically — a
      // BACKFILLED 0 rather than null for the NOT NULL column, which is what makes the
      // `interrupt_prior_partial = 0` guard on the monotonic flag work on upgraded databases.
      expect(row.interrupt_at).toBeNull();
      expect(row.interrupt_claimed_at).toBeNull();
      expect(row.interrupt_outcome).toBeNull();
      expect(row.interrupt_prior_partial).toBe(0);
    }
    // Pre-existing values are untouched.
    const held = rows.find((r) => r.id === 'held-1')!;
    expect(held.status).toBe('held');
    expect(held.reason).toBe('busy');
    expect(held.created_at).toBe(1000);
  });

  it('a fresh GLOBAL_SCHEMA install converges on the identical mailbox shape', () => {
    seedV18();
    migrate();
    const migratedCols = columns();

    const fresh = new Database(resolve(TEST_DIR, 'fresh.db'));
    try {
      fresh.exec(GLOBAL_SCHEMA);
      const freshCols = (
        fresh.prepare("SELECT name FROM pragma_table_info('mailbox')").all() as Array<{ name: string }>
      )
        .map((c) => c.name)
        .sort();
      expect(freshCols).toEqual(migratedCols);

      // And the DEFAULTS converge too, not just the names: an insert that names none of the new
      // columns must produce the same row on both shapes. A CHECK constraint present only in
      // GLOBAL_SCHEMA would be invisible to a column-name comparison and would reject values the
      // upgraded database accepts — which is why `interrupt_outcome` deliberately has none.
      for (const target of [db, fresh]) {
        target
          .prepare(
            `INSERT INTO mailbox (id, workspace_path, to_agent, body, formatted_message, created_at, updated_at)
             VALUES ('converge', '/ws/a', 'b1', 'raw', 'formatted', 1, 1)`,
          )
          .run();
        const row = target.prepare("SELECT * FROM mailbox WHERE id = 'converge'").get() as Record<string, unknown>;
        expect(row.interrupt_at).toBeNull();
        expect(row.interrupt_prior_partial).toBe(0);
        // Every value of the vocabulary must be storable on BOTH shapes.
        target.prepare("UPDATE mailbox SET interrupt_outcome = 'claimed-degraded' WHERE id = 'converge'").run();
      }
    } finally {
      fresh.close();
    }
  });

  it('survives a close and reopen — the columns are on disk, not in a session', () => {
    seedV18();
    migrate();
    const dbPath = resolve(TEST_DIR, 'global.db');
    db.prepare(
      `INSERT INTO mailbox (id, workspace_path, to_agent, body, formatted_message, created_at, updated_at,
                            interrupt_at, interrupt_outcome)
       VALUES ('armed-1', '/ws/a', 'b1', 'raw', 'formatted', 1, 1, 5000, 'armed')`,
    ).run();
    db.close();

    db = new Database(dbPath);
    const row = db.prepare("SELECT * FROM mailbox WHERE id = 'armed-1'").get() as Record<string, unknown>;
    expect(row.interrupt_at).toBe(5000);
    expect(row.interrupt_outcome).toBe('armed');
    expect(row.interrupt_prior_partial).toBe(0);
  });
});
