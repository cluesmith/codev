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
 * The latter two are the DEFECT class: the classifier could not verify anything, so the mail
 * will not deliver on its own. `GateVerdict.detail`'s fourth value, `empty`, is never persisted
 * — a clean verdict delivers the row (and delivery nulls both columns).
 *
 * Null for every non-gate hold (`no-live-pty`, `no-profile`) and for the post-classify
 * token/settle re-holds, so a stale detail can never outlive the verdict that produced it.
 *
 * The DB column carries NO CHECK constraint (see `GLOBAL_SCHEMA` / migration v18); this type
 * is the enforcement.
 */
export type MailboxGateDetail = 'user-text' | 'no-region-end' | 'no-composer-marker';

/**
 * Audit vocabulary for a bounded-patience force (Issue #1481, `afx send --interrupt-after`).
 *
 * Deliberately EXPLICIT rather than a lossy precedence, because every one of these states is a
 * different thing to tell an operator, and the difference between "we claimed the row" and "the
 * bytes reached the agent" is exactly what this feature must never blur:
 *
 *   - `armed` — a deadline is set and no force has run. The ONLY state the restart sweep and the
 *     starvation suppression treat as "this will self-resolve".
 *   - `claimed` / `claimed-degraded` — the row was transitioned held→delivered immediately BEFORE
 *     the first byte (the same loss-over-duplicate trade immediate `--interrupt` already makes).
 *     After a crash this means the write outcome is UNKNOWN, never that it was received.
 *     `-degraded` records that the write edge was entered ahead of unfinished predecessor work on
 *     that terminal, and is preserved even if completion is never recorded.
 *   - `written-unverified` / `degraded-written-unverified` — the writer completed and every byte
 *     was accepted. Still NOT acknowledgment: nothing here proves the agent read it.
 *   - `failed` / `degraded-failed` — a write was observed to fail (a dropped PTY write).
 *   - `skipped-offline` / `skipped-session-replaced` / `skipped-restart` — no bytes were written
 *     and nothing was claimed; the body stays held for ordinary gated delivery. `skipped-restart`
 *     is the lifetime boundary: force authority does not survive a Tower restart, even when the
 *     deadline is still in the future.
 *
 * Row `status` remains authoritative for cancellation: a row delivered/dismissed/superseded by
 * another path keeps whatever outcome it had (usually `armed`) and is simply never forced.
 */
export type MailboxInterruptOutcome =
  | 'armed'
  | 'claimed'
  | 'claimed-degraded'
  | 'written-unverified'
  | 'degraded-written-unverified'
  | 'failed'
  | 'degraded-failed'
  | 'skipped-offline'
  | 'skipped-session-replaced'
  | 'skipped-restart';

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
  /**
   * Issue #1481 (`--interrupt-after`): epoch ms at which a FORCED interrupt delivery becomes
   * armed for this row. null on every ordinary row. Unlike {@link not_before} it does NOT gate
   * eligibility — the row competes for ordinary gated delivery from the moment it is enqueued,
   * and this is only the moment patience runs out.
   */
  interrupt_at: number | null;
  /** Epoch ms the force claimed the row immediately before its first byte; null if it never did. */
  interrupt_claimed_at: number | null;
  /** Force audit state; null on ordinary rows. Never receipt — see {@link MailboxInterruptOutcome}. */
  interrupt_outcome: MailboxInterruptOutcome | null;
  /** 0 | 1 — an ordinary write for this row may already have emitted bytes (audit/disclosure only). */
  interrupt_prior_partial: number;
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
