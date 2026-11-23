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
    await spawnBuilder('42');
    expect(cli.spawnCodevCli).toHaveBeenCalledWith('afx', ['spawn', '42', '--protocol', 'pir'], { detached: true, stdio: 'ignore' });

    child.emit('error', Object.assign(new Error('spawn afx ENOENT'), { code: 'ENOENT' }));
    expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('afx was not found on PATH'));
  });

  it('shows the error message for any other failure', async () => {
    const child = fakeChild();
    cli.spawnCodevCli.mockReturnValue(child);
    await spawnBuilder('42');

    child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
    expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith('Codev: could not run afx: spawn EACCES');
  });
});
