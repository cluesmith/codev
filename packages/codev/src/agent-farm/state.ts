/**
 * State management for Agent Farm
 *
 * Uses SQLite for ACID-compliant state persistence with proper concurrency handling.
 * All operations are synchronous and atomic.
 */

import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { DashboardState, ArchitectState, Builder, UtilTerminal, Annotation } from './types.js';
import { getDb, closeDb } from './db/index.js';
import type { DbArchitect, DbBuilder, DbUtil, DbAnnotation } from './db/types.js';
import {
  dbArchitectToArchitectState,
  dbBuilderToBuilder,
  dbUtilToUtilTerminal,
  dbAnnotationToAnnotation,
} from './db/types.js';
import { isPortConflictError } from './db/errors.js';

/**
 * Normalize a workspace path to its canonical form (Bugfix #826 iter-6).
 *
 * The architect table's primary key includes `workspace_path`. Tower writes
 * canonical realpaths (via `normalizeWorkspacePath` in tower-utils.ts); CLI
 * callers and legacy migration paths often pass raw paths (e.g. a symlinked
 * workspace root). Without normalization, accessing a workspace via two
 * different paths (symlink + realpath) creates two distinct rows and lookups
 * silently fail.
 *
 * Mirrors the contract of `servers/tower-utils.ts:normalizeWorkspacePath`.
 * Kept inline to avoid pulling the server-layer import chain into the data
 * layer. Uses `realpathSync` when the path exists; falls back to
 * `path.resolve` for not-yet-existing paths (e.g. fresh installs).
 */
function canonicalize(workspacePath: string): string {
  try {
    return realpathSync(workspacePath);
  } catch {
    return path.resolve(workspacePath);
  }
}

/**
 * Load complete state from database
 *
 * Spec 755: `DashboardState.architect` retains its scalar shape for
 * backward-compat — it's a shim pointing at `architects[0]` for legacy callers.
 * Spec 786 Phase 5: `DashboardState.architects` is now populated as a
 * main-first sorted collection so callers like `afx status` (Tower-down mode)
 * can enumerate ALL architects without re-querying. Main is always
 * `architects[0]` when present.
 *
 * Bugfix #826: now takes a `workspacePath` argument and scopes the architect
 * read by `workspace_path`. Other tables (builders, utils, annotations) are
 * not workspace-scoped in this schema — they remain global per state.db file.
 */
export function loadState(workspacePath: string): DashboardState {
  const db = getDb();
  const ws = canonicalize(workspacePath);

  // Spec 786 Phase 5: load ALL architects, ordered `main` first then by
  // started_at (so siblings appear in spawn order).
  //
  // The ORDER BY uses `id != 'main'` so that 'main' sorts first
  // (0 < 1 with this expression), then started_at ASC for siblings.
  //
  // Bugfix #826: scoped by workspace_path so a state.db that contains rows
  // for multiple workspaces (Tower's CWD shared by many) returns only the
  // architects belonging to the requested workspace.
  const architectRows = db.prepare(
    "SELECT * FROM architect WHERE workspace_path = ? ORDER BY (id != 'main'), started_at"
  ).all(ws) as DbArchitect[];
  const architects = architectRows.map(dbArchitectToArchitectState);
  // The scalar shim points at architects[0] (which is `main` when present,
  // else the first-registered architect by started_at). Preserves the legacy
  // /api/state contract.
  const architect = architects[0] ?? null;

  // Load builders
  const builderRows = db.prepare('SELECT * FROM builders ORDER BY started_at').all() as DbBuilder[];
  const builders = builderRows.map(dbBuilderToBuilder);

  // Load utils
  const utilRows = db.prepare('SELECT * FROM utils ORDER BY started_at').all() as DbUtil[];
  const utils = utilRows.map(dbUtilToUtilTerminal);

  // Load annotations
  const annotationRows = db.prepare('SELECT * FROM annotations ORDER BY started_at').all() as DbAnnotation[];
  const annotations = annotationRows.map(dbAnnotationToAnnotation);

  return {
    architect,
    architects,
    builders,
    utils,
    annotations,
  };
}

/**
 * Update architect state (main-only setter — preserved for backward-compat with
 * existing callers like `workspace start` / `stop`). Spec 755 added per-name
 * setters/getters below.
 *
 * If `architect` is provided with a non-default `name`, callers should use
 * `setArchitectByName(workspacePath, name, architect)` instead — this function
 * always writes the row with id = 'main'.
 *
 * Bugfix #826: scoped by workspace_path.
 */
