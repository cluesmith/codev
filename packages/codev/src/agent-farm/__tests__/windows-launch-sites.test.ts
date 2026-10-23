/**
 * Spec 1658 Phase 6: launch sites on native Windows (seam forced to `win32`,
 * Git Bash pinned, Tower client stubbed). Each site is asserted twice: POSIX
 * keeps exactly today's argv, Windows routes through the resolved Git Bash
 * with POSIX-form paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
  fatal: vi.fn((msg: string) => { throw new Error(msg); }),
}));

import { CLAUDE_HARNESS } from '../utils/harness.js';
vi.mock('../utils/config.js', () => ({
  getBuilderHarness: () => CLAUDE_HARNESS,
  getWorktreeConfig: () => ({ symlinks: [], postSpawn: [], devCommand: null, devUrls: [] }),
}));

const createTerminalMock = vi.fn().mockResolvedValue({ id: 'term-test' });
vi.mock('../lib/tower-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tower-client.js')>();
  return { ...actual, getTowerClient: () => ({ createTerminal: createTerminalMock }) };
});

import {
  startBuilderSession,
  startShellSession,
  buildWorktreeLaunchScript,
  builderScriptLaunch,
  buildSessionLaunchLoop,
} from '../commands/spawn-worktree.js';
import { devCommandLaunch } from '../commands/dev.js';
import { setHostPlatformForTests, resetHostPlatformForTests } from '../../lib/platform.js';
import { setGitBashForTests } from '../../lib/shell-launch.js';
import { toMsysPath } from '../../lib/msys-path.js';

const GIT_BASH = {
  path: 'C:\\Program Files\\Git\\bin\\bash.exe',
  root: 'C:\\Program Files\\Git',
  gitVersion: 'git version 2.47.1.windows.1',
  source: 'install' as const,
};

function writtenFile(suffix: string): { path: string; content: string } {
  const call = vi.mocked(writeFileSync).mock.calls.find((c) => typeof c[0] === 'string' && c[0].endsWith(suffix));
  if (call === undefined) {
    throw new Error(`no write to *${suffix}`);
  }
  return { path: call[0] as string, content: call[1] as string };
}

beforeEach(() => {
  vi.clearAllMocks();
  setGitBashForTests(GIT_BASH);
});

afterEach(() => {
  resetHostPlatformForTests();
  setGitBashForTests(null);
});

describe('builder launch script', () => {
  it('POSIX: /bin/bash runs the script; the script is unchanged', async () => {
    setHostPlatformForTests('darwin');
    await startBuilderSession({ workspaceRoot: '/ws' } as any, 'spir-1', '/ws/.builders/spir-1', 'claude', 'PROMPT', 'ROLE', 'codev');
    const script = writtenFile('.builder-start.sh');
    expect(createTerminalMock).toHaveBeenCalledWith(expect.objectContaining({
      command: '/bin/bash',
      args: [script.path],
      cwd: '/ws/.builders/spir-1',
    }));
    expect(script.content.startsWith('#!/bin/bash\ncd "/ws/.builders/spir-1"\nexport CODEV_BUILDER_WORKTREE=')).toBe(true);
    expect(script.content).not.toContain('CLAUDE_CODE_GIT_BASH_PATH');
    expect(script.content).toContain(`"$(cat '${writtenFile('.builder-prompt.txt').path}')"`);
    expect(script.content).not.toContain('randomUUID');
  });

  it('Windows: the resolved Git Bash runs the script by its POSIX path', async () => {
    setHostPlatformForTests('win32');
    const worktree = 'C:\\ws\\.builders\\spir-1';
    await startBuilderSession({ workspaceRoot: 'C:\\ws' } as any, 'spir-1', worktree, 'claude', 'PROMPT', 'ROLE', 'codev');
    const script = writtenFile('.builder-start.sh');
    expect(createTerminalMock).toHaveBeenCalledWith(expect.objectContaining({
      command: GIT_BASH.path,
      args: [toMsysPath(script.path)],
      cwd: worktree,
    }));
    // cd in POSIX form; identity native (Node reads it); Git Bash exported for the harness.
    expect(script.content).toContain('cd "/c/ws/.builders/spir-1"\n');
    expect(script.content).toContain(`export CODEV_BUILDER_WORKTREE='C:\\ws\\.builders\\spir-1'\n`);
    expect(script.content).toContain(`export CLAUDE_CODE_GIT_BASH_PATH='C:\\Program Files\\Git\\bin\\bash.exe'\n`);
    expect(script.content).toContain(`"$(cat '${toMsysPath(writtenFile('.builder-prompt.txt').path)}')"`);
  });

  it('Windows: relaunch ids are minted through Node when Git Bash has no uuid source', async () => {
    setHostPlatformForTests('win32');
    await startBuilderSession({ workspaceRoot: 'C:\\ws' } as any, 'spir-1', 'C:\\ws\\.builders\\spir-1', 'claude', 'PROMPT', null, null);
    const script = writtenFile('.builder-start.sh').content;
    const mint = script.match(/codev_mint_session_id\(\) \{\n([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(mint).toContain('elif [ -r /proc/sys/kernel/random/uuid ]; then');
    expect(mint).toContain(`  else\n    '${toMsysPath(process.execPath)}' -e 'process.stdout.write(require("crypto").randomUUID())'\n  fi`);
  });

  it('the mint fallback is absent unless given, so POSIX loops are byte-identical', () => {
    const base = { sessionId: 'id', pinnedFresh: 'a', unpinnedFresh: 'b', resume: 'c' };
    const loop = buildSessionLaunchLoop(base);
    expect(loop).toContain('    cat /proc/sys/kernel/random/uuid\n  fi\n}');
    expect(buildSessionLaunchLoop({ ...base, mintFallback: 'node -e x' })).toContain('    cat /proc/sys/kernel/random/uuid\n  else\n    node -e x\n  fi\n}');
  });

  it('worktree-mode script gets the same Windows prelude', () => {
    setHostPlatformForTests('win32');
    const script = buildWorktreeLaunchScript('C:\\ws\\.builders\\task-x', 'claude', null, 'C:\\ws');
    expect(script).toContain('cd "/c/ws/.builders/task-x"\n');
    expect(script).toContain('export CLAUDE_CODE_GIT_BASH_PATH=');
  });

  it('builderScriptLaunch: /bin/bash on POSIX, Git Bash with a POSIX path on Windows', () => {
    setHostPlatformForTests('linux');
    expect(builderScriptLaunch('/ws/x/.builder-start.sh')).toEqual({ command: '/bin/bash', args: ['/ws/x/.builder-start.sh'] });
    setHostPlatformForTests('win32');
    expect(builderScriptLaunch('C:\\ws\\x\\.builder-start.sh')).toEqual({ command: GIT_BASH.path, args: ['/c/ws/x/.builder-start.sh'] });
  });
});

describe('shell session (afx spawn --shell)', () => {
  it('POSIX: /bin/bash -c <command>', async () => {
    setHostPlatformForTests('darwin');
    await startShellSession({ workspaceRoot: '/ws' } as any, 'abc', 'claude --x');
    expect(createTerminalMock).toHaveBeenCalledWith(expect.objectContaining({ command: '/bin/bash', args: ['-c', 'claude --x'] }));
  });

  it('Windows: Git Bash -c <command>', async () => {
    setHostPlatformForTests('win32');
    await startShellSession({ workspaceRoot: 'C:\\ws' } as any, 'abc', 'claude --x');
    expect(createTerminalMock).toHaveBeenCalledWith(expect.objectContaining({ command: GIT_BASH.path, args: ['-c', 'claude --x'] }));
  });
});

describe('afx dev', () => {
  it('POSIX: /bin/sh -lc <devCommand>', () => {
    setHostPlatformForTests('linux');
    expect(devCommandLaunch('pnpm dev')).toEqual({ command: '/bin/sh', args: ['-lc', 'pnpm dev'] });
  });

  it('Windows: Git Bash -c <devCommand>, no login profile', () => {
    setHostPlatformForTests('win32');
    expect(devCommandLaunch('pnpm dev')).toEqual({ command: GIT_BASH.path, args: ['-c', 'pnpm dev'] });
  });
});
