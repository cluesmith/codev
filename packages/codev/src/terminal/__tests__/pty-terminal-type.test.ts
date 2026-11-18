/**
 * Issue #1920: every Tower-launched PTY child carries `TERM=xterm-256color`.
 *
 * node-pty derives `TERM` from its `name` option on POSIX but not on Windows, where a child
 * launched straight into ConPTY (the architect's bare `claude`) gets only the env's `TERM`.
 * Without one claude draws its ASCII fallbacks, including a `>` composer marker, and the render
 * gate held that architect's mail permanently. The shellper paths are pinned in the
 * session-manager suites; this file pins the helper and the non-shellper `PtySession.spawn`.
 */

import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

const spawned = vi.hoisted(() => ({ calls: [] as Array<{ name: string; env: Record<string, string> }> }));
vi.mock('node-pty', () => ({
  spawn: (_file: string, _args: string[], opts: { name: string; env: Record<string, string> }) => {
    spawned.calls.push({ name: opts.name, env: opts.env });
    return { pid: 1, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {} };
  },
}));
vi.mock('../../lib/pty-command.js', () => ({
  ptyCommand: (file: string, args: string[]) => ({ file, args }),
}));

import { PtySession } from '../pty-session.js';
import { PTY_TERMINAL_TYPE, withPtyTerminalType } from '../../lib/agent-env.js';

describe('withPtyTerminalType', () => {
  it('adds TERM when the env has none, keeping everything else', () => {
    expect(withPtyTerminalType({ PATH: 'p', KEEP: '1' })).toEqual({ PATH: 'p', KEEP: '1', TERM: 'xterm-256color' });
  });

  it("replaces a TERM that names a different terminal (mintty's xterm, a dumb console)", () => {
    expect(withPtyTerminalType({ TERM: 'xterm' }).TERM).toBe('xterm-256color');
    expect(withPtyTerminalType({ TERM: 'dumb' }).TERM).toBe('xterm-256color');
  });

  it('does not mutate its input', () => {
    const env = { KEEP: '1' };
    withPtyTerminalType(env);
    expect(env).toEqual({ KEEP: '1' });
  });

  it('matches the terminal type the PTY is created as', () => {
    expect(PTY_TERMINAL_TYPE).toBe('xterm-256color');
  });
});

describe('PtySession.spawn (non-shellper path)', () => {
  it('hands node-pty an env whose TERM matches the PTY name, even when the config env has none', async () => {
    spawned.calls.length = 0;
    const session = new PtySession({
      id: 'term-type',
      command: 'claude',
      args: [],
      cols: 80,
      rows: 24,
      cwd: os.tmpdir(),
      env: { KEEP: '1' },
      label: 'term type',
      logDir: path.join(os.tmpdir(), 'pty-terminal-type-logs'),
      diskLogEnabled: false,
      ringBufferLines: 10,
      reconnectTimeoutMs: 1000,
    });
    await session.spawn();
    expect(spawned.calls).toHaveLength(1);
    expect(spawned.calls[0].name).toBe('xterm-256color');
    expect(spawned.calls[0].env).toEqual({ KEEP: '1', TERM: 'xterm-256color' });
  });
});
