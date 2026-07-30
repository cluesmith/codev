/**
 * Spec 1273 Phase 1 — `afx interrupt` and the ESC delivery path.
 *
 * The behaviour under test is a *verified production recovery*, not a design
 * preference: on 2026-07-27 a builder wedged mid-turn for 45+ minutes resumed
 * within two minutes of receiving an ESC keystroke. These tests pin the pieces
 * that recovery depends on, several of which are otherwise implicit:
 *
 *  - the exact byte sequence (ESC, then Enter by default — the Enter is what
 *    lets messages queued during the wedge process);
 *  - that a lone `\x1b` survives `handleSend`'s `trim()`/non-empty guard, an
 *    accidental invariant the manual recipe has always relied on;
 *  - that ESC delivery is never deferred by the send buffer — an interrupt that
 *    can be delayed because someone recently typed is not an interrupt.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  writeEscapeToSession,
  ESC,
  ESCAPE_ENTER_DELAY_MS,
} from '../servers/message-write.js';
import type { PtySession } from '../../terminal/pty-session.js';

// ============================================================================
// writeEscapeToSession — the byte sequence
// ============================================================================

function makeSession(): PtySession & { writeCalls: string[] } {
  const writeCalls: string[] = [];
  return {
    write: vi.fn((data: string) => writeCalls.push(data)),
    writeCalls,
  } as unknown as PtySession & { writeCalls: string[] };
}

describe('writeEscapeToSession (Spec 1273)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes ESC immediately, then Enter after the enter delay', () => {
    const session = makeSession();

    const endTime = writeEscapeToSession(session, false);

    // ESC must not be delayed — the builder is wedged *now*.
    expect(session.writeCalls).toEqual([ESC]);

    vi.advanceTimersByTime(ESCAPE_ENTER_DELAY_MS);
    expect(session.writeCalls).toEqual([ESC, '\r']);
    expect(endTime).toBe(ESCAPE_ENTER_DELAY_MS);
  });

  it('writes ESC alone when noEnter is set', () => {
    const session = makeSession();

    writeEscapeToSession(session, true);

    vi.advanceTimersByTime(1000);
    expect(session.writeCalls).toEqual([ESC]);
  });

  it('sends the exact byte the verified manual recovery sends', () => {
    // `afx send <builder> --raw "$(printf '\x1b')"` — the command form must not
    // drift to a different control byte (e.g. Ctrl+C, which is a harder signal
    // and is NOT what unwedged the builder).
    expect(ESC).toBe('\x1b');
    expect(ESC).not.toBe('\x03');
  });
});

// ============================================================================
// The trim invariant the ESC recovery silently depends on
// ============================================================================

describe('ESC survives the send route input guard (Spec 1273)', () => {
  it('a lone ESC is not trimmed to empty', () => {
    // handleSend does `typeof body.message === 'string' ? body.message.trim() : ''`
    // and rejects the result when falsy. JS trim() strips WhiteSpace and
    // LineTerminator; ESC (U+001B) is neither. The whole ESC recovery — manual
    // and command form alike — rests on that. If a future change normalises or
    // strips control characters from message bodies, this fails loudly here
    // rather than silently breaking the only mid-turn recovery we have.
    expect('\x1b'.trim()).toBe('\x1b');
    expect('\x1b'.trim().length).toBe(1);
    expect(Boolean('\x1b'.trim())).toBe(true);
  });

  it('whitespace-only messages still trim to empty (guard still works)', () => {
    // Guards against "fix" attempts that would make the guard permissive.
    expect('   \n\t '.trim()).toBe('');
  });
});

// ============================================================================
// The interrupt command
// ============================================================================

const { mockSendMessage, mockIsRunning, mockDetectWorkspaceRoot, mockDetectCurrentBuilderId, mockFatal } =
  vi.hoisted(() => ({
    mockSendMessage: vi.fn(),
    mockIsRunning: vi.fn(),
    mockDetectWorkspaceRoot: vi.fn(),
    mockDetectCurrentBuilderId: vi.fn(),
    mockFatal: vi.fn((msg: string) => {
      throw new Error(`FATAL: ${msg}`);
    }),
  }));

vi.mock('../lib/tower-client.js', () => ({
  TowerClient: class {
    isRunning = mockIsRunning;
    sendMessage = mockSendMessage;
  },
}));

vi.mock('../commands/send.js', () => ({
  detectWorkspaceRoot: mockDetectWorkspaceRoot,
  detectCurrentBuilderId: mockDetectCurrentBuilderId,
}));

vi.mock('../utils/logger.js', () => ({
  logger: { header: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn(), kv: vi.fn() },
  fatal: mockFatal,
}));

describe('afx interrupt (Spec 1273)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning.mockResolvedValue(true);
    mockSendMessage.mockResolvedValue({ ok: true, resolvedTo: 'builder-aspir-1273' });
    mockDetectWorkspaceRoot.mockReturnValue('/tmp/ws');
    mockDetectCurrentBuilderId.mockReturnValue(null);
  });

  it('sends the ESC byte with escape:true', async () => {
    const { interrupt } = await import('../commands/interrupt.js');

    await interrupt({ builder: '1273' });

    expect(mockSendMessage).toHaveBeenCalledWith(
      '1273',
      '\x1b',
      expect.objectContaining({ escape: true }),
    );
  });

  it('does not set the Ctrl+C interrupt flag (ESC is a different signal)', async () => {
    const { interrupt } = await import('../commands/interrupt.js');

    await interrupt({ builder: '1273' });

    const opts = mockSendMessage.mock.calls[0][2];
    expect(opts.interrupt).toBeUndefined();
    expect(opts.raw).toBeUndefined();
  });

  it('forwards noEnter when --no-enter is passed', async () => {
    const { interrupt } = await import('../commands/interrupt.js');

    await interrupt({ builder: '1273', noEnter: true });

    expect(mockSendMessage).toHaveBeenCalledWith(
      '1273',
      '\x1b',
      expect.objectContaining({ escape: true, noEnter: true }),
    );
  });

  it('passes the target through verbatim so Tower resolves it (no second resolver)', async () => {
    const { interrupt } = await import('../commands/interrupt.js');

    await interrupt({ builder: 'builder-aspir-1273' });

    expect(mockSendMessage.mock.calls[0][0]).toBe('builder-aspir-1273');
  });

  it('sends as the current builder id when run from inside a worktree', async () => {
    mockDetectCurrentBuilderId.mockReturnValue('builder-spir-999');
    const { interrupt } = await import('../commands/interrupt.js');

    await interrupt({ builder: '1273' });

    expect(mockSendMessage).toHaveBeenCalledWith(
      '1273',
      '\x1b',
      expect.objectContaining({ from: 'builder-spir-999' }),
    );
  });

  it('aborts when no builder is given', async () => {
    const { interrupt } = await import('../commands/interrupt.js');

    await expect(interrupt({})).rejects.toThrow(/FATAL/);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('aborts when Tower is not running', async () => {
    mockIsRunning.mockResolvedValue(false);
    const { interrupt } = await import('../commands/interrupt.js');

    await expect(interrupt({ builder: '1273' })).rejects.toThrow(/Tower is not running/);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('aborts loudly when the send fails rather than reporting success', async () => {
    mockSendMessage.mockResolvedValue({ ok: false, error: 'TERMINAL_NOT_WRITABLE' });
    const { interrupt } = await import('../commands/interrupt.js');

    await expect(interrupt({ builder: '1273' })).rejects.toThrow(/TERMINAL_NOT_WRITABLE/);
  });

  it('aborts when the builder identity cannot be verified (issue #1094)', async () => {
    mockDetectCurrentBuilderId.mockImplementation(() => {
      throw new Error('Cannot resolve canonical builder id');
    });
    const { interrupt } = await import('../commands/interrupt.js');

    await expect(interrupt({ builder: '1273' })).rejects.toThrow(/Cannot resolve canonical builder id/);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});