export function setArchitect(workspacePath: string, architect: ArchitectState | null): void {
  const db = getDb();
  const ws = canonicalize(workspacePath);

  if (architect === null) {
    db.prepare("DELETE FROM architect WHERE workspace_path = ? AND id = 'main'").run(ws);
  } else {
    db.prepare(`
      INSERT OR REPLACE INTO architect (workspace_path, id, pid, port, cmd, started_at, terminal_id, session_id)
      VALUES (@workspacePath, 'main', 0, 0, @cmd, @startedAt, @terminalId, @sessionId)
    `).run({
      workspacePath: ws,
      cmd: architect.cmd,
      startedAt: architect.startedAt,
      terminalId: architect.terminalId ?? null,
      sessionId: architect.sessionId ?? null,
    });
  }
}

/**
 * Update architect state by name (Spec 755). Used by the Phase 2 CLI for
 * registering additional named architects. When `architect` is null, removes
 * just that named architect; non-null upserts it.
 *
 * Bugfix #826: scoped by workspace_path so siblings in workspace A are
 * isolated from workspace B.
 */
export function setArchitectByName(workspacePath: string, name: string, architect: ArchitectState | null): void {
  const db = getDb();
  const ws = canonicalize(workspacePath);

  if (architect === null) {
    db.prepare('DELETE FROM architect WHERE workspace_path = ? AND id = ?').run(ws, name);
    return;
  }

  db.prepare(`
    INSERT OR REPLACE INTO architect (workspace_path, id, pid, port, cmd, started_at, terminal_id, session_id)
    VALUES (@workspacePath, @name, 0, 0, @cmd, @startedAt, @terminalId, @sessionId)
  `).run({
    workspacePath: ws,
    name,
    cmd: architect.cmd,
    startedAt: architect.startedAt,
    terminalId: architect.terminalId ?? null,
    sessionId: architect.sessionId ?? null,
  });
}

/**
 * Add or update a builder
 * Note: This is now synchronous
 */
export function upsertBuilder(builder: Builder): void {
  const db = getDb();

  db.prepare(`
    INSERT INTO builders (
      id, name, port, pid, status, phase, worktree, branch,
      type, task_text, protocol_name, issue_number, terminal_id, spawned_by_architect
    )
    VALUES (
      @id, @name, 0, 0, @status, @phase, @worktree, @branch,
      @type, @taskText, @protocolName, @issueNumber, @terminalId, @spawnedByArchitect
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      status = excluded.status,
      phase = excluded.phase,
      worktree = excluded.worktree,
      branch = excluded.branch,
      type = excluded.type,
      task_text = excluded.task_text,
      protocol_name = excluded.protocol_name,
      issue_number = excluded.issue_number,
      terminal_id = excluded.terminal_id,
      spawned_by_architect = COALESCE(excluded.spawned_by_architect, builders.spawned_by_architect)
  `).run({
    id: builder.id,
    name: builder.name,
    status: builder.status,
    phase: builder.phase,
    worktree: builder.worktree,
    branch: builder.branch,
    type: builder.type,
    taskText: builder.taskText ?? null,
    protocolName: builder.protocolName ?? null,
    issueNumber: builder.issueNumber != null ? String(builder.issueNumber) : null,
    terminalId: builder.terminalId ?? null,
    spawnedByArchitect: builder.spawnedByArchitect ?? null,
  });
}

/**
 * Remove a builder
 * Note: This is now synchronous
 */
export function removeBuilder(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM builders WHERE id = ?').run(id);
}

/**
 * Get a single builder by ID
 */
export function getBuilder(id: string): Builder | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM builders WHERE id = ?').get(id) as DbBuilder | undefined;
  return row ? dbBuilderToBuilder(row) : null;
}

/**
 * Get all builders
 */
export function getBuilders(): Builder[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM builders ORDER BY started_at').all() as DbBuilder[];
  return rows.map(dbBuilderToBuilder);
}

/**
 * Get builders by status
 */
export function getBuildersByStatus(status: Builder['status']): Builder[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM builders WHERE status = ? ORDER BY started_at').all(status) as DbBuilder[];
  return rows.map(dbBuilderToBuilder);
}

