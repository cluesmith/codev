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
 * Mailbox lifecycle status (Spec 1313).
 *
 * A row is born `held` and moves to exactly one terminal state:
 *   - `delivered`  — written to the recipient's PTY after a clean render-gate pass
 *   - `superseded` — replaced by a newer row sharing its supersede_key (cron only)
 *   - `dismissed`  — cleared by an operator via `afx inbox dismiss`
 * Terminal states are final; the repository enforces `held → *` only.
 */
export type MailboxStatus = 'held' | 'delivered' | 'superseded' | 'dismissed';

/**
 * Why a mailbox row is currently held (Spec 1313). Null once delivered.
 *   - `busy`        — the target PTY's prompt is not a clean, empty prompt (draft/menu/etc.)
 *   - `no-profile`  — the target app has no render-gate classifier profile (unknown app)
 *   - `no-live-pty` — the recipient agent has no live terminal right now
 */
export type MailboxReason = 'busy' | 'no-profile' | 'no-live-pty';

/**
 * The render gate's classification detail behind a `busy` hold (Issue #1482). Persisted
 * beside {@link MailboxReason} so every operator surface can tell the two apart:
 *   - `user-text`           — a draft or menu occupies the composer. A human is at the line;
 *                             this is the SAFE, intended hold and it clears when they finish.
 *   - `no-region-end`       — a composer marker with no rule/status line beneath it to bound
 *                             the region (a partial/mid-repaint frame, or a mirror rendered at
 *                             dims the real TUI never adopted).
 *   - `no-composer-marker`  — no recognized marker at all (a wrapper/boot screen, a drifted
 *                             profile, or an unrenderable frame).
 *   - `recent-input`        — the terminal saw INPUT too recently to write onto (Issue #1473):
 *                             either a keystroke landed while the gate was classifying, or the
 *                             input-settle interval has not elapsed. Like `user-text` this is a
 *                             SAFE hold that clears on its own — it is the same "a human is at
 *                             the line" class, caught one beat earlier, before the TUI has
 *                             echoed anything for the classifier to see.
 * The two can't-verify values are the DEFECT class: the classifier could not verify anything,
 * so the mail will not deliver on its own. `GateVerdict.detail`'s fourth value, `empty`, is
 * never persisted — a clean verdict delivers the row (and delivery nulls both columns).
 *
 * `recent-input` is deliberately NOT part of {@link isUnverifiableVerdict}'s set: escalating it
 * would false-alarm on every ordinary typist. That predicate is an allow-list, so the value is
 * correctly inert there by construction rather than by an edit.
 *
 * Null for every non-gate hold (`no-live-pty`, `no-profile`) and for the post-classify
 * token re-hold, so a stale detail can never outlive the verdict that produced it.
 *
 * The DB column carries NO CHECK constraint (see `GLOBAL_SCHEMA` / migration v18); this type
 * is the enforcement.
 */
export type MailboxGateDetail = 'user-text' | 'no-region-end' | 'no-composer-marker' | 'recent-input';

/**
 * Database row type for the mailbox table (Spec 1313).
 *
 * Rows address AGENTS (`to_agent` within `workspace_path`), not PTYs, so a
 * respawned terminal drains its predecessor's mail. Timestamps are epoch-ms
 * integers set by the repository at the call site (not SQLite `datetime`), so
 * ordering and age math are trivial and test-injectable. `body` is the raw
 * message (never logged); `formatted_message` is what gets written to the PTY.
 */
export interface DbMailbox {
  id: string;
  workspace_path: string;
  to_agent: string;
  terminal_id: string | null;
  from_agent: string | null;
  from_workspace: string | null;
  body: string;
  formatted_message: string;
  no_enter: number;        // 0 | 1 (SQLite has no boolean)
  status: MailboxStatus;
  reason: MailboxReason | null;
  detail: MailboxGateDetail | null;  // Issue #1482: the gate verdict behind a `busy` hold; null for non-gate holds and once delivered
  supersede_key: string | null;
  escalated: number;       // 0 | 1 — set once escalation age crossed (visibility only)
  not_before: number | null; // epoch ms; delayed-send due time (Spec 1313 round 3). null = deliver-ASAP; row is deliverable only when not_before IS NULL OR not_before <= now
  created_at: number;      // epoch ms; per-agent enqueue order
  updated_at: number;      // epoch ms
  resolved_at: number | null;  // delivered/superseded/dismissed timestamp; null while held
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
