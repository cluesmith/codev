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
 * Tower-to-Tower messaging tables (Spec 1967, migration v21). New tables, so a fresh
 * install (GLOBAL_SCHEMA) and migration v21 create them from this one text and cannot
 * diverge. Only `peer/store.ts` writes them. Timestamps are epoch-ms integers, as in
 * `mailbox`. Enumerated values carry no CHECK, for v18's reason: SQLite cannot alter a
 * CHECK, so a value added later (stage 3) would need a table rebuild. `peer/store.ts`
 * enforces every value set (reasons by their shape) and refuses a row it does not recognise.
 */
export const PEER_SCHEMA = `
-- The receiving Tower's switch, one row. No row means off: a fresh install and an
-- upgraded one both read the switch as off. The listing_* columns are the cached
-- peer listing's own fields (when it was fetched, the relay it stated, the cloud's limits).
CREATE TABLE IF NOT EXISTS peer_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  remote_messaging INTEGER NOT NULL DEFAULT 0,   -- 1 = on
  remote_messaging_changed_at INTEGER,
  listing_refreshed_at INTEGER,                  -- NULL = never listed
  listing_relay_protocols TEXT,                  -- JSON integer array; NULL when the listing stated no relay
  listing_limits TEXT                            -- JSON PeerCloudLimits
);

-- Who may message whom here (default deny: no row, no mail). One row per peer and
-- scope: 'front-door', 'architect' (one, by name), 'architects' (every architect of a
-- workspace) or 'all' (everything on this Tower). workspace_path is '' only for 'all';
-- architect is '' unless the scope is 'architect'. mode: 'deliver' or 'hold' (for release).
CREATE TABLE IF NOT EXISTS peer_grants (
  peer_tower_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  scope TEXT NOT NULL,
  architect TEXT NOT NULL,
  mode TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (peer_tower_id, workspace_path, scope, architect)
);

-- The cached peer listing: the account's other Towers as the last listing gave them
-- (when it was fetched is peer_settings.listing_refreshed_at).
CREATE TABLE IF NOT EXISTS peer_towers (
  tower_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  online INTEGER NOT NULL,                       -- a hint, never a promise
  protocols TEXT NOT NULL,                       -- JSON integer array
  remote_messaging TEXT NOT NULL                 -- 'on' | 'off' | 'unknown'
);

-- Every slug each Tower has been listed under, current and former, so a former name
-- can be refused naming the current one.
CREATE TABLE IF NOT EXISTS peer_tower_names (
  tower_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (tower_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_peer_tower_names_slug ON peer_tower_names(slug);

-- Mail waiting at the sending Tower for a peer. Never in mailbox, so the local drainer
-- and the escalation cannot see it. seq is acceptance order (the per-peer queue's order);
-- payload is the exact bytes every retry sends. state: 'held' (waiting), or resolved as
-- 'accepted', 'refused', 'dismissed' or 'expired'.
CREATE TABLE IF NOT EXISTS peer_outbox (
  seq INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  peer_tower_id TEXT NOT NULL,
  to_address TEXT NOT NULL,                      -- the recipient as the sender wrote it (afx://…)
  payload BLOB NOT NULL,
  sent_at INTEGER NOT NULL,                      -- the payload's sentAt; the lifetime runs from it
  from_workspace_path TEXT NOT NULL,
  from_agent TEXT,                               -- NULL when the sender has no agent identity
  state TEXT NOT NULL,
  last_outcome TEXT,                             -- the last answer's outcome, NULL before any attempt
  last_reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_peer_outbox_peer_state ON peer_outbox(peer_tower_id, state, seq);

-- Accepted once, at the receiving Tower: one row per message accepted from a peer,
-- carrying the message's current state itself (delivered, held with its reason, or
-- dismissed), written in the same transaction as every mailbox change that alters it.
-- A duplicate is answered from this row alone; it outlives the mailbox row and is
-- pruned only after expires_at (sentAt + 30 days).
CREATE TABLE IF NOT EXISTS peer_accepted (
  peer_tower_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  mailbox_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,                           -- 'delivered' | 'held' | 'dismissed'
  reason TEXT,                                   -- with 'held': busy | no-profile | no-live-pty | held-for-release
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (peer_tower_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_peer_accepted_expires ON peer_accepted(expires_at);

-- The record of every cross-Tower attempt, at both ends, without a body, statement, MAC
-- or secret. One row per attempt, except floods (contract section 8, Departures C5):
-- aggregate rows carry aggregate_key (one per direction, sender, outcome, reason and
-- minute) with a count and the first and last time.
CREATE TABLE IF NOT EXISTS peer_records (
  id INTEGER PRIMARY KEY,
  direction TEXT NOT NULL,                       -- 'outbound' | 'inbound'
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  aggregate_key TEXT,                            -- NULL for an ordinary row
  kind TEXT,                                     -- 'message' | 'query'; NULL when not known
  peer_tower_id TEXT,                            -- the other Tower; NULL while the sender is unverified
  peer_slug TEXT,
  tunnel_session TEXT,                           -- inbound, sender unverified: the tunnel session
  message_id TEXT,
  from_address TEXT,
  to_address TEXT,
  payload_size INTEGER,
  outcome TEXT NOT NULL,
  reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_peer_records_aggregate
  ON peer_records(aggregate_key) WHERE aggregate_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_peer_records_last_at ON peer_records(last_at);
CREATE INDEX IF NOT EXISTS idx_peer_records_peer ON peer_records(peer_tower_id, first_at);
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
  command TEXT,                           -- launch command; render-gate identity seam (Spec 1313)
  shellper_session_id TEXT,               -- id the shellper was created with (Spec 1658)
  shellper_secret TEXT,                   -- per-session pipe secret; Windows only, else NULL (Spec 1658)
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
-- address_name (Spec 1940, migration v20): the workspace's explicit address name, lower-cased,
-- NULL when it is addressed by its directory basename. The rules live in
-- utils/workspace-address.ts; the unique index is only a backstop for them.
CREATE TABLE IF NOT EXISTS known_workspaces (
  workspace_path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  last_launched_at TEXT NOT NULL DEFAULT (datetime('now')),
  address_name TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_known_workspaces_address_name
  ON known_workspaces(address_name) WHERE address_name IS NOT NULL;

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

-- Mailbox (Spec 1313): durable home for every 'afx send'.
-- Persist-first delivery — a row is written before the send response returns, so
-- nothing is lost to a Tower crash/restart/shutdown (the retired in-memory
-- SendBuffer lost held messages on both). Rows address AGENTS (to_agent within
-- workspace_path), not PTYs, so a respawned terminal drains its predecessor's
-- mail. Delivery is authorized elsewhere by the render-gate (Phases 2/4); this
-- table is pure durable state. Timestamps are epoch-ms integers (not SQLite
-- datetime) so ordering and age math are trivial. Additive new table — fresh
-- installs get it here; existing installs get it from migration v15.
CREATE TABLE IF NOT EXISTS mailbox (
  id TEXT PRIMARY KEY,                    -- uuid
  workspace_path TEXT NOT NULL,           -- addressing scope
  to_agent TEXT NOT NULL,                 -- recipient agent identity (drains across respawn)
  terminal_id TEXT,                       -- last-known PTY hint (nullable; not the identity)
  from_agent TEXT,
  from_workspace TEXT,
  body TEXT NOT NULL,                     -- raw message (never logged)
  formatted_message TEXT NOT NULL,        -- what gets written to the PTY
  no_enter INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'held'
    CHECK(status IN ('held', 'delivered', 'superseded', 'dismissed')),
  reason TEXT CHECK(reason IN ('busy', 'no-profile', 'no-live-pty')),  -- why-held; null once delivered
  detail TEXT,                            -- Issue #1482: the gate verdict's detail behind a busy hold ('user-text' = a human at the line; 'no-region-end'/'no-composer-marker' = the classifier could not verify). Null for non-gate holds and once delivered. NO CHECK on purpose -- SQLite cannot ALTER one in, so migration v18 could not match it and a fresh install would diverge from an upgraded one; the value set is enforced in TypeScript (MailboxGateDetail)
  supersede_key TEXT,                     -- cron-only; null for direct sends
  escalated INTEGER NOT NULL DEFAULT 0,   -- set once escalation age crossed (visibility only)
  not_before INTEGER,                     -- epoch ms; delayed-send due time (Spec 1313 round 3, --delay). null = deliver ASAP; a row is deliverable only when not_before IS NULL OR not_before <= now
  created_at INTEGER NOT NULL,            -- epoch ms (enqueue order per agent)
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,                    -- delivered/superseded/dismissed timestamp
  -- Spec 1967 (migration v21): mail that arrived from another Tower. All NULL for local mail.
  -- No CHECK on any of them, for v18's reason; the values are enforced in TypeScript.
  remote_tower_id TEXT,                   -- the sending Tower's id, from the verified statement
  remote_message_id TEXT,                 -- the message id (the statement's requestId)
  remote_sender TEXT,                     -- JSON MailboxRemoteSender: Tower id and slug, and the stated sending address
  remote_owner_email TEXT,                -- the sending Tower's owner, from the statement
  release_hold INTEGER NOT NULL DEFAULT 0, -- 1 = held for release: never drained, escalated or counted as waiting; only with status 'held'
  released_at INTEGER                     -- epoch ms the owner released it (afx inbox release); NULL if never released
);

CREATE INDEX IF NOT EXISTS idx_mailbox_workspace_status ON mailbox(workspace_path, status);
CREATE INDEX IF NOT EXISTS idx_mailbox_agent_drain ON mailbox(workspace_path, to_agent, status);
CREATE INDEX IF NOT EXISTS idx_mailbox_supersede ON mailbox(supersede_key);

${PEER_SCHEMA}`;
