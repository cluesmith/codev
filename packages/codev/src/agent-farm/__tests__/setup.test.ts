import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  symlinkConfigFiles: vi.fn(),
  syncLocalConfigSnapshot: vi.fn(() => true),
  runPostSpawnHooks: vi.fn(async () => undefined),
  getWorktreeConfig: vi.fn(),
  logger: {
    info: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: mocks.logger,
}));

vi.mock('../utils/index.js', () => ({
  getConfig: () => ({ workspaceRoot: '/workspace' }),
  getWorktreeConfig: (...args: unknown[]) => mocks.getWorktreeConfig(...args),
}));

vi.mock('../lib/builder-lookup.js', () => ({
  findBuilderById: () => ({
    id: 'spir-1216',
    worktree: '/workspace/.builders/spir-1216',
  }),
}));

vi.mock('../commands/spawn-worktree.js', () => ({
  symlinkConfigFiles: (...args: unknown[]) => mocks.symlinkConfigFiles(...args),
  syncLocalConfigSnapshot: (...args: unknown[]) => mocks.syncLocalConfigSnapshot(...args),
  runPostSpawnHooks: (...args: unknown[]) => mocks.runPostSpawnHooks(...args),
}));

import { setup } from '../commands/setup.js';

describe('afx setup worktree configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.syncLocalConfigSnapshot.mockReturnValue(true);
    mocks.getWorktreeConfig.mockReturnValue({
      symlinks: [],
      postSpawn: ['install-deps'],
    });
  });

  it('refreshes the personal config after symlinks and before post-spawn hooks', async () => {
    await setup({ builderId: '1216' });

    expect(mocks.symlinkConfigFiles).toHaveBeenCalledWith(
      { workspaceRoot: '/workspace' },
      '/workspace/.builders/spir-1216',
    );
    expect(mocks.syncLocalConfigSnapshot).toHaveBeenCalledWith(
      { workspaceRoot: '/workspace' },
      '/workspace/.builders/spir-1216',
    );
    expect(mocks.runPostSpawnHooks).toHaveBeenCalledWith(
      '/workspace/.builders/spir-1216',
      ['install-deps'],
    );
    expect(mocks.symlinkConfigFiles.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.syncLocalConfigSnapshot.mock.invocationCallOrder[0]);
    expect(mocks.syncLocalConfigSnapshot.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.runPostSpawnHooks.mock.invocationCallOrder[0]);
  });

  it('reports setup completion when only the personal config was refreshed', async () => {
    mocks.getWorktreeConfig.mockReturnValue({
      symlinks: [],
      postSpawn: [],
    });

    await setup({ builderId: '1216' });

    expect(mocks.logger.success).toHaveBeenCalledWith(
      'Setup complete for spir-1216 (no postSpawn configured)',
    );
    expect(mocks.logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining('Nothing further to do'),
    );
  });
});
