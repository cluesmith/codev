/**
 * Boot-time canonicalization of stored workspace paths (Spec 1658, finding M6).
 *
 * Before the fix, Windows rows were keyed by whatever spelling a writer saw
 * (`c:\repo` from the VS Code extension, `C:\repo` from Git Bash), so one
 * directory could own rows under two keys. Tower calls this at boot on Windows,
 * before reconcile and `initInstances()` read any row, so every stored spelling
 * collapses onto the canonical key `normalizeWorkspacePath` now produces.
 *
 * It runs on every Windows boot rather than once behind a marker: it is
 * idempotent (a canonical row maps to itself and is left alone) and cheap (one
 * canonicalization per distinct stored path), and it heals any row a stray
 * writer keys raw later. Tower does not call it on POSIX (#1870).
 *
 * When two spellings collapse onto one key and both hold the same key, the
 * winner is decided by liveness and freshness, never by spelling alone, and no
 * row whose process is still running is ever deleted:
 *
 * - `terminal_sessions`, per (type, role_id): a row whose process is gone is
 *   deleted; if only the other row's process is gone, that one is. If BOTH are
 *   alive, both rows are kept (nothing is deleted or signalled) and the pair is
 *   reported as a live duplicate for the caller to log as an error: reconcile
 *   reconnects both, so neither shellper is swept as an orphan, and a human
 *   decides which to stop.
 * - `architect`, `builders`, per (workspace, id): the row whose terminal is
 *   alive wins; else the later `started_at`; a full tie keeps the row already
 *   under the canonical key. Agent rows are settled before terminal rows, so a
 *   surviving agent's terminal is the live one whenever exactly one is live.
 * - `known_workspaces`: one row survives, with the later `last_launched_at`.
 * - `cron_tasks`, per (workspace, task_name): the later `last_run` wins; a moved
 *   row's id is recomputed, because cron ids hash the workspace path.
 * - `mailbox`, `file_tabs`: no workspace-scoped key, so every row moves (the
 *   mailbox's `from_workspace` too, including spellings that appear only there).
 *
 * Paths that no longer exist canonicalize through the same fallback chain as
 * live ones (see workspace-path.ts), so they move only if that chain changes
 * their spelling (for example a lower-case drive letter).
 */

import type Database from 'better-sqlite3';

export interface CanonicalizeOptions {
  /** The canonical form of a stored path (production: `normalizeWorkspacePath`). */
  canonicalize: (workspacePath: string) => string;
  /** A cron task's id for a workspace and task name (production: tower-cron `getTaskId`). */
  cronTaskId: (workspacePath: string, taskName: string) => string;
  /**
   * Whether the process a row recorded is still running. `recordedStartTime` is the
   * row's `shellper_start_time` (null for a row without one): a live PID whose start
   * time does not match it is a REUSED PID, so it reads as dead. Production: a
   * signal-0 probe plus the husk sweep's start-time identity check, from a start-time
   * snapshot taken before the transaction.
   */
  isAlive: (pid: number, recordedStartTime: number | null) => boolean;
}

export interface CanonicalizeReport {
  /** Each stored spelling that moved, and its canonical form. */
  moved: Array<{ from: string; to: string }>;
  /** Rows deleted because the canonical spelling already held their key. */
  dropped: Array<{ table: string; key: string }>;
  /** Terminal ids whose rows were dropped because their process was gone. */
  droppedTerminalIds: string[];
  /** Two live sessions claiming one role: both rows kept, for a human to resolve. */
  liveDuplicates: Array<{ workspace: string; type: string; roleId: string | null; terminalIds: string[] }>;
  /** Builder worktree paths rewritten to their canonical spelling. */
  worktreesRewritten: number;
}

/** Tables keyed (in whole or part) by `workspace_path`. */
const WORKSPACE_TABLES = [
  'known_workspaces',
  'architect',
  'builders',
  'cron_tasks',
  'terminal_sessions',
  'mailbox',
  'file_tabs',
] as const;

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function distinctStoredPaths(db: Database.Database, tables: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const table of tables) {
    const rows = db.prepare(`SELECT DISTINCT workspace_path AS p FROM ${table}`).all() as Array<{ p: string }>;
    for (const row of rows) {
      paths.add(row.p);
    }
  }
  if (tables.includes('mailbox')) {
    // A sender workspace with no rows of its own still needs its spelling moved.
    const senders = db.prepare('SELECT DISTINCT from_workspace AS p FROM mailbox WHERE from_workspace IS NOT NULL').all() as Array<{ p: string }>;
    for (const row of senders) {
      paths.add(row.p);
    }
  }
  return [...paths];
}

