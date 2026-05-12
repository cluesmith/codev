/**
 * Unit tests for `afx dev` (commands/dev.ts).
 *
 * Mocks the Tower client, builder lookup, createPtySession, and readline.
 * Tests cover: missing builder, missing devCommand, happy spawn path,
 * already-running same-builder, swap accept/decline, and --stop.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Builder } from '../types.js';

// ─── Mocks ──────────────────────────────────────────────────────────────

// Tower client — return value is a stub we can prod per-test.
const listTerminalsMock = vi.fn();
const killTerminalMock = vi.fn();
const getTerminalWsUrlMock = vi.fn((id: string) => `ws://localhost:4100/terminal/${id}`);
vi.mock('../lib/tower-client.js', () => ({
  getTowerClient: () => ({
    listTerminals: listTerminalsMock,
    killTerminal: killTerminalMock,
    getTerminalWsUrl: getTerminalWsUrlMock,
  }),
}));

// Builder lookup
const findBuilderByIdMock = vi.fn<(id: string) => Builder | null>();
vi.mock('../lib/builder-lookup.js', () => ({
  findBuilderById: (id: string) => findBuilderByIdMock(id),
}));

// PTY creation
const createPtySessionMock = vi.fn(async () => ({ terminalId: 'pty-new' }));
vi.mock('../commands/spawn-worktree.js', () => ({
  createPtySession: (...args: unknown[]) => createPtySessionMock(...args),
}));

// Config (getConfig + getWorktreeConfig come via utils/index)
const getWorktreeConfigMock = vi.fn(() => ({
  symlinks: [],
  postSpawn: [],
  devCommand: 'pnpm dev',
}));
vi.mock('../utils/index.js', () => ({
  getConfig: () => ({ workspaceRoot: '/proj' }),
  getWorktreeConfig: (...args: unknown[]) => getWorktreeConfigMock(...args),
}));

// Logger — silent
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    kv: vi.fn(),
    blank: vi.fn(),
  },
}));

// readline prompt
const readlineQuestionMock = vi.fn();
vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (prompt: string, cb: (answer: string) => void) => {
      readlineQuestionMock(prompt, cb);
    },
    close: vi.fn(),
  }),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────

const { dev } = await import('../commands/dev.js');

// ─── Fixtures ───────────────────────────────────────────────────────────

const builder: Builder = {
  id: 'builder-spir-42',
  name: 'spir 42',
  status: 'implementing',
  phase: 'implement',
  worktree: '/proj/.builders/spir-42',
  branch: 'builder/spir-42',
  type: 'spec',
};

function answerPrompt(answer: 'y' | 'n'): void {
  readlineQuestionMock.mockImplementationOnce((_q: string, cb: (a: string) => void) => cb(answer));
}

beforeEach(() => {
  vi.clearAllMocks();
  findBuilderByIdMock.mockReturnValue(builder);
  listTerminalsMock.mockResolvedValue([]);
  killTerminalMock.mockResolvedValue(true);
  getWorktreeConfigMock.mockReturnValue({ symlinks: [], postSpawn: [], devCommand: 'pnpm dev' });
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe('afx dev — validation', () => {
  it('errors when neither --stop nor builderId is provided', async () => {
    await expect(dev({})).rejects.toThrow(/Usage: afx dev/);
  });

  it('errors when the builder is not found', async () => {
    findBuilderByIdMock.mockReturnValue(null);
    await expect(dev({ builderId: 'ghost' })).rejects.toThrow(/No builder found matching "ghost"/);
  });

  it('errors when worktree.devCommand is unset', async () => {
    getWorktreeConfigMock.mockReturnValueOnce({ symlinks: [], postSpawn: [], devCommand: null });
    await expect(dev({ builderId: 'spir-42' })).rejects.toThrow(/No worktree\.devCommand configured/);
  });
});

describe('afx dev — spawn (no existing dev)', () => {
  it('creates a PTY with type=dev, label=Dev: <id>, cwd=worktree', async () => {
    await dev({ builderId: 'spir-42' });

    expect(createPtySessionMock).toHaveBeenCalledTimes(1);
    const [, command, args, cwd, registration] = createPtySessionMock.mock.calls[0] as [
      unknown, string, string[], string, { workspacePath: string; type: string; roleId: string; label: string },
    ];
    expect(command).toBe('/bin/sh');
    expect(args).toEqual(['-lc', 'pnpm dev']);
    expect(cwd).toBe('/proj/.builders/spir-42');
    expect(registration).toEqual({
      workspacePath: '/proj',
      type: 'dev',
      roleId: 'builder-spir-42',
      label: 'Dev: builder-spir-42',
    });
  });
});

describe('afx dev — already running for same builder', () => {
  it('does not create a second PTY, prints existing terminal URL', async () => {
    listTerminalsMock.mockResolvedValueOnce([
      { id: 'pty-existing', label: 'Dev: builder-spir-42', createdAt: '2026-01-01T00:00:00Z' },
    ]);

    await dev({ builderId: 'spir-42' });

    expect(createPtySessionMock).not.toHaveBeenCalled();
    expect(killTerminalMock).not.toHaveBeenCalled();
  });
});

describe('afx dev — swap detection', () => {
  it('prompts before killing the existing PTY when a different builder is running', async () => {
    listTerminalsMock.mockResolvedValueOnce([
      { id: 'pty-old', label: 'Dev: builder-air-99', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    // After the kill, listTerminals returns [] (old PTY gone)
    listTerminalsMock.mockResolvedValueOnce([]);
    answerPrompt('y');

    await dev({ builderId: 'spir-42' });

    expect(readlineQuestionMock).toHaveBeenCalledTimes(1);
    expect(killTerminalMock).toHaveBeenCalledWith('pty-old');
    expect(createPtySessionMock).toHaveBeenCalledTimes(1);
  });

  it('declining the prompt aborts and does not kill or spawn', async () => {
    listTerminalsMock.mockResolvedValueOnce([
      { id: 'pty-old', label: 'Dev: builder-air-99', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    answerPrompt('n');

    await dev({ builderId: 'spir-42' });

    expect(killTerminalMock).not.toHaveBeenCalled();
    expect(createPtySessionMock).not.toHaveBeenCalled();
  });

  it('throws if the killed PTY does not disappear within the timeout', async () => {
    listTerminalsMock.mockResolvedValueOnce([
      { id: 'pty-stuck', label: 'Dev: builder-air-99', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    // Every subsequent poll still returns the stuck PTY.
    listTerminalsMock.mockResolvedValue([
      { id: 'pty-stuck', label: 'Dev: builder-air-99', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    answerPrompt('y');

    await expect(dev({ builderId: 'spir-42' })).rejects.toThrow(/did not exit within/);
    expect(createPtySessionMock).not.toHaveBeenCalled();
  }, 15_000);
});

describe('afx dev --stop', () => {
  it('is a no-op + clear log when no dev is running', async () => {
    listTerminalsMock.mockResolvedValueOnce([]);
    await dev({ stop: true });
    expect(killTerminalMock).not.toHaveBeenCalled();
  });

  it('kills the running dev PTY', async () => {
    listTerminalsMock.mockResolvedValueOnce([
      { id: 'pty-running', label: 'Dev: builder-spir-42', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    await dev({ stop: true });
    expect(killTerminalMock).toHaveBeenCalledWith('pty-running');
  });
});
