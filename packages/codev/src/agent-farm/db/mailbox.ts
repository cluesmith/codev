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
import type { DbMailbox, MailboxGateDetail, MailboxInterruptOutcome, MailboxReason } from './types.js';

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
  /**
   * Delayed-send due time in epoch-ms (Spec 1313 round 3 — `--delay`). null means
   * deliver-ASAP (every non-delayed send). A row is deliverable only once
   * `not_before IS NULL OR not_before <= now`; a delayed send persists this at REQUEST
   * time so the delay is durable across a Tower restart.
   */
  notBefore?: number | null;
  /**
   * Bounded-patience force deadline in epoch-ms (Issue #1481 — `--interrupt-after`). null (the
   * default) means no force is armed. Setting it does NOT defer eligibility — the row is
   * deliverable immediately, exactly like an ordinary send; this is only the instant at which a
   * still-held row becomes eligible for a forced interrupt delivery. A row carrying it is
   * persisted with `interrupt_outcome = 'armed'`, which is what every downstream surface reads
   * to mean "this one will self-resolve".
   */
  interruptAt?: number | null;
}

const INSERT_SQL = `
  INSERT INTO mailbox (
    id, workspace_path, to_agent, terminal_id, from_agent, from_workspace,
    body, formatted_message, no_enter, status, reason, detail, supersede_key,
    escalated, not_before, interrupt_at, interrupt_claimed_at, interrupt_outcome,
    interrupt_prior_partial, created_at, updated_at, resolved_at
  ) VALUES (
    @id, @workspace_path, @to_agent, @terminal_id, @from_agent, @from_workspace,
    @body, @formatted_message, @no_enter, @status, @reason, @detail, @supersede_key,
    @escalated, @not_before, @interrupt_at, @interrupt_claimed_at, @interrupt_outcome,
    @interrupt_prior_partial, @created_at, @updated_at, @resolved_at
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
    // A brand-new row has no gate verdict yet: the only reasons available at enqueue are the
    // non-gate ones (`no-live-pty` from holdAndRespond), which never carry a detail. The first
    // delivery pass sets it (Issue #1482).
    detail: null,
    supersede_key: input.supersedeKey ?? null,
    escalated: 0,
    not_before: input.notBefore ?? null,
    interrupt_at: input.interruptAt ?? null,
    interrupt_claimed_at: null,
    // `armed` is set at enqueue, not by the coordinator, so the DB never has a window where a
    // deadline exists with no state naming it — the restart sweep and the starvation
    // suppression both key off this exact value.
    interrupt_outcome: input.interruptAt == null ? null : 'armed',
    interrupt_prior_partial: 0,
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
 * ELIGIBLE held rows addressed to a specific agent, in enqueue order (`created_at ASC`).
 * This is the per-agent drain order a delivery pass walks.
 *
 * Spec 1313 round 3 (`--delay`): a row is deliverable only when
 * `not_before IS NULL OR not_before <= now` — a pre-due delayed send is EXCLUDED here, so it
 * neither delivers early nor blocks a later normal message (the drainer picks `held[0]`, the
 * oldest ELIGIBLE row). It becomes eligible on the first pass at/after its due time. `now`
 * defaults to `Date.now()` and is injectable for deterministic tests.
 */
export function findHeldForAgent(
  db: Database.Database,
  workspacePath: string,
  toAgent: string,
  now: number = Date.now()
): DbMailbox[] {
  return db
    .prepare(
      "SELECT * FROM mailbox WHERE workspace_path = ? AND to_agent = ? AND status = 'held' AND (not_before IS NULL OR not_before <= ?) ORDER BY created_at ASC, id ASC"
    )
    .all(workspacePath, toAgent, now) as DbMailbox[];
}

/**
 * SQL for a held row's escalation-age START — the moment it became *deliverable-but-stuck*.
 * For a normal row that is `created_at` (born held then). For a delayed row (`not_before`
 * set) it is the DUE time, so a still-scheduled row's clock has not started (Spec 1313 round
 * 3: "measure escalation age from max(created_at, not_before)"). `not_before` is always ≥
 * `created_at` when set (due = created + delay), so MAX == COALESCE(not_before, created_at);
 * MAX is kept so a hand-written earlier not_before can never move the start before enqueue.
 *
 * Issue #1481 adds a third term for a row whose forced interrupt is still ARMED: its clock runs
 * from the patience deadline. Such a row is not "stuck" before then — it is a row that has
 * PROMISED to resolve itself at a known instant, so alarming about it beforehand would be noise,
 * and the grace period after the deadline is what gives the force time to actually run. The term
 * is gated on `interrupt_outcome = 'armed'` rather than on `interrupt_at` alone: once the force
 * has been SKIPPED (restart, offline, replaced session) there is no self-resolution left to wait
 * for, so the row instantly reverts to the ordinary creation/eligibility clock and alarms like
 * any other stuck mail.
 */
const ESCALATION_START_SQL =
  "MAX(created_at, COALESCE(not_before, created_at), " +
  "CASE WHEN interrupt_outcome = 'armed' THEN COALESCE(interrupt_at, created_at) ELSE created_at END)";

/**
 * TypeScript twin of {@link ESCALATION_START_SQL}, for the ONE surface that reports an age it
 * did not compute in SQL (the drainer's escalation broadcast). Two expressions is one more than
 * ideal; the alternative — re-deriving the age in SQL for an already-fetched row — costs a
 * second query per escalation. They are kept adjacent and asserted equal in the unit tests.
 */
export function escalationStart(row: DbMailbox): number {
  const armed = row.interrupt_outcome === 'armed' ? row.interrupt_at ?? row.created_at : row.created_at;
  return Math.max(row.created_at, row.not_before ?? row.created_at, armed);
}

/**
 * Held rows whose escalation age ({@link ESCALATION_START_SQL} → now) has crossed `maxAgeMs`
 * and that have NOT yet been escalated. Tower-global (every workspace) — the drainer's
 * escalation pass walks these once per tick to flip `escalated` and emit the visibility
 * broadcast. Bounded by the (small) held set, so a full scan is fine. Oldest effective-start
 * escalates first.
 *
 * Spec 1313 round 3: a PRE-DUE delayed row never escalates — its effective start is its
 * future `not_before`, which cannot be `< cutoff` (cutoff = now − maxAgeMs ≤ now), so the
 * age filter excludes it by construction. A delayed row escalates only after it has been
 * deliverable-but-stuck (past its due time) for the window.
 */
export function findEscalatable(
  db: Database.Database,
  maxAgeMs: number,
  now: number = Date.now()
): DbMailbox[] {
  const cutoff = now - maxAgeMs;
  return db
    .prepare(
      `SELECT * FROM mailbox WHERE status = 'held' AND escalated = 0 AND ${ESCALATION_START_SQL} < ? ORDER BY ${ESCALATION_START_SQL} ASC, id ASC`
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
 *
 * ELIGIBLE rows only (Spec 1313 round 3): a PRE-DUE delayed send (`not_before` in the
 * future) is "scheduled, not stuck" and must NOT inflate the attention count/indicator —
 * this is the same `not_before IS NULL OR not_before <= now` eligibility every other
 * count/alarm surface uses (`findHeldForAgent`, `findEscalatable`, `findStarvingAgents`),
 * so `afx status` / the dashboard badge report deliverable-but-stuck mail, not scheduled
 * sends. (Pre-due rows are still visible in `afx inbox`, which lists ALL held rows and
 * labels these "scheduled" — only the count/alarm surfaces exclude them.) The `escalated`
 * flag was already pre-due-safe (a pre-due row never escalates); this aligns the raw count.
 */
export function heldSummaryForWorkspace(
  db: Database.Database,
  workspacePath: string,
  now: number = Date.now()
): WorkspaceHeldSummary {
  const rows = db
    .prepare(
      "SELECT to_agent AS toAgent, COUNT(*) AS count, MAX(escalated) AS esc FROM mailbox WHERE workspace_path = ? AND status = 'held' AND (not_before IS NULL OR not_before <= ?) GROUP BY to_agent"
    )
    .all(workspacePath, now) as Array<{ toAgent: string; count: number; esc: number }>;
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
      "UPDATE mailbox SET status = 'delivered', reason = NULL, detail = NULL, updated_at = ?, resolved_at = ? WHERE id = ? AND status = 'held'"
    )
    .run(now, now, id);
  return info.changes > 0;
}

/**
 * Refresh the why-held verdict — `reason` AND its gate `detail` — on a still-held row
 * (informational: the values `afx inbox`, the send response, the escalation broadcast and the
 * owner starvation notice report). Only touches `held` rows, so it can never relabel or
 * resurrect a terminal row. Returns true if a held row was updated. The delivery pass calls
 * this so a held row's verdict tracks the current gate verdict (e.g. `busy` → `no-live-pty`
 * when the terminal dies).
 *
 * ONE statement, not two (Issue #1482): the pair is a single verdict, and writing it in two
 * updates would leave a window — and a second `updated_at` bump — where a reader could see a
 * new reason beside the previous reason's detail. Callers that hold for a NON-gate cause pass
 * `detail: null` so a stale detail can never outlive the verdict that produced it.
 *
 * `updated_at` therefore keeps meaning "when this row's verdict last MOVED", and that is
 * enforced HERE, by the `(reason IS NOT ? OR detail IS NOT ?)` predicate — not merely by the
 * callers that happen to check first. The delivery pass does guard before calling (see
 * `mailbox-delivery.ts`), but a guard living only at the call site is one new caller away from
 * silently breaking the starvation notice, which reads elapsed time off `updated_at` to say how
 * long a composer has been occupied. `IS NOT` rather than `<>` because both columns are
 * nullable and SQL's `<>` is not null-safe: `NULL <> NULL` is NULL, not false, so a
 * `null`→`null` no-op would slip through the predicate and bump the timestamp anyway.
 *
 * Returns true only when a held row's verdict actually moved. A repeat of the same pair, a
 * terminal row, and an unknown id are all `false` — callers wanting "does this row exist"
 * should ask {@link getById}, not this.
 */
export function setHeldVerdict(
  db: Database.Database,
  id: string,
  reason: MailboxReason | null,
  detail: MailboxGateDetail | null,
  now: number = Date.now()
): boolean {
  const info = db
    .prepare(
      "UPDATE mailbox SET reason = ?, detail = ?, updated_at = ? " +
        "WHERE id = ? AND status = 'held' AND (reason IS NOT ? OR detail IS NOT ?)"
    )
    .run(reason, detail, now, id, reason, detail);
  return info.changes > 0;
}

/**
 * Claim a still-held bounded-patience row for a FORCED interrupt delivery (Issue #1481).
 *
 * ONE guarded statement, and its guard is the whole safety argument: it transitions only a row
 * that is still `held` AND still `armed`, so a delivery/dismissal/supersession that won the race
 * makes this a zero-row no-op and the caller writes nothing at all — not even the Ctrl+C. The
 * caller invokes it SYNCHRONOUSLY at the write edge, with no await between this and the first
 * byte, so no gated pass can observe the row as held once the bytes are on their way.
 *
 * Claim-before-write is the same loss-over-duplicate trade immediate `--interrupt` already makes
 * (`tower-routes.ts`): a crash after this returns leaves a row reading `delivered` for a body
 * that may never have reached the terminal. `outcome` (`claimed` / `claimed-degraded`) is what
 * says so — it means the row was CLAIMED, never that the message was received. Re-holding
 * instead would let the backstop gate-deliver a second copy of a body the operator has already
 * force-injected.
 *
 * @param outcome `claimed-degraded` when the write edge was entered ahead of unfinished
 *                predecessor work on that terminal, so the degradation survives even if the
 *                completion update never lands.
 * @returns true if this call won the claim; false if the row was already terminal, was never
 *          armed, or another force claimed it first.
 */
export function claimForForcedInterrupt(
  db: Database.Database,
  id: string,
  outcome: 'claimed' | 'claimed-degraded',
  now: number = Date.now()
): boolean {
  const info = db
    .prepare(
      "UPDATE mailbox SET status = 'delivered', reason = NULL, detail = NULL, " +
        "interrupt_claimed_at = ?, interrupt_outcome = ?, updated_at = ?, resolved_at = ? " +
        "WHERE id = ? AND status = 'held' AND interrupt_outcome = 'armed'"
    )
    .run(now, outcome, now, now, id);
  return info.changes > 0;
}

/**
 * Record the force's FINAL audit outcome on a row this process already claimed.
 *
 * Guarded on `interrupt_claimed_at IS NOT NULL` so it can only ever refine a claim this Tower
 * made — it can never invent a completion for a row that was skipped, cancelled, or never armed.
 * Deliberately NOT lossy: the caller passes the fully-qualified value (`degraded-*` variants
 * included) rather than this function deriving a precedence, because "the write completed" and
 * "the write was degraded" are independent facts and collapsing them is how an unverified
 * degraded write comes to read as a clean success.
 *
 * A completion outcome is still not acknowledgment: `written-unverified` means every byte was
 * accepted by the session, nothing more.
 */
export function setForcedInterruptOutcome(
  db: Database.Database,
  id: string,
  outcome: MailboxInterruptOutcome,
  now: number = Date.now()
): boolean {
  const info = db
    .prepare(
      'UPDATE mailbox SET interrupt_outcome = ?, updated_at = ? WHERE id = ? AND interrupt_claimed_at IS NOT NULL'
    )
    .run(outcome, now, id);
  return info.changes > 0;
}

/**
 * Record that the force was SKIPPED without writing anything (Issue #1481).
 *
 * Held-and-armed only, so it cannot overwrite a claim or relabel a row another path resolved.
 * The body is left exactly as it was: still held, still eligible, still delivered by the
 * ordinary render gate whenever the recipient's prompt next clears. What is lost is only the
 * FORCE, and losing it visibly is the point — the row also stops suppressing the starvation
 * alarm the moment its outcome stops being `armed`, so a dead force can never hide stuck mail.
 */
export function skipForcedInterrupt(
  db: Database.Database,
  id: string,
  outcome: 'skipped-offline' | 'skipped-session-replaced' | 'skipped-restart',
  now: number = Date.now()
): boolean {
  const info = db
    .prepare(
      "UPDATE mailbox SET interrupt_outcome = ?, updated_at = ? WHERE id = ? AND status = 'held' AND interrupt_outcome = 'armed'"
    )
    .run(outcome, now, id);
  return info.changes > 0;
}

/**
 * Record that an ORDINARY write for this row may already have emitted bytes (Issue #1481).
 *
 * Set when a normal delivery reports `dropped`/`preempted` or throws after entering its
 * byte-attempting edge. Monotonic (the `= 0` guard makes a repeat a no-op) and deliberately
 * INDEPENDENT of `interrupt_outcome`: it is a fact about history, not a force state, so it
 * survives every later transition and shows up beside whatever outcome the force reaches.
 *
 * It is disclosure, NEVER a disarm. The ordinary path is itself still allowed to retry such a
 * row, so cancelling the operator's escalation on this evidence would be a stricter rule than
 * the one the normal path lives by. What it buys is honesty: when the force does run afterwards,
 * every surface can say that some or all of this body's effects may already have landed once.
 *
 * @returns true if this call flipped it (worth a one-time warning), false if already recorded.
 */
export function markInterruptPriorPartial(db: Database.Database, id: string, now: number = Date.now()): boolean {
  const info = db
    .prepare('UPDATE mailbox SET interrupt_prior_partial = 1, updated_at = ? WHERE id = ? AND interrupt_prior_partial = 0')
    .run(now, id);
  return info.changes > 0;
}

/**
 * Held rows with an ARMED force, oldest deadline first (Issue #1481).
 *
 * Two callers, both at Tower start: the disarm sweep (below) reads it to retire every leftover
 * policy, and diagnostics read it to say what is pending. Bounded by the held set.
 */
export function findArmedInterrupts(db: Database.Database): DbMailbox[] {
  return db
    .prepare(
      "SELECT * FROM mailbox WHERE status = 'held' AND interrupt_outcome = 'armed' ORDER BY interrupt_at ASC, id ASC"
    )
    .all() as DbMailbox[];
}

/**
 * Retire every leftover armed force at Tower start (Issue #1481) — the lifetime boundary.
 *
 * Force authority is scoped to the Tower lifetime that accepted it, exactly like the delayed
 * `--interrupt` ^C nudge, and unlike the message BODY, which is durable and still delivers
 * through the gate. A future deadline is disarmed too, not rearmed: the operator asked to
 * interrupt a specific turn that a restart has already ended, and firing into whatever turn
 * exists minutes later is a surprise nobody asked for. The deliberate cost is that a restart
 * inside the patience window silently downgrades that send to an ordinary hold — visible in
 * `afx inbox` as `skipped-restart`, never silent in the audit.
 *
 * Runs BEFORE any writer starts, so no coordinator can arm a row this sweep is about to retire.
 *
 * @returns the number of rows disarmed (the caller logs it and fires ONE held-state refresh).
 */
export function disarmInterruptsOnRestart(db: Database.Database, now: number = Date.now()): number {
  const info = db
    .prepare(
      "UPDATE mailbox SET interrupt_outcome = 'skipped-restart', updated_at = ? WHERE status = 'held' AND interrupt_outcome = 'armed'"
    )
    .run(now);
  return info.changes;
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
 * Flag an already-DELIVERED row as escalated (Issue #1584) — visibility only, and the
 * counterpart to {@link markEscalated} for the one case that flags a row *after* it has left
 * the held set: a delivery whose write completed but whose echo never confirmed.
 *
 * A separate function rather than a relaxed guard on {@link markEscalated}, because that one's
 * held-only contract is what makes the drainer's escalation pass safe to call blindly. Here the
 * ordering is the point: the row is marked `delivered` FIRST (that commit is what makes the
 * write un-repeatable even across a crash), so by the time the verdict is known the held-only
 * guard would silently no-op and the flag would be lost.
 *
 * Delivered-only and idempotent (the `escalated = 0` guard). Returns true if it flipped.
 */
export function markEscalatedDelivered(db: Database.Database, id: string, now: number = Date.now()): boolean {
  const info = db
    .prepare("UPDATE mailbox SET escalated = 1, updated_at = ? WHERE id = ? AND status = 'delivered' AND escalated = 0")
    .run(now, id);
  return info.changes > 0;
}

/**
 * Supersede-key prefix for architect starvation notices (Spec 1313 round 3, change 3). A
 * notice row carries `${NOTICE_SUPERSEDE_PREFIX}<starving-agent>` so (a) one pending notice
 * per starving agent coalesces via {@link supersede}, and (b) notice rows are recognizable by
 * prefix and EXCLUDED from {@link findStarvingAgents} — a notice can never itself trigger a
 * notice ("no notice about a notice"). Cron uses bare task names as keys, which never collide
 * with this prefix.
 */
export const NOTICE_SUPERSEDE_PREFIX = 'mailbox-notice:';

/** Per-agent aggregate over an agent's ELIGIBLE, non-notice held rows (Spec 1313 round 3). */
export interface StarvingAgent {
  workspacePath: string;
  toAgent: string;
  /**
   * Escalation-start ({@link ESCALATION_START_SQL}) of the OLDEST eligible held row — the
   * moment this agent's oldest deliverable mail became stuck. Its age is `now - stuckSince`.
   */
  stuckSince: number;
  /** How many eligible non-notice rows are held for this agent. */
  count: number;
  /** Representative why-held reason (held rows for one agent share the gate's verdict). */
  reason: MailboxReason | null;
  /**
   * Representative gate detail beside {@link reason} (Issue #1482) — the same MAX() aggregate,
   * for the same reason: an agent's held rows all carry the verdict of the last delivery pass.
   * It is what lets the owner starvation notice distinguish "a human is at the composer" from
   * "the classifier cannot verify this composer", which have different remedies.
   */
  detail: MailboxGateDetail | null;
}

/**
 * Per-agent view of currently-STARVING mail (Spec 1313 round 3, change 3): agents with at
 * least one ELIGIBLE (`not_before IS NULL OR not_before <= now`) held row that is NOT itself a
 * notice ({@link NOTICE_SUPERSEDE_PREFIX}). Tower-global (every workspace), aggregated in SQL
 * so cost is bounded by the (small) held set. The drainer's notice pass compares each agent's
 * `stuckSince` against the owner-notice threshold to decide whether to alarm, and uses the
 * membership of the returned set to decide when a prior notice can be cleared (agent no longer
 * has any eligible non-notice held row → drained). PRE-DUE delayed rows are excluded (not
 * stuck), so a scheduled send never trips the alarm nor keeps one alive.
 *
 * Issue #1481 excludes one more class, and ONLY that class: a row whose forced interrupt is
 * still `armed` and whose deadline has not passed. It is not stuck — it will resolve itself at a
 * known instant. Written as three explicit null-tolerant disjuncts rather than a `NOT (...)`
 * because `interrupt_outcome` is NULL on every ordinary row, and `NOT (NULL AND …)` is NULL, not
 * true — an ordinary row would silently vanish from the alarm. The exclusion is per-ROW, never
 * per-agent: ordinary held mail to the same recipient still aggregates and still alarms, which
 * is the whole reason this is not a recipient-level skip. Past the deadline (including a skipped
 * force, whose outcome is no longer `armed`) the row participates normally again.
 */
export function findStarvingAgents(db: Database.Database, now: number = Date.now()): StarvingAgent[] {
  return db
    .prepare(
      `SELECT workspace_path AS workspacePath, to_agent AS toAgent,
              MIN(${ESCALATION_START_SQL}) AS stuckSince,
              COUNT(*) AS count,
              MAX(reason) AS reason,
              MAX(detail) AS detail
         FROM mailbox
        WHERE status = 'held'
          AND (not_before IS NULL OR not_before <= ?)
          AND (interrupt_outcome IS NULL OR interrupt_outcome <> 'armed'
               OR interrupt_at IS NULL OR interrupt_at <= ?)
          AND (supersede_key IS NULL OR supersede_key NOT LIKE ?)
        GROUP BY workspace_path, to_agent`
    )
    .all(now, now, `${NOTICE_SUPERSEDE_PREFIX}%`) as StarvingAgent[];
}

/**
 * Dismiss every still-`held` row matching `(workspacePath, supersedeKey)` (Spec 1313 round 3).
 * Used to clear a pending architect notice once its starving agent recovers (the notice is
 * moot). Audit-preserving (soft transition), and a no-op on an already-delivered notice.
 * Returns the number of rows dismissed.
 */
export function dismissHeldWithKey(
  db: Database.Database,
  workspacePath: string,
  supersedeKey: string,
  now: number = Date.now()
): number {
  const info = db
    .prepare(
      "UPDATE mailbox SET status = 'dismissed', updated_at = ?, resolved_at = ? WHERE workspace_path = ? AND supersede_key = ? AND status = 'held'"
    )
    .run(now, now, workspacePath, supersedeKey);
  return info.changes;
}

/**
 * Dismiss every still-`held` row addressed to an agent (Spec 1313 round 3, take-now B). Called
 * when an agent is cleaned up (`afx cleanup`) so its orphaned held rows stop pinning
 * `heldCount`/escalated forever — the terminal-row prune only removes delivered/superseded/
 * dismissed rows, never held ones. Audit-preserving. Returns the number of rows dismissed.
 */
export function dismissHeldForAgent(
  db: Database.Database,
  workspacePath: string,
  toAgent: string,
  now: number = Date.now()
): number {
  const info = db
    .prepare(
      "UPDATE mailbox SET status = 'dismissed', updated_at = ?, resolved_at = ? WHERE workspace_path = ? AND to_agent = ? AND status = 'held'"
    )
    .run(now, now, workspacePath, toAgent);
  return info.changes;
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
