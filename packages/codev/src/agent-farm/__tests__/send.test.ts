/**
 * Tests for commands/send.ts (refactored to use TowerClient.sendMessage)
 * Spec 0110: Messaging Infrastructure — Phase 4
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

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
      // detectWorkspaceRoot looks for af-config.json or .git
      if (typeof p === 'string' && (p.endsWith('af-config.json') || p.endsWith('.git'))) {
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

import { send, detectWorkspaceRoot } from '../commands/send.js';
import { fatal } from '../utils/logger.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Detect the 'from' value the send command will use based on CWD.
 * If CWD is inside .builders/<dir>/, `from` will be the builder's canonical ID
 * (from state.db) or the dir name. Otherwise 'architect'.
 */
function getExpectedFrom(): string {
  const cwd = process.cwd();
  const match = cwd.match(/\.builders\/([^/]+)/);
  if (!match) return 'architect';
  // In tests, loadState returns our mock with builders that have worktree paths.
  // The worktree dir match will look for match[1] in state.db.
  // Our defaultState doesn't match the actual CWD dir, so it falls back to dir name.
  return match[1]; // e.g., '0110'
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning.mockResolvedValue(true);
    mockSendMessage.mockResolvedValue({ ok: true, resolvedTo: 'builder-spir-109' });
    mockLoadState.mockReturnValue(defaultState());
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
    it('sends to all builders from state.db', async () => {
      await send({ all: true, builder: 'Hello everyone' });

      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // sendToAll always uses from: 'architect' since broadcast is from architect
      expect(mockSendMessage).toHaveBeenCalledWith(
        'builder-spir-109',
        'Hello everyone',
        expect.objectContaining({ from: 'architect' }),
      );
      expect(mockSendMessage).toHaveBeenCalledWith(
        'builder-bugfix-42',
        'Hello everyone',
        expect.objectContaining({ from: 'architect' }),
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
