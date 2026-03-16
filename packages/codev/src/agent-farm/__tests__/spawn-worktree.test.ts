/**
 * Unit tests for spawn-worktree.ts (Spec 0105 Phase 7)
 *
 * Tests: worktree creation, dependency checking, porch initialization,
 * bugfix collision detection, slugify, resume validation, and session creation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  slugify, buildWorktreeLaunchScript,
  checkDependencies, createWorktree, createWorktreeFromBranch,
  validateBranchName, validateRemoteName, detectForkRemote,
  symlinkConfigFiles,
  checkBugfixCollisions,
  findExistingBugfixWorktree,
  validateResumeWorktree, initPorchInWorktree, type GitHubIssue,
} from '../commands/spawn-worktree.js';
import { DEFAULT_TOWER_PORT } from '../lib/tower-client.js';

// Mock dependencies
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
    symlinkSync: vi.fn(),
    readdirSync: vi.fn(() => []),
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

const executeForgeCommandMock = vi.fn().mockResolvedValue(null);
vi.mock('../../lib/forge.js', () => ({
  executeForgeCommand: (...args: unknown[]) => executeForgeCommandMock(...args),
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
  // findExistingBugfixWorktree (Bugfix #316)
  // =========================================================================

  describe('findExistingBugfixWorktree', () => {
    it('returns matching directory when issue number matches', async () => {
      const { readdirSync } = await import('node:fs');
      vi.mocked(readdirSync).mockReturnValueOnce([
        { name: 'bugfix-315-gate-notification-indicator-mi', isDirectory: () => true },
        { name: 'bugfix-316-af-spawn-issue-resume-fails', isDirectory: () => true },
        { name: 'spir-42-some-feature', isDirectory: () => true },
      ] as any);
      expect(findExistingBugfixWorktree('/builders', 316)).toBe('bugfix-316-af-spawn-issue-resume-fails');
    });

    it('returns null when no matching directory exists', async () => {
      const { readdirSync } = await import('node:fs');
      vi.mocked(readdirSync).mockReturnValueOnce([
        { name: 'bugfix-315-some-other-issue', isDirectory: () => true },
        { name: 'spir-42-some-feature', isDirectory: () => true },
      ] as any);
      expect(findExistingBugfixWorktree('/builders', 316)).toBeNull();
    });

    it('returns null when builders directory does not exist', async () => {
      const { readdirSync } = await import('node:fs');
      vi.mocked(readdirSync).mockImplementationOnce(() => { throw new Error('ENOENT'); });
      expect(findExistingBugfixWorktree('/nonexistent', 316)).toBeNull();
    });

    it('ignores files that are not directories', async () => {
      const { readdirSync } = await import('node:fs');
      vi.mocked(readdirSync).mockReturnValueOnce([
        { name: 'bugfix-316-some-file.txt', isDirectory: () => false },
      ] as any);
      expect(findExistingBugfixWorktree('/builders', 316)).toBeNull();
    });

    it('does not match issue 31 when looking for issue 316', async () => {
      const { readdirSync } = await import('node:fs');
      vi.mocked(readdirSync).mockReturnValueOnce([
        { name: 'bugfix-31-some-issue', isDirectory: () => true },
      ] as any);
      expect(findExistingBugfixWorktree('/builders', 316)).toBeNull();
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
      executeForgeCommandMock.mockResolvedValueOnce([]); // pr-search returns empty
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
      executeForgeCommandMock.mockResolvedValueOnce([{ number: 99, headRefName: 'fix-42' }]);
      const { fatal } = await import('../utils/logger.js');
      await checkBugfixCollisions(42, '/tmp/wt', baseIssue, false);
      expect(fatal).toHaveBeenCalledWith(expect.stringContaining('open PR'));
      expect(executeForgeCommandMock).toHaveBeenCalledWith(
        'pr-search',
        expect.objectContaining({ CODEV_SEARCH_QUERY: expect.stringContaining('#42') }),
        expect.any(Object),
      );
    });

    it('warns when issue is already closed', async () => {
      const { existsSync } = await import('node:fs');
      vi.mocked(existsSync).mockReturnValueOnce(false);
      executeForgeCommandMock.mockResolvedValueOnce([]); // pr-search returns empty
      const { logger } = await import('../utils/logger.js');
      const closedIssue: GitHubIssue = { ...baseIssue, state: 'CLOSED' };
      await checkBugfixCollisions(42, '/tmp/wt', closedIssue, false);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('already closed'));
    });

    it('skips PR collision check when pr-search concept returns null', async () => {
      const { existsSync } = await import('node:fs');
      vi.mocked(existsSync).mockReturnValueOnce(false);
      executeForgeCommandMock.mockResolvedValueOnce(null); // concept unavailable
      // Should not fatal — just skips the PR check
      await expect(
        checkBugfixCollisions(42, '/tmp/wt', baseIssue, false),
      ).resolves.toBeUndefined();
    });

    it('skips collision check gracefully when issue has no comments array', async () => {
      const { existsSync } = await import('node:fs');
      vi.mocked(existsSync).mockReturnValueOnce(false);
      executeForgeCommandMock.mockResolvedValueOnce([]); // pr-search returns empty
      const noCommentsIssue = { title: 'Test', body: 'body', state: 'OPEN' } as GitHubIssue;
      await expect(
        checkBugfixCollisions(42, '/tmp/wt', noCommentsIssue, false),
      ).resolves.toBeUndefined();
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

  // =========================================================================
  // validateBranchName (Spec 609)
  // =========================================================================

  describe('validateBranchName', () => {
    it('accepts valid branch names', () => {
      expect(() => validateBranchName('main')).not.toThrow();
      expect(() => validateBranchName('builder/bugfix-603-slug')).not.toThrow();
      expect(() => validateBranchName('feature/my-feature')).not.toThrow();
      expect(() => validateBranchName('release/v1.2.3')).not.toThrow();
      expect(() => validateBranchName('my_branch.name')).not.toThrow();
    });

    it('rejects empty branch name', () => {
      expect(() => validateBranchName('')).toThrow('--branch requires a branch name');
    });

    it('rejects branch names with shell metacharacters', () => {
      expect(() => validateBranchName('foo;rm -rf /')).toThrow('Invalid branch name');
      expect(() => validateBranchName('foo$(whoami)')).toThrow('Invalid branch name');
      expect(() => validateBranchName('foo`whoami`')).toThrow('Invalid branch name');
      expect(() => validateBranchName('foo & bar')).toThrow('Invalid branch name');
      expect(() => validateBranchName('foo | bar')).toThrow('Invalid branch name');
    });

    it('rejects branch names with spaces', () => {
      expect(() => validateBranchName('my branch')).toThrow('Invalid branch name');
    });
  });

  // =========================================================================
  // createWorktreeFromBranch (Spec 609)
  // =========================================================================

  describe('createWorktreeFromBranch', () => {
    const config = { workspaceRoot: '/projects/test' } as any;

    it('fetches, verifies remote branch, and creates worktree', async () => {
      const { run } = await import('../utils/shell.js');
      vi.mocked(run)
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)         // git fetch origin
        .mockResolvedValueOnce({ stdout: 'abc123\trefs/heads/my-branch', stderr: '' } as any) // git ls-remote
        .mockResolvedValueOnce({ stdout: 'worktree /projects/test\nbranch refs/heads/main\n', stderr: '' } as any) // git worktree list
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any);        // git worktree add
      await expect(createWorktreeFromBranch(config, 'my-branch', '/tmp/wt')).resolves.toBeUndefined();
      expect(run).toHaveBeenCalledWith('git fetch "origin"', { cwd: '/projects/test' });
      expect(run).toHaveBeenCalledWith('git ls-remote --heads "origin" "my-branch"', { cwd: '/projects/test' });
      expect(run).toHaveBeenCalledWith(
        'git worktree add "/tmp/wt" -b "my-branch" "origin/my-branch"',
        { cwd: '/projects/test' },
      );
    });

    it('fatals when branch does not exist on remote', async () => {
      const { run } = await import('../utils/shell.js');
      vi.mocked(run)
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)  // git fetch origin
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any); // git ls-remote (empty = not found)
      await expect(createWorktreeFromBranch(config, 'nonexistent', '/tmp/wt'))
        .rejects.toThrow("Branch 'nonexistent' does not exist on the remote");
    });

    it('fatals when branch is already checked out in another worktree', async () => {
      const { run } = await import('../utils/shell.js');
      vi.mocked(run)
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)  // git fetch origin
        .mockResolvedValueOnce({ stdout: 'abc123\trefs/heads/my-branch', stderr: '' } as any) // git ls-remote
        .mockResolvedValueOnce({
          stdout: 'worktree /projects/test\nbranch refs/heads/main\n\nworktree /other/wt\nbranch refs/heads/my-branch\n',
          stderr: '',
        } as any); // git worktree list
      await expect(createWorktreeFromBranch(config, 'my-branch', '/tmp/wt'))
        .rejects.toThrow("Branch 'my-branch' is already checked out at '/other/wt'");
    });

    it('falls back to using existing local branch when -b fails', async () => {
      const { run } = await import('../utils/shell.js');
      vi.mocked(run)
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)         // git fetch origin
        .mockResolvedValueOnce({ stdout: 'abc123\trefs/heads/my-branch', stderr: '' } as any) // git ls-remote
        .mockResolvedValueOnce({ stdout: 'worktree /projects/test\nbranch refs/heads/main\n', stderr: '' } as any) // git worktree list
        .mockRejectedValueOnce(new Error('branch already exists'))         // git worktree add -b (fails)
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any);        // git worktree add (fallback)
      await expect(createWorktreeFromBranch(config, 'my-branch', '/tmp/wt')).resolves.toBeUndefined();
      expect(run).toHaveBeenCalledWith(
        'git worktree add "/tmp/wt" "my-branch"',
        { cwd: '/projects/test' },
      );
    });

    it('rejects invalid branch names before any git operations', async () => {
      const { run } = await import('../utils/shell.js');
      await expect(createWorktreeFromBranch(config, 'foo;rm -rf /', '/tmp/wt'))
        .rejects.toThrow('Invalid branch name');
      expect(run).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // validateRemoteName (Bugfix #615)
  // =========================================================================

  describe('validateRemoteName', () => {
    it('accepts valid remote names', () => {
      expect(() => validateRemoteName('origin')).not.toThrow();
      expect(() => validateRemoteName('upstream')).not.toThrow();
      expect(() => validateRemoteName('nharward')).not.toThrow();
      expect(() => validateRemoteName('my-fork')).not.toThrow();
    });

    it('rejects empty remote name', () => {
      expect(() => validateRemoteName('')).toThrow('--remote requires a remote name');
    });

    it('rejects remote names with shell metacharacters', () => {
      expect(() => validateRemoteName('foo;rm -rf /')).toThrow('Invalid remote name');
      expect(() => validateRemoteName('foo$(whoami)')).toThrow('Invalid remote name');
    });
  });

  // =========================================================================
  // detectForkRemote (Bugfix #615)
  // =========================================================================

  describe('detectForkRemote', () => {
    const config = { workspaceRoot: '/projects/test' } as any;

    it('returns fork owner and URL when a fork PR is found', async () => {
      const { run } = await import('../utils/shell.js');
      vi.mocked(run).mockResolvedValueOnce({
        stdout: JSON.stringify([{
          number: 604,
          headRepositoryOwner: { login: 'nharward' },
          headRepository: { name: 'codev' },
          isCrossRepository: true,
        }]),
        stderr: '',
      } as any);

      const result = await detectForkRemote(config, 'feature-branch');
      expect(result).toEqual({
        owner: 'nharward',
        url: 'https://github.com/nharward/codev.git',
      });
    });

    it('returns null when no PRs are found', async () => {
      const { run } = await import('../utils/shell.js');
      vi.mocked(run).mockResolvedValueOnce({ stdout: '[]', stderr: '' } as any);

      const result = await detectForkRemote(config, 'feature-branch');
      expect(result).toBeNull();
    });

    it('returns null when PRs exist but none are cross-repository', async () => {
      const { run } = await import('../utils/shell.js');
      vi.mocked(run).mockResolvedValueOnce({
        stdout: JSON.stringify([{
          number: 604,
          headRepositoryOwner: { login: 'owner' },
          headRepository: { name: 'codev' },
          isCrossRepository: false,
        }]),
        stderr: '',
      } as any);

      const result = await detectForkRemote(config, 'feature-branch');
      expect(result).toBeNull();
    });

    it('returns null when gh command fails', async () => {
      const { run } = await import('../utils/shell.js');
      vi.mocked(run).mockRejectedValueOnce(new Error('gh not found'));

      const result = await detectForkRemote(config, 'feature-branch');
      expect(result).toBeNull();
    });

    it('fatals when multiple fork PRs share the same branch name', async () => {
      const { run } = await import('../utils/shell.js');
      vi.mocked(run).mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 604,
            headRepositoryOwner: { login: 'nharward' },
            headRepository: { name: 'codev' },
            isCrossRepository: true,
          },
          {
            number: 610,
            headRepositoryOwner: { login: 'otherfork' },
            headRepository: { name: 'codev' },
            isCrossRepository: true,
          },
        ]),
        stderr: '',
      } as any);

      await expect(detectForkRemote(config, 'feature-branch'))
        .rejects.toThrow('Multiple fork PRs found');
    });
  });

  // =========================================================================
  // createWorktreeFromBranch with --remote and fork detection (Bugfix #615)
  // =========================================================================

  describe('createWorktreeFromBranch (fork support)', () => {
    const config = { workspaceRoot: '/projects/test' } as any;

    it('uses explicit --remote instead of origin', async () => {
      const { run } = await import('../utils/shell.js');
      vi.mocked(run)
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)         // git fetch "nharward"
        .mockResolvedValueOnce({ stdout: 'abc123\trefs/heads/my-branch', stderr: '' } as any) // git ls-remote nharward
        .mockResolvedValueOnce({ stdout: 'worktree /projects/test\nbranch refs/heads/main\n', stderr: '' } as any) // git worktree list
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any);        // git worktree add

      await expect(createWorktreeFromBranch(config, 'my-branch', '/tmp/wt', { remote: 'nharward' }))
        .resolves.toBeUndefined();

      expect(run).toHaveBeenCalledWith('git fetch "nharward"', { cwd: '/projects/test' });
      expect(run).toHaveBeenCalledWith('git ls-remote --heads "nharward" "my-branch"', { cwd: '/projects/test' });
      expect(run).toHaveBeenCalledWith(
        'git worktree add "/tmp/wt" -b "my-branch" "nharward/my-branch"',
        { cwd: '/projects/test' },
      );
    });

    it('auto-detects fork when branch not found on origin', async () => {
      const { run } = await import('../utils/shell.js');
      vi.mocked(run)
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)         // git fetch "origin"
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)         // git ls-remote origin (not found)
        // Fork detection: gh pr list
        .mockResolvedValueOnce({
          stdout: JSON.stringify([{
            number: 604,
            headRepositoryOwner: { login: 'nharward' },
            headRepository: { name: 'codev' },
            isCrossRepository: true,
          }]),
          stderr: '',
        } as any)
        // ensureRemote: git remote get-url fails (remote doesn't exist)
        .mockRejectedValueOnce(new Error('No such remote'))
        // ensureRemote: git remote add
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)
        // git fetch fork
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)
        // git ls-remote fork (found)
        .mockResolvedValueOnce({ stdout: 'abc123\trefs/heads/my-branch', stderr: '' } as any)
        // git worktree list
        .mockResolvedValueOnce({ stdout: 'worktree /projects/test\nbranch refs/heads/main\n', stderr: '' } as any)
        // git worktree add
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any);

      await expect(createWorktreeFromBranch(config, 'my-branch', '/tmp/wt'))
        .resolves.toBeUndefined();

      // Verify fork remote was added and used
      expect(run).toHaveBeenCalledWith('git remote add "nharward" "https://github.com/nharward/codev.git"', { cwd: '/projects/test' });
      expect(run).toHaveBeenCalledWith('git fetch "nharward" "my-branch"', { cwd: '/projects/test' });
      expect(run).toHaveBeenCalledWith(
        'git worktree add "/tmp/wt" -b "my-branch" "nharward/my-branch"',
        { cwd: '/projects/test' },
      );
    });

    it('fatals with helpful message when branch not found anywhere', async () => {
      const { run } = await import('../utils/shell.js');
      vi.mocked(run)
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)  // git fetch origin
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)  // git ls-remote (not found)
        .mockResolvedValueOnce({ stdout: '[]', stderr: '' } as any); // gh pr list (no fork PRs)

      await expect(createWorktreeFromBranch(config, 'nonexistent', '/tmp/wt'))
        .rejects.toThrow('does not exist on the remote');
    });

    it('fatals with remote name in message when explicit --remote fails', async () => {
      const { run } = await import('../utils/shell.js');
      vi.mocked(run)
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)  // git fetch nharward
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any); // git ls-remote (not found)

      await expect(createWorktreeFromBranch(config, 'nonexistent', '/tmp/wt', { remote: 'nharward' }))
        .rejects.toThrow("does not exist on remote 'nharward'");
    });

    it('fatals when existing remote has mismatched URL during fork detection', async () => {
      const { run } = await import('../utils/shell.js');
      vi.mocked(run)
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)         // git fetch "origin"
        .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)         // git ls-remote origin (not found)
        // Fork detection: gh pr list
        .mockResolvedValueOnce({
          stdout: JSON.stringify([{
            number: 604,
            headRepositoryOwner: { login: 'nharward' },
            headRepository: { name: 'codev' },
            isCrossRepository: true,
          }]),
          stderr: '',
        } as any)
        // ensureRemote: git remote get-url succeeds with WRONG URL
        .mockResolvedValueOnce({ stdout: 'https://github.com/other/repo.git', stderr: '' } as any);

      await expect(createWorktreeFromBranch(config, 'my-branch', '/tmp/wt'))
        .rejects.toThrow("Remote 'nharward' already exists but points to");
    });

    it('rejects invalid remote names', () => {
      expect(() => validateRemoteName('foo;rm -rf /')).toThrow('Invalid remote name');
    });
  });

  // =========================================================================
  // symlinkConfigFiles (Spec 609 — extracted helper)
  // =========================================================================

  describe('symlinkConfigFiles', () => {
    const config = { workspaceRoot: '/projects/test' } as any;

    it('symlinks .env and af-config.json when they exist at root', async () => {
      const { existsSync, symlinkSync } = await import('node:fs');
      vi.mocked(existsSync)
        .mockReturnValueOnce(true)   // .env exists at root
        .mockReturnValueOnce(false)  // .env not in worktree
        .mockReturnValueOnce(true)   // af-config.json exists at root
        .mockReturnValueOnce(false); // af-config.json not in worktree
      symlinkConfigFiles(config, '/tmp/wt');
      expect(symlinkSync).toHaveBeenCalledTimes(2);
    });

    it('skips symlink when file already exists in worktree', async () => {
      const { existsSync, symlinkSync } = await import('node:fs');
      vi.mocked(existsSync)
        .mockReturnValueOnce(true)  // .env exists at root
        .mockReturnValueOnce(true)  // .env already in worktree
        .mockReturnValueOnce(true)  // af-config.json exists at root
        .mockReturnValueOnce(true); // af-config.json already in worktree
      symlinkConfigFiles(config, '/tmp/wt');
      expect(symlinkSync).not.toHaveBeenCalled();
    });
  });
});
