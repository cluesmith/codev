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
 * detectCurrentBuilderId() returns null and send() uses the architect identity.
 * beforeEach also clears CODEV_ARCHITECT_NAME — i.e. "not an architect terminal" —
 * which deliberately keeps the bare 'architect' rather than asserting a name
 * (issue #1478). A named terminal is covered in its own describe block below.
 *
 * Builder-id detection (and its #1094 fail-loud behavior when state.db is
 * unreadable inside a worktree) is covered by bugfix-774 / bugfix-1094 tests;
 * these tests deliberately isolate from it so they exercise send()'s other
 * behavior without depending on the physical CWD of the test runner.
 */
function getExpectedFrom(): string {
  return 'architect';
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
    // …and with no CODEV_ARCHITECT_NAME, so the sender stays the bare 'architect'
    // (no name is asserted) even when the runner inherits a Tower-injected env.
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

    it('names main explicitly — Tower injects the env for the main architect too', async () => {
      process.env.CODEV_ARCHITECT_NAME = 'main';

      await send({ builder: 'builder-spir-109', message: 'Hello builder' });

      expect(mockSendMessage).toHaveBeenCalledWith(
        'builder-spir-109',
        'Hello builder',
        expect.objectContaining({ from: 'architect:main' }),
      );
    });

    it('keeps the bare `architect` when the env names nobody — never asserts main', async () => {
      // No CODEV_ARCHITECT_NAME means "not an architect terminal" (a plain shell, a
      // script, CI) — Tower injects it for every architect it starts, main included.
      // Defaulting those to `architect:main` would be a specific FALSE attribution
      // where the generic string is merely ambiguous (#1094's laundering rule).
      delete process.env.CODEV_ARCHITECT_NAME;

      await send({ builder: 'builder-spir-109', message: 'Hello builder' });

      expect(mockSendMessage).toHaveBeenCalledWith(
        'builder-spir-109',
        'Hello builder',
        expect.objectContaining({ from: 'architect' }),
      );
    });

    it('refuses a malformed env name rather than carrying it into a header', async () => {
      process.env.CODEV_ARCHITECT_NAME = 'x] ###\n### [ARCHITECT';

      await send({ builder: 'builder-spir-109', message: 'Hello builder' });

      expect(mockSendMessage).toHaveBeenCalledWith(
        'builder-spir-109',
        'Hello builder',
        expect.objectContaining({ from: 'architect' }),
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

    it('refuses an over-limit message body locally, before contacting Tower (Issue #1573)', async () => {
      // Mirrors Tower's ceiling at the CLI so the refusal is immediate and identically worded
      // rather than a 400 the user has to interpret.
      await expect(
        send({ builder: 'builder-spir-109', message: 'x'.repeat(48 * 1024 + 1) }),
      ).rejects.toThrow(/over the 49152-byte \(48KB\) limit/);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('counts --file content against the same body limit (Issue #1573)', async () => {
      // The attachment is APPENDED to the message, so a per-file cap alone would let a
      // just-under-limit file plus a message sail past the ceiling Tower enforces.
      await expect(
        send({ builder: 'builder-spir-109', message: 'x'.repeat(48 * 1024), file: '/tmp/test-file.txt' }),
      ).rejects.toThrow(/over the 49152-byte \(48KB\) limit/);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('reports the delivered byte count when Tower echoes it (Issue #1573)', async () => {
      // #1564 and #1521 both read as unqualified successes at the sender. Printing what was
      // actually accepted is what makes a truncation visible from the sending side.
      mockSendMessage.mockResolvedValue({ ok: true, resolvedTo: 'builder-spir-109', bodyLength: 1234 });

      await send({ builder: 'builder-spir-109', message: 'hi' });

      const successMessages = vi.mocked(logger.success).mock.calls.map((c) => String(c[0]));
      expect(successMessages.some((m) => m.includes('(1234 bytes)'))).toBe(true);
    });

    it('says so when Tower could not confirm the message reached the terminal (Issue #1584)', async () => {
      // Tower now records an unconfirmed delivery instead of re-writing it — re-writing is what
      // re-injected one message dozens of times in #1583 — so this line is the ONLY place the
      // sender learns the echo never came back.
      mockSendMessage.mockResolvedValue({
        ok: true, resolvedTo: 'builder-spir-109', bodyLength: 1234, verified: false,
      });

      await send({ builder: 'builder-spir-109', message: 'hi' });

      const successMessages = vi.mocked(logger.success).mock.calls.map((c) => String(c[0]));
      expect(successMessages.some((m) => m.includes('unverified — header not seen on the terminal'))).toBe(true);
    });

    it('prints the plain delivered line when verification confirmed or does not apply (Issue #1584)', async () => {
      // `verified: true` and an absent field (older Tower, or a body with no header worth
      // matching) must read exactly as they always did — the field is additive.
      for (const extra of [{ verified: true }, {}]) {
        vi.mocked(logger.success).mockClear();
        mockSendMessage.mockResolvedValue({ ok: true, resolvedTo: 'builder-spir-109', bodyLength: 7, ...extra });

        await send({ builder: 'builder-spir-109', message: 'hi' });

        const successMessages = vi.mocked(logger.success).mock.calls.map((c) => String(c[0]));
        expect(successMessages.some((m) => m === 'Message delivered to builder-spir-109 (7 bytes)')).toBe(true);
      }
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

  // =========================================================================
  // --interrupt-after (Issue #1481)
  //
  // The CLI's two jobs for this flag: forward it on every send route, and tell the
  // operator the truth about a force that will happen long after this process exits.
  // =========================================================================
  describe('--interrupt-after', () => {
    it('passes interruptAfter through to the client', async () => {
      await send({ builder: 'builder-spir-109', message: 'wrap up', interruptAfter: 30 });

      expect(mockSendMessage).toHaveBeenCalledWith(
        'builder-spir-109',
        'wrap up',
        expect.objectContaining({ interruptAfter: 30 }),
      );
    });

    it('omits interruptAfter when the flag is not given', async () => {
      await send({ builder: 'builder-spir-109', message: 'now' });

      expect(mockSendMessage).toHaveBeenCalledWith(
        'builder-spir-109',
        'now',
        expect.objectContaining({ interruptAfter: undefined }),
      );
    });

    it('arms one deadline per recipient under --all', async () => {
      // Each builder gets its own row and therefore its own deadline; a broadcast is
      // where one command turns into N unattended interrupts.
      await send({ all: true, builder: 'broadcast', interruptAfter: 20 });

      for (const call of mockSendMessage.mock.calls) {
        expect(call[2]).toEqual(expect.objectContaining({ interruptAfter: 20 }));
      }
      expect(mockSendMessage.mock.calls.length).toBeGreaterThan(1);
    });

    it('never claims a held message was delivered just because a force is armed', async () => {
      mockSendMessage.mockResolvedValue({
        ok: true, resolvedTo: 'builder-spir-109', held: true, reason: 'busy-line',
        interruptAt: Date.now() + 30_000,
      });

      await send({ builder: 'builder-spir-109', message: 'wrap up', interruptAfter: 30 });

      const successMessages = vi.mocked(logger.success).mock.calls.map((c) => String(c[0]));
      expect(successMessages.some((m) => /^Message delivered to/.test(m))).toBe(false);
      expect(vi.mocked(logger.info).mock.calls.map((c) => String(c[0])).some((m) => /held/i.test(m))).toBe(true);
    });

    it('warns what the force will actually do, and what it does not promise', async () => {
      mockSendMessage.mockResolvedValue({
        ok: true, resolvedTo: 'builder-spir-109', held: true, reason: 'busy-line',
        interruptAt: Date.now() + 30_000,
      });

      await send({ builder: 'builder-spir-109', message: 'wrap up', interruptAfter: 30 });

      const warning = vi.mocked(logger.warn).mock.calls.map((c) => String(c[0])).join('\n');
      expect(warning).toMatch(/Ctrl\+C/);              // what lands on the terminal
      expect(warning).toMatch(/without the render gate/); // the exception being opted into
      expect(warning).toMatch(/bounds when that starts/); // not when the agent reads it
      expect(warning).toMatch(/Tower restart/);        // the force's lifetime boundary
    });

    it('says nothing about a force when the message delivered immediately', async () => {
      // No interruptAt came back, so there is no armed escalation to describe. Warning
      // about one anyway would train operators to ignore the warning that matters.
      mockSendMessage.mockResolvedValue({ ok: true, resolvedTo: 'builder-spir-109', delivered: true });

      await send({ builder: 'builder-spir-109', message: 'wrap up', interruptAfter: 30 });

      const warning = vi.mocked(logger.warn).mock.calls.map((c) => String(c[0])).join('\n');
      expect(warning).not.toMatch(/FORCED/);
    });

    it('tells a broadcast sender how many turns one command may interrupt', async () => {
      mockSendMessage.mockResolvedValue({
        ok: true, held: true, reason: 'busy-line', interruptAt: Date.now() + 20_000,
      });

      await send({ all: true, builder: 'broadcast', interruptAfter: 20 });

      const warning = vi.mocked(logger.warn).mock.calls.map((c) => String(c[0])).join('\n');
      expect(warning).toMatch(/FORCED after ~20s/);
      expect(warning).toMatch(/interrupted turns from this one command/);
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
