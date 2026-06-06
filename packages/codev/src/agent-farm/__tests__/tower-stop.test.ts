/**
 * #991: `afx tower stop` must target only the LISTENing server, never clients.
 *
 * Without `-sTCP:LISTEN`, `lsof -ti :PORT` returns every process with a socket
 * on the port — including *clients*: the VSCode extension host (its SSE stream
 * + terminal WebSockets) and dashboard browsers. `towerStop` SIGTERMs whatever
 * `getProcessesOnPort` returns, so the unfiltered form would kill the editor's
 * extension host (and every open terminal with it), not just the Tower server.
 * This pins the LISTEN filter so a future edit can't silently drop it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execSyncMock = vi.fn(() => '');
// Spread the real module and override only execSync — other transitive imports
// (shell.js, etc.) still need the genuine child_process exports.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: (...args: unknown[]) => execSyncMock(...args) };
});

const { getProcessesOnPort } = await import('../commands/tower.js');

describe('getProcessesOnPort — LISTENer only (#991)', () => {
  beforeEach(() => execSyncMock.mockClear());

  it('queries lsof with -sTCP:LISTEN so client sockets are not matched', () => {
    getProcessesOnPort(4100);
    expect(execSyncMock).toHaveBeenCalledTimes(1);
    const cmd = String(execSyncMock.mock.calls[0][0]);
    expect(cmd).toContain('-sTCP:LISTEN');
    expect(cmd).toContain(':4100');
  });

  it('returns the listening server pids and nothing else', () => {
    execSyncMock.mockReturnValueOnce('8435\n'); // a single LISTEN pid (the server)
    expect(getProcessesOnPort(4100)).toEqual([8435]);
  });

  it('returns [] when nothing is listening (lsof exits non-zero / empty)', () => {
    execSyncMock.mockImplementationOnce(() => { throw new Error('exit 1'); });
    expect(getProcessesOnPort(4100)).toEqual([]);
  });
});
