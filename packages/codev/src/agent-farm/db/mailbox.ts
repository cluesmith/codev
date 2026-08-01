/**
 * Mailbox repository (Spec 1313 — mailbox-first delivery).
 *
 * Pure, unit-testable data operations over the `mailbox` table. Every `afx send`
 * is persisted here *before* the send response returns, so nothing is lost to a
 * Tower crash, restart, or shutdown. This module is deliberately decoupled from
 * delivery: it never writes to a PTY and never runs the render-gate. The delivery
 * orchestration (Phase 4) wires against these proven operations.
 *
 * Design notes:
 * - Functions take an explicit `db` handle first (matching `db/consolidate.ts`),
 *   which keeps them trivially testable against any better-sqlite3 database.
 * - Timestamps are epoch-ms integers supplied by the caller (defaulting to
 *   `Date.now()`), so ordering and age math are deterministic and test-injectable.
 * - `workspace_path` is treated as an opaque addressing key: callers pass a
 *   canonical path (the send boundary canonicalizes in Phase 4), mirroring how
 *   `cron_tasks` scopes by workspace. This module does not canonicalize.
 * - The lifecycle state machine (`held → delivered | superseded | dismissed`) is
 *   enforced here: every transition targets only `held` rows, so a terminal row
 *   can never revert (no `delivered → held`) and `supersede` only replaces a row
 *   that is still `held`.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { DbMailbox, MailboxReason } from './types.js';

/**
 * Fields a caller supplies to persist a new held row. The repository fills in the
 * id, `held` status, `escalated=0`, and the timestamps.
 */
export interface EnqueueInput {
  workspacePath: string;
  toAgent: string;
  /** Raw message body (never logged). */
  body: string;
  /** Exact bytes written to the PTY on delivery. */
  formattedMessage: string;
  /** Last-known PTY hint; the recipient is the agent, not this terminal. */
  terminalId?: string | null;
  fromAgent?: string | null;
  fromWorkspace?: string | null;
  /** Stage the text without submitting (no trailing Enter). */
  noEnter?: boolean;
  /** Initial why-held reason; null if it will be delivered immediately. */
  reason?: MailboxReason | null;
  /** Cron-only coalescing key; null for direct sends. */
  supersedeKey?: string | null;
}

const INSERT_SQL = `
  INSERT INTO mailbox (
    id, workspace_path, to_agent, terminal_id, from_agent, from_workspace,
    body, formatted_message, no_enter, status, reason, supersede_key,
    escalated, created_at, updated_at, resolved_at
  ) VALUES (
    @id, @workspace_path, @to_agent, @terminal_id, @from_agent, @from_workspace,
    @body, @formatted_message, @no_enter, @status, @reason, @supersede_key,
    @escalated, @created_at, @updated_at, @resolved_at
  )
`;

function buildRow(input: EnqueueInput, now: number): DbMailbox {
  return {
    id: randomUUID(),
    workspace_path: input.workspacePath,
    to_agent: input.toAgent,
    terminal_id: input.terminalId ?? null,
    from_agent: input.fromAgent ?? null,
    from_workspace: input.fromWorkspace ?? null,
    body: input.body,
    formatted_message: input.formattedMessage,
    no_enter: input.noEnter ? 1 : 0,
    status: 'held',
    reason: input.reason ?? null,
    supersede_key: input.supersedeKey ?? null,
    escalated: 0,
    created_at: now,
    updated_at: now,
    resolved_at: null,
  };
}

/**
 * Persist a new `held` row and return it. This is the persist-first step: the row
 * exists (and survives a crash) before any delivery is attempted.
 */
export function enqueue(db: Database.Database, input: EnqueueInput, now: number = Date.now()): DbMailbox {
  const row = buildRow(input, now);
  db.prepare(INSERT_SQL).run(row);
  return row;
}

/** Fetch a single row by id, or null if it does not exist. */
export function getById(db: Database.Database, id: string): DbMailbox | null {
  const row = db.prepare('SELECT * FROM mailbox WHERE id = ?').get(id) as DbMailbox | undefined;
  return row ?? null;
}

/**
 * List all currently-held rows, oldest first. Scoped to `workspacePath` when
 * provided, else workspace-wide (for `afx inbox`). `id` breaks created_at ties
 * for deterministic ordering.
 */
