/**
 * Tests for spawn resolver fallback (Spec 620, Phase 2)
 *
 * When spawnSpec() finds no local spec file, it should try the artifact
 * resolver before falling back to a fatal GitHub issue fetch.
 * This enables af spawn N --protocol aspir when specs exist only in a
 * CLI artifact backend.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the artifact resolver
const findSpecBaseNameMock = vi.fn();
vi.mock('../../commands/porch/artifacts.js', () => ({
  getResolver: vi.fn(() => ({ findSpecBaseName: findSpecBaseNameMock })),
}));

// Mock spawn-roles helpers
vi.mock('../commands/spawn-roles.js', () => ({
  findSpecFile: vi.fn(async () => null), // no local spec by default
  validateProtocol: vi.fn(),
  loadProtocol: vi.fn(() => ({ input: { required: false } })),
  resolveMode: vi.fn(() => 'strict'),
  buildPromptFromTemplate: vi.fn(() => 'prompt'),
  buildResumeNotice: vi.fn(() => ''),
  loadProtocolRole: vi.fn(() => null),
}));

vi.mock('../utils/index.js', () => ({
  getConfig: vi.fn(() => ({
    workspaceRoot: '/repo',
    codevDir: '/repo/codev',
    buildersDir: '/repo/.builders',
  })),
  ensureDirectories: vi.fn(),
  getResolvedCommands: vi.fn(() => ({ builder: 'claude' })),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), kv: vi.fn(), header: vi.fn(), blank: vi.fn(), success: vi.fn() },
  fatal: vi.fn((msg: string) => { throw new Error(msg); }),
}));

vi.mock('../utils/shell.js', () => ({
  run: vi.fn(async () => ({ stdout: '', stderr: '' })),
}));

vi.mock('../state.js', () => ({ upsertBuilder: vi.fn() }));

vi.mock('../utils/roles.js', () => ({ loadRolePrompt: vi.fn(() => null) }));

vi.mock('../utils/agent-names.js', () => ({
  buildAgentName: vi.fn(() => 'builder-620'),
  stripLeadingZeros: vi.fn((s: string) => s.replace(/^0+/, '') || '0'),
}));

vi.mock('../../lib/github.js', () => ({
  fetchIssue: vi.fn(async () => null),
}));

vi.mock('../../lib/forge.js', () => ({
  loadForgeConfig: vi.fn(() => null),
}));

vi.mock('../commands/spawn-worktree.js', () => ({
  checkDependencies: vi.fn(),
  createWorktree: vi.fn(),
  initPorchInWorktree: vi.fn(),
  validateResumeWorktree: vi.fn(),
  startBuilderSession: vi.fn(async () => ({ terminalId: 'tid-123' })),
  slugify: vi.fn((t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)),
  fetchGitHubIssue: vi.fn(async () => { throw new Error('GitHub fetch should not be called'); }),
}));

vi.mock('../lib/tower-client.js', () => ({
  getTowerClient: vi.fn(() => ({ getTerminalWsUrl: vi.fn(() => 'ws://localhost') })),
}));

describe('spawnSpec resolver fallback (Spec 620)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses resolver spec name when no local spec file exists', async () => {
    findSpecBaseNameMock.mockReturnValue('620-my-feature-spec');

    const { spawn } = await import('../commands/spawn.js');
    const { startBuilderSession } = await import('../commands/spawn-worktree.js');
    const { fetchGitHubIssue } = await import('../commands/spawn-worktree.js');

    await spawn({ issueNumber: 620, protocol: 'aspir' });

    // Should NOT have fallen through to fatal GitHub fetch
    expect(fetchGitHubIssue).not.toHaveBeenCalled();
    // Should have started a builder session (spawn succeeded)
    expect(startBuilderSession).toHaveBeenCalled();
  });

  it('falls through to GitHub fetch when resolver returns null', async () => {
    findSpecBaseNameMock.mockReturnValue(null);

    const { spawn } = await import('../commands/spawn.js');
    const { fetchGitHubIssue } = await import('../commands/spawn-worktree.js');
    // Override fetchGitHubIssue to succeed for this test
    vi.mocked(fetchGitHubIssue).mockResolvedValueOnce({ title: 'my issue', body: '', state: 'OPEN', comments: [] });

    await spawn({ issueNumber: 620, protocol: 'aspir' });

    // Should have fallen through to GitHub fetch since resolver returned null
    expect(fetchGitHubIssue).toHaveBeenCalledWith(620, expect.any(Object));
  });

  it('falls through to GitHub fetch when resolver throws', async () => {
    findSpecBaseNameMock.mockImplementation(() => { throw new Error('resolver error'); });

    const { spawn } = await import('../commands/spawn.js');
    const { fetchGitHubIssue } = await import('../commands/spawn-worktree.js');
    vi.mocked(fetchGitHubIssue).mockResolvedValueOnce({ title: 'my issue', body: '', state: 'OPEN', comments: [] });

    await spawn({ issueNumber: 620, protocol: 'aspir' });

    // Non-fatal resolver error — should fall through to GitHub fetch
    expect(fetchGitHubIssue).toHaveBeenCalledWith(620, expect.any(Object));
  });
});
