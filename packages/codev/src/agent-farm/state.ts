/**
 * State management for Agent Farm
 *
 * Uses SQLite for ACID-compliant state persistence with proper concurrency handling.
 * All operations are synchronous and atomic.
 */

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
 * Load complete state from database
 * Note: This is now synchronous
 */
export function loadState(): DashboardState {
  const db = getDb();

  // Load architect (singleton)
  const architectRow = db.prepare('SELECT * FROM architect WHERE id = 1').get() as DbArchitect | undefined;
  const architect = architectRow ? dbArchitectToArchitectState(architectRow) : null;

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
    builders,
    utils,
    annotations,
  };
}

/**
 * Update architect state
 * Note: This is now synchronous
 */
export function setArchitect(architect: ArchitectState | null): void {
  const db = getDb();

  if (architect === null) {
    db.prepare('DELETE FROM architect WHERE id = 1').run();
  } else {
    db.prepare(`
      INSERT OR REPLACE INTO architect (id, pid, port, cmd, started_at, tmux_session)
      VALUES (1, @pid, @port, @cmd, @startedAt, @tmuxSession)
    `).run({
      pid: architect.pid,
      port: architect.port,
      cmd: architect.cmd,
      startedAt: architect.startedAt,
      tmuxSession: architect.tmuxSession ?? null,
    });
  }
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
      tmux_session, type, task_text, protocol_name, issue_number
    )
    VALUES (
      @id, @name, @port, @pid, @status, @phase, @worktree, @branch,
      @tmuxSession, @type, @taskText, @protocolName, @issueNumber
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      port = excluded.port,
      pid = excluded.pid,
      status = excluded.status,
      phase = excluded.phase,
      worktree = excluded.worktree,
      branch = excluded.branch,
      tmux_session = excluded.tmux_session,
      type = excluded.type,
      task_text = excluded.task_text,
      protocol_name = excluded.protocol_name,
      issue_number = excluded.issue_number
  `).run({
    id: builder.id,
    name: builder.name,
    port: builder.port,
    pid: builder.pid,
    status: builder.status,
    phase: builder.phase,
    worktree: builder.worktree,
    branch: builder.branch,
    tmuxSession: builder.tmuxSession ?? null,
    type: builder.type,
    taskText: builder.taskText ?? null,
    protocolName: builder.protocolName ?? null,
    issueNumber: builder.issueNumber ?? null,
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
    INSERT INTO utils (id, name, port, pid, tmux_session)
    VALUES (@id, @name, @port, @pid, @tmuxSession)
  `).run({
    id: util.id,
    name: util.name,
    port: util.port,
    pid: util.pid,
    tmuxSession: util.tmuxSession ?? null,
  });
}

/**
 * Try to add a utility terminal, returning false on port conflict
 * Used to handle concurrent port allocation race conditions
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
    VALUES (@id, @file, @port, @pid, @parentType, @parentId)
  `).run({
    id: annotation.id,
    file: annotation.file,
    port: annotation.port,
    pid: annotation.pid,
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
 * Get architect state
 */
export function getArchitect(): ArchitectState | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM architect WHERE id = 1').get() as DbArchitect | undefined;
  return row ? dbArchitectToArchitectState(row) : null;
}

// Re-export closeDb for cleanup
export { closeDb };