/**
 * Add a utility terminal
 * Note: This is now synchronous
 */
export function addUtil(util: UtilTerminal): void {
  const db = getDb();

  db.prepare(`
    INSERT INTO utils (id, name, port, pid, terminal_id)
    VALUES (@id, @name, 0, 0, @terminalId)
  `).run({
    id: util.id,
    name: util.name,
    terminalId: util.terminalId ?? null,
  });
}

/**
 * Try to add a utility terminal, returning false on ID conflict
 * Used to handle concurrent insertion race conditions
 */
export function tryAddUtil(util: UtilTerminal): boolean {
  try {
    addUtil(util);
    return true;
  } catch (err) {
    if (isPortConflictError(err)) {
      return false;
    }
    throw err;
  }
}

/**
 * Update a utility terminal
 */
export function updateUtil(id: string, updates: Partial<UtilTerminal>): void {
  const db = getDb();
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  if ('terminalId' in updates) {
    fields.push('terminal_id = @terminalId');
    values.terminalId = updates.terminalId ?? null;
  }
  if ('name' in updates) {
    fields.push('name = @name');
    values.name = updates.name;
  }

  if (fields.length > 0) {
    db.prepare(`UPDATE utils SET ${fields.join(', ')} WHERE id = @id`).run(values);
  }
}

/**
 * Remove a utility terminal
 * Note: This is now synchronous
 */
export function removeUtil(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM utils WHERE id = ?').run(id);
}

/**
 * Get all utility terminals
 */
export function getUtils(): UtilTerminal[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM utils ORDER BY started_at').all() as DbUtil[];
  return rows.map(dbUtilToUtilTerminal);
}

/**
 * Get a single utility terminal by ID
 */
export function getUtil(id: string): UtilTerminal | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM utils WHERE id = ?').get(id) as DbUtil | undefined;
  return row ? dbUtilToUtilTerminal(row) : null;
}

/**
 * Add an annotation
 * Note: This is now synchronous
 */
export function addAnnotation(annotation: Annotation): void {
  const db = getDb();

  db.prepare(`
    INSERT INTO annotations (id, file, port, pid, parent_type, parent_id)
    VALUES (@id, @file, 0, 0, @parentType, @parentId)
  `).run({
    id: annotation.id,
    file: annotation.file,
    parentType: annotation.parent.type,
    parentId: annotation.parent.id ?? null,
  });
}

/**
 * Remove an annotation
 * Note: This is now synchronous
 */
export function removeAnnotation(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM annotations WHERE id = ?').run(id);
}

/**
 * Get all annotations
 */
export function getAnnotations(): Annotation[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM annotations ORDER BY started_at').all() as DbAnnotation[];
  return rows.map(dbAnnotationToAnnotation);
}

/**
 * Clear all state
 * Note: This is now synchronous
 */
export function clearState(): void {
  const db = getDb();

  const clear = db.transaction(() => {
    db.prepare('DELETE FROM architect').run();
    db.prepare('DELETE FROM builders').run();
    db.prepare('DELETE FROM utils').run();
    db.prepare('DELETE FROM annotations').run();
  });

  clear();
}

/**
 * Spec 786: clear runtime state but preserve the architect registry.
 *
 * Used by `afx workspace stop` so sibling architects survive a graceful stop/
 * start cycle. The `architect` table is the durable registration; `builders`,
 * `utils`, and `annotations` are runtime concerns and get wiped as before.
 *
 * `clearState()` (the full-wipe variant) is preserved for callers that genuinely
 * want everything gone (uninstall / nuke flows / `handleWorkspaceStopAll`).
 */
export function clearRuntime(): void {
  const db = getDb();

  const clear = db.transaction(() => {
    db.prepare('DELETE FROM builders').run();
    db.prepare('DELETE FROM utils').run();
    db.prepare('DELETE FROM annotations').run();
  });

  clear();
}

/**
 * Spec 786: remove a single architect by name from `state.db.architect`.
 *
 * Idempotent — no-op if the named row is absent. Used by `remove-architect`
 * (Phase 4) and the permanent-exit handler (Phase 3 / OQ-B).
 *
 * For callsite clarity this is spelled as its own function rather than
 * relying on `setArchitectByName(workspacePath, name, null)`. The two are
 * functionally equivalent today; this function exists so that "remove" reads
 * as "remove" at the call site.
 *
 * Bugfix #826: scoped by workspace_path.
 */
