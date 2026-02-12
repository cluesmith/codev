/**
 * Database Type Definitions
 *
 * TypeScript interfaces matching the SQLite schema.
 * These types represent the database row format.
 */

import type { Builder, ArchitectState, UtilTerminal, Annotation, BuilderType } from '../types.js';

/**
 * Database row type for architect table
 */
export interface DbArchitect {
  id: number;
  pid: number;
  port: number;
  cmd: string;
  started_at: string;
  tmux_session: string | null;
  terminal_id: string | null;
}

/**
 * Database row type for builders table
 */
export interface DbBuilder {
  id: string;
  name: string;
  port: number;
  pid: number;
  status: string;
  phase: string;
  worktree: string;
  branch: string;
  tmux_session: string | null;
  type: string;
  task_text: string | null;
  protocol_name: string | null;
  issue_number: number | null;
  terminal_id: string | null;
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
  tmux_session: string | null;
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
 * Database row type for port_allocations table
 */
export interface DbPortAllocation {
  project_path: string;
  base_port: number;
  pid: number | null;
  registered_at: string;
  last_used_at: string;
}

/**
 * Convert database architect row to application type
 */
export function dbArchitectToArchitectState(row: DbArchitect): ArchitectState {
  return {
    cmd: row.cmd,
    startedAt: row.started_at,
    tmuxSession: row.tmux_session ?? undefined,
    terminalId: row.terminal_id ?? undefined,
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
    tmuxSession: row.tmux_session ?? undefined,
    type: row.type as BuilderType,
    taskText: row.task_text ?? undefined,
    protocolName: row.protocol_name ?? undefined,
    issueNumber: row.issue_number ?? undefined,
    terminalId: row.terminal_id ?? undefined,
  };
}

/**
 * Convert database util row to application type
 */
export function dbUtilToUtilTerminal(row: DbUtil): UtilTerminal {
  return {
    id: row.id,
    name: row.name,
    tmuxSession: row.tmux_session ?? undefined,
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
