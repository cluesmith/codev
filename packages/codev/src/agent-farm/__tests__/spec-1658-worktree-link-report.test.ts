/**
 * Spec 1658 Phase 7: spawn reports how each worktree link was made. A copy
 * (native Windows with neither a symlink nor a hard link available) is a
 * warning, since edits in the worktree do not reach the workspace root.
 */
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(), mkdirSync: vi.fn() };
});

const createWorktreeLink = vi.fn();
vi.mock('../lib/worktree-links.js', () => ({
  createWorktreeLink: (...args: unknown[]) => createWorktreeLink(...args),
}));

vi.mock('../utils/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/config.js')>()),
  getWorktreeConfig: () => ({ symlinks: [], postSpawn: [], devCommand: null, devUrls: [] }),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
  fatal: vi.fn((msg: string) => {
    throw new Error(msg);
  }),
}));

import { existsSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import { symlinkConfigFiles } from '../commands/spawn-worktree.js';

// Host-shaped paths: the product resolves with path.resolve, which gives a drive-letter path on
// Windows. Neither path exists on disk; existsSync and createWorktreeLink are mocked.
const workspaceRoot = path.resolve('/projects/test');
const worktree = path.resolve('/worktrees/wt');
const config = { workspaceRoot } as Parameters<typeof symlinkConfigFiles>[0];

describe('symlinkConfigFiles reports each link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Root .env and .codev/config.json exist; nothing yet in the worktree.
    vi.mocked(existsSync).mockImplementation((p) => !String(p).startsWith(worktree));
  });

  it('warns on a copy and logs a link as linked', () => {
    createWorktreeLink.mockReturnValueOnce('copy').mockReturnValueOnce('junction');
    symlinkConfigFiles(config, worktree);

    expect(createWorktreeLink).toHaveBeenCalledWith(
      path.join(workspaceRoot, '.env'), path.join(worktree, '.env'), 'file'
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Copied .env from workspace root'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('edits will not write through'));
    expect(logger.info).toHaveBeenCalledWith('Linked .codev/config.json from workspace root');
  });
});
