/**
 * Spec 1658 Phase 10: a node-pty binding that cannot load (scripts disabled at
 * install, or Node switched after it) surfaces on Windows with the
 * supported-versions message, not node-pty's raw loader error. node-pty loads
 * its ConPTY binding inside `spawn`, so the spawn is a load point.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

const CONPTY_LOAD_ERROR = 'Failed to load native module: conpty.node, checked: build/Release, build/Debug, prebuilds/win32-x64/: Error: The specified module could not be found.';

const spawnImpl = vi.hoisted(() => ({ fn: (): unknown => { throw new Error('unset'); } }));
vi.mock('node-pty', () => ({ spawn: () => spawnImpl.fn() }));
vi.mock('../../lib/pty-command.js', () => ({
  ptyCommand: (file: string, args: string[]) => ({ file, args }),
}));

import { PtySession } from '../pty-session.js';
import { resetHostPlatformForTests, setHostPlatformForTests } from '../../lib/platform.js';

function session(): PtySession {
  return new PtySession({
    id: 'native-load',
    command: 'claude',
    args: [],
    cols: 80,
    rows: 24,
    cwd: os.tmpdir(),
    env: {},
    label: 'native load',
    logDir: path.join(os.tmpdir(), 'pty-session-native-load-logs'),
    diskLogEnabled: false,
    ringBufferLines: 10,
    reconnectTimeoutMs: 1000,
  });
}

afterEach(() => {
  resetHostPlatformForTests();
});

describe('PtySession.spawn with a binding that cannot load', () => {
  it('Windows: names the supported Node versions and keeps the loader error', async () => {
    setHostPlatformForTests('win32');
    spawnImpl.fn = () => { throw new Error(CONPTY_LOAD_ERROR); };
    const err = await session().spawn().then(() => null, (e: Error) => e);
    expect(err?.message).toContain('native Windows needs Node.js 22 or 24');
    expect(err?.message).toContain('conpty.node');
    expect((err?.cause as Error).message).toBe(CONPTY_LOAD_ERROR);
  });

  it('POSIX: the loader error is unchanged', async () => {
    setHostPlatformForTests('darwin');
    spawnImpl.fn = () => { throw new Error(CONPTY_LOAD_ERROR); };
    await expect(session().spawn()).rejects.toThrow(/^Failed to load native module/);
  });

  it('an unrelated spawn error is unchanged on Windows', async () => {
    setHostPlatformForTests('win32');
    spawnImpl.fn = () => { throw new Error('File not found: '); };
    await expect(session().spawn()).rejects.toThrow(/^File not found/);
  });
});
