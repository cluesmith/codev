/**
 * Tests for attach command
 *
 * These are unit tests for the attach command logic. Integration tests
 * that attach to actual builders require git and Tower to be running.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Builder } from '../types.js';
import { EventEmitter } from 'node:events';

// Mock state module
const mockBuilders: Builder[] = [];
vi.mock('../state.js', () => ({
  loadState: () => ({ builders: mockBuilders, architect: null, utils: [], annotations: [] }),
  getBuilder: (id: string) => mockBuilders.find(b => b.id === id) ?? null,
  getBuilders: () => mockBuilders,
}));

// Mock shell utilities
vi.mock('../utils/shell.js', () => ({
  run: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
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

// Mock logger
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
  fatal: vi.fn((msg: string) => { throw new Error(msg || 'Fatal error'); }),
}));

// Mock DB — configurable per test
const mockDbGet = vi.fn();
vi.mock('../db/index.js', () => ({
  getGlobalDb: () => ({
    prepare: () => ({ get: mockDbGet }),
  }),
}));

// Mock normalizeWorkspacePath
vi.mock('../servers/tower-utils.js', () => ({
  normalizeWorkspacePath: (p: string) => p,
}));

// Configurable fs mock
const mockExistsSync = vi.fn().mockReturnValue(false);
const mockAccessSync = vi.fn();
const mockReaddirSync = vi.fn().mockReturnValue([]);
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (...args: unknown[]) => mockExistsSync(...args),
      accessSync: (...args: unknown[]) => mockAccessSync(...args),
      readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
    },
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    accessSync: (...args: unknown[]) => mockAccessSync(...args),
    readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  };
});

// Mock ShellperClient as a class
const mockShellperConnect = vi.fn();
const mockShellperDisconnect = vi.fn();
const mockShellperWrite = vi.fn();
const mockShellperResize = vi.fn();
const mockShellperWaitForReplay = vi.fn();

let lastShellperInstance: EventEmitter | null = null;

vi.mock('../../terminal/shellper-client.js', () => ({
  ShellperClient: class MockShellperClient extends EventEmitter {
    socketPath: string;
    clientType: string;
    connected = true;

    constructor(socketPath: string, clientType: string = 'tower') {
      super();
      this.socketPath = socketPath;
      this.clientType = clientType;
      lastShellperInstance = this;
    }

    connect() { return mockShellperConnect(); }
    disconnect() { mockShellperDisconnect(); }
    write(data: string | Buffer) { mockShellperWrite(data); }
    resize(cols: number, rows: number) { mockShellperResize(cols, rows); }
    waitForReplay(ms?: number) { return mockShellperWaitForReplay(ms); }
    signal() {}
    spawn() {}
    ping() {}
    getReplayData() { return null; }
  },
}));

describe('attach command', () => {
  beforeEach(() => {
    mockBuilders.length = 0;
    mockDbGet.mockReset();
    mockExistsSync.mockReset().mockReturnValue(false);
    mockAccessSync.mockReset();
    mockReaddirSync.mockReset().mockReturnValue([]);
    mockShellperConnect.mockReset().mockResolvedValue({
      pid: 12345, cols: 80, rows: 24, version: 1, startTime: Date.now(),
    });
    mockShellperDisconnect.mockReset();
    mockShellperWrite.mockReset();
    mockShellperResize.mockReset();
    mockShellperWaitForReplay.mockReset().mockResolvedValue(Buffer.alloc(0));
    lastShellperInstance = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('findBuilderByIssue', () => {
    it('should find builder by issue number', async () => {
      mockBuilders.push({
        id: 'bugfix-42',
        name: 'Bugfix #42: Test issue',
        status: 'implementing',
        phase: 'init',
        worktree: '/path/to/.builders/bugfix-42',
        branch: 'builder/bugfix-42-test-issue',
        type: 'bugfix',
        issueNumber: 42,
      });

      const { attach } = await import('../commands/attach.js');
      const { openBrowser } = await import('../utils/shell.js');

      await attach({ issue: 42, browser: true });

      expect(openBrowser).toHaveBeenCalledWith(expect.stringContaining('localhost:4100/workspace/'));
    });

    it('should error when issue not found', async () => {
      const { attach } = await import('../commands/attach.js');
      const { fatal } = await import('../utils/logger.js');

      await expect(attach({ issue: 999 })).rejects.toThrow();
      expect(fatal).toHaveBeenCalledWith(expect.stringContaining('No builder found for issue #999'));
    });
  });

  describe('findBuilderById', () => {
    it('should find builder by exact ID', async () => {
      mockBuilders.push({
        id: '0073',
        name: '0073-feature',
        status: 'implementing',
        phase: 'init',
        worktree: '/path/to/.builders/0073',
        branch: 'builder/0073-feature',
        type: 'spec',
      });

      const { attach } = await import('../commands/attach.js');
      const { openBrowser } = await import('../utils/shell.js');

      await attach({ project: '0073', browser: true });

      expect(openBrowser).toHaveBeenCalledWith(expect.stringContaining('localhost:4100/workspace/'));
    });

    it('should find builder by prefix match', async () => {
      mockBuilders.push({
        id: 'bugfix-173',
        name: 'Bugfix #173: Test',
        status: 'implementing',
        phase: 'init',
        worktree: '/path/to/.builders/bugfix-173',
        branch: 'builder/bugfix-173-test',
        type: 'bugfix',
        issueNumber: 173,
      });

      const { attach } = await import('../commands/attach.js');
      const { openBrowser } = await import('../utils/shell.js');

      await attach({ project: 'bugfix-173', browser: true });

      expect(openBrowser).toHaveBeenCalledWith(expect.stringContaining('localhost:4100/workspace/'));
    });

    it('should error when builder not found', async () => {
      const { attach } = await import('../commands/attach.js');
      const { fatal } = await import('../utils/logger.js');

      await expect(attach({ project: 'nonexistent' })).rejects.toThrow();
      expect(fatal).toHaveBeenCalledWith(expect.stringContaining('Builder "nonexistent" not found'));
    });
  });

  describe('displayBuilderList', () => {
    it('should display list when no args provided', async () => {
      mockBuilders.push({
        id: 'bugfix-42',
        name: 'Bugfix #42: Test',
        status: 'implementing',
        phase: 'init',
        worktree: '/path',
        branch: 'branch',
        type: 'bugfix',
        issueNumber: 42,
      });

      const { attach } = await import('../commands/attach.js');
      const { logger } = await import('../utils/logger.js');

      await attach({});

      expect(logger.header).toHaveBeenCalledWith('Running Builders');
      expect(logger.row).toHaveBeenCalled();
    });

    it('should show helpful message when no builders running', async () => {
      const { attach } = await import('../commands/attach.js');
      const { logger } = await import('../utils/logger.js');

      await attach({});

      expect(logger.info).toHaveBeenCalledWith('No builders running.');
      expect(logger.info).toHaveBeenCalledWith('Spawn a builder with:');
    });
  });

  describe('browser option', () => {
    it('should open browser when --browser flag is set', async () => {
      mockBuilders.push({
        id: '0073',
        name: 'Test',
        status: 'implementing',
        phase: 'init',
        worktree: '/path',
        branch: 'branch',
        type: 'spec',
      });

      const { attach } = await import('../commands/attach.js');
      const { openBrowser } = await import('../utils/shell.js');

      await attach({ project: '0073', browser: true });

      expect(openBrowser).toHaveBeenCalledWith(expect.stringContaining('localhost:4100/workspace/'));
    });
  });

  describe('findShellperSocket', () => {
    it('should return socket path from SQLite when available', async () => {
      const { findShellperSocket } = await import('../commands/attach.js');

      mockDbGet.mockReturnValue({ shellper_socket: '/tmp/shellper-test.sock' });
      mockExistsSync.mockImplementation((p) => p === '/tmp/shellper-test.sock');

      const builder: Builder = {
        id: '0116',
        name: 'test-builder',
        status: 'implementing',
        phase: 'init',
        worktree: '/workspace/.builders/0116',
        branch: 'builder/0116-test',
        type: 'spec',
      };

      const result = findShellperSocket(builder);
      expect(result).toBe('/tmp/shellper-test.sock');
    });

    it('should pass workspace_path and role_id to SQLite query', async () => {
      const { findShellperSocket } = await import('../commands/attach.js');

      mockDbGet.mockReturnValue(undefined);

      const builder: Builder = {
        id: 'spir-118',
        name: 'test',
        status: 'implementing',
        phase: 'init',
        worktree: '/workspace/.builders/spir-118',
        branch: 'builder/spir-118',
        type: 'spec',
      };

      findShellperSocket(builder);

      expect(mockDbGet).toHaveBeenCalledWith('/workspace/.builders/spir-118', 'spir-118');
    });

    it('should return null when no socket found in DB or filesystem', async () => {
      const { findShellperSocket } = await import('../commands/attach.js');

      mockDbGet.mockReturnValue(undefined);
      mockExistsSync.mockReturnValue(false);

      const builder: Builder = {
        id: '0099',
        name: 'test',
        status: 'implementing',
        phase: 'init',
        worktree: '/workspace/.builders/0099',
        branch: 'builder/0099',
        type: 'spec',
      };

      const result = findShellperSocket(builder);
      expect(result).toBeNull();
    });

    it('should skip stale socket paths that no longer exist', async () => {
      const { findShellperSocket } = await import('../commands/attach.js');

      mockDbGet.mockReturnValue({ shellper_socket: '/tmp/stale-shellper.sock' });
      mockExistsSync.mockReturnValue(false);

      const builder: Builder = {
        id: '0099',
        name: 'test',
        status: 'implementing',
        phase: 'init',
        worktree: '/workspace/.builders/0099',
        branch: 'builder/0099',
        type: 'spec',
      };

      const result = findShellperSocket(builder);
      expect(result).toBeNull();
    });
  });

  describe('attachTerminal', () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    });

    afterEach(() => {
      exitSpy.mockRestore();
    });

    it('should create ShellperClient with terminal clientType', async () => {
      const { attachTerminal } = await import('../commands/attach.js');

      const connectPromise = attachTerminal('/tmp/test.sock');
      await new Promise((r) => setTimeout(r, 10));

      expect(lastShellperInstance).toBeTruthy();
      expect((lastShellperInstance as any).clientType).toBe('terminal');

      lastShellperInstance!.emit('exit', { code: 0, signal: null });
      await new Promise((r) => setTimeout(r, 10));
    });

    it('should call connect on the client', async () => {
      const { attachTerminal } = await import('../commands/attach.js');

      const connectPromise = attachTerminal('/tmp/test.sock');
      await new Promise((r) => setTimeout(r, 10));

      expect(mockShellperConnect).toHaveBeenCalled();

      lastShellperInstance!.emit('exit', { code: 0, signal: null });
      await new Promise((r) => setTimeout(r, 10));
    });

    it('should wait for replay data', async () => {
      const { attachTerminal } = await import('../commands/attach.js');

      const connectPromise = attachTerminal('/tmp/test.sock');
      await new Promise((r) => setTimeout(r, 10));

      expect(mockShellperWaitForReplay).toHaveBeenCalledWith(500);

      lastShellperInstance!.emit('exit', { code: 0, signal: null });
      await new Promise((r) => setTimeout(r, 10));
    });

    it('should call disconnect on error', async () => {
      const { attachTerminal } = await import('../commands/attach.js');

      mockShellperConnect.mockRejectedValue(new Error('Connection refused'));

      await expect(attachTerminal('/tmp/bad.sock')).rejects.toThrow('Connection refused');

      expect(mockShellperDisconnect).toHaveBeenCalled();
    });

    it('should exit cleanly on EXIT frame from shellper', async () => {
      const { attachTerminal } = await import('../commands/attach.js');

      const connectPromise = attachTerminal('/tmp/test.sock');
      await new Promise((r) => setTimeout(r, 10));

      lastShellperInstance!.emit('exit', { code: 0, signal: null });
      await new Promise((r) => setTimeout(r, 10));

      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(mockShellperDisconnect).toHaveBeenCalled();
    });
  });

  describe('terminal mode (default, no --browser)', () => {
    it('should error when no shellper socket found', async () => {
      mockBuilders.push({
        id: '0116',
        name: 'test',
        status: 'implementing',
        phase: 'init',
        worktree: '/workspace/.builders/0116',
        branch: 'builder/0116',
        type: 'spec',
      });

      mockDbGet.mockReturnValue(undefined);
      mockExistsSync.mockReturnValue(false);

      const { attach } = await import('../commands/attach.js');
      const { fatal } = await import('../utils/logger.js');

      await expect(attach({ project: '0116' })).rejects.toThrow();
      expect(fatal).toHaveBeenCalledWith(expect.stringContaining('No shellper socket found'));
    });
  });
});
