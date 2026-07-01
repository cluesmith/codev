/**
 * State management for Agent Farm
 *
 * Uses SQLite for ACID-compliant state persistence with proper concurrency handling.
 * All operations are synchronous and atomic.
 */

import path from 'node:path';
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
// Issue #1118: shared workspace-path canonicalization (single source of truth).
// The architect/builders tables key on `workspace_path`; writers and readers
// must agree on its exact form, so both layers normalize through this one leaf
// helper (Bugfix #826 iter-6). Aliased to `canonicalize` for the local callsites.
import { normalizeWorkspacePath as canonicalize } from './utils/workspace-path.js';

/**
 * Derive a builder's owning workspace from its worktree path (Issue #1118).
 *
 * Builder worktrees are always `<workspace>/.builders/<id>`, so the workspace is
 * the path prefix before `/.builders/`. Falls back to two-levels-up if the
 * marker is absent (defensive — e.g. an ad-hoc worktree). The result is
 * canonicalized to match the workspace_path normalization used everywhere else,
 * so a builder's row is keyed by the same canonical workspace its architect is.
 */
function deriveWorkspaceFromWorktree(worktree: string): string {
  // lastIndexOf, not indexOf: the workspace is the prefix before the FINAL
  // `/.builders/` — robust when the path itself contains an earlier `.builders`
  // segment (e.g. a builder worktree nested under another).
  const marker = '/.builders/';
  const idx = worktree.lastIndexOf(marker);
  let root: string;
  if (idx >= 0) {
    root = worktree.slice(0, idx);
  } else {
    root = path.dirname(path.dirname(worktree));
  }
  return canonicalize(root);
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
 * Bugfix #826: takes a `workspacePath` and scopes the architect read by
 * `workspace_path`. Issue #1118: `builders` is now workspace-scoped too (composite
 * PK), so its read is scoped by the same `workspace_path`. `utils` and
 * `annotations` remain global (UUID-keyed, runtime-ephemeral).
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
  // Bugfix #826 / Issue #1118: scoped by workspace_path so the single shared
  // global.db (which holds every workspace's architect rows) returns only the
  // architects belonging to the requested workspace.
  const architectRows = db.prepare(
    "SELECT * FROM architect WHERE workspace_path = ? ORDER BY (id != 'main'), started_at"
  ).all(ws) as DbArchitect[];
  const architects = architectRows.map(dbArchitectToArchitectState);
  // The scalar shim points at architects[0] (which is `main` when present,
  // else the first-registered architect by started_at). Preserves the legacy
  // /api/state contract.
  const architect = architects[0] ?? null;

  // Load builders. Issue #1118: builders are now workspace-scoped (composite PK
  // with workspace_path), so scope the read to this workspace — consistent with
  // the architect read above, and correct now that one shared DB holds every
  // workspace's builders.
  const builderRows = db.prepare(
    'SELECT * FROM builders WHERE workspace_path = ? ORDER BY started_at'
  ).all(ws) as DbBuilder[];
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
  // Issue #1118: derive the owning workspace from the worktree so the row is
  // keyed by (workspace_path, id) — letting the same id exist in two workspaces.
  const ws = deriveWorkspaceFromWorktree(builder.worktree);

  db.prepare(`
    INSERT INTO builders (
      workspace_path, id, name, port, pid, status, phase, worktree, branch,
      type, task_text, protocol_name, issue_number, terminal_id, spawned_by_architect
    )
    VALUES (
      @workspacePath, @id, @name, 0, 0, @status, @phase, @worktree, @branch,
      @type, @taskText, @protocolName, @issueNumber, @terminalId, @spawnedByArchitect
    )
    ON CONFLICT(workspace_path, id) DO UPDATE SET
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
    workspacePath: ws,
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
export function removeBuilder(id: string, workspacePath?: string): void {
  const db = getDb();
  // Issue #1118: when a workspace is in scope, delete the workspace-scoped row
  // (the same id can exist in another workspace). Without one, fall back to
  // delete-by-id (legacy callers; ids were unique within the old per-file DB).
  if (workspacePath) {
    db.prepare('DELETE FROM builders WHERE workspace_path = ? AND id = ?').run(canonicalize(workspacePath), id);
  } else {
    db.prepare('DELETE FROM builders WHERE id = ?').run(id);
  }
}

/**
 * Get a single builder by ID.
 * Issue #1118: pass `workspacePath` to disambiguate when the same id may exist
 * in multiple workspaces; without it, returns the first matching row.
 */
export function getBuilder(id: string, workspacePath?: string): Builder | null {
  const db = getDb();
  let row: DbBuilder | undefined;
  if (workspacePath) {
    row = db.prepare('SELECT * FROM builders WHERE workspace_path = ? AND id = ?')
      .get(canonicalize(workspacePath), id) as DbBuilder | undefined;
  } else {
    row = db.prepare('SELECT * FROM builders WHERE id = ?').get(id) as DbBuilder | undefined;
  }
  if (!row) return null;
  return dbBuilderToBuilder(row);
}

/**
 * Get all builders. Issue #1118: pass `workspacePath` to scope to one workspace;
 * omit it for a deliberate cross-workspace read (e.g. Tower global views).
 */
export function getBuilders(workspacePath?: string): Builder[] {
  const db = getDb();
  let rows: DbBuilder[];
  if (workspacePath) {
    rows = db.prepare('SELECT * FROM builders WHERE workspace_path = ? ORDER BY started_at')
      .all(canonicalize(workspacePath)) as DbBuilder[];
  } else {
    rows = db.prepare('SELECT * FROM builders ORDER BY started_at').all() as DbBuilder[];
  }
  return rows.map(dbBuilderToBuilder);
}

/**
 * Get builders by status. Issue #1118: optional `workspacePath` scopes the read.
 */
export function getBuildersByStatus(status: Builder['status'], workspacePath?: string): Builder[] {
  const db = getDb();
  let rows: DbBuilder[];
  if (workspacePath) {
    rows = db.prepare('SELECT * FROM builders WHERE workspace_path = ? AND status = ? ORDER BY started_at')
      .all(canonicalize(workspacePath), status) as DbBuilder[];
  } else {
    rows = db.prepare('SELECT * FROM builders WHERE status = ? ORDER BY started_at').all(status) as DbBuilder[];
  }
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
 * start cycle. The `architect` table is the durable registration; `builders`
 * are the runtime concern and get wiped.
 *
 * Issue #1118: now that all workspaces share one `global.db`, this MUST be
 * scoped by `workspace_path` — an unscoped `DELETE FROM builders` would wipe
 * every other workspace's builders when one workspace stops. `builders` is
 * workspace-scoped (composite PK), so the delete filters by `workspace_path`.
 * `utils`/`annotations` are global (UUID-keyed, no workspace column) and
 * vestigial (no producers), so they are intentionally left untouched here to
 * avoid a cross-workspace wipe; the full-wipe `clearState()` still clears them.
 *
 * `clearState()` (the full-wipe variant) is preserved for callers that genuinely
 * want everything gone (uninstall / nuke flows).
 */
export function clearRuntime(workspacePath: string): void {
  const db = getDb();
  const ws = canonicalize(workspacePath);
  db.prepare('DELETE FROM builders WHERE workspace_path = ?').run(ws);
}

/**
 * Spec 786: remove a single architect by name from the `architect` table.
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
 * Issue #1118: builders now live in the single shared global.db, scoped by
 * `workspace_path`. When `workspacePath` is supplied (Tower, serving multiple
 * workspaces), the lookup is scoped `WHERE workspace_path = ? AND id = ?` — this
 * is load-bearing, since the same builder id can exist in two workspaces and the
 * spoofing check must resolve to the *correct* workspace's spawning architect.
 * When omitted (a CLI caller already inside one workspace), it falls back to
 * match by id alone.
 */
export function lookupBuilderSpawningArchitect(
  builderId: string,
  workspacePath?: string,
): string | null | undefined {
  const db = getDb();
  let row: { spawned_by_architect: string | null } | undefined;
  if (workspacePath) {
    row = db
      .prepare('SELECT spawned_by_architect FROM builders WHERE workspace_path = ? AND id = ?')
      .get(canonicalize(workspacePath), builderId) as { spawned_by_architect: string | null } | undefined;
  } else {
    row = db
      .prepare('SELECT spawned_by_architect FROM builders WHERE id = ?')
      .get(builderId) as { spawned_by_architect: string | null } | undefined;
  }
  if (!row) return undefined;
  return row.spawned_by_architect;
}

// Re-export closeDb for cleanup
export { closeDb };
