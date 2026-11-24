/**
 * #1911: when `afx` cannot be started (on Windows, `cli-process.ts` refuses a
 * name that does not resolve on PATH and emits ENOENT), Spawn Builder shows a
 * readable error instead of leaving an unhandled 'error' event.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const vscodeMock = vi.hoisted(() => ({
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
  },
}));
vi.mock('vscode', () => vscodeMock);

const cli = vi.hoisted(() => ({ spawnCodevCli: vi.fn() }));
vi.mock('../cli-process.js', () => cli);

import { spawnBuilder } from '../commands/spawn.js';

function fakeChild(): EventEmitter & { unref: () => void } {
  return Object.assign(new EventEmitter(), { unref: vi.fn() });
}

beforeEach(() => {
  vi.clearAllMocks();
  vscodeMock.window.showQuickPick.mockResolvedValue('pir');
});

describe('Spawn Builder when afx cannot start', () => {
  it('says afx was not found on PATH for ENOENT', async () => {
    const child = fakeChild();
    cli.spawnCodevCli.mockReturnValue(child);
    await spawnBuilder('42', '/ws');
    expect(cli.spawnCodevCli).toHaveBeenCalledWith('afx', ['spawn', '42', '--protocol', 'pir'], { cwd: '/ws', detached: true, stdio: 'ignore' });

    child.emit('error', Object.assign(new Error('spawn afx ENOENT'), { code: 'ENOENT' }));
    expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('afx was not found on PATH'));
  });

  it('shows the error message for any other failure', async () => {
    const child = fakeChild();
    cli.spawnCodevCli.mockReturnValue(child);
    await spawnBuilder('42', '/ws');

    child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
    expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith('Codev: could not run afx: spawn EACCES');
  });
});

/**
 * `afx spawn` resolves its workspace from its cwd. Run in the extension host's
 * own cwd (Tower's, in the Codev IDE) it would spawn into whichever project
 * that is, so it runs in this window's workspace, and refuses without one.
 */
describe('Spawn Builder runs afx in this window\'s workspace', () => {
  it('passes the workspace path as cwd', async () => {
    cli.spawnCodevCli.mockReturnValue(fakeChild());
    await spawnBuilder('42', '/path/to/workspace');
    expect(cli.spawnCodevCli.mock.calls[0][2]).toMatchObject({ cwd: '/path/to/workspace' });
  });

  it('refuses before prompting when the window has no workspace', async () => {
    await spawnBuilder(undefined, null);
    expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith('Codev: Spawn Builder needs a Codev workspace open in this window.');
    expect(vscodeMock.window.showInputBox).not.toHaveBeenCalled();
    expect(cli.spawnCodevCli).not.toHaveBeenCalled();
  });
});
