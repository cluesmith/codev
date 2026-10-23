/**
 * Spec 1658 Phase 4: how `afx tower start` launches the daemon on Windows
 * (seam forced), and the CIM launch helpers.
 *
 * - Inside a codev session (the shellper's marker in the environment) the
 *   daemon is created through CIM, with the sanitized environment minus the
 *   marker, and is never spawned as a child.
 * - CIM unavailable: the start is refused, naming the supported launch paths.
 * - Outside a session, and on POSIX even with the marker, the daemon is
 *   spawned as before, with no console window.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const h = vi.hoisted(() => {
  const nodeOs = require('node:os') as typeof import('node:os');
  const nodePath = require('node:path') as typeof import('node:path');
  const nodeFs = require('node:fs') as typeof import('node:fs');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'af-1658-launch-'));
  return {
    agentFarmDir: dir,
    spawnCalls: [] as Array<{ command: string; args: string[]; opts: Record<string, unknown> }>,
    cimCalls: [] as Array<{ command: string; args: string[]; cwd: string; env: Record<string, string> }>,
    cimResult: { pid: 999999 } as { pid: number } | { error: string },
  };
});

vi.mock('../lib/tower-client.js', () => ({ DEFAULT_TOWER_PORT: 4100, AGENT_FARM_DIR: h.agentFarmDir }));
vi.mock('../utils/config.js', () => ({ getConfig: () => ({ serversDir: h.agentFarmDir }) }));
vi.mock('../utils/shell.js', () => ({ isPortAvailable: vi.fn(async () => true) }));
vi.mock('node:http', () => {
  const request = vi.fn(() => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.destroy = () => {};
    req.end = () => {
      setImmediate(() => req.emit('error', new Error('ECONNREFUSED')));
    };
    return req;
  });
  return { default: { request }, request };
});
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: vi.fn((command: string, args: string[], opts: Record<string, unknown>) => {
      h.spawnCalls.push({ command, args, opts });
      const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
      child.pid = 999998;
      child.unref = () => {};
      setTimeout(() => child.emit('exit', 1, null), 10);
      return child;
    }),
  };
});
vi.mock('../commands/tower-start-windows.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../commands/tower-start-windows.js')>();
  return {
    ...actual,
    launchViaCim: vi.fn(async (req: { command: string; args: string[]; cwd: string; env: Record<string, string> }) => {
      h.cimCalls.push(req);
      return h.cimResult;
    }),
  };
});

const { towerStart } = await import('../commands/tower.js');
const { resetHostPlatformForTests, setHostPlatformForTests } = await import('../../lib/platform.js');
const {
  SUPPORTED_TOWER_LAUNCH_PATHS,
  cimRefusalMessage,
  daemonEnvironment,
  isInsideCodevSession,
  launchViaCim: realLaunchViaCim,
} = await vi.importActual<typeof import('../commands/tower-start-windows.js')>('../commands/tower-start-windows.js');
const { SHELLPER_SESSION_ENV } = await import('../../terminal/shellper-endpoint.js');

let savedEnv: NodeJS.ProcessEnv;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fs.writeFileSync(path.join(h.agentFarmDir, 'tower-server.js'), '// stub');
  h.spawnCalls.length = 0;
  h.cimCalls.length = 0;
  h.cimResult = { pid: 999999 };
  savedEnv = { ...process.env };
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as never);
});

afterEach(() => {
  process.env = savedEnv;
  resetHostPlatformForTests();
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(h.agentFarmDir, { recursive: true, force: true });
});

describe('afx tower start launch path on Windows', () => {
  it('inside a codev session: creates the daemon through CIM, without the marker, and never spawns it', async () => {
    setHostPlatformForTests('win32');
    process.env[SHELLPER_SESSION_ENV] = 'sess-1';
    process.env.KEEP_ME = 'yes';

    // The CIM pid (999999) is not alive, so the wait reports a fast exit.
    await expect(towerStart({ wait: true })).rejects.toThrow('process.exit:1');

    expect(h.spawnCalls).toHaveLength(0);
    expect(h.cimCalls).toHaveLength(1);
    const call = h.cimCalls[0];
    expect(call.command).toBe(process.execPath);
    expect(call.args[0]).toBe(path.join(h.agentFarmDir, 'tower-server.js'));
    expect(call.cwd).toBe(process.cwd());
    expect(call.env[SHELLPER_SESSION_ENV]).toBeUndefined();
    expect(call.env.KEEP_ME).toBe('yes');
  });

  it('inside a codev session with CIM unavailable: refuses and names the supported paths', async () => {
    setHostPlatformForTests('win32');
    process.env[SHELLPER_SESSION_ENV] = 'sess-1';
    h.cimResult = { error: 'Access denied' };

    await expect(towerStart({ wait: true })).rejects.toThrow('process.exit:1');

    expect(h.spawnCalls).toHaveLength(0);
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(stderr).toContain('Access denied');
    expect(stderr).toContain(SUPPORTED_TOWER_LAUNCH_PATHS);
  });

  it('outside a session: spawns the daemon detached with no console window', async () => {
    setHostPlatformForTests('win32');
    delete process.env[SHELLPER_SESSION_ENV];

    await expect(towerStart({ wait: true })).rejects.toThrow('process.exit:1');

    expect(h.cimCalls).toHaveLength(0);
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0].opts.detached).toBe(true);
    expect(h.spawnCalls[0].opts.windowsHide).toBe(true);
  });

  it('dev mode (tower-server.ts present) goes through cmd.exe so npx resolves', async () => {
    setHostPlatformForTests('win32');
    process.env[SHELLPER_SESSION_ENV] = 'sess-1';
    const tsServer = path.join(h.agentFarmDir, 'tower-server.ts');
    fs.writeFileSync(tsServer, '// stub');
    try {
      await expect(towerStart({ wait: true })).rejects.toThrow('process.exit:1');
      expect(h.cimCalls[0].command).toBe('cmd.exe');
      expect(h.cimCalls[0].args.slice(0, 4)).toEqual(['/d', '/c', 'npx', 'tsx']);
      expect(h.cimCalls[0].args[4]).toBe(tsServer);
    } finally {
      fs.rmSync(tsServer, { force: true });
    }
  });

  it('POSIX ignores the marker and spawns as before', async () => {
    setHostPlatformForTests('linux');
    process.env[SHELLPER_SESSION_ENV] = 'sess-1';
    await expect(towerStart({ wait: true })).rejects.toThrow('process.exit:1');
    expect(h.cimCalls).toHaveLength(0);
    expect(h.spawnCalls).toHaveLength(1);
  });
});

describe('CIM launch helpers', () => {
  it('detects the session marker', () => {
    expect(isInsideCodevSession({ [SHELLPER_SESSION_ENV]: 'x' })).toBe(true);
    expect(isInsideCodevSession({ [SHELLPER_SESSION_ENV]: '' })).toBe(false);
    expect(isInsideCodevSession({})).toBe(false);
  });

  it('strips only the marker from the daemon environment', () => {
    expect(daemonEnvironment({ A: '1', [SHELLPER_SESSION_ENV]: 'x', B: undefined })).toEqual({ A: '1' });
  });

  it('quotes the command line and passes data on stdin', async () => {
    let input = '';
    const run = vi.fn(async (_script: string, stdin: string) => {
      input = stdin;
      return '{"returnValue":0,"pid":4242}\r\n';
    });
    const result = await realLaunchViaCim({ command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\x\\tower-server.js', '4100'], cwd: 'C:\\w', env: { A: '1', BAD: 'a\0b' } }, run);
    expect(result).toEqual({ pid: 4242 });
    const sent = JSON.parse(input);
    expect(sent.commandLine).toBe('"C:\\Program Files\\nodejs\\node.exe" C:\\x\\tower-server.js 4100');
    expect(sent.cwd).toBe('C:\\w');
    expect(sent.env).toEqual(['A=1']);
  });

  it('reports every failure as an error, never a throw', async () => {
    const req = { command: 'node', args: [], cwd: 'C:\\', env: {} };
    expect(await realLaunchViaCim(req, async () => '{"error":"Access denied"}')).toEqual({ error: 'Access denied' });
    expect(await realLaunchViaCim(req, async () => '{"returnValue":2,"pid":0}')).toEqual({ error: 'Win32_Process.Create returned 2' });
    expect(await realLaunchViaCim(req, async () => 'garbage')).toEqual({ error: 'unexpected output: garbage' });
    const failed = await realLaunchViaCim(req, async () => {
      throw new Error('ENOENT');
    });
    expect(failed).toEqual({ error: 'powershell.exe failed: ENOENT' });
  });

  it('the refusal names the cause and the supported paths', () => {
    const text = cimRefusalMessage('blocked by policy');
    expect(text).toContain('blocked by policy');
    expect(text).toContain(SUPPORTED_TOWER_LAUNCH_PATHS);
  });
});
