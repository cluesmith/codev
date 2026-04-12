/**
 * SSE event types emitted by Tower at /api/events.
 */

export type SSEEventType =
  | 'overview-changed'
  | 'notification'
  | 'connected'
  | 'heartbeat';

export interface SSENotification {
  type: string;
  title: string;
  body: string;
  workspace?: string;
}
