/**
 * Cron message delivery through the mailbox + gate (Spec 1313, Phase 6).
 *
 * Cron is today the most unguarded message writer: it wrote straight to the PTY with
 * no idle check and logged "delivered" unconditionally. This phase makes it an
 * ordinary mailbox sender — every cron notification is persisted and then delivered
 * through the SAME single gated path (`deliverAgentMailSerialized`) that `handleSend`
 * and the backstop drainer use, so a cron message can never land mid-draft or fuse
 * with a human's half-typed line. There is no force path: a busy/menu/wrapper screen
 * holds the message for the backstop, exactly like any other send.
 *
 * Two cron-specific twists on top of the shared path:
 *  - **Supersede key = task name** (Baked Decision 6): a newer run of a task replaces
 *    its own older *held* row instead of queueing a backlog. Supersede keys are
 *    cron-only in this project — no non-cron send ever supplies one.
 *  - **Honest run outcome**: the caller logs the real fate (`delivered` / `held` /
 *    `superseded`) rather than an unconditional "delivered".
 *
 * This module holds the registry-free orchestration core behind the Phase-4
 * {@link DeliveryPorts} seam, so it is unit-testable against a real mailbox DB with
 * fake edges (no live Tower). The identity resolution that needs the live routing
 * registry (`resolveTarget` + the architect reverse-map + the dead-session registry
 * fallback) lives in `tower-routes.ts`'s `deliverCronMessage`, which calls this.
 */

import type Database from 'better-sqlite3';
import { supersede, getById, countHeldWithKey } from '../db/mailbox.js';
import type { MailboxReason } from '../db/types.js';
import { deliverAgentMailSerialized, type DeliveryPorts } from './mailbox-delivery.js';

/** The pseudo-agent identity every cron notification is sent as. */
export const CRON_SENDER = 'af-cron';

/** The real fate of one cron run's message (what the run log records). */
export type CronOutcome = 'delivered' | 'held' | 'superseded' | 'unresolved';

/** Outcome of routing a cron notification through the mailbox + gate. */
export interface CronDeliveryResult {
  /**
   * `delivered` — written to a render-verified empty prompt now; `held` — this run's
   * message is held for the backstop (line busy / menu / no profile / no live PTY);
   * `superseded` — held, and it replaced a still-held row from an earlier run of the
   * same task (no backlog); `unresolved` — the target could not be resolved at all
   * (nothing persisted).
   */
  outcome: CronOutcome;
  /** Why held, when `held`/`superseded`; null when `delivered`/`unresolved`. */
  reason: MailboxReason | null;
  /** The persisted row id (audit); null only when `unresolved`. */
  mailboxId: string | null;
}

/** A resolved cron recipient plus the bytes to persist. */
export interface CronTarget {
  workspacePath: string;
  /** Canonical recipient agent id (a builder id or a specific architect name). */
  toAgent: string;
  /** Last-known PTY hint; null when the recipient has no live terminal. */
  terminalId: string | null;
  /** Raw message body (never logged). */
  body: string;
  /** Exact bytes written to the PTY on delivery. */
  formattedMessage: string;
  /** Per-task coalescing key (Baked Decision 6) — the task name. */
  supersedeKey: string;
}

/**
 * Persist a cron notification (superseding any still-held row from an earlier run of
 * the same task) and attempt one gated delivery, returning the run's real outcome.
 *
 * The corruption-safety is entirely inherited from {@link deliverAgentMailSerialized}:
 * the body is only ever written to a render-verified empty prompt, and the per-agent
 * serializer means a concurrent send can never interleave with this write. A busy or
 * unclassifiable screen simply leaves the row held for the backstop — there is no
 * force path here, by construction.
 */
export async function deliverCronMail(
  ports: DeliveryPorts,
  db: Database.Database,
  target: CronTarget
): Promise<CronDeliveryResult> {
  const { workspacePath, toAgent, supersedeKey } = target;

  // Did an earlier run of this task leave a row still held? Read it BEFORE the
  // supersede, with no await between, so the pair is atomic on the synchronous DB
  // handle (see countHeldWithKey). This only informs the log word — the "no backlog"
  // correctness comes from supersede() being atomic regardless.
  const replacedPrior = countHeldWithKey(db, workspacePath, supersedeKey) > 0;
  const row = supersede(
    db,
    workspacePath,
    supersedeKey,
    {
      workspacePath,
      toAgent,
      terminalId: target.terminalId,
      body: target.body,
      formattedMessage: target.formattedMessage,
      fromAgent: CRON_SENDER,
      fromWorkspace: workspacePath,
    },
    ports.now()
  );

  try {
    await deliverAgentMailSerialized(ports, db, workspacePath, toAgent);
  } catch (err) {
    // A gate/write error leaves the row HELD (markDelivered only runs on a completed
    // write); the backstop drainer retries. Mirrors handleSend — never throws upward.
    ports.log(`[cron] delivery attempt errored for ${toAgent} (row ${row.id.slice(0, 8)}… stays held): ${String(err)}`);
  }

  const stored = getById(db, row.id);
  if (stored?.status === 'delivered') {
    return { outcome: 'delivered', reason: null, mailboxId: row.id };
  }
  // Held. `reason` is set by the delivery pass when it holds; default to `busy` for
  // the rare case where an older row for the same agent delivered first and left ours
  // queued behind it (its Enter makes the line busy for the next pass anyway).
  return {
    outcome: replacedPrior ? 'superseded' : 'held',
    reason: stored?.reason ?? 'busy',
    mailboxId: row.id,
  };
}
