/**
 * Message buffering for typing-aware af send delivery.
 * Spec 403: af send Typing Awareness — Phase 2
 *
 * Buffers messages when a user is actively typing in a terminal session.
 * Messages are delivered when the user goes idle or after a maximum age.
 */

import type { PtySession } from '../../terminal/pty-session.js';

export interface BufferedMessage {
  sessionId: string;
  formattedMessage: string;
  noEnter: boolean;
  timestamp: number;
  broadcastPayload: {
    type: string;
    from: { project: string; agent: string };
    to: { project: string; agent: string };
    content: string;
    metadata: Record<string, unknown>;
    timestamp: string;
  };
  logMessage: string;
}

export type GetSessionFn = (id: string) => PtySession | undefined;
export type DeliverFn = (session: PtySession, msg: BufferedMessage) => void;
export type LogFn = (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;

const DEFAULT_IDLE_THRESHOLD_MS = 3000;
const DEFAULT_MAX_BUFFER_AGE_MS = 60_000;
const FLUSH_INTERVAL_MS = 500;

export class SendBuffer {
  private buffers = new Map<string, BufferedMessage[]>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private getSession: GetSessionFn | null = null;
  private deliver: DeliverFn | null = null;
  private log: LogFn | null = null;
  readonly idleThresholdMs: number;
  readonly maxBufferAgeMs: number;

  constructor(opts?: { idleThresholdMs?: number; maxBufferAgeMs?: number }) {
    this.idleThresholdMs = opts?.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
    this.maxBufferAgeMs = opts?.maxBufferAgeMs ?? DEFAULT_MAX_BUFFER_AGE_MS;
  }

  /** Buffer a message for deferred delivery. */
  enqueue(msg: BufferedMessage): void {
    const queue = this.buffers.get(msg.sessionId);
    if (queue) {
      queue.push(msg);
    } else {
      this.buffers.set(msg.sessionId, [msg]);
    }
  }

  /** Start the periodic flush timer. Clears any existing timer first. */
  start(getSession: GetSessionFn, deliver: DeliverFn, log: LogFn): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.getSession = getSession;
    this.deliver = deliver;
    this.log = log;
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  /** Stop the flush timer and deliver all remaining messages. */
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Final flush — deliver everything remaining
    this.flush(true);
  }

  /** Check and deliver messages for sessions that are idle or aged out. */
  flush(forceAll = false): void {
    if (!this.getSession || !this.deliver) return;

    for (const [sessionId, messages] of this.buffers) {
      const session = this.getSession(sessionId);

      if (!session) {
        // Session is gone — discard with warning
        if (this.log) {
          this.log('WARN', `Discarding ${messages.length} buffered message(s) for dead session ${sessionId.slice(0, 8)}...`);
        }
        this.buffers.delete(sessionId);
        continue;
      }

      const now = Date.now();
      const maxAgeExceeded = messages.some(m => now - m.timestamp >= this.maxBufferAgeMs);
      const isIdle = session.isUserIdle(this.idleThresholdMs);
      const isComposing = session.composing;

      // Deliver when: forced, idle AND not composing, or max age exceeded (Bugfix #450)
      if (forceAll || (!isComposing && isIdle) || maxAgeExceeded) {
        // Deliver all messages in order
        for (const msg of messages) {
          this.deliver(session, msg);
          if (this.log && msg.logMessage) {
            this.log('INFO', msg.logMessage);
          }
        }
        if (this.log && !forceAll) {
          const reason = maxAgeExceeded ? 'max age exceeded' : 'user idle';
          this.log('INFO', `Delivered ${messages.length} deferred message(s) to session ${sessionId.slice(0, 8)}... (${reason})`);
        }
        this.buffers.delete(sessionId);
      }
    }
  }

  /** Number of buffered messages across all sessions (for testing). */
  get pendingCount(): number {
    let count = 0;
    for (const messages of this.buffers.values()) {
      count += messages.length;
    }
    return count;
  }

  /** Number of sessions with buffered messages (for testing). */
  get sessionCount(): number {
    return this.buffers.size;
  }
}
