/**
 * One-time state.db → global.db consolidation engine (Issue #1118).
 *
 * The retired per-workspace `state.db` files hold architect/builders/utils/
 * annotations rows. This engine migrates a single `state.db` into the shared
 * `global.db`, then renames the source (never deletes it). It is the single
 * source of truth used by two callers:
 *
 *   1. The automatic boot one-off (tower-server.ts) — runs once ever, gated by
 *      a persistent `_consolidation` marker, against the *active* state.db.
 *   2. The manual `afx db consolidate <path>` command — runs on demand against
 *      any satellite state.db. Not marker-gated.
 *
 * It knows nothing about the marker. Conflict resolution is **upsert-if-newer**
 * (latest `started_at` wins): on an empty target every row inserts; on a
 * non-empty target a stale overlapping row is skipped. Reads are defensive
 * (`PRAGMA`-tolerant) so source files at any historical schema version migrate.
 */

import Database from 'better-sqlite3';
import { existsSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getConfig } from '../utils/index.js';
// Issue #1118: shared workspace-path canonicalization (single source of truth),
// aliased to `canonicalize` for the local callsites.
import { normalizeWorkspacePath as canonicalize } from '../utils/workspace-path.js';

type Row = Record<string, unknown>;

export interface TableStat {
  table: string;
  inserted: number; // no existing row for this PK
  updated: number;  // existing row, incoming is newer
  skipped: number;  // existing row, incoming is older-or-equal
}

export interface MigrationPlan {
  sourcePath: string;
  exists: boolean;
  stats: TableStat[];
  get total(): number;
}

export interface MigrationResult {
  sourcePath: string;
  migrated: boolean;
  renamedTo: string | null;
  stats: TableStat[];
}

/** The `state.db` the pre-#1118 `getDb()` would have opened for this process. */
export function activeStateDbPath(): string {
  return resolve(getConfig().stateDir, 'state.db');
}

/** A builder's owning workspace: the prefix before the LAST `/.builders/`, else fallback. */
function deriveWorkspaceFromWorktree(worktree: string, fallback: string): string {
  // lastIndexOf, not indexOf — robust when the path contains an earlier
  // `.builders` segment (a builder worktree nested under another).
  const marker = '/.builders/';
  const idx = worktree.lastIndexOf(marker);
  if (idx >= 0) return canonicalize(worktree.slice(0, idx));
  return fallback;
}

/** `<workspace>/.agent-farm/state.db` → canonical `<workspace>`. */
function workspaceFromStateDbPath(file: string): string {
  return canonicalize(dirname(dirname(file)));
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
}

function readRows(db: Database.Database, table: string): Row[] {
  if (!tableExists(db, table)) return [];
  return db.prepare(`SELECT * FROM ${table}`).all() as Row[];
}

function str(v: unknown, fallback = ''): string {
  if (v == null) return fallback;
  return String(v);
}
function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  return fallback;
}

const VALID_STATUS = new Set(['spawning', 'implementing', 'blocked', 'pr', 'complete']);
const VALID_TYPE = new Set(['spec', 'task', 'protocol', 'shell', 'worktree', 'bugfix', 'pir']);

// ---------------------------------------------------------------------------
// Normalizers — map a source row (any historical shape) to the target shape,
// synthesizing workspace_path and clamping legacy enum values so the global
// CHECK constraints never reject a migrated row.
// ---------------------------------------------------------------------------

function normalizeArchitect(row: Row, wsFromFile: string): Row {
  // Pre-v11 rows lack workspace_path → derive from the file's own directory.
  // Pre-v9 rows used integer id=1 → the singleton became 'main'.
  let workspace_path: string;
  if (row.workspace_path) {
    workspace_path = canonicalize(str(row.workspace_path));
  } else {
    workspace_path = wsFromFile;
  }
  const idRaw = row.id;
  let id: string;
  if (idRaw == null || str(idRaw) === '1') {
    id = 'main';
  } else {
    id = str(idRaw);
  }
  return {
    workspace_path,
    id,
    pid: num(row.pid),
    port: num(row.port),
    cmd: str(row.cmd),
    started_at: str(row.started_at),
    terminal_id: row.terminal_id ?? null,
    session_id: row.session_id ?? null,
  };
}

