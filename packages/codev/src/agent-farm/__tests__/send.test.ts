/**
 * Tests for commands/send.ts (refactored to use TowerClient.sendMessage)
 * Spec 0110: Messaging Infrastructure — Phase 4
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

const { mockIsRunning, mockSendMessage, mockLoadState } = vi.hoisted(() => ({
  mockIsRunning: vi.fn<() => Promise<boolean>>(),
  mockSendMessage: vi.fn<() => Promise<{ ok: boolean; resolvedTo?: string; error?: string }>>(),
  mockLoadState: vi.fn(),
}));

vi.mock('../lib/tower-client.js', () => ({
  TowerClient: vi.fn().mockImplementation(function (this: any) {
    this.isRunning = mockIsRunning;
    this.sendMessage = mockSendMessage;
  }),
}));

vi.mock('../state.js', () => ({
  loadState: mockLoadState,
}));

// Mock logger to capture output without printing
vi.mock('../utils/logger.js', () => ({
  logger: {
    header: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    kv: vi.fn(),
    blank: vi.fn(),
    row: vi.fn(),
  },
  fatal: vi.fn((msg: string) => { throw new Error(msg); }),
}));

// Mock fs for file operations
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      // detectWorkspaceRoot looks for .codev or .git
      if (typeof p === 'string' && (p.endsWith('.codev') || p.endsWith('.git'))) {
        return false;
      }
      // For file reading in --file tests
      if (p === '/tmp/test-file.txt') return true;
      if (p === '/tmp/missing.txt') return false;
      if (p === '/tmp/large-file.txt') return true;
      return false;
    }),
    readFileSync: vi.fn((p: string) => {
      if (p === '/tmp/test-file.txt') return Buffer.from('file contents here');
      if (p === '/tmp/large-file.txt') return Buffer.alloc(50 * 1024); // 50KB > 48KB limit
      return Buffer.from('');
    }),
  };
});

import { tmpdir } from 'node:os';
import { send, detectWorkspaceRoot } from '../commands/send.js';
import { fatal, logger } from '../utils/logger.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * The 'from' sender identity these tests expect. The suite runs from a CWD
 * outside any `.builders/<id>/` worktree (see beforeEach), so
 * detectCurrentBuilderId() returns null and send() uses the architect identity —
 * `architect:<name>` from CODEV_ARCHITECT_NAME, which beforeEach clears so it
 * resolves to the default 'main' (issue #1478).
 *
 * Builder-id detection (and its #1094 fail-loud behavior when state.db is
 * unreadable inside a worktree) is covered by bugfix-774 / bugfix-1094 tests;
 * these tests deliberately isolate from it so they exercise send()'s other
 * behavior without depending on the physical CWD of the test runner.
 */
function getExpectedFrom(): string {
  return 'architect:main';
}

