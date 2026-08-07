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
}
