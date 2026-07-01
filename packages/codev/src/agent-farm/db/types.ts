/**
 * Database Type Definitions
 *
 * TypeScript interfaces matching the SQLite schema.
 * These types represent the database row format.
 */

import type { Builder, ArchitectState, UtilTerminal, Annotation, BuilderType } from '../types.js';

/**
 * Database row type for architect table.
 *
 * Spec 755: `id` is now the architect name (TEXT PRIMARY KEY). Pre-v9 schemas
 * had `id INTEGER PRIMARY KEY CHECK (id = 1)`; the v9 migration rebuilds the
 * table and rekeys the existing row's id to 'main'.
 */
export interface DbArchitect {
  workspace_path: string;
  id: string;
  pid: number;
  port: number;
  cmd: string;
  started_at: string;
  terminal_id: string | null;
  session_id: string | null;   // Issue #832: persisted agent conversation session id (agent-neutral)
}

/**
 * Database row type for builders table
 */
export interface DbBuilder {
  workspace_path: string;   // Issue #1118: builders are workspace-scoped (composite PK with id)
  id: string;
  name: string;
  port: number;
  pid: number;
  status: string;
  phase: string;
  worktree: string;
  branch: string;
  type: string;
  task_text: string | null;
  protocol_name: string | null;
  issue_number: string | null;
  terminal_id: string | null;
  spawned_by_architect: string | null;   // Spec 755: spawning architect's name; null for legacy rows
  started_at: string;
  updated_at: string;
}

/**
 * Database row type for utils table
 */
export interface DbUtil {
  id: string;
  name: string;
  port: number;
  pid: number;
  terminal_id: string | null;
  started_at: string;
}

/**
 * Database row type for annotations table
 */
export interface DbAnnotation {
  id: string;
  file: string;
  port: number;
  pid: number;
  parent_type: string;
  parent_id: string | null;
  started_at: string;
}

/**
 * Convert database architect row to application type
 */
export function dbArchitectToArchitectState(row: DbArchitect): ArchitectState {
  return {
    name: row.id,
    cmd: row.cmd,
    startedAt: row.started_at,
    terminalId: row.terminal_id ?? undefined,
    sessionId: row.session_id ?? undefined,
  };
}

/**
 * Convert database builder row to application type
 */
export function dbBuilderToBuilder(row: DbBuilder): Builder {
  return {
    id: row.id,
    name: row.name,
    status: row.status as Builder['status'],
    phase: row.phase,
    worktree: row.worktree,
    branch: row.branch,
    type: row.type as BuilderType,
    taskText: row.task_text ?? undefined,
    protocolName: row.protocol_name ?? undefined,
    issueNumber: row.issue_number ?? undefined,
    terminalId: row.terminal_id ?? undefined,
    spawnedByArchitect: row.spawned_by_architect ?? undefined,
  };
}

/**
 * Convert database util row to application type
 */
export function dbUtilToUtilTerminal(row: DbUtil): UtilTerminal {
  return {
    id: row.id,
    name: row.name,
    terminalId: row.terminal_id ?? undefined,
  };
}

/**
 * Convert database annotation row to application type
 */
export function dbAnnotationToAnnotation(row: DbAnnotation): Annotation {
  return {
    id: row.id,
    file: row.file,
    parent: {
      type: row.parent_type as Annotation['parent']['type'],
      id: row.parent_id ?? undefined,
    },
  };
}
