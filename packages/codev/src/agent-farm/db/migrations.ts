/**
 * global.db forward-only migrations (Issue #1476).
 *
 * The migration sequence used to live inline inside the private
 * `ensureGlobalDatabase()` path in `db/index.ts`, so migration tests could only
 * drive hand-maintained *replicas* of it. This module is the single source of
 * truth both production init and the tests call:
 *
 *   - `ensureGlobalDatabase()` calls `runGlobalMigrations(db)` on an existing
 *     database (fresh installs get the final shape from GLOBAL_SCHEMA and stamp
 *     every marker up to `GLOBAL_CURRENT_VERSION` instead).
 *   - `__tests__/spec-1313-migration.test.ts` builds a database at a historical
 *     version and calls the very same function, so the SQL under test is the SQL
 *     that ships.
 *
 * The runner takes an explicit `db` handle (matching `db/mailbox.ts` /
 * `db/consolidate.ts`) — it never opens a connection, reads a singleton, or sets
 * pragmas. Every step is idempotent and gated on its `_migrations` marker, so
 * calling it repeatedly on the same handle is a no-op. Migrations are
 * forward-only by project convention; there is no reverse SQL.
 */

import type Database from 'better-sqlite3';
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Current migration version — bump when adding new migrations. */
export const GLOBAL_CURRENT_VERSION = 17;

export interface GlobalMigrationOptions {
  /**
   * Sink for per-migration progress lines. Defaults to `console.log`, which is
   * what the production open path wants; tests pass a collector (or a no-op) to
   * keep output clean and to assert which steps actually ran.
   */
  log?: (message: string) => void;
  /**
   * Directory holding shellper sockets, whose files migration v8 renames.
   * Defaults to `~/.codev/run` — the production location. Tests point it at a
   * temp directory so driving the real runner never touches a developer's live
   * sockets.
   */
  runDir?: string;
}

/**
 * Run every outstanding global.db migration against `db`.
 *
 * Safe to call on any existing database that reached its recorded version through
 * migrations: each step checks its own `_migrations` marker first, so applied steps
 * are skipped and the call converges on the `GLOBAL_CURRENT_VERSION` shape.
 *
 * NOT for a fresh database. A GLOBAL_SCHEMA-shaped database with no markers would run
 * v5 against the long-renamed `terminal_sessions.project_path` — which is why
 * `ensureGlobalDatabase()` stamps every marker on the fresh path instead of running
 * the chain. That shape is rejected at entry with a named error rather than an opaque
 * mid-chain SQLite failure.
 *
 * @throws if the database carries the post-v9 `workspace_path` shape without the v9
 * marker to match (a fresh schema that never walked the chain).
 */
