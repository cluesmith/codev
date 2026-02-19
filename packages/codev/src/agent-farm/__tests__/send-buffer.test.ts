/**
 * Tests for SendBuffer — typing-aware message delivery.
 * Spec 403: af send Typing Awareness — Phase 2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SendBuffer } from '../servers/send-buffer.js';
import type { BufferedMessage } from '../servers/send-buffer.js';
import type { PtySession } from '../../terminal/pty-session.js';

function makeMsg(sessionId: string, overrides?: Partial<BufferedMessage>): BufferedMessage {
  return {
    sessionId,
    formattedMessage: `msg for ${sessionId}`,
    noEnter: false,
    timestamp: Date.now(),
    broadcastPayload: {
      type: 'message',
      from: { project: 'proj', agent: 'builder' },
      to: { project: 'proj', agent: 'architect' },
      content: 'hello',
      metadata: {},
      timestamp: new Date().toISOString(),
    },
    logMessage: 'test log',
    ...overrides,
  };
}

function makeSession(idle: boolean, composing = false): PtySession {
  return {
    isUserIdle: () => idle,
    composing,
    write: vi.fn(),
  } as unknown as PtySession;
}

describe('SendBuffer', () => {
  let buf: SendBuffer;

  beforeEach(() => {
    vi.useFakeTimers();
    buf = new SendBuffer({ idleThresholdMs: 3000, maxBufferAgeMs: 10_000 });
  });

  afterEach(() => {
    buf.stop();
    vi.useRealTimers();
  });

  it('enqueues messages and reports pending count', () => {
    buf.enqueue(makeMsg('sess-1'));
    buf.enqueue(makeMsg('sess-1'));
    buf.enqueue(makeMsg('sess-2'));

    expect(buf.pendingCount).toBe(3);
    expect(buf.sessionCount).toBe(2);
  });

  it('delivers messages when session is idle', () => {
    const session = makeSession(true);
    const deliver = vi.fn();
    const log = vi.fn();

    buf.start(() => session, deliver, log);
    buf.enqueue(makeMsg('sess-1'));
    buf.enqueue(makeMsg('sess-1'));

    // Trigger flush via interval
    vi.advanceTimersByTime(500);

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(buf.pendingCount).toBe(0);
    expect(log).toHaveBeenCalledWith('INFO', expect.stringContaining('2 deferred'));
  });

  it('does NOT deliver messages when session is actively typing', () => {
    const session = makeSession(false); // not idle
    const deliver = vi.fn();
    const log = vi.fn();

    buf.start(() => session, deliver, log);
    buf.enqueue(makeMsg('sess-1'));

    vi.advanceTimersByTime(500);

    expect(deliver).not.toHaveBeenCalled();
    expect(buf.pendingCount).toBe(1);
  });

  it('delivers when max buffer age is exceeded even if user is typing', () => {
    const session = makeSession(false); // not idle
    const deliver = vi.fn();
    const log = vi.fn();

    buf.start(() => session, deliver, log);

    // Enqueue a message with an old timestamp (> maxBufferAgeMs ago)
    const oldMsg = makeMsg('sess-1', { timestamp: Date.now() - 15_000 });
    buf.enqueue(oldMsg);

    vi.advanceTimersByTime(500);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(buf.pendingCount).toBe(0);
    expect(log).toHaveBeenCalledWith('INFO', expect.stringContaining('max age exceeded'));
  });

  it('delivers all messages in order within a session', () => {
    const session = makeSession(true);
    const deliveredMsgs: string[] = [];
    const deliver = (_s: PtySession, msg: BufferedMessage) => {
      deliveredMsgs.push(msg.formattedMessage);
    };
    const log = vi.fn();

    buf.start(() => session, deliver, log);

    buf.enqueue(makeMsg('sess-1', { formattedMessage: 'first' }));
    buf.enqueue(makeMsg('sess-1', { formattedMessage: 'second' }));
    buf.enqueue(makeMsg('sess-1', { formattedMessage: 'third' }));

    vi.advanceTimersByTime(500);

    expect(deliveredMsgs).toEqual(['first', 'second', 'third']);
  });

  it('discards messages for dead sessions with warning', () => {
    const deliver = vi.fn();
    const log = vi.fn();

    buf.start(() => undefined, deliver, log); // session gone
    buf.enqueue(makeMsg('dead-sess'));

    vi.advanceTimersByTime(500);

    expect(deliver).not.toHaveBeenCalled();
    expect(buf.pendingCount).toBe(0);
    expect(log).toHaveBeenCalledWith('WARN', expect.stringContaining('Discarding'));
  });

  it('stop() delivers all remaining messages (force flush)', () => {
    const session = makeSession(false); // not idle — normally wouldn't deliver
    const deliver = vi.fn();
    const log = vi.fn();

    buf.start(() => session, deliver, log);
    buf.enqueue(makeMsg('sess-1'));
    buf.enqueue(makeMsg('sess-1'));

    // Stop forces delivery of everything
    buf.stop();

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(buf.pendingCount).toBe(0);
  });

  it('handles multiple sessions independently', () => {
    const idleSession = makeSession(true);
    const typingSession = makeSession(false);
    const deliver = vi.fn();
    const log = vi.fn();

    buf.start(
      (id) => id === 'idle' ? idleSession : typingSession,
      deliver,
      log,
    );

    buf.enqueue(makeMsg('idle'));
    buf.enqueue(makeMsg('typing'));

    vi.advanceTimersByTime(500);

    // Only the idle session's message should be delivered
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toBe(idleSession);
    expect(buf.pendingCount).toBe(1); // typing session still buffered
  });

  it('flush is a no-op before start() is called', () => {
    buf.enqueue(makeMsg('sess-1'));
    // Should not throw
    buf.flush();
    expect(buf.pendingCount).toBe(1);
  });

  it('uses default thresholds when no options provided', () => {
    const defaultBuf = new SendBuffer();
    expect(defaultBuf.idleThresholdMs).toBe(3000);
    expect(defaultBuf.maxBufferAgeMs).toBe(60_000);
  });

  describe('composing state (Bugfix #450)', () => {
    it('does NOT deliver when session is idle but composing', () => {
      // User typed but paused >3s — idle by timestamp but still composing
      const session = makeSession(true, true); // idle=true, composing=true
      const deliver = vi.fn();
      const log = vi.fn();

      buf.start(() => session, deliver, log);
      buf.enqueue(makeMsg('sess-1'));

      vi.advanceTimersByTime(500);

      expect(deliver).not.toHaveBeenCalled();
      expect(buf.pendingCount).toBe(1);
    });

    it('delivers when session is idle and NOT composing', () => {
      // User pressed Enter and has been idle
      const session = makeSession(true, false); // idle=true, composing=false
      const deliver = vi.fn();
      const log = vi.fn();

      buf.start(() => session, deliver, log);
      buf.enqueue(makeMsg('sess-1'));

      vi.advanceTimersByTime(500);

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(buf.pendingCount).toBe(0);
    });

    it('delivers when composing but max buffer age exceeded', () => {
      // Safety valve: deliver after max age even if composing
      const session = makeSession(false, true); // not idle, composing
      const deliver = vi.fn();
      const log = vi.fn();

      buf.start(() => session, deliver, log);

      const oldMsg = makeMsg('sess-1', { timestamp: Date.now() - 15_000 });
      buf.enqueue(oldMsg);

      vi.advanceTimersByTime(500);

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(buf.pendingCount).toBe(0);
    });
  });
});