function normalizeBuilder(row: Row, wsFromFile: string): Row {
  const worktree = str(row.worktree);
  let workspace_path: string;
  if (row.workspace_path) {
    workspace_path = canonicalize(str(row.workspace_path));
  } else {
    workspace_path = deriveWorkspaceFromWorktree(worktree, wsFromFile);
  }
  let status = str(row.status, 'spawning');
  if (status === 'pr-ready') status = 'pr'; // pre-v7 rename
  if (!VALID_STATUS.has(status)) status = 'implementing';
  let type = str(row.type, 'spec');
  if (!VALID_TYPE.has(type)) type = 'spec';
  const startedAt = str(row.started_at);
  let issueNumber: string | null = null;
  if (row.issue_number != null) issueNumber = str(row.issue_number);
  return {
    workspace_path,
    id: str(row.id),
    name: str(row.name, str(row.id)),
    port: num(row.port),
    pid: num(row.pid),
    status,
    phase: str(row.phase),
    worktree,
    branch: str(row.branch),
    type,
    task_text: row.task_text ?? null,
    protocol_name: row.protocol_name ?? null,
    issue_number: issueNumber,
    terminal_id: row.terminal_id ?? null,
    spawned_by_architect: row.spawned_by_architect ?? null,
    started_at: startedAt,
    updated_at: str(row.updated_at, startedAt),
  };
}

function normalizeUtil(row: Row): Row {
  return {
    id: str(row.id),
    name: str(row.name, str(row.id)),
    port: num(row.port),
    pid: num(row.pid),
    terminal_id: row.terminal_id ?? null,
    started_at: str(row.started_at),
  };
}

function normalizeAnnotation(row: Row): Row {
  return {
    id: str(row.id),
    file: str(row.file),
    port: num(row.port),
    pid: num(row.pid),
    parent_type: str(row.parent_type, 'util'),
    parent_id: row.parent_id ?? null,
    started_at: str(row.started_at),
  };
}

// ---------------------------------------------------------------------------
// Upsert-if-newer statements. The `WHERE excluded.started_at > <table>.started_at`
// on the conflict path means a stale incoming row leaves the existing (newer)
// row untouched.
// ---------------------------------------------------------------------------

function upsertArchitect(db: Database.Database, r: Row): void {
  db.prepare(`
    INSERT INTO architect (workspace_path, id, pid, port, cmd, started_at, terminal_id, session_id)
    VALUES (@workspace_path, @id, @pid, @port, @cmd, @started_at, @terminal_id, @session_id)
    ON CONFLICT(workspace_path, id) DO UPDATE SET
      pid = excluded.pid, port = excluded.port, cmd = excluded.cmd,
      started_at = excluded.started_at, terminal_id = excluded.terminal_id,
      session_id = excluded.session_id
    WHERE excluded.started_at > architect.started_at
  `).run(r);
}

function upsertBuilder(db: Database.Database, r: Row): void {
  db.prepare(`
    INSERT INTO builders (
      workspace_path, id, name, port, pid, status, phase, worktree, branch,
      type, task_text, protocol_name, issue_number, terminal_id, spawned_by_architect,
      started_at, updated_at
    )
    VALUES (
      @workspace_path, @id, @name, @port, @pid, @status, @phase, @worktree, @branch,
      @type, @task_text, @protocol_name, @issue_number, @terminal_id, @spawned_by_architect,
      @started_at, @updated_at
    )
    ON CONFLICT(workspace_path, id) DO UPDATE SET
      name = excluded.name, port = excluded.port, pid = excluded.pid,
      status = excluded.status, phase = excluded.phase, worktree = excluded.worktree,
      branch = excluded.branch, type = excluded.type, task_text = excluded.task_text,
      protocol_name = excluded.protocol_name, issue_number = excluded.issue_number,
      terminal_id = excluded.terminal_id, spawned_by_architect = excluded.spawned_by_architect,
      started_at = excluded.started_at, updated_at = excluded.updated_at
    WHERE excluded.started_at > builders.started_at
  `).run(r);
}

