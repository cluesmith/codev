/**
 * SSE event types emitted by Tower at /api/events.
 */

export type SSEEventType =
  | 'overview-changed'
  | 'notification'
  | 'builder-spawned'
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