export function listHeld(db: Database.Database, workspacePath?: string): DbMailbox[] {
  if (workspacePath !== undefined) {
    return db
      .prepare(
        "SELECT * FROM mailbox WHERE workspace_path = ? AND status = 'held' ORDER BY created_at ASC, id ASC"
      )
      .all(workspacePath) as DbMailbox[];
  }
  return db
    .prepare("SELECT * FROM mailbox WHERE status = 'held' ORDER BY created_at ASC, id ASC")
    .all() as DbMailbox[];
}

/**
 * Held rows addressed to a specific agent, in enqueue order (`created_at ASC`).
 * This is the per-agent drain order a delivery pass walks.
 */
export function findHeldForAgent(
  db: Database.Database,
  workspacePath: string,
  toAgent: string
): DbMailbox[] {
  return db
    .prepare(
      "SELECT * FROM mailbox WHERE workspace_path = ? AND to_agent = ? AND status = 'held' ORDER BY created_at ASC, id ASC"
    )
    .all(workspacePath, toAgent) as DbMailbox[];
}

/**
 * Held rows whose age (`now − created_at`) has crossed `maxAgeMs` and that have NOT yet
 * been escalated. Tower-global (every workspace) — the drainer's escalation pass walks
 * these once per tick to flip `escalated` and emit the visibility broadcast. Bounded by
 * the (small) held set, so a full scan is fine. `created_at ASC` escalates the oldest
 * first. A row is born held at `created_at`, so that timestamp is exactly "held since".
 */
export function findEscalatable(
  db: Database.Database,
  maxAgeMs: number,
  now: number = Date.now()
): DbMailbox[] {
  const cutoff = now - maxAgeMs;
  return db
    .prepare(
      "SELECT * FROM mailbox WHERE status = 'held' AND escalated = 0 AND created_at < ? ORDER BY created_at ASC, id ASC"
    )
    .all(cutoff) as DbMailbox[];
}

/** Per-agent held tally within a workspace (drives the overview's live indicator). */
export interface HeldAgentCount {
  toAgent: string;
  count: number;
  /** True if any of this agent's held rows has crossed the escalation age. */
  escalated: boolean;
}

/** Workspace-level held summary: total, whether any row is escalated, and the per-agent split. */
export interface WorkspaceHeldSummary {
  total: number;
  escalated: boolean;
  byAgent: HeldAgentCount[];
}

/**
 * Count currently-held rows for a workspace, grouped by recipient agent, with an
 * escalation flag. Counts only — **no message bodies** are read or returned, so this is
 * safe to fold into the overview payload that the dashboard/VSCode indicator renders
 * (spec: the indicator is count-only; bodies live only in `afx inbox`). Aggregated in
 * SQL so cost is bounded by the (small) held set, not the row bodies.
 */
export function heldSummaryForWorkspace(db: Database.Database, workspacePath: string): WorkspaceHeldSummary {
  const rows = db
    .prepare(
      "SELECT to_agent AS toAgent, COUNT(*) AS count, MAX(escalated) AS esc FROM mailbox WHERE workspace_path = ? AND status = 'held' GROUP BY to_agent"
    )
    .all(workspacePath) as Array<{ toAgent: string; count: number; esc: number }>;
  let total = 0;
  let escalated = false;
  const byAgent: HeldAgentCount[] = rows.map((r) => {
    total += r.count;
    const rowEsc = r.esc === 1;
    if (rowEsc) escalated = true;
    return { toAgent: r.toAgent, count: r.count, escalated: rowEsc };
  });
  return { total, escalated, byAgent };
}

/**
 * Transition a held row to `delivered` (clearing its why-held reason and stamping
 * `resolved_at`). Returns true if it transitioned; false if the row was already
 * terminal or does not exist — so a re-delivery attempt (backstop racing a submit
 * trigger) is a safe no-op and can never revert or double-deliver a row.
 */
export function markDelivered(db: Database.Database, id: string, now: number = Date.now()): boolean {
  const info = db
    .prepare(
      "UPDATE mailbox SET status = 'delivered', reason = NULL, updated_at = ?, resolved_at = ? WHERE id = ? AND status = 'held'"
    )
    .run(now, now, id);
  return info.changes > 0;
}