function defaultState() {
  return {
    builders: [
      { id: 'builder-spir-109', name: '109-messaging', type: 'spec', worktree: '/project/.builders/spir-109', terminalId: 'term-1', status: 'implementing', phase: 'impl' },
      { id: 'builder-bugfix-42', name: 'bugfix-42-fix', type: 'issue', worktree: '/project/.builders/bugfix-42', terminalId: 'term-2', status: 'implementing', phase: 'impl' },
    ],
    architect: null,
    utils: [],
    annotations: [],
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('send command', () => {
  const origCwd = process.cwd();
  const origArchitectName = process.env.CODEV_ARCHITECT_NAME;

  beforeEach(() => {
    // Run from outside any `.builders/<id>/` worktree so the sender identity
    // resolves deterministically to the architect identity regardless of where the
    // test runner physically lives (it may itself run inside a builder worktree).
    process.chdir(tmpdir());
    // …and with no CODEV_ARCHITECT_NAME, so the architect name resolves to its
    // default 'main' even when the runner inherits a Tower-injected env.
    delete process.env.CODEV_ARCHITECT_NAME;
    vi.clearAllMocks();
    mockIsRunning.mockResolvedValue(true);
    mockSendMessage.mockResolvedValue({ ok: true, resolvedTo: 'builder-spir-109' });
    mockLoadState.mockReturnValue(defaultState());
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (origArchitectName === undefined) delete process.env.CODEV_ARCHITECT_NAME;
    else process.env.CODEV_ARCHITECT_NAME = origArchitectName;
  });

  // Issue #1478: the sender is the SPECIFIC architect, not the generic 'architect'.
  // It is the mailbox row's from_agent and the composer header's name, so both
  // attribution surfaces answer "which architect?".
  describe('architect sender identity (issue #1478)', () => {
    it('sends as architect:<name> from the terminal architect name', async () => {
      process.env.CODEV_ARCHITECT_NAME = 'feedback';

      await send({ builder: 'builder-spir-109', message: 'Hello builder' });

      expect(mockSendMessage).toHaveBeenCalledWith(
        'builder-spir-109',
        'Hello builder',
        expect.objectContaining({ from: 'architect:feedback' }),
      );
    });

    it('defaults to architect:main when no architect name is in the env', async () => {
      await send({ builder: 'builder-spir-109', message: 'Hello builder' });

      expect(mockSendMessage).toHaveBeenCalledWith(
        'builder-spir-109',
        'Hello builder',
        expect.objectContaining({ from: 'architect:main' }),
      );
    });

    it('carries the same identity on a broadcast (--all)', async () => {
      process.env.CODEV_ARCHITECT_NAME = 'feedback';

      await send({ all: true, message: 'Broadcast' });

      for (const call of mockSendMessage.mock.calls) {
        expect(call[2]).toMatchObject({ from: 'architect:feedback' });
      }
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('single target send', () => {
    it('sends to a builder by full name', async () => {
      await send({ builder: 'builder-spir-109', message: 'Hello builder' });

      expect(mockSendMessage).toHaveBeenCalledWith(
        'builder-spir-109',
        'Hello builder',
        expect.objectContaining({ from: getExpectedFrom() }),
      );
    });

    it('sends to architect (backward compat)', async () => {
      await send({ builder: 'architect', message: 'Status update' });

      expect(mockSendMessage).toHaveBeenCalledWith(
        'architect',
        'Status update',
        expect.objectContaining({ from: getExpectedFrom() }),
      );
    });

    it('sends to "arch" shorthand (backward compat)', async () => {
      await send({ builder: 'arch', message: 'Hello' });

      expect(mockSendMessage).toHaveBeenCalledWith(
        'arch',
        'Hello',
        expect.objectContaining({}),
      );
    });

    it('sends to bare numeric ID (backward compat)', async () => {
      await send({ builder: '0109', message: 'Test' });

      expect(mockSendMessage).toHaveBeenCalledWith(
        '0109',
        'Test',
        expect.objectContaining({ from: getExpectedFrom() }),
      );
    });

    it('sends cross-project address', async () => {
      await send({ builder: 'other-project:architect', message: 'Cross-project msg' });

      expect(mockSendMessage).toHaveBeenCalledWith(
        'other-project:architect',
        'Cross-project msg',
        expect.objectContaining({ from: getExpectedFrom() }),
      );
    });

    it('passes raw option through', async () => {
      await send({ builder: 'builder-spir-109', message: 'Raw msg', raw: true });

      expect(mockSendMessage).toHaveBeenCalledWith(
        'builder-spir-109',
        'Raw msg',
        expect.objectContaining({ raw: true }),
      );
    });

    it('passes noEnter option through', async () => {
      await send({ builder: 'builder-spir-109', message: 'No enter', noEnter: true });

      expect(mockSendMessage).toHaveBeenCalledWith(
        'builder-spir-109',
        'No enter',
        expect.objectContaining({ noEnter: true }),
      );
    });

    it('passes interrupt option through', async () => {
      await send({ builder: 'builder-spir-109', message: 'Interrupt', interrupt: true });

      expect(mockSendMessage).toHaveBeenCalledWith(
        'builder-spir-109',
        'Interrupt',
        expect.objectContaining({ interrupt: true }),
      );
    });

    it('appends file content to message', async () => {
      await send({ builder: 'builder-spir-109', message: 'Review this', file: '/tmp/test-file.txt' });

      expect(mockSendMessage).toHaveBeenCalledWith(
        'builder-spir-109',
        expect.stringContaining('file contents here'),
        expect.any(Object),
      );
      // Verify the message includes the file attachment format
      const sentMessage = mockSendMessage.mock.calls[0][1];
      expect(sentMessage).toContain('Review this');
      expect(sentMessage).toContain('Attached content:');
      expect(sentMessage).toContain('file contents here');
    });

    it('throws on file too large', async () => {
      await expect(
        send({ builder: 'builder-spir-109', message: 'Test', file: '/tmp/large-file.txt' }),
      ).rejects.toThrow('File too large');
    });

    it('throws on file not found', async () => {
      await expect(
        send({ builder: 'builder-spir-109', message: 'Test', file: '/tmp/missing.txt' }),
      ).rejects.toThrow('File not found');
    });
  });

  describe('--all broadcast', () => {
    it('sends to all builders from state.db with correct sender identity', async () => {
      await send({ all: true, builder: 'Hello everyone' });

      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // sendToAll uses the detected sender identity (from CWD), same as single-target
      expect(mockSendMessage).toHaveBeenCalledWith(
        'builder-spir-109',
        'Hello everyone',
        expect.objectContaining({ from: getExpectedFrom() }),
      );
      expect(mockSendMessage).toHaveBeenCalledWith(
        'builder-bugfix-42',
        'Hello everyone',
        expect.objectContaining({ from: getExpectedFrom() }),
      );
    });

    it('handles no active builders', async () => {
      mockLoadState.mockReturnValue({ ...defaultState(), builders: [] });

      await send({ all: true, builder: 'Hello' });

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('continues sending after individual failure', async () => {
      mockSendMessage
        .mockResolvedValueOnce({ ok: false, error: 'NOT_FOUND' })
        .mockResolvedValueOnce({ ok: true, resolvedTo: 'builder-bugfix-42' });

      await send({ all: true, builder: 'Hello' });

      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // --delay (Spec 1307)
  // =========================================================================

  describe('--delay', () => {
    it('passes deliverAfter through to the client', async () => {
      // The CLI->client hop for --delay. Without this assertion, dropping
      // `deliverAfter: options.delay` from send.ts leaves every other test
      // green while --delay silently degrades to an immediate send.
      await send({ builder: 'builder-spir-109', message: 'later', delay: 15 });

      expect(mockSendMessage).toHaveBeenCalledWith(
        'builder-spir-109',
        'later',
        expect.objectContaining({ deliverAfter: 15 }),
      );
    });

    it('omits deliverAfter when no delay is given', async () => {
      await send({ builder: 'builder-spir-109', message: 'now' });

      expect(mockSendMessage).toHaveBeenCalledWith(
        'builder-spir-109',
        'now',
        expect.objectContaining({ deliverAfter: undefined }),
      );
    });

    it('passes deliverAfter for every target under --all', async () => {
      await send({ all: true, builder: 'broadcast later', delay: 20 });

      for (const call of mockSendMessage.mock.calls) {
        expect(call[2]).toEqual(expect.objectContaining({ deliverAfter: 20 }));
      }
      expect(mockSendMessage.mock.calls.length).toBeGreaterThan(0);
    });

    it('reports a scheduled send as scheduled, not sent', async () => {
      mockSendMessage.mockResolvedValue({
        ok: true, resolvedTo: 'builder-spir-109', scheduled: true,
      });

      await send({ builder: 'builder-spir-109', message: 'later', delay: 15 });

      const messages = vi.mocked(logger.success).mock.calls.map(c => String(c[0]));
      expect(messages.some(m => /scheduled/i.test(m))).toBe(true);
      expect(messages.some(m => /^Message sent to/.test(m))).toBe(false);
    });

    it('reports a held send as held, never as delivered', async () => {
      // Spec 1313: the SendBuffer `deferred`/"queued" bucket is gone. A message that
      // cannot land now is `held` in the durable mailbox and reported via logger.info
      // (not success) — it is explicitly NOT a delivery.
      mockSendMessage.mockResolvedValue({
        ok: true, resolvedTo: 'builder-spir-109', held: true, reason: 'busy-line',
      });

      await send({ builder: 'builder-spir-109', message: 'hi' });

      const infoMessages = vi.mocked(logger.info).mock.calls.map(c => String(c[0]));
      const successMessages = vi.mocked(logger.success).mock.calls.map(c => String(c[0]));
      expect(infoMessages.some(m => /held/i.test(m))).toBe(true);
      expect(successMessages.some(m => /^Message delivered to/.test(m))).toBe(false);
    });
  });

  describe('error handling', () => {
    it('throws when Tower is not running', async () => {
      mockIsRunning.mockResolvedValue(false);

      await expect(
        send({ builder: 'builder-spir-109', message: 'Test' }),
      ).rejects.toThrow('Tower is not running');
    });

    it('throws when sendMessage returns error', async () => {
      mockSendMessage.mockResolvedValue({ ok: false, error: 'Agent not found' });

      await expect(
        send({ builder: 'builder-spir-109', message: 'Test' }),
      ).rejects.toThrow('Agent not found');
    });

    it('throws when no message provided', async () => {
      await expect(
        send({ builder: 'builder-spir-109' }),
      ).rejects.toThrow('No message provided');
    });

    it('throws when no builder and no --all', async () => {
      await expect(
        send({ message: 'Hello' }),
      ).rejects.toThrow('Must specify a builder ID');
    });
  });
});
