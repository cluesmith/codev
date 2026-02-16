/**
 * Regression tests for Bugfix #195 - attach command with PTY-backed builders
 *
 * Tests that af attach properly handles PTY-backed builders (no port/pid).
 * Updated for Spec 0099: port/pid removed from Builder type entirely.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Builder } from '../types.js';

// Module-level mock state (must be outside describe for vi.mock hoisting)
const mockBuilders: Builder[] = [];

vi.mock('../state.js', () => ({
  loadState: () => ({ builders: mockBuilders, architect: null, utils: [], annotations: [] }),
  getBuilder: (id: string) => mockBuilders.find(b => b.id === id) ?? null,
  getBuilders: () => mockBuilders,
}));

const mockRun = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
vi.mock('../utils/shell.js', () => ({
  run: (...args: any[]) => mockRun(...args),
  openBrowser: vi.fn().mockResolvedValue(undefined),
}));

// Mock config
vi.mock('../utils/config.js', () => ({
  getConfig: () => ({
    workspaceRoot: '/test/workspace',
  }),
}));

// Mock TowerClient (constructor reads local-key file)
vi.mock('../lib/tower-client.js', () => ({
  TowerClient: class {
    getWorkspaceUrl(path: string) {
      return `http://localhost:4100/workspace/${Buffer.from(path).toString('base64url')}/`;
    }
  },
}));

const mockFatal = vi.fn((msg: string) => { throw new Error(msg || 'Fatal error'); });
vi.mock('../utils/logger.js', () => ({
  logger: {
    header: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    kv: vi.fn(),
    row: vi.fn(),
    blank: vi.fn(),
    debug: vi.fn(),
  },
  fatal: (...args: any[]) => mockFatal(...args),
}));

// Mock DB (needed by findShellperSocket)
vi.mock('../db/index.js', () => ({
  getGlobalDb: () => ({
    prepare: () => ({ get: () => undefined }),
  }),
}));

// Mock normalizeWorkspacePath (needed by findShellperSocket)
vi.mock('../servers/tower-utils.js', () => ({
  normalizeWorkspacePath: (p: string) => p,
}));

// Mock fs to prevent real filesystem access in findShellperSocket
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: { ...actual, existsSync: () => false, accessSync: () => {}, readdirSync: () => [] },
    existsSync: () => false,
    accessSync: () => {},
    readdirSync: () => [],
  };
});

// Mock ShellperClient (imported by attach.ts for terminal mode)
vi.mock('../../terminal/shellper-client.js', () => ({
  ShellperClient: class { constructor() {} connect() {} disconnect() {} },
}));

describe('Bugfix #195: attach command handles PTY-backed builders', () => {
  beforeEach(() => {
    mockBuilders.length = 0;
    vi.clearAllMocks();
    mockRun.mockResolvedValue({ stdout: '', stderr: '' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should display PTY-backed builders in list', async () => {
    mockBuilders.push({
      id: 'task-AAAA',
      name: 'Task: First builder',
      status: 'implementing',
      phase: 'init',
      worktree: '/tmp/1',
      branch: 'builder/task-AAAA',
      type: 'task',
      terminalId: 'term-001',
    });

    const { attach } = await import('../commands/attach.js');
    const { logger } = await import('../utils/logger.js');

    await attach({});

    // Should show builder list
    expect(logger.header).toHaveBeenCalledWith('Running Builders');
    expect(logger.row).toHaveBeenCalled();
  });

  it('should open Tower dashboard with --browser flag', async () => {
    mockBuilders.push({
      id: 'task-AAAA',
      name: 'Task: Test',
      status: 'implementing',
      phase: 'init',
      worktree: '/tmp/1',
      branch: 'builder/task-AAAA',
      type: 'task',
      terminalId: 'term-001',
    });

    const { attach } = await import('../commands/attach.js');
    const { openBrowser } = await import('../utils/shell.js');

    await attach({ project: 'task-AAAA', browser: true });

    // Should open Tower dashboard, not a per-builder port
    expect(openBrowser).toHaveBeenCalledWith(expect.stringContaining('localhost:4100/workspace/'));
  });

  it('should fatal when builder has no terminal session', async () => {
    mockBuilders.push({
      id: 'task-BBBB',
      name: 'Task: Test',
      status: 'implementing',
      phase: 'init',
      worktree: '/tmp/1',
      branch: 'builder/task-BBBB',
      type: 'task',
    });

    const { attach } = await import('../commands/attach.js');

    await expect(attach({ project: 'task-BBBB' })).rejects.toThrow('No shellper socket found');
  });
});
