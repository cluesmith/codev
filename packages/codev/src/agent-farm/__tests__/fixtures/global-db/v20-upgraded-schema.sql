-- global.db at migration v20, the schema before Spec 1967 (migration v21), as an install
-- that walked the whole chain from v1 has it. Generated once from the v20 runner
-- (runGlobalMigrations on a v1 database) by dumping sqlite_master in creation order:
-- note the ALTER-appended columns. Schema only; no rows. Used by
-- peer-storage-migration.test.ts.

CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE "terminal_sessions" (
          id TEXT PRIMARY KEY,
          workspace_path TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('architect', 'builder', 'shell')),
          role_id TEXT,
          pid INTEGER,
          shellper_socket TEXT,
          shellper_pid INTEGER,
          shellper_start_time INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        , label TEXT, cwd TEXT, command TEXT, shellper_session_id TEXT, shellper_secret TEXT);

CREATE INDEX idx_terminal_sessions_workspace ON terminal_sessions(workspace_path);

CREATE INDEX idx_terminal_sessions_type ON terminal_sessions(type);

CREATE TABLE "file_tabs" (
          id TEXT PRIMARY KEY,
          workspace_path TEXT NOT NULL,
          file_path TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

CREATE INDEX idx_file_tabs_workspace ON file_tabs(workspace_path);

CREATE TABLE known_workspaces (
          workspace_path TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          last_launched_at TEXT NOT NULL DEFAULT (datetime('now'))
        , address_name TEXT);

CREATE TABLE cron_tasks (
        id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        task_name TEXT NOT NULL,
        last_run INTEGER,
        last_result TEXT,
        last_output TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        UNIQUE(workspace_path, task_name)
      );

CREATE TABLE architect (
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

CREATE INDEX idx_architect_workspace ON architect(workspace_path);

CREATE TABLE builders (
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

CREATE INDEX idx_builders_status ON builders(status);

CREATE INDEX idx_builders_port ON builders(port);

CREATE TRIGGER builders_updated_at
        AFTER UPDATE ON builders
        FOR EACH ROW
        BEGIN
          UPDATE builders SET updated_at = datetime('now')
            WHERE workspace_path = NEW.workspace_path AND id = NEW.id;
        END;

CREATE TABLE utils (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 0,
        pid INTEGER NOT NULL DEFAULT 0,
        terminal_id TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

CREATE TABLE annotations (
        id TEXT PRIMARY KEY,
        file TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 0,
        pid INTEGER NOT NULL DEFAULT 0,
        parent_type TEXT NOT NULL CHECK(parent_type IN ('architect', 'builder', 'util')),
        parent_id TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

CREATE TABLE mailbox (
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
      , not_before INTEGER, detail TEXT);

CREATE INDEX idx_mailbox_workspace_status ON mailbox(workspace_path, status);

CREATE INDEX idx_mailbox_agent_drain ON mailbox(workspace_path, to_agent, status);

CREATE INDEX idx_mailbox_supersede ON mailbox(supersede_key);

CREATE UNIQUE INDEX idx_known_workspaces_address_name
           ON known_workspaces(address_name) WHERE address_name IS NOT NULL;