/** Whether a terminal row's process (its shellper, else the PTY child) is still running. */
function terminalAlive(db: Database.Database, terminalId: string | null, opts: CanonicalizeOptions): boolean {
  if (!terminalId) return false;
  const row = db.prepare('SELECT pid, shellper_pid, shellper_start_time FROM terminal_sessions WHERE id = ?').get(terminalId) as
    | { pid: number | null; shellper_pid: number | null; shellper_start_time: number | null }
    | undefined;
  if (!row) return false;
  if (row.shellper_pid !== null && row.shellper_pid !== undefined && row.shellper_pid > 0) {
    return opts.isAlive(row.shellper_pid, row.shellper_start_time ?? null);
  }
  // No shellper: the PTY child's pid, which carries no recorded start time.
  if (row.pid === null || row.pid === undefined || row.pid <= 0) return false;
  return opts.isAlive(row.pid, null);
}

function moveKnownWorkspace(db: Database.Database, from: string, to: string, report: CanonicalizeReport): void {
  const old = db.prepare('SELECT last_launched_at FROM known_workspaces WHERE workspace_path = ?').get(from) as
    | { last_launched_at: string }
    | undefined;
  if (!old) return;
  const existing = db.prepare('SELECT last_launched_at FROM known_workspaces WHERE workspace_path = ?').get(to) as
    | { last_launched_at: string }
    | undefined;
  if (!existing) {
    db.prepare('UPDATE known_workspaces SET workspace_path = ? WHERE workspace_path = ?').run(to, from);
    return;
  }
  if (old.last_launched_at > existing.last_launched_at) {
    db.prepare('UPDATE known_workspaces SET last_launched_at = ? WHERE workspace_path = ?').run(old.last_launched_at, to);
  }
  db.prepare('DELETE FROM known_workspaces WHERE workspace_path = ?').run(from);
  report.dropped.push({ table: 'known_workspaces', key: from });
}

/** True when the moving agent row should replace the one already under the canonical key. */
function movingAgentWins(
  db: Database.Database,
  moving: { terminal_id: string | null; started_at: string },
  existing: { terminal_id: string | null; started_at: string },
  opts: CanonicalizeOptions,
): boolean {
  const movingAlive = terminalAlive(db, moving.terminal_id, opts);
  const existingAlive = terminalAlive(db, existing.terminal_id, opts);
  if (movingAlive !== existingAlive) {
    return movingAlive;
  }
  return moving.started_at > existing.started_at;
}

/** `architect` / `builders`: move by (workspace, id), settling a clash by liveness, then freshness. */
function moveById(
  db: Database.Database,
  table: 'architect' | 'builders',
  from: string,
  to: string,
  opts: CanonicalizeOptions,
  report: CanonicalizeReport,
): void {
  type AgentRow = { id: string; terminal_id: string | null; started_at: string };
  const rows = db.prepare(`SELECT id, terminal_id, started_at FROM ${table} WHERE workspace_path = ?`).all(from) as AgentRow[];
  for (const row of rows) {
    const existing = db
      .prepare(`SELECT id, terminal_id, started_at FROM ${table} WHERE workspace_path = ? AND id = ?`)
      .get(to, row.id) as AgentRow | undefined;
    if (!existing) {
      db.prepare(`UPDATE ${table} SET workspace_path = ? WHERE workspace_path = ? AND id = ?`).run(to, from, row.id);
      continue;
    }
    if (movingAgentWins(db, row, existing, opts)) {
      db.prepare(`DELETE FROM ${table} WHERE workspace_path = ? AND id = ?`).run(to, row.id);
      db.prepare(`UPDATE ${table} SET workspace_path = ? WHERE workspace_path = ? AND id = ?`).run(to, from, row.id);
      report.dropped.push({ table, key: `${to} ${row.id}` });
    } else {
      db.prepare(`DELETE FROM ${table} WHERE workspace_path = ? AND id = ?`).run(from, row.id);
      report.dropped.push({ table, key: `${from} ${row.id}` });
    }
  }
}

function moveCronTasks(db: Database.Database, from: string, to: string, opts: CanonicalizeOptions, report: CanonicalizeReport): void {
  type CronRow = { id: string; task_name: string; last_run: number | null };
  const rows = db.prepare('SELECT id, task_name, last_run FROM cron_tasks WHERE workspace_path = ?').all(from) as CronRow[];
  for (const row of rows) {
    const existing = db
      .prepare('SELECT id, task_name, last_run FROM cron_tasks WHERE workspace_path = ? AND task_name = ?')
      .get(to, row.task_name) as CronRow | undefined;
    if (existing && (row.last_run ?? -1) > (existing.last_run ?? -1)) {
      db.prepare('DELETE FROM cron_tasks WHERE id = ?').run(existing.id);
      report.dropped.push({ table: 'cron_tasks', key: `${to} ${row.task_name}` });
    } else if (existing) {
      db.prepare('DELETE FROM cron_tasks WHERE id = ?').run(row.id);
      report.dropped.push({ table: 'cron_tasks', key: `${from} ${row.task_name}` });
      continue;
    }
    db.prepare('UPDATE cron_tasks SET workspace_path = ?, id = ? WHERE id = ?').run(to, opts.cronTaskId(to, row.task_name), row.id);
  }
}