/**
 * Refresh the why-held `reason` on a still-held row (informational — the value
 * `afx inbox` shows and the send response reports). Only touches `held` rows, so
 * it can never relabel or resurrect a terminal row. Returns true if a held row was
 * updated. The delivery pass calls this so a held row's reason tracks the current
 * gate verdict (e.g. `busy` → `no-live-pty` when the terminal dies).
 */
export function setHeldReason(
  db: Database.Database,
  id: string,
  reason: MailboxReason | null,
  now: number = Date.now()
): boolean {
  const info = db
    .prepare("UPDATE mailbox SET reason = ?, updated_at = ? WHERE id = ? AND status = 'held'")
    .run(reason, now, id);
  return info.changes > 0;
}

/**
 * Flag a still-held row as escalated — **visibility only, NEVER affects delivery**. The
 * drainer's escalation pass calls this when a row crosses the escalation age, then emits
 * the escalation broadcast; the row still delivers only on a later clean gate pass.
 * Held-only and idempotent (the `escalated = 0` guard), so a terminal or already-escalated
 * row is untouched. Returns true if it flipped.
 */
export function markEscalated(db: Database.Database, id: string, now: number = Date.now()): boolean {
  const info = db
    .prepare("UPDATE mailbox SET escalated = 1, updated_at = ? WHERE id = ? AND status = 'held' AND escalated = 0")
    .run(now, id);
  return info.changes > 0;
}

/**
 * Transition a held row to `dismissed` (operator-cleared via `afx inbox dismiss`).
 * The why-held reason is preserved for audit. Returns true if it transitioned;
 * a dismissed row is never delivered.
 */
export function dismiss(db: Database.Database, id: string, now: number = Date.now()): boolean {
  const info = db
    .prepare(
      "UPDATE mailbox SET status = 'dismissed', updated_at = ?, resolved_at = ? WHERE id = ? AND status = 'held'"
    )
    .run(now, now, id);
  return info.changes > 0;
}

/**
 * Count currently-`held` rows sharing `(workspacePath, supersedeKey)`. Cron reads
 * this immediately before {@link supersede} — with no `await` between the two calls,
 * so on better-sqlite3's synchronous, single-threaded handle the pair cannot
 * interleave with another run — to log an honest outcome: a newer run that finds a
 * prior held row of the same task reports `superseded`, otherwise `held`. The
 * `(supersede_key)` index keeps this cheap.
 */
export function countHeldWithKey(
  db: Database.Database,
  workspacePath: string,
  supersedeKey: string
): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM mailbox WHERE workspace_path = ? AND supersede_key = ? AND status = 'held'"
    )
    .get(workspacePath, supersedeKey) as { n: number };
  return row.n;
}

/**
 * Replace the held row sharing `(workspacePath, supersedeKey)` — if any — with a
 * fresh held row carrying the same key, atomically. Only `held` rows are
 * superseded (a delivered/dismissed row is untouched), so a newer cron run
 * collapses a stale backlog without disturbing history. When no held row matches,
 * this is just an enqueue. Returns the newly-enqueued replacement row.
 */
export function supersede(
  db: Database.Database,
  workspacePath: string,
  supersedeKey: string,
  input: EnqueueInput,
  now: number = Date.now()
): DbMailbox {
  const run = db.transaction(() => {
    db.prepare(
      "UPDATE mailbox SET status = 'superseded', updated_at = ?, resolved_at = ? WHERE workspace_path = ? AND supersede_key = ? AND status = 'held'"
    ).run(now, now, workspacePath, supersedeKey);
    return enqueue(db, { ...input, workspacePath, supersedeKey }, now);
  });
  return run();
}

/**
 * Delete terminal rows (delivered/superseded/dismissed) whose `resolved_at` is
 * older than `retentionDays`. Held rows are never removed — the `status != 'held'`
 * and `resolved_at IS NOT NULL` guards make that impossible even if a held row
 * somehow carried a stale timestamp. Returns the number of rows deleted.
 */
export function pruneTerminal(
  db: Database.Database,
  retentionDays: number,
  now: number = Date.now()
): number {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const info = db
    .prepare(
      "DELETE FROM mailbox WHERE status != 'held' AND resolved_at IS NOT NULL AND resolved_at < ?"
    )
    .run(cutoff);
  return info.changes;
}
