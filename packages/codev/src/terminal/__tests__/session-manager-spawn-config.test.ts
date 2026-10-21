/**
 * Spec 1658 Phase 2: what `SessionManager.createSession` hands a shellper.
 *
 * POSIX: the argv JSON is exactly the pre-1658 shape and no secret exists.
 * Windows (seam forced): the endpoint is a named pipe, the argv JSON adds the
 * socket dir (the orphan sweep's scope marker) and session id, and the
 * per-session secret travels in the environment, never in argv.
 *
 * `child_process.spawn` is mocked to capture the launch; the fake child then
 * reports bad info so creation stops right after the spawn.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface SpawnCall {
  args: string[];
  env: Record<string, string>;
}

const spawnCalls: SpawnCall[] = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((_cmd: string, args: string[], opts: { env: Record<string, string> }) => {
      spawnCalls.push({ args, env: opts.env });
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => void; unref: () => void };
      child.stdout = new PassThrough();
      child.kill = () => {};
      child.unref = () => {};
      setImmediate(() => child.stdout.end('not json'));
      return child;
    }),
  };
});

const { SessionManager } = await import('../session-manager.js');
const { SHELLPER_SECRET_ENV, isPipeEndpoint } = await import('../shellper-endpoint.js');
const { resetHostPlatformForTests, setHostPlatformForTests } = await import('../../lib/platform.js');

let socketDir: string;

function createOpts() {
  return {
    sessionId: 'sess-1658',
    command: '/bin/bash',
    args: ['-l'],
    cwd: '/tmp',
    env: { TERM: 'xterm-256color' },
    cols: 80,
    rows: 24,
  };
}

async function captureLaunch(): Promise<{ config: Record<string, unknown>; argvJson: string; env: Record<string, string> }> {
  const manager = new SessionManager({ socketDir, shellperScript: '/nonexistent.js', nodeExecutable: process.execPath });
  await expect(manager.createSession(createOpts())).rejects.toThrow('Invalid shellper info JSON');
  expect(spawnCalls).toHaveLength(1);
  const argvJson = spawnCalls[0].args[1];
  return { config: JSON.parse(argvJson) as Record<string, unknown>, argvJson, env: spawnCalls[0].env };
}

beforeEach(() => {
  spawnCalls.length = 0;
  socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smspawn-'));
});

afterEach(() => {
  resetHostPlatformForTests();
  fs.rmSync(socketDir, { recursive: true, force: true });
});

describe('SessionManager.createSession launch config', () => {
  it('POSIX: argv JSON is the unchanged shape, and no secret is minted', async () => {
    const { config, env } = await captureLaunch();
    expect(Object.keys(config)).toEqual(['command', 'args', 'cwd', 'env', 'cols', 'rows', 'socketPath']);
    expect(config.socketPath).toBe(path.join(socketDir, 'shellper-sess-1658.sock'));
    expect(env[SHELLPER_SECRET_ENV]).toBeUndefined();
  });

  it('Windows: pipe endpoint, scope marker in argv, secret only in the environment', async () => {
    setHostPlatformForTests('win32');
    const { config, argvJson, env } = await captureLaunch();

    expect(isPipeEndpoint(config.socketPath as string)).toBe(true);
    expect(config.socketDir).toBe(socketDir);
    expect(config.sessionId).toBe('sess-1658');

    const secret = env[SHELLPER_SECRET_ENV];
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    // Never in argv (another user can read a process's command line), and never
    // in the env the shellper hands its PTY child.
    expect(argvJson).not.toContain(secret);
    expect(argvJson).not.toContain(SHELLPER_SECRET_ENV);
    expect((config.env as Record<string, string>)[SHELLPER_SECRET_ENV]).toBeUndefined();
  });

  it('Windows: every session gets its own secret', async () => {
    setHostPlatformForTests('win32');
    const first = (await captureLaunch()).env[SHELLPER_SECRET_ENV];
    spawnCalls.length = 0;
    const second = (await captureLaunch()).env[SHELLPER_SECRET_ENV];
    expect(second).not.toBe(first);
  });
});
