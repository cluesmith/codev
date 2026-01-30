/**
 * Tests for attach command
 *
 * These are unit tests for the attach command logic. Integration tests
 * that attach to actual builders require git and tmux to be running.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Builder } from '../types.js';

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
  isProcessRunning: vi.fn().mockResolvedValue(true),
  openBrowser: vi.fn().mockResolvedValue(undefined),
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

describe('attach command', () => {
  beforeEach(() => {
    mockBuilders.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('findBuilderByIssue', () => {
    it('should find builder by issue number', async () => {
      // Add a bugfix builder
      mockBuilders.push({
        id: 'bugfix-42',
        name: 'Bugfix #42: Test issue',
        port: 4210,
        pid: 12345,
        status: 'implementing',
        phase: 'init',
        worktree: '/path/to/.builders/bugfix-42',
        branch: 'builder/bugfix-42-test-issue',
        tmuxSession: 'builder-project-bugfix-42',
        type: 'bugfix',
        issueNumber: 42,
      });

      // Import after mocks are set up
      const { attach } = await import('../commands/attach.js');
      const { openBrowser } = await import('../utils/shell.js');

      // Attach with --browser to avoid actually attaching to tmux
      await attach({ issue: 42, browser: true });

      expect(openBrowser).toHaveBeenCalledWith('http://localhost:4210');
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
        port: 4211,
        pid: 12346,
        status: 'implementing',
        phase: 'init',
        worktree: '/path/to/.builders/0073',
        branch: 'builder/0073-feature',
        tmuxSession: 'builder-project-0073',
        type: 'spec',
      });

      const { attach } = await import('../commands/attach.js');
      const { openBrowser } = await import('../utils/shell.js');

      await attach({ project: '0073', browser: true });

      expect(openBrowser).toHaveBeenCalledWith('http://localhost:4211');
    });

    it('should find builder by prefix match', async () => {
      mockBuilders.push({
        id: 'bugfix-173',
        name: 'Bugfix #173: Test',
        port: 4212,
        pid: 12347,
        status: 'implementing',
        phase: 'init',
        worktree: '/path/to/.builders/bugfix-173',
        branch: 'builder/bugfix-173-test',
        tmuxSession: 'builder-project-bugfix-173',
        type: 'bugfix',
        issueNumber: 173,
      });

      const { attach } = await import('../commands/attach.js');
      const { openBrowser } = await import('../utils/shell.js');

      // Use partial match
      await attach({ project: 'bugfix-173', browser: true });

      expect(openBrowser).toHaveBeenCalledWith('http://localhost:4212');
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
        port: 4210,
        pid: 12345,
        status: 'implementing',
        phase: 'init',
        worktree: '/path',
        branch: 'branch',
        tmuxSession: 'session',
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
        port: 4211,
        pid: 12346,
        status: 'implementing',
        phase: 'init',
        worktree: '/path',
        branch: 'branch',
        tmuxSession: 'session',
        type: 'spec',
      });

      const { attach } = await import('../commands/attach.js');
      const { openBrowser } = await import('../utils/shell.js');

      await attach({ project: '0073', browser: true });

      expect(openBrowser).toHaveBeenCalledWith('http://localhost:4211');
    });
  });
});