function upsertUtil(db: Database.Database, r: Row): void {
  db.prepare(`
    INSERT INTO utils (id, name, port, pid, terminal_id, started_at)
    VALUES (@id, @name, @port, @pid, @terminal_id, @started_at)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, port = excluded.port, pid = excluded.pid,
      terminal_id = excluded.terminal_id, started_at = excluded.started_at
    WHERE excluded.started_at > utils.started_at
  `).run(r);
}

function upsertAnnotation(db: Database.Database, r: Row): void {
  db.prepare(`
    INSERT INTO annotations (id, file, port, pid, parent_type, parent_id, started_at)
    VALUES (@id, @file, @port, @pid, @parent_type, @parent_id, @started_at)
    ON CONFLICT(id) DO UPDATE SET
      file = excluded.file, port = excluded.port, pid = excluded.pid,
      parent_type = excluded.parent_type, parent_id = excluded.parent_id,
      started_at = excluded.started_at
    WHERE excluded.started_at > annotations.started_at
  `).run(r);
}

interface TableSpec {
  table: string;
  pk: string[];
  rows: Row[];
  upsert: (db: Database.Database, r: Row) => void;
}

function buildSpecs(src: Database.Database, wsFromFile: string): TableSpec[] {
  return [
    {
      table: 'architect',
      pk: ['workspace_path', 'id'],
      rows: readRows(src, 'architect').map((r) => normalizeArchitect(r, wsFromFile)),
      upsert: upsertArchitect,
    },
    {
      table: 'builders',
      pk: ['workspace_path', 'id'],
      rows: readRows(src, 'builders').map((r) => normalizeBuilder(r, wsFromFile)),
      upsert: upsertBuilder,
    },
    {
      table: 'utils',
      pk: ['id'],
      rows: readRows(src, 'utils').map(normalizeUtil),
      upsert: upsertUtil,
    },
    {
      table: 'annotations',
      pk: ['id'],
      rows: readRows(src, 'annotations').map(normalizeAnnotation),
      upsert: upsertAnnotation,
    },
  ];
}

/** Classify one incoming row against the current global table (no writes). */
function classify(
  db: Database.Database,
  spec: TableSpec,
  row: Row,
): 'inserted' | 'updated' | 'skipped' {
  if (!tableExists(db, spec.table)) return 'inserted';
  const where = spec.pk.map((c) => `${c} = ?`).join(' AND ');
  const existing = db
    .prepare(`SELECT started_at FROM ${spec.table} WHERE ${where}`)
    .get(...spec.pk.map((c) => row[c])) as { started_at: string } | undefined;
  if (!existing) return 'inserted';
  if (str(row.started_at) > str(existing.started_at)) return 'updated';
  return 'skipped';
}

/**
 * Compute what migrating `sourcePath` into `globalDb` would do — pure read, no
 * writes, no rename. Used by the `--dry-run-migration` preview.
 */
export function planMigration(globalDb: Database.Database, sourcePath: string): MigrationPlan {
  if (!existsSync(sourcePath)) {
    return { sourcePath, exists: false, stats: [], get total() { return 0; } };
  }
  const wsFromFile = workspaceFromStateDbPath(sourcePath);
  const src = new Database(sourcePath, { readonly: true });
  try {
    const specs = buildSpecs(src, wsFromFile);
    const stats: TableStat[] = specs.map((spec) => {
      const s: TableStat = { table: spec.table, inserted: 0, updated: 0, skipped: 0 };
      for (const row of spec.rows) s[classify(globalDb, spec, row)]++;
      return s;
    });
    return {
      sourcePath,
      exists: true,
      stats,
      get total() {
        return stats.reduce((n, s) => n + s.inserted + s.updated + s.skipped, 0);
      },
    };
  } finally {
    src.close();
  }
}