export function removeArchitect(workspacePath: string, name: string): void {
  const db = getDb();
  const ws = canonicalize(workspacePath);
  db.prepare('DELETE FROM architect WHERE workspace_path = ? AND id = ?').run(ws, name);
}

/**
 * Get architect state (main-only — Spec 755 scalar shim).
 * Returns the architect named 'main' if present, otherwise the first
 * registered architect by name. For multi-architect access, use
 * `getArchitects(workspacePath)` or `getArchitectByName(workspacePath, name)`
 * below.
 *
 * Bugfix #826: scoped by workspace_path.
 */
export function getArchitect(workspacePath: string): ArchitectState | null {
  const db = getDb();
  const ws = canonicalize(workspacePath);
  let row = db
    .prepare("SELECT * FROM architect WHERE workspace_path = ? AND id = 'main'")
    .get(ws) as DbArchitect | undefined;
  if (!row) {
    // Spec 755: when 'main' is absent, fall back to the first-registered
    // architect (started_at ordering), not the lexicographically-first name.
    row = db
      .prepare('SELECT * FROM architect WHERE workspace_path = ? ORDER BY started_at LIMIT 1')
      .get(ws) as DbArchitect | undefined;
  }
  return row ? dbArchitectToArchitectState(row) : null;
}

/**
 * Get all architects belonging to a workspace (Spec 755 + Bugfix #826).
 *
 * The architect table is scoped by `workspace_path` (Bugfix #826 migration v11),
 * eliminating the cross-workspace leak by construction: a workspace's
 * `launchInstance` only sees its own architect rows, regardless of which other
 * workspaces this Tower process is serving.
 */
export function getArchitects(workspacePath: string): ArchitectState[] {
  const db = getDb();
  const ws = canonicalize(workspacePath);
  const rows = db
    .prepare('SELECT * FROM architect WHERE workspace_path = ? ORDER BY id')
    .all(ws) as DbArchitect[];
  return rows.map(dbArchitectToArchitectState);
}

/**
 * Get a single architect by name within a workspace (Spec 755 + Bugfix #826).
 */
export function getArchitectByName(workspacePath: string, name: string): ArchitectState | null {
  const db = getDb();
  const ws = canonicalize(workspacePath);
  const row = db
    .prepare('SELECT * FROM architect WHERE workspace_path = ? AND id = ?')
    .get(ws, name) as DbArchitect | undefined;
  return row ? dbArchitectToArchitectState(row) : null;
}

/**
 * Look up a builder's spawning-architect name (Spec 755).
 *
 * Returns:
 *   - `string` — the recorded `spawned_by_architect` (builder context with explicit name)
 *   - `null`   — a row exists for that builder ID but `spawned_by_architect` is NULL (legacy row)
 *   - `undefined` — no row exists for that ID (not a builder)
 *
 * This three-valued return cleanly distinguishes "legacy builder" from
 * "non-builder sender." Used by the Phase 3 affinity-aware resolver.
 *
 * When `workspacePath` is supplied, opens a per-workspace readonly handle
 * directly — the right thing for Tower, which serves multiple workspaces
 * and cannot rely on the singleton `getDb()` (which is tied to the process's
 * startup CWD). When omitted, falls back to the singleton — convenient for
 * CLI callers that already ran inside one workspace. Mirrors the pattern in
 * `servers/overview.ts`.
 */
export function lookupBuilderSpawningArchitect(
  builderId: string,
  workspacePath?: string,
): string | null | undefined {
  if (workspacePath) {
    const dbPath = path.join(workspacePath, '.agent-farm', 'state.db');
    if (!existsSync(dbPath)) return undefined;
    const wsDb = new Database(dbPath, { readonly: true });
    try {
      const row = wsDb
        .prepare('SELECT spawned_by_architect FROM builders WHERE id = ?')
        .get(builderId) as { spawned_by_architect: string | null } | undefined;
      if (!row) return undefined;
      return row.spawned_by_architect;
    } finally {
      wsDb.close();
    }
  }

  const db = getDb();
  const row = db.prepare('SELECT spawned_by_architect FROM builders WHERE id = ?').get(builderId) as
    | { spawned_by_architect: string | null }
    | undefined;
  if (!row) return undefined;
  return row.spawned_by_architect;
}

// Re-export closeDb for cleanup
export { closeDb };
