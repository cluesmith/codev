/**
 * Message buffering for typing-aware afx send delivery.
 * Spec 403: afx send Typing Awareness — Phase 2
 *
 * Buffers messages when a user is actively typing in a terminal session.
 * Messages are delivered when the user goes idle or after a maximum age.
 */

import type { PtySession } from '../../terminal/pty-session.js';

export interface BufferedMessage {
  sessionId: string;
  formattedMessage: string;
  noEnter: boolean;
  /**
   * Write Ctrl+C immediately before THIS message's payload (Spec 1307).
   *
   * Only set for a delayed `--interrupt` send that had to queue behind earlier
   * buffered messages. Without it such a send would have to choose between
   * interrupting (write directly, overtaking the queue) and preserving order
   * (queue, losing the interrupt). Carrying the Ctrl+C on the message keeps
   * both: the queue drains in order, and the interrupt still lands directly
   * ahead of the payload it belongs to.
   */
  interruptFirst?: boolean;
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
/** Deliver function returns ms timestamp when all writes complete (for serialization). */
export type DeliverFn = (session: PtySession, msg: BufferedMessage, delayOffset?: number) => number;
export type LogFn = (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;

const DEFAULT_IDLE_THRESHOLD_MS = 3000;
const DEFAULT_MAX_BUFFER_AGE_MS = 60_000;
const FLUSH_INTERVAL_MS = 500;

export class SendBuffer {
  private buffers = new Map<string, BufferedMessage[]>();
  /**
   * Per-session epoch-ms at which the last flush's paced writes finish
   * (Spec 1307).
   *
   * `flush()` removes a session's queue as soon as it has SCHEDULED its writes,
   * but `writeMessageToSession` paces lines and the trailing Enter across
   * several timeouts. Without this, `hasPending()` goes false while `/clear` is
   * still mid-delivery, and a delayed `/arch-init` coming due in that window
   * writes into the middle of it — producing `/clear/arch-init main` on one
   * line, so the clear never executes.
   *
   * Tracking the completion time keeps a session "busy" until its writes have
   * actually landed.
   */
  private busyUntil = new Map<string, number>();
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

      // #1198: writes to a session whose shellper connection is down are
      // dropped silently. Hold the messages while the connection recovers
      // (in-place reconnect takes a few seconds); if it never does, drop
      // loudly instead of logging a successful delivery.
      if (!session.writable) {
        if (forceAll || maxAgeExceeded) {
          if (this.log) {
            this.log('ERROR', `Dropping ${messages.length} buffered message(s) for unwritable session ${sessionId.slice(0, 8)}... (shellper connection down)`);
          }
          this.buffers.delete(sessionId);
        }
        continue;
      }

      // Spec 1307: do not start a new delivery while the PREVIOUS flush's paced
      // writes are still landing. Without this, a message queued during that
      // window is picked up by the next 500ms tick and written into the middle
      // of the message already being delivered. `hasPending` alone is not
      // enough — it stops writers from bypassing the queue, but the queue's own
      // drain has to wait too. `forceAll` (shutdown) overrides: delivering late
      // beats losing the message.
      if (!forceAll) {
        const busy = this.busyUntil.get(sessionId);
        if (busy !== undefined && now < busy) continue;
      }

      // Deliver when: forced, user idle, or max age exceeded.
      // Bugfix #492: removed composing check — it gets stuck true after non-Enter
      // keystrokes (Ctrl+C, arrows, Tab), causing messages to wait 60s max age.
      if (forceAll || isIdle || maxAgeExceeded) {
        // Deliver all messages in order, serializing paced writes (Bugfix #584).
        // Each delivery returns the ms when its writes complete; the next message
        // starts after that to prevent interleaved lines.
        let offset = 0;
        for (const msg of messages) {
          offset = this.deliver(session, msg, offset);
          if (this.log && msg.logMessage) {
            this.log('INFO', msg.logMessage);
          }
        }
        if (this.log && !forceAll) {
          const reason = maxAgeExceeded ? 'max age exceeded' : 'user idle';
          this.log('INFO', `Delivered ${messages.length} deferred message(s) to session ${sessionId.slice(0, 8)}... (${reason})`);
        }
        this.buffers.delete(sessionId);
        // Stay "busy" until the paced writes actually land (Spec 1307).
        if (offset > 0) this.busyUntil.set(sessionId, Date.now() + offset);
      }
    }
  }

  /**
   * Whether this session already has messages waiting (Spec 1307).
   *
   * Used by the delayed-send path to preserve per-session FIFO. A delayed
   * message that finds the session idle would otherwise write straight to the
   * PTY and overtake an earlier message still sitting in this buffer — which
   * for `/arch-save` means `/arch-init` landing before the `/clear` that was
   * sent first, after which the clear destroys the freshly recovered context.
   *
   * Consulting this makes ordering a property of the queue rather than of
   * flush timing.
   */
  hasPending(sessionId: string): boolean {
    const queue = this.buffers.get(sessionId);
    if (queue !== undefined && queue.length > 0) return true;

    // A flush that has scheduled but not finished its writes still counts:
    // writing into that window interleaves with a message already being
    // delivered, which is the same hazard as overtaking a queued one.
    const busy = this.busyUntil.get(sessionId);
    if (busy === undefined) return false;
    if (Date.now() < busy) return true;
    this.busyUntil.delete(sessionId); // expired — clean up lazily
    return false;
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
