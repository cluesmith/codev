/**
 * SQLite Schema Definitions
 *
 * Defines the schema for both local state (state.db) and global registry (global.db)
 */

/**
 * Local state schema (state.db)
 * Stores dashboard state: architect, builders, utils, annotations
 */
export const LOCAL_SCHEMA = `
-- Schema versioning
CREATE TABLE IF NOT EXISTS _migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Architect session (singleton)
CREATE TABLE IF NOT EXISTS architect (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  port INTEGER NOT NULL,
  cmd TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  terminal_id TEXT
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
    CHECK(type IN ('spec', 'task', 'protocol', 'shell', 'worktree', 'bugfix')),
  task_text TEXT,
  protocol_name TEXT,
  issue_number INTEGER,
  terminal_id TEXT,
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
`;