function renameWithSidecars(file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${file}.pre-merge-${stamp}`;
  renameSync(file, target);
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = file + suffix;
    if (existsSync(sidecar)) {
      try {
        renameSync(sidecar, target + suffix);
      } catch {
        // Sidecar rename is best-effort; the main file is already retired.
      }
    }
  }
  return target;
}

/** Read a source state.db, build per-table specs, and classify each row. */
function prepareMigration(
  globalDb: Database.Database,
  sourcePath: string,
): { specs: TableSpec[]; stats: TableStat[]; total: number } {
  const wsFromFile = workspaceFromStateDbPath(sourcePath);
  const src = new Database(sourcePath, { readonly: true });
  try {
    const specs = buildSpecs(src, wsFromFile);
    let total = 0;
    const stats = specs.map((spec) => {
      const s: TableStat = { table: spec.table, inserted: 0, updated: 0, skipped: 0 };
      for (const row of spec.rows) {
        s[classify(globalDb, spec, row)]++;
        total++;
      }
      return s;
    });
    return { specs, stats, total };
  } finally {
    src.close();
  }
}

/** Apply all upserts for the prepared specs (caller wraps in a transaction). */
function copyRows(globalDb: Database.Database, specs: TableSpec[]): void {
  for (const spec of specs) {
    for (const row of spec.rows) spec.upsert(globalDb, row);
  }
}

/**
 * Migrate `sourcePath` into `globalDb` (upsert-if-newer, one transaction), then
 * rename the source to `*.pre-merge-<timestamp>`. Does NOT touch the
 * `_consolidation` marker — that is the boot caller's concern. This is the
 * manual `afx db consolidate <path>` path. Idempotent in practice: once renamed
 * the source is gone, and re-running upsert-if-newer is a no-op.
 */
export function applyMigration(globalDb: Database.Database, sourcePath: string): MigrationResult {
  if (!existsSync(sourcePath)) {
    return { sourcePath, migrated: false, renamedTo: null, stats: [] };
  }
  const { specs, stats } = prepareMigration(globalDb, sourcePath);
  globalDb.transaction(() => copyRows(globalDb, specs))();
  const renamedTo = renameWithSidecars(sourcePath);
  return { sourcePath, migrated: true, renamedTo, stats };
}

// ---------------------------------------------------------------------------
// The `_consolidation` marker + the automatic boot one-off (Issue #1118).
// The marker's mere presence means the one-time boot cutover has run; `state.db`
// is never read again afterward.
// ---------------------------------------------------------------------------

function ensureMarkerTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _consolidation (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      done_at TEXT NOT NULL DEFAULT (datetime('now')),
      source_path TEXT,
      rows_migrated INTEGER
    )
  `);
}

/** Whether the one-time boot consolidation has already run. */
export function isConsolidationDone(db: Database.Database): boolean {
  ensureMarkerTable(db);
  return !!db.prepare('SELECT 1 FROM _consolidation WHERE id = 1').get();
}

function writeMarker(db: Database.Database, sourcePath: string | null, rows: number): void {
  db.prepare(
    'INSERT OR IGNORE INTO _consolidation (id, source_path, rows_migrated) VALUES (1, ?, ?)',
  ).run(sourcePath, rows);
}

/**
 * The automatic boot one-off. Runs once ever (strict policy): on the first boot
 * the marker is unset, so it migrates the *active* state.db and writes the
 * marker — **unconditionally**, even if the active file is absent/empty, so
 * state.db is never checked again. The row copy and marker write share one
 * transaction (atomic); the source rename happens after commit.
 *
 * Returns null if the marker was already set (no-op). Satellite files missed by
 * this one-off are recoverable via the manual `afx db consolidate <path>`.
 */
export function runBootConsolidation(globalDb: Database.Database): MigrationResult | null {
  if (isConsolidationDone(globalDb)) return null;
  const sourcePath = activeStateDbPath();

  if (!existsSync(sourcePath)) {
    // Strict: mark done even with nothing to migrate.
    globalDb.transaction(() => writeMarker(globalDb, null, 0))();
    return { sourcePath, migrated: false, renamedTo: null, stats: [] };
  }

  const { specs, stats, total } = prepareMigration(globalDb, sourcePath);
  globalDb.transaction(() => {
    copyRows(globalDb, specs);
    writeMarker(globalDb, sourcePath, total);
  })();
  const renamedTo = renameWithSidecars(sourcePath);
  return { sourcePath, migrated: true, renamedTo, stats };
}