export function runGlobalMigrations(
  db: Database.Database,
  options: GlobalMigrationOptions = {}
): void {
  const log = options.log ?? ((message: string) => console.log(message));
  const runDir = options.runDir ?? join(homedir(), '.codev', 'run');

  // Ensure _migrations table exists for tracking
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Precondition. Steps v5/v7/v8/v9 read and rebuild the project_path-era tables, so
  // the chain only makes sense on a database that reached its recorded version through
  // migrations. A fresh GLOBAL_SCHEMA database with no markers would instead die at v5
  // with an opaque `no such column: project_path` — so name that shape here. Production
  // never reaches this (ensureGlobalDatabase stamps every marker on the fresh path); it
  // exists because the runner is now callable from anywhere.
  const terminalSessions = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='terminal_sessions'")
    .get();
  if (terminalSessions) {
    const renamed = (db.prepare(`PRAGMA table_info(terminal_sessions)`).all() as Array<{ name: string }>)
      .some((c) => c.name === 'workspace_path');
    const v9Marker = db.prepare('SELECT version FROM _migrations WHERE version = 9').get();
    if (renamed && !v9Marker) {
      throw new Error(
        'runGlobalMigrations: refusing to run on a database whose terminal_sessions is already ' +
          'workspace_path-shaped but has no v9 migration marker. This is a fresh GLOBAL_SCHEMA ' +
          'database that never walked the chain — stamp markers 1..GLOBAL_CURRENT_VERSION instead ' +
          '(see ensureGlobalDatabase), or the chain will fail mid-way on renamed columns.'
      );
    }
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
    log('[info] Created terminal_sessions table (Spec 0090 TICK-001)');
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
    log('[info] Created file_tabs table (Spec 0099 Phase 4)');
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
    log('[info] Created known_projects table');
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
    log('[info] Added shepherd columns to terminal_sessions (Spec 0104)');
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
    log('[info] Dropped tmux_session column from terminal_sessions (Spec 0104)');
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
    log('[info] Renamed shepherd columns to shellper in terminal_sessions (Spec 0106)');
  }

  // Migration v9: Rename project_path → workspace_path in all tables (Spec 0112)
  // Note: Fresh installs never reach here (handled by the caller), so old column
  // names are guaranteed.
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
    log('[info] Renamed project_path → workspace_path in global tables (Spec 0112)');
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
    log('[info] Created cron_tasks table (Spec 399)');
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
    log('[info] Added label column to terminal_sessions (Spec 468)');
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
    log('[info] Added cwd column to terminal_sessions (Bugfix #506)');
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
    log('[info] Backfilled architect role_id with \'main\' (Spec 755)');
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
    log('[info] Absorbed state.db tables into global.db (Issue #1118)');
  }

  // Migration v15: Add mailbox table (Spec 1313 — mailbox-first delivery).
  // Additive new table: every `afx send` is persisted here before the send
  // response returns, so nothing is lost to a Tower crash/restart/shutdown.
  // Rows address AGENTS (to_agent), not PTYs, so a respawned terminal drains its
  // predecessor's mail. No rows to migrate — the retired SendBuffer was in-memory.
  // Idempotent via CREATE TABLE / CREATE INDEX IF NOT EXISTS (fresh installs
  // already created it from GLOBAL_SCHEMA and reach the marker as a no-op).
  const v15 = db.prepare('SELECT version FROM _migrations WHERE version = 15').get();
  if (!v15) {
    db.exec(`
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
        supersede_key TEXT,
        escalated INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_mailbox_workspace_status ON mailbox(workspace_path, status);
      CREATE INDEX IF NOT EXISTS idx_mailbox_agent_drain ON mailbox(workspace_path, to_agent, status);
      CREATE INDEX IF NOT EXISTS idx_mailbox_supersede ON mailbox(supersede_key);
    `);
    db.prepare('INSERT INTO _migrations (version) VALUES (15)').run();
    log('[info] Created mailbox table (Spec 1313)');
  }

  // Migration v16: Add command column to terminal_sessions (Spec 1313).
  // The render-gate resolves an agent's classifier profile from its launch
  // command (PtySession.command). Shellper-backed sessions were created with
  // command: '' and the profile fell back to reading `.builder-start.sh` —
  // which only builder worktrees have. Architects run in the workspace root
  // (no launch script), so they never resolved and every `afx send architect`
  // held `no-profile`. Persisting the command lets the reconcile/reconnect
  // paths restore identity after a Tower restart, so architects resolve
  // directly and survive restart (builders keep the launch-script backstop).
  // Mirrors the label (v11) / cwd (v12) column adds.
  const v16 = db.prepare('SELECT version FROM _migrations WHERE version = 16').get();
  if (!v16) {
    // Only skip the ALTER when the column genuinely exists already (fresh install
    // ran GLOBAL_SCHEMA). A blanket try/catch would let a REAL alter failure be
    // recorded as "migrated" — and since saveTerminalSession's INSERT now names
    // `command`, every future write would then fail against a table missing it.
    const hasCommand = (db.prepare(`PRAGMA table_info(terminal_sessions)`).all() as Array<{ name: string }>)
      .some((c) => c.name === 'command');
    if (!hasCommand) {
      db.exec(`ALTER TABLE terminal_sessions ADD COLUMN command TEXT`);
    }
    db.prepare('INSERT INTO _migrations (version) VALUES (16)').run();
    log('[info] Added command column to terminal_sessions (Spec 1313 restart-safe render-gate identity)');
  }

  // Migration v17: Add not_before column to mailbox (Spec 1313 round 3 — durable `--delay`).
  // `afx send --delay` now persists its row at REQUEST time with not_before = now + delay*1000
  // and defers delivery through the render gate, so a delayed send survives a Tower restart
  // (the conscious reversal of Spec 1307's drop-on-restart semantics). A row is deliverable
  // only when `not_before IS NULL OR not_before <= now`; null means deliver-ASAP (every
  // pre-round-3 row). PRAGMA-gated ADD COLUMN mirroring v16 — a blanket try/catch would let a
  // real ALTER failure be recorded as "migrated" and every subsequent mailbox insert (which
  // now names not_before) would then fail against a table missing it. Do NOT edit v15 in place:
  // dev machines on this branch already applied it, so the column must arrive as its own step.
  const v17 = db.prepare('SELECT version FROM _migrations WHERE version = 17').get();
  if (!v17) {
    const hasNotBefore = (db.prepare(`PRAGMA table_info(mailbox)`).all() as Array<{ name: string }>)
      .some((c) => c.name === 'not_before');
    if (!hasNotBefore) {
      db.exec(`ALTER TABLE mailbox ADD COLUMN not_before INTEGER`);
    }
    db.prepare('INSERT INTO _migrations (version) VALUES (17)').run();
    log('[info] Added not_before column to mailbox (Spec 1313 durable --delay)');
  }
}
