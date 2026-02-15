/**
 * Unit tests for spawn-worktree.ts (Spec 0105 Phase 7)
 *
 * Tests: worktree creation, dependency checking, porch initialization,
 * bugfix collision detection, slugify, resume validation, and session creation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  slugify, DEFAULT_TOWER_PORT, buildWorktreeLaunchScript,
  checkDependencies, createWorktree, checkBugfixCollisions,
  validateResumeWorktree, initPorchInWorktree, type GitHubIssue,
} from '../commands/spawn-worktree.js';

// Mock dependencies
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
    symlinkSync: vi.fn(),
  };
});

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
  fatal: vi.fn((msg: string) => { throw new Error(msg); }),
}));

vi.mock('../utils/shell.js', () => ({
  run: vi.fn(async () => ({ stdout: '', stderr: '' })),
  commandExists: vi.fn(async () => true),
}));

describe('spawn-worktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Constants
  // =========================================================================

  describe('DEFAULT_TOWER_PORT', () => {
    it('exports the tower port constant', () => {
      expect(DEFAULT_TOWER_PORT).toBe(4100);
    });
  });

  // =========================================================================
  // Slugify
  // =========================================================================

  describe('slugify', () => {
    it('converts title to lowercase slug', () => {
      const result = slugify('Login fails when username has spaces');
      expect(result.length).toBeLessThanOrEqual(30);
      expect(result).toMatch(/^login-fails-when-username-has/);
    });

    it('removes special characters', () => {
      const result = slugify("Can't authenticate with OAuth2.0!");
      expect(result.length).toBeLessThanOrEqual(30);
      expect(result).toMatch(/^can-t-authenticate-with-oauth2/);
    });

    it('handles empty string', () => {
      expect(slugify('')).toBe('');
    });

    it('truncates to 30 characters', () => {
      const longTitle = 'This is a very long issue title that exceeds thirty characters';
      expect(slugify(longTitle).length).toBeLessThanOrEqual(30);
    });

    it('collapses multiple hyphens', () => {
      expect(slugify('a---b')).toBe('a-b');
    });

    it('trims leading/trailing hyphens', () => {
      expect(slugify('--hello--')).toBe('hello');
    });
  });

  // =========================================================================
  // Build Worktree Launch Script
  // =========================================================================

  describe('buildWorktreeLaunchScript', () => {
    it('generates script without role', () => {
      const script = buildWorktreeLaunchScript('/tmp/worktree', 'claude', null);
      expect(script).toContain('#!/bin/bash');
      expect(script).toContain('cd "/tmp/worktree"');
      expect(script).toContain('claude');
      expect(script).not.toContain('--append-system-prompt');
    });

    it('generates script with role and port injection', () => {
      const role = { content: 'Tower at {PORT}', source: 'codev' };
      const script = buildWorktreeLaunchScript('/tmp/worktree', 'claude', role);
      expect(script).toContain('--append-system-prompt');
      expect(script).toContain('.builder-role.md');
    });

    it('includes restart loop', () => {
      const script = buildWorktreeLaunchScript('/tmp/worktree', 'claude', null);
      expect(script).toContain('while true');
      expect(script).toContain('Restarting in 2 seconds');
    });
  });

  // =========================================================================
  // Collision Detection (unit-level)
  // =========================================================================

  describe('collision detection', () => {
    it('slugify produces filesystem-safe branch names', () => {
      const issueNumber = 42;
      const slug = slugify('Login fails with special chars!@#');
      const branchName = `builder/bugfix-${issueNumber}-${slug}`;
      expect(branchName).toMatch(/^builder\/bugfix-42-[a-z0-9-]+$/);
    });

    it('bugfix IDs match expected pattern', () => {
      const builderId = `bugfix-${42}`;
      expect(builderId).toBe('bugfix-42');
    });
  });

  // =========================================================================
  // checkDependencies
  // =========================================================================

  describe('checkDependencies', () => {
    it('succeeds when git is available', async () => {
      const { commandExists } = await import('../utils/shell.js');
      vi.mocked(commandExists).mockResolvedValueOnce(true);
      await expect(checkDependencies()).resolves.toBeUndefined();
    });

    it('fatals when git is not found', async () => {
      const { commandExists } = await import('../utils/shell.js');
      vi.mocked(commandExists).mockResolvedValueOnce(false);
      await expect(checkDependencies()).rejects.toThrow('git not found');
    });
  });

  // =========================================================================
  // createWorktree
  // =========================================================================

  describe('createWorktree', () => {
    const config = { workspaceRoot: '/projects/test' } as any;

    it('creates branch and worktree', async () => {
      const { run } = await import('../utils/shell.js');
      vi.mocked(run).mockResolvedValue({ stdout: '', stderr: '' } as any);
      await expect(createWorktree(config, 'my-branch', '/tmp/wt')).resolves.toBeUndefined();
      expect(run).toHaveBeenCalledWith('git branch my-branch', { cwd: '/projects/test' });
      expect(run).toHaveBeenCalledWith('git worktree add "/tmp/wt" my-branch', { cwd: '/projects/test' });
    });

    it('continues if branch already exists', async () => {
      const { run } = await import('../utils/shell.js');
      vi.mocked(run)
        .mockRejectedValueOnce(new Error('branch already exists'))
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any);
      await expect(createWorktree(config, 'my-branch', '/tmp/wt')).resolves.toBeUndefined();
    });

    it('fatals if worktree creation fails', async () => {
      const { run } = await import('../utils/shell.js');
      vi.mocked(run)
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)
        .mockRejectedValueOnce(new Error('worktree add failed'));
      await expect(createWorktree(config, 'my-branch', '/tmp/wt')).rejects.toThrow('Failed to create worktree');
    });
  });

  // =========================================================================
  // checkBugfixCollisions
  // =========================================================================

  describe('checkBugfixCollisions', () => {
    const baseIssue: GitHubIssue = {
      title: 'Test issue',
      body: 'body',
      state: 'OPEN',
      comments: [],
    };

    it('fatals when worktree already exists', async () => {
      const { existsSync } = await import('node:fs');
      vi.mocked(existsSync).mockReturnValueOnce(true);
      await expect(
        checkBugfixCollisions(42, '/tmp/wt', baseIssue, false),
      ).rejects.toThrow('Worktree already exists');
    });

    it('fatals when recent "On it" comment exists and no --force', async () => {
      const { existsSync } = await import('node:fs');
      vi.mocked(existsSync).mockReturnValueOnce(false);
      const issue: GitHubIssue = {
        ...baseIssue,
        comments: [{
          body: 'On it! Working on a fix.',
          createdAt: new Date().toISOString(),
          author: { login: 'builder-bot' },
        }],
      };
      await expect(
        checkBugfixCollisions(42, '/tmp/wt', issue, false),
      ).rejects.toThrow('On it');
    });

    it('warns but continues when "On it" comment exists with --force', async () => {
      const { existsSync } = await import('node:fs');
      vi.mocked(existsSync).mockReturnValueOnce(false);
      const { run } = await import('../utils/shell.js');
      vi.mocked(run).mockResolvedValueOnce({ stdout: '[]', stderr: '' } as any);
      const issue: GitHubIssue = {
        ...baseIssue,
        comments: [{
          body: 'On it!',
          createdAt: new Date().toISOString(),
          author: { login: 'builder-bot' },
        }],
      };
      await expect(
        checkBugfixCollisions(42, '/tmp/wt', issue, true),
      ).resolves.toBeUndefined();
    });

    it('fatals when open PRs reference the issue and no --force', async () => {
      const { existsSync } = await import('node:fs');
      vi.mocked(existsSync).mockReturnValueOnce(false);
      const { run } = await import('../utils/shell.js');
      vi.mocked(run).mockResolvedValueOnce({
        stdout: JSON.stringify([{ number: 99, title: 'Fix #42' }]),
        stderr: '',
      } as any);
      // fatal() in production calls process.exit(), which isn't catchable.
      // Our mock throws, but the PR-check try/catch swallows it.
      // Verify fatal was called with the right message instead.
      const { fatal } = await import('../utils/logger.js');
      await checkBugfixCollisions(42, '/tmp/wt', baseIssue, false);
      expect(fatal).toHaveBeenCalledWith(expect.stringContaining('open PR'));
    });

    it('warns when issue is already closed', async () => {
      const { existsSync } = await import('node:fs');
      vi.mocked(existsSync).mockReturnValueOnce(false);
      const { run } = await import('../utils/shell.js');
      vi.mocked(run).mockResolvedValueOnce({ stdout: '[]', stderr: '' } as any);
      const { logger } = await import('../utils/logger.js');
      const closedIssue: GitHubIssue = { ...baseIssue, state: 'CLOSED' };
      await checkBugfixCollisions(42, '/tmp/wt', closedIssue, false);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('already closed'));
    });
  });

  // =========================================================================
  // validateResumeWorktree
  // =========================================================================

  describe('validateResumeWorktree', () => {
    it('fatals when worktree does not exist', async () => {
      const { existsSync } = await import('node:fs');
      vi.mocked(existsSync).mockReturnValueOnce(false);
      expect(() => validateResumeWorktree('/tmp/missing')).toThrow('worktree does not exist');
    });

    it('fatals when .git file is missing', async () => {
      const { existsSync } = await import('node:fs');
      vi.mocked(existsSync)
        .mockReturnValueOnce(true)  // worktreePath exists
        .mockReturnValueOnce(false); // .git does not
      expect(() => validateResumeWorktree('/tmp/broken')).toThrow('not a valid git worktree');
    });

    it('succeeds when worktree is valid', async () => {
      const { existsSync } = await import('node:fs');
      vi.mocked(existsSync)
        .mockReturnValueOnce(true)  // worktreePath exists
        .mockReturnValueOnce(true); // .git exists
      expect(() => validateResumeWorktree('/tmp/good')).not.toThrow();
    });
  });

  // =========================================================================
  // initPorchInWorktree
  // =========================================================================

  describe('initPorchInWorktree', () => {
    it('runs porch init with sanitized inputs', async () => {
      const { run } = await import('../utils/shell.js');
      vi.mocked(run).mockResolvedValueOnce({ stdout: '', stderr: '' } as any);
      await initPorchInWorktree('/tmp/wt', 'spir', '0105', 'my-feature');
      expect(run).toHaveBeenCalledWith('porch init spir 0105 "my-feature"', { cwd: '/tmp/wt' });
    });

    it('sanitizes special characters from inputs', async () => {
      const { run } = await import('../utils/shell.js');
      vi.mocked(run).mockResolvedValueOnce({ stdout: '', stderr: '' } as any);
      await initPorchInWorktree('/tmp/wt', 'sp!r', '01;05', 'my feature & more');
      expect(run).toHaveBeenCalledWith(
        expect.stringMatching(/^porch init spr 0105 "my-feature---more"$/),
        { cwd: '/tmp/wt' },
      );
    });

    it('warns but does not fatal on failure', async () => {
      const { run } = await import('../utils/shell.js');
      vi.mocked(run).mockRejectedValueOnce(new Error('porch not found'));
      const { logger } = await import('../utils/logger.js');
      await expect(initPorchInWorktree('/tmp/wt', 'spir', '0105', 'feat')).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to initialize porch'));
    });
  });
});
