/**
 * The new CLI against a Tower from before Spec 1940: the state every user is in right
 * after upgrading, until Tower is restarted.
 *
 * The commands run for real, through the real SDK client, against a transport that
 * answers as that Tower does: healthy, and its catch-all `404 Not found` (plain text) for
 * the two routes it does not have. Each must say what that means and how to fix it, not
 * print `Not found`. (`afx whoami` meets the same Tower through its database:
 * `spec-1134-whoami.test.ts`.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TowerClient } from '@cluesmith/codev-sdk/tower-client';

const { transport, mockLogger } = vi.hoisted(() => ({
  transport: { fetchFn: undefined as unknown as typeof fetch },
  mockLogger: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../lib/tower-client.js', () => ({
  getTowerClient: () => new TowerClient({ fetchFn: transport.fetchFn }),
}));
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../commands/send.js', () => ({
  detectWorkspaceRoot: () => '/home/ana/work/codev',
  detectCurrentBuilderId: () => null,
  architectSenderId: () => 'architect:review',
}));

import { workspaceList } from '../commands/workspace-list.js';
import { workspaceName } from '../commands/workspace-name.js';

function answer(status: number, contentType: string, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': contentType } });
}

/** A Tower from before the address book and workspace names. */
const olderTower = (async (input: Parameters<typeof fetch>[0]) => {
  const { pathname } = new URL(String(input));
  if (pathname === '/health') return answer(200, 'application/json', JSON.stringify({ status: 'healthy' }));
  return answer(404, 'text/plain', 'Not found');
}) as typeof fetch;

/** A Tower of this version that has no row for the workspace: a 404 of the route's own. */
const towerWithoutTheWorkspace = (async (input: Parameters<typeof fetch>[0]) => {
  const { pathname } = new URL(String(input));
  if (pathname === '/health') return answer(200, 'application/json', JSON.stringify({ status: 'healthy' }));
  return answer(
    404,
    'application/json',
    JSON.stringify({ error: 'NOT_FOUND', message: 'Workspace /home/ana/work/codev is not registered with Tower.' }),
  );
}) as typeof fetch;

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const RESTART = 'afx tower stop && afx tower start';

describe('Spec 1940: the new CLI against a Tower from before it', () => {
  let stdout: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    transport.fetchFn = olderTower;
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Exit(code ?? 0);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('afx workspace list says the Tower is older and has no address book, with the restart commands', async () => {
    await expect(workspaceList()).rejects.toMatchObject({ code: 1 });

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      `The running Tower is older than this CLI: it has no address book. Restart Tower to pick up the new version: ${RESTART}`,
    );
    expect(stdout).toEqual([]);
  });

  it('afx workspace list --json says the same, and prints nothing a reader would take for a listing', async () => {
    await expect(workspaceList({ json: true })).rejects.toMatchObject({ code: 1 });

    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining(RESTART));
    expect(stdout).toEqual([]);
  });

  it.each([
    ['afx workspace name <name>', { name: 'work' }],
    ['afx workspace name --clear', { clear: true }],
  ])('%s says the Tower is older and cannot name a workspace, with the restart commands', async (_command, options) => {
    await expect(workspaceName(options)).rejects.toMatchObject({ code: 1 });

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      `The running Tower is older than this CLI: it cannot name a workspace. Restart Tower to pick up the new version: ${RESTART}`,
    );
    expect(mockLogger.success).not.toHaveBeenCalled();
  });

  it('a 404 of the route\'s own is not taken for an older Tower: Tower\'s reason is printed', async () => {
    transport.fetchFn = towerWithoutTheWorkspace;

    await expect(workspaceName({ name: 'work' })).rejects.toMatchObject({ code: 1 });

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Workspace /home/ana/work/codev is not registered with Tower. (NOT_FOUND)',
    );
  });
});
