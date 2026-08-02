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

/**
 * Reserves a session for the duration of one batch (Spec 1273's submission
 * lock, adopted per Spec 1307).
 *
 * `write` may perform MANY writes and returns the FINAL completion offset, so a
 * whole flush drains as ONE reservation with the existing `delayOffset`
 * threading intact. That is what stops a direct or delayed send writing into a
 * flush that has scheduled its paced writes but not finished them — the
 * `busyUntil` bookkeeping this replaces.
 *
 * Injected rather than imported so this module keeps no dependency on the
 * server layer, and so tests can drive it without Tower.
 */
export type SubmitFn = (sessionId: string, write: () => number) => Promise<void>;

const DEFAULT_IDLE_THRESHOLD_MS = 3000;
const DEFAULT_MAX_BUFFER_AGE_MS = 60_000;
const FLUSH_INTERVAL_MS = 500;

export class SendBuffer {
  private buffers = new Map<string, BufferedMessage[]>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private getSession: GetSessionFn | null = null;
  private deliver: DeliverFn | null = null;
  private log: LogFn | null = null;
  private submit: SubmitFn = (_id, write) => { write(); return Promise.resolve(); };
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
  start(getSession: GetSessionFn, deliver: DeliverFn, log: LogFn, submit?: SubmitFn): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.getSession = getSession;
    this.deliver = deliver;
    this.log = log;
    // Default runs the batch inline — used by tests that drive flush() directly
    // and do not care about cross-path serialisation.
    this.submit = submit ?? ((_id, write) => { write(); return Promise.resolve(); });
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  /**
   * Stop the flush timer and deliver all remaining messages.
   *
   * Awaits the final flush's submissions (Spec 1307): once the drain goes
   * through `submitToSession`, a batch can be queued behind an in-flight write
   * and NOT yet delivered when this returns. Graceful shutdown must await this
   * before tearing down terminals, or a buffered message accepted for delivery
   * is silently lost — the guarantee that held before the lock adoption and had
   * to be restored after it.
   */
  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Final flush — deliver everything remaining, and wait for it to land.
    await this.flush(true);
  }

  /** Check and deliver messages for sessions that are idle or aged out. */
  flush(forceAll = false): Promise<void> {
    if (!this.getSession || !this.deliver) return Promise.resolve();
    // Only the shutdown flush (forceAll) needs to be awaited; the periodic
    // timer is fire-and-forget, as before.
    const submissions: Promise<void>[] = [];


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

      // Deliver when: forced, user idle, or max age exceeded.
      // Bugfix #492: removed composing check — it gets stuck true after non-Enter
      // keystrokes (Ctrl+C, arrows, Tab), causing messages to wait 60s max age.
      if (forceAll || isIdle || maxAgeExceeded) {
        // Deliver all messages in order, serializing paced writes (Bugfix #584).
        // Each delivery returns the ms when its writes complete; the next message
        // starts after that to prevent interleaved lines.
        // Spec 1307: the whole drain is ONE reservation. `write` may perform
        // many writes and returns the final offset, so the existing offset
        // threading is untouched while nothing else can write into this
        // session mid-batch.
        submissions.push(this.submit(sessionId, () => {
          let offset = 0;
          for (const msg of messages) {
            offset = this.deliver!(session, msg, offset);
            if (this.log && msg.logMessage) {
              this.log('INFO', msg.logMessage);
            }
          }
          return offset;
        }));
        if (this.log && !forceAll) {
          const reason = maxAgeExceeded ? 'max age exceeded' : 'user idle';
          this.log('INFO', `Delivered ${messages.length} deferred message(s) to session ${sessionId.slice(0, 8)}... (${reason})`);
        }
        this.buffers.delete(sessionId);
      }
    }
    return submissions.length ? Promise.all(submissions).then(() => undefined) : Promise.resolve();
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
    return queue !== undefined && queue.length > 0;
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