/** Whether a surviving architect or builder row in `workspace` points at this terminal. */
function referencedByAgent(db: Database.Database, workspace: string, terminalId: string): boolean {
  for (const table of ['architect', 'builders']) {
    if (!tableExists(db, table)) continue;
    if (db.prepare(`SELECT 1 FROM ${table} WHERE workspace_path = ? AND terminal_id = ?`).get(workspace, terminalId)) {
      return true;
    }
  }
  return false;
}

/**
 * `terminal_sessions`, per (type, role_id): delete only a row whose process is
 * gone; when both are alive keep both and report the pair. When neither is
 * alive, keep the row a surviving agent row points at, so an agent never keeps a
 * dangling terminal id. Never signals.
 */
function moveTerminalSessions(db: Database.Database, from: string, to: string, opts: CanonicalizeOptions, report: CanonicalizeReport): void {
  const rows = db.prepare('SELECT id, type, role_id FROM terminal_sessions WHERE workspace_path = ?').all(from) as Array<{
    id: string;
    type: string;
    role_id: string | null;
  }>;
  for (const row of rows) {
    const existing = db
      .prepare('SELECT id FROM terminal_sessions WHERE workspace_path = ? AND type = ? AND role_id IS ?')
      .all(to, row.type, row.role_id) as Array<{ id: string }>;
    const movingAlive = terminalAlive(db, row.id, opts);
    const anyExistingAlive = existing.some((other) => terminalAlive(db, other.id, opts));
    const movingIsTheAgentsTerminal = referencedByAgent(db, to, row.id);
    if (existing.length > 0 && !movingAlive && (anyExistingAlive || !movingIsTheAgentsTerminal)) {
      db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(row.id);
      report.dropped.push({ table: 'terminal_sessions', key: `${from} ${row.type} ${row.role_id ?? ''}`.trim() });
      report.droppedTerminalIds.push(row.id);
      continue;
    }
    const liveExisting: string[] = [];
    for (const other of existing) {
      if (terminalAlive(db, other.id, opts)) {
        liveExisting.push(other.id);
      } else {
        db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(other.id);
        report.dropped.push({ table: 'terminal_sessions', key: `${to} ${row.type} ${row.role_id ?? ''}`.trim() });
        report.droppedTerminalIds.push(other.id);
      }
    }
    db.prepare('UPDATE terminal_sessions SET workspace_path = ? WHERE id = ?').run(to, row.id);
    if (liveExisting.length > 0) {
      report.liveDuplicates.push({ workspace: to, type: row.type, roleId: row.role_id, terminalIds: [...liveExisting, row.id] });
    }
  }
}

function rewriteWorktrees(db: Database.Database, opts: CanonicalizeOptions, report: CanonicalizeReport): void {
  const rows = db.prepare('SELECT workspace_path, id, worktree FROM builders').all() as Array<{
    workspace_path: string;
    id: string;
    worktree: string;
  }>;
  for (const row of rows) {
    if (!row.worktree) continue;
    const canonical = opts.canonicalize(row.worktree);
    if (canonical !== row.worktree) {
      db.prepare('UPDATE builders SET worktree = ? WHERE workspace_path = ? AND id = ?').run(canonical, row.workspace_path, row.id);
      report.worktreesRewritten++;
    }
  }
}

/** Collapse every stored workspace spelling onto its canonical key, in one transaction. */
export function canonicalizeWorkspacePathRows(db: Database.Database, opts: CanonicalizeOptions): CanonicalizeReport {
  const report: CanonicalizeReport = { moved: [], dropped: [], droppedTerminalIds: [], liveDuplicates: [], worktreesRewritten: 0 };
  const tables = WORKSPACE_TABLES.filter((t) => tableExists(db, t));

  db.transaction(() => {
    for (const from of distinctStoredPaths(db, tables)) {
      const to = opts.canonicalize(from);
      if (to === from) continue;
      report.moved.push({ from, to });
      for (const table of tables) {
        if (table === 'known_workspaces') {
          moveKnownWorkspace(db, from, to, report);
        } else if (table === 'architect' || table === 'builders') {
          moveById(db, table, from, to, opts, report);
        } else if (table === 'cron_tasks') {
          moveCronTasks(db, from, to, opts, report);
        } else if (table === 'terminal_sessions') {
          moveTerminalSessions(db, from, to, opts, report);
        } else {
          db.prepare(`UPDATE ${table} SET workspace_path = ? WHERE workspace_path = ?`).run(to, from);
        }
        if (table === 'mailbox') {
          // The sender's workspace, kept for replies, is a stored spelling too.
          db.prepare('UPDATE mailbox SET from_workspace = ? WHERE from_workspace = ?').run(to, from);
        }
      }
    }
    if (tables.includes('builders')) {
      rewriteWorktrees(db, opts, report);
    }
  })();

  return report;
}
