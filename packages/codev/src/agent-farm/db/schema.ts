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
  tmux_session TEXT,
  terminal_id TEXT
);

-- Builder sessions
CREATE TABLE IF NOT EXISTS builders (
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

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_builders_status ON builders(status);
CREATE INDEX IF NOT EXISTS idx_builders_port ON builders(port);

-- Utility terminals
CREATE TABLE IF NOT EXISTS utils (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 0,
  pid INTEGER NOT NULL DEFAULT 0,
  tmux_session TEXT,
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
 * Stores terminal sessions and migrations across all projects
 */
export const GLOBAL_SCHEMA = `
-- Schema versioning
CREATE TABLE IF NOT EXISTS _migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Terminal sessions (Spec 0090 TICK-001)
-- Tracks all terminal sessions across all projects for persistence and reconciliation
CREATE TABLE IF NOT EXISTS terminal_sessions (
  id TEXT PRIMARY KEY,                    -- terminal UUID from PtyManager
  project_path TEXT NOT NULL,             -- project this terminal belongs to
  type TEXT NOT NULL                      -- 'architect', 'builder', 'shell'
    CHECK(type IN ('architect', 'builder', 'shell')),
  role_id TEXT,                           -- builder ID or shell ID (null for architect)
  pid INTEGER,                            -- process ID of the terminal
  tmux_session TEXT,                      -- tmux session name if tmux-backed
  shepherd_socket TEXT,                   -- Unix socket path for shepherd process
  shepherd_pid INTEGER,                   -- shepherd process PID
  shepherd_start_time INTEGER,            -- shepherd process start time (epoch ms)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_terminal_sessions_project ON terminal_sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_terminal_sessions_type ON terminal_sessions(type);
`;
