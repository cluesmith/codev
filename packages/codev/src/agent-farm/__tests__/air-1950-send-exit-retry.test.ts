/**
 * Issue #1950 — `afx send --exit-code`, `--retry <n>` and `--message-file <path>`.
 *
 * The Tower client is mocked (the real one would reach the developer's live Tower on 4100);
 * everything between it and the CLI's exit code is the real code path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sendMessageMock = vi.fn();
const isRunningMock = vi.fn(async () => true);
const loadStateMock = vi.fn();

vi.mock('../lib/tower-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tower-client.js')>()),
  TowerClient: class {
    isRunning = isRunningMock;
    sendMessage = sendMessageMock;
  },
}));

vi.mock('../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state.js')>()),
  loadState: (ws: string) => loadStateMock(ws),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    success: vi.fn(), header: vi.fn(), kv: vi.fn(), blank: vi.fn(), row: vi.fn(),
  },
  fatal: vi.fn((msg: string) => { throw new Error(`FATAL: ${msg}`); }),
}));

import { send, SEND_EXIT_CODES, worstOutcome, retryDelayMs } from '../commands/send.js';
import { runAgentFarm } from '../cli.js';

const delivered = { ok: true, resolvedTo: 't', delivered: true, bodyLength: 5 };
const held = { ok: true, resolvedTo: 't', held: true, delivered: false, reason: 'busy', detail: 'user-text', mailboxId: 'row-1' };
const scheduled = { ok: true, resolvedTo: 't', scheduled: true, mailboxId: 'row-2' };
const refusedConn = { ok: false, error: 'Tower not running', connectionRefused: true };
const timedOut = { ok: false, error: 'Request timeout' };

describe('afx send — #1950', () => {
  // Run from a neutral directory with no builder env, so the sender resolves as `architect`
  // rather than insisting on this worktree's canonical builder id (#1094).
  const origCwd = process.cwd();
  const origWorktreeEnv = process.env.CODEV_BUILDER_WORKTREE;
  let dir: string;
  let stderr: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    isRunningMock.mockResolvedValue(true);
    loadStateMock.mockReturnValue({ builders: [], architects: [], utils: [], annotations: [] });
    dir = mkdtempSync(join(tmpdir(), 'air-1950-send-'));
    process.chdir(dir);
    delete process.env.CODEV_BUILDER_WORKTREE;
    stderr = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { stderr.push(a.map(String).join(' ')); });
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.chdir(origCwd);
    if (origWorktreeEnv !== undefined) process.env.CODEV_BUILDER_WORKTREE = origWorktreeEnv;
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  describe('outcomes and their exit codes', () => {
    it('maps each outcome to the documented code', () => {
      expect(SEND_EXIT_CODES).toEqual({ delivered: 0, scheduled: 0, failed: 1, held: 3, unverified: 4 });
    });

    it.each([
      ['delivered', delivered],
      ['scheduled', scheduled],
      ['held', held],
      ['unverified', { ...delivered, verified: false }],
      ['unverified', { ...delivered, verified: true, unverifiedCause: 'input-raced' }],
      ['unverified', { ...delivered, degraded: true, degradedReason: 'submit-wait-ceiling-expired' }],
    ])('classifies a %s send', async (outcome, result) => {
      sendMessageMock.mockResolvedValue(result);
      expect(await send({ builder: 't', message: 'hello' })).toBe(outcome);
    });

    it('a refused send still fails (exit 1) as it always has', async () => {
      sendMessageMock.mockResolvedValue({ ok: false, error: 'builder may only address its own architect (FORBIDDEN)' });
      await expect(send({ builder: 't', message: 'hello' })).rejects.toThrow('FATAL: builder may only');
    });

    it('--all reports the most severe outcome across recipients', async () => {
      loadStateMock.mockReturnValue({
        builders: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], architects: [], utils: [], annotations: [],
      });
      sendMessageMock.mockResolvedValueOnce(delivered).mockResolvedValueOnce(held).mockResolvedValueOnce(scheduled);
      expect(await send({ all: true, message: 'hello' })).toBe('held');

      sendMessageMock.mockResolvedValueOnce({ ...delivered, verified: false }).mockResolvedValueOnce(held)
        .mockResolvedValueOnce({ ok: false, error: 'boom' });
      expect(await send({ all: true, message: 'hello' })).toBe('failed');
    });

    it('orders severity failed > unverified > held > scheduled/delivered', () => {
      expect(worstOutcome('held', 'unverified')).toBe('unverified');
      expect(worstOutcome('failed', 'unverified')).toBe('failed');
      expect(worstOutcome('delivered', 'held')).toBe('held');
      expect(worstOutcome('scheduled', 'delivered')).toBe('scheduled');
    });
  });

  describe('CLI exit codes', () => {
    it.each([
      [delivered, 0],
      [scheduled, 0],
      [held, 3],
      [{ ...delivered, verified: false }, 4],
    ])('--exit-code sets the exit code by outcome', async (result, code) => {
      sendMessageMock.mockResolvedValue(result);
      await runAgentFarm(['send', 't', 'hello', '--exit-code']);
      expect(process.exitCode).toBe(code);
    });

    it.each([held, { ...delivered, verified: false }, scheduled])(
      'without --exit-code every non-failed outcome exits 0, as today',
      async (result) => {
        sendMessageMock.mockResolvedValue(result);
        await runAgentFarm(['send', 't', 'hello']);
        expect(process.exitCode).toBeUndefined();
      },
    );

    it('--all with a failed recipient still exits 0 without the flag, 1 with it', async () => {
      loadStateMock.mockReturnValue({ builders: [{ id: 'a' }], architects: [], utils: [], annotations: [] });
      sendMessageMock.mockResolvedValue({ ok: false, error: 'boom' });
      await runAgentFarm(['send', '--all', 'hello']);
      expect(process.exitCode).toBeUndefined();
      await runAgentFarm(['send', '--all', 'hello', '--exit-code']);
      expect(process.exitCode).toBe(1);
    });

    it('rejects a --retry that is not a non-negative integer', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('__exit__'); }) as never);
      await expect(runAgentFarm(['send', 't', 'hello', '--retry', '-1'])).rejects.toThrow('__exit__');
      expect(exit).toHaveBeenCalledWith(1);
      expect(sendMessageMock).not.toHaveBeenCalled();
    });
  });

  describe('--retry', () => {
    it('resends after a refused connection, saying so on stderr', async () => {
      vi.useFakeTimers();
      sendMessageMock.mockResolvedValueOnce(refusedConn).mockResolvedValueOnce(refusedConn).mockResolvedValueOnce(delivered);
      const run = send({ builder: 't', message: 'hello', retry: 3 });
      await vi.runAllTimersAsync();
      expect(await run).toBe('delivered');
      expect(sendMessageMock).toHaveBeenCalledTimes(3);
      expect(stderr.join('\n')).toContain('Retry 1/3 in 1s');
      expect(stderr.join('\n')).toContain('Retry 2/3 in 2s');
      expect(stderr.join('\n')).toContain('was not sent');
    });

    it('stops after n retries and fails', async () => {
      vi.useFakeTimers();
      sendMessageMock.mockResolvedValue(refusedConn);
      const run = send({ builder: 't', message: 'hello', retry: 2 });
      const settled = expect(run).rejects.toThrow('FATAL: Tower not running');
      await vi.runAllTimersAsync();
      await settled;
      expect(sendMessageMock).toHaveBeenCalledTimes(3);
    });

    it('never resends a held message', async () => {
      sendMessageMock.mockResolvedValue(held);
      expect(await send({ builder: 't', message: 'hello', retry: 5 })).toBe('held');
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });

    it('never resends after a timeout — the request may have arrived', async () => {
      sendMessageMock.mockResolvedValue(timedOut);
      await expect(send({ builder: 't', message: 'hello', retry: 5 })).rejects.toThrow('FATAL: Request timeout');
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });

    it('never resends a refusal from Tower', async () => {
      sendMessageMock.mockResolvedValue({ ok: false, error: 'not allowed (FORBIDDEN)' });
      await expect(send({ builder: 't', message: 'hello', retry: 5 })).rejects.toThrow('FATAL: not allowed');
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });

    it('waits for Tower to come up before sending', async () => {
      vi.useFakeTimers();
      isRunningMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      sendMessageMock.mockResolvedValue(delivered);
      const run = send({ builder: 't', message: 'hello', retry: 1 });
      await vi.runAllTimersAsync();
      expect(await run).toBe('delivered');
      expect(stderr.join('\n')).toContain('Tower is not running; nothing has been sent.');
    });

    it('without --retry, a down Tower fails at once', async () => {
      isRunningMock.mockResolvedValue(false);
      await expect(send({ builder: 't', message: 'hello' })).rejects.toThrow('FATAL: Tower is not running');
      expect(isRunningMock).toHaveBeenCalledTimes(1);
    });

    it('backs off 1s, 2s, 4s, then 8s', () => {
      expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000, 8000]);
    });
  });

  describe('--message-file', () => {
    it('sends the file verbatim — quotes, newlines and all', async () => {
      const body = `it's "quoted" $HOME \`tick\`\nsecond line\n`;
      writeFileSync(join(dir, 'msg.txt'), body);
      sendMessageMock.mockResolvedValue(delivered);
      await send({ builder: 't', messageFile: join(dir, 'msg.txt') });
      expect(sendMessageMock.mock.calls[0][1]).toBe(body.trimEnd());
    });

    it('combines with --file, which appends', async () => {
      writeFileSync(join(dir, 'msg.txt'), 'body');
      writeFileSync(join(dir, 'att.txt'), 'attached');
      sendMessageMock.mockResolvedValue(delivered);
      await send({ builder: 't', messageFile: join(dir, 'msg.txt'), file: join(dir, 'att.txt') });
      expect(sendMessageMock.mock.calls[0][1]).toBe('body\n\nAttached content:\n```\nattached\n```');
    });

    it('refuses a message given both ways', async () => {
      writeFileSync(join(dir, 'msg.txt'), 'body');
      await expect(send({ builder: 't', message: 'x', messageFile: join(dir, 'msg.txt') })).rejects.toThrow('not both');
      await expect(send({ all: true, builder: 'x', messageFile: join(dir, 'msg.txt') })).rejects.toThrow('not both');
      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('applies the 48 KB limit to the combined message', async () => {
      writeFileSync(join(dir, 'msg.txt'), 'a'.repeat(30 * 1024));
      writeFileSync(join(dir, 'att.txt'), 'b'.repeat(30 * 1024));
      await expect(send({ builder: 't', messageFile: join(dir, 'msg.txt'), file: join(dir, 'att.txt') }))
        .rejects.toThrow('FATAL');
      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('names a missing file', async () => {
      await expect(send({ builder: 't', messageFile: join(dir, 'nope.txt') })).rejects.toThrow('Message file not found');
    });
  });
});
