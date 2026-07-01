/**
 * SQLite Schema Definitions
 *
 * Defines the schema for both local state (state.db) and global registry (global.db)
 */

/**
 * Legacy local state schema (the retired per-workspace state.db).
 *
 * Issue #1118: state.db is retired — its four tables now live in global.db
 * (see GLOBAL_SCHEMA below). LOCAL_SCHEMA is no longer exec'd by the production
 * `getDb()` path. It is retained as the canonical description of a *legacy*
 * state.db's shape — used by the one-time consolidation engine's test fixtures
 * (db/consolidate.ts) and by older migration tests. Note its `builders` table is
 * keyed by `id` alone (the pre-#1118 shape); global.db's `builders` is keyed by
 * the composite `(workspace_path, id)`.
 */
export const LOCAL_SCHEMA = `
-- Schema versioning
CREATE TABLE IF NOT EXISTS _migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Architect sessions (Spec 755: multi-architect — id is the architect's name)
-- Bugfix #826: workspace_path scopes architect rows per workspace, eliminating
-- the cross-workspace leak. Composite PK lets the same architect name (e.g.
-- 'main') exist in multiple workspaces without collision.
--
-- Bugfix #826 iter-7: idx_architect_workspace is intentionally NOT created
-- here. LOCAL_SCHEMA runs via db.exec() BEFORE migrations on every open. On
-- pre-v11 installs the architect table doesn't yet have workspace_path, so a
-- CREATE INDEX statement referencing that column would throw 'no such column'
-- and abort ensureLocalDatabase before migration v11 can run — breaking every
-- upgrade install. The index is created INSIDE migration v11 instead, where
-- both fresh installs and upgrade installs converge on the same v11 shape.
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

-- Builder sessions
CREATE TABLE IF NOT EXISTS builders (
  id TEXT PRIMARY KEY,
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
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_builders_status ON builders(status);
CREATE INDEX IF NOT EXISTS idx_builders_port ON builders(port);

-- Utility terminals
CREATE TABLE IF NOT EXISTS utils (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 0,
  pid INTEGER NOT NULL DEFAULT 0,
  terminal_id TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Annotations (file viewers)
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 0,
  pid INTEGER NOT NULL DEFAULT 0,
  parent_type TEXT NOT NULL CHECK(parent_type IN ('architect', 'builder', 'util')),
  parent_id TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Trigger to update updated_at on builders
CREATE TRIGGER IF NOT EXISTS builders_updated_at
  AFTER UPDATE ON builders
  FOR EACH ROW
  BEGIN
    UPDATE builders SET updated_at = datetime('now') WHERE id = NEW.id;
  END;
`;

/**
 * Global registry schema (global.db)
 * Stores terminal sessions and migrations across all workspaces
 */
export const GLOBAL_SCHEMA = `
-- Schema versioning
CREATE TABLE IF NOT EXISTS _migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Terminal sessions (Spec 0090 TICK-001)
-- Tracks all terminal sessions across all workspaces for persistence and reconciliation
CREATE TABLE IF NOT EXISTS terminal_sessions (
  id TEXT PRIMARY KEY,                    -- terminal UUID from PtyManager
  workspace_path TEXT NOT NULL,           -- workspace this terminal belongs to
  type TEXT NOT NULL                      -- 'architect', 'builder', 'shell'
    CHECK(type IN ('architect', 'builder', 'shell')),
  role_id TEXT,                           -- builder ID or shell ID (null for architect)
  pid INTEGER,                            -- process ID of the terminal
  shellper_socket TEXT,                   -- Unix socket path for shellper process
  shellper_pid INTEGER,                   -- shellper process PID
  shellper_start_time INTEGER,            -- shellper process start time (epoch ms)
  label TEXT,                             -- custom display label (Spec 468)
  cwd TEXT,                               -- working directory of the terminal (Bugfix #506)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_terminal_sessions_workspace ON terminal_sessions(workspace_path);
CREATE INDEX IF NOT EXISTS idx_terminal_sessions_type ON terminal_sessions(type);

-- File tabs (Spec 0099 Phase 4)
CREATE TABLE IF NOT EXISTS file_tabs (
  id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_tabs_workspace ON file_tabs(workspace_path);

-- Known workspaces (persistent workspace registry)
CREATE TABLE IF NOT EXISTS known_workspaces (
  workspace_path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  last_launched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cron tasks (Spec 399)
-- Tracks scheduled task state across all workspaces
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

-- ===========================================================================
-- Issue #1118: tables absorbed from the retired per-workspace state.db.
-- architect/utils/annotations move as-is; builders is RESHAPED to be
-- workspace-scoped (composite PK), mirroring architect (Bugfix #826) — builder
-- ids are <protocol>-<issueNumber>, unique within a workspace but reused across
-- repos, so a single shared table must disambiguate by workspace_path.
-- ===========================================================================

-- Architect sessions (Spec 755 multi-architect; Bugfix #826 workspace-scoped;
-- Issue #832 session_id). id is the architect's name ('main', siblings).
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

-- Builder sessions. Issue #1118: workspace_path + composite PK so the same
-- builder id can exist in multiple workspaces without collision.
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

-- Utility terminals (UUID-keyed; moved as-is).
CREATE TABLE IF NOT EXISTS utils (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 0,
  pid INTEGER NOT NULL DEFAULT 0,
  terminal_id TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Annotations / file viewers (UUID-keyed; moved as-is).
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 0,
  pid INTEGER NOT NULL DEFAULT 0,
  parent_type TEXT NOT NULL CHECK(parent_type IN ('architect', 'builder', 'util')),
  parent_id TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
