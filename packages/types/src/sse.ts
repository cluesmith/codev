/**
 * SSE event types emitted by Tower at /api/events.
 */

export type SSEEventType =
  | 'overview-changed'
  | 'notification'
  | 'builder-spawned'
  | 'mailbox-escalation'
  | 'connected'
  | 'heartbeat';

export interface SSENotification {
  type: string;
  title: string;
  body: string;
  workspace?: string;
}

/**
 * Payload carried in the `body` field of a `builder-spawned` notification.
 * JSON-stringified on the wire; parse before use.
 */
export interface BuilderSpawnedPayload {
  terminalId: string;
  roleId: string;
  workspacePath: string;
}

/**
 * Payload carried in the `body` field of a `mailbox-escalation` notification
 * (Spec 1313, Phase 7). JSON-stringified on the wire; parse before use. Emitted when
 * a held message crosses the escalation age — a VISIBILITY signal only (it moves the
 * dashboard/VSCode indicator into its attention state); it never triggers delivery.
 * Carries no message body (ids + metadata only, per the spec's redaction rule).
 */
export interface MailboxEscalationPayload {
  workspacePath: string;
  toAgent: string;
  mailboxId: string;
  /** How long the row had been held when it escalated, in ms. */
  ageMs: number;
  /** Why it is held: 'busy' | 'no-profile' | 'no-live-pty' (null if unset). */
  reason: string | null;
  /**
   * The render gate's detail behind a `busy` reason (Issue #1482):
   * `'user-text'` (a draft/menu occupies the composer — a human is at the line, and the hold
   * clears when they finish) | `'no-region-end'` | `'no-composer-marker'` (the classifier
   * could not verify the composer at all — a drifted profile, a torn frame, or Tower's
   * dimensions diverging from the real PTY; this hold does NOT clear on its own).
   * `null` for a non-gate hold. Additive and optional so older clients are unaffected.
   */
  detail?: string | null;
}
