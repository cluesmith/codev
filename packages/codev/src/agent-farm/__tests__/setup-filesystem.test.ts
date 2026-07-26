import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({
  workspaceRoot: '',
  worktreeRoot: '',
  snapshotObservedByHook: '',
  runStreaming: vi.fn(async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    state.snapshotObservedByHook = fs.readFileSync(
      path.join(state.worktreeRoot, '.codev', 'config.local.json'),
      'utf8',
    );
  }),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
  fatal: vi.fn((message: string) => {
    throw new Error(message);
  }),
}));

vi.mock('../utils/index.js', () => ({
  getConfig: () => ({ workspaceRoot: state.workspaceRoot }),
  getWorktreeConfig: () => ({
    symlinks: [],
    postSpawn: ['verify-snapshot'],
  }),
}));

vi.mock('../utils/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/config.js')>();
  return {
    ...actual,
    getWorktreeConfig: () => ({
      symlinks: [],
      postSpawn: [],
      devCommand: null,
      devUrls: [],
    }),
  };
});

vi.mock('../utils/shell.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/shell.js')>();
  return {
    ...actual,
    runStreaming: (...args: unknown[]) => state.runStreaming(...args),
  };
});

vi.mock('../lib/builder-lookup.js', () => ({
  findBuilderById: () => ({
    id: 'spir-1216',
    worktree: state.worktreeRoot,
  }),
}));

import { setup } from '../commands/setup.js';

describe('afx setup personal config filesystem flow', () => {
  let fixtureRoot: string;
  let sourcePath: string;
  let targetPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    state.snapshotObservedByHook = '';
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-setup-local-config-'));
    state.workspaceRoot = path.join(fixtureRoot, 'workspace');
    state.worktreeRoot = path.join(fixtureRoot, 'worktree');
    sourcePath = path.join(state.workspaceRoot, '.codev', 'config.local.json');
    targetPath = path.join(state.worktreeRoot, '.codev', 'config.local.json');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(state.worktreeRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('refreshes the on-disk snapshot before running post-spawn hooks', async () => {
    fs.writeFileSync(sourcePath, '{"porch":{"autoOpenArtifacts":false}}');

    await setup({ builderId: '1216' });

    expect(state.snapshotObservedByHook).toBe(fs.readFileSync(sourcePath, 'utf8'));
    expect(fs.readFileSync(targetPath, 'utf8')).toBe(fs.readFileSync(sourcePath, 'utf8'));

    fs.writeFileSync(sourcePath, '{"porch":{"autoOpenArtifacts":true}}');
    fs.writeFileSync(targetPath, '{"builderOnly":true}');

    await setup({ builderId: '1216' });

    expect(state.snapshotObservedByHook).toBe(fs.readFileSync(sourcePath, 'utf8'));
    expect(fs.readFileSync(targetPath, 'utf8')).toBe(fs.readFileSync(sourcePath, 'utf8'));
  });
});
