/**
 * Issue #1901 — `afx tower start` must never stop a Tower because the machine is busy.
 *
 * The old start probed `/api/status` with a 2 s timeout and, when that missed, decided "port in
 * use but not responding", SIGTERMed every PID on the port and started a new Tower. Under load
 * that PID is the live Tower. Start now probes `/health` through `checkTower`: a refused port is
 * started on as before; a holder that accepted the connection but did not answer is left alone,
 * named, and the command exits non-zero. Replacing it is `afx tower stop`, which must still work.
 *
 * The stalled holder is a real child process listening on an ephemeral port that never answers,
 * so these tests cannot reach the developer's Tower on 4100. Only the client's request timeout is
 * shortened (300 ms); the fetch, the port lookup and the process table are real.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const h = vi.hoisted(() => {
  const nodeOs = require('node:os') as typeof import('node:os');
  const nodePath = require('node:path') as typeof import('node:path');
  const nodeFs = require('node:fs') as typeof import('node:fs');
  const nodeEvents = require('node:events') as typeof import('node:events');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'af-1901-'));
  // A dummy compiled server so towerStart takes the `node <jsScript>` branch; spawn is stubbed.
  nodeFs.writeFileSync(nodePath.join(dir, 'tower-server.js'), '// stub');
  const fakeDaemon = () => Object.assign(new nodeEvents.EventEmitter(), { pid: 999_999, unref: () => {} });
  return { dir, fakeDaemon };
});

vi.mock('../lib/tower-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tower-client.js')>();
  class ShortTimeoutTowerClient extends actual.TowerClient {
    constructor(options: import('../lib/tower-client.js').TowerClientOptions = {}) {
      super({ ...options, getAuthKey: () => null, requestTimeoutMs: 300 });
    }
  }
  return { ...actual, AGENT_FARM_DIR: h.dir, TowerClient: ShortTimeoutTowerClient };
});

vi.mock('../utils/config.js', () => ({
  getConfig: () => ({ serversDir: h.dir }),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn(() => h.fakeDaemon()) };
});

const { towerStart, towerStop } = await import('../commands/tower.js');
const { spawn: daemonSpawn } = await import('node:child_process');
const { spawn: realSpawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');

const STALLED_SERVER = "require('node:http').createServer(() => {}).listen(0, '127.0.0.1', function () { console.log(this.address().port); })";

/** A process that accepts every connection on its port and never answers. */
async function startStalledServer(): Promise<{ child: ChildProcess; port: number }> {
  const child = realSpawn(process.execPath, ['-e', STALLED_SERVER], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout!.once('data', (chunk) => resolve(Number(String(chunk).trim())));
    child.once('exit', (code) => reject(new Error(`stalled server exited before listening (code ${code})`)));
  });
  return { child, port };
}

async function refusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const isAlive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

const children: ChildProcess[] = [];
let stderr: string[];

beforeEach(() => {
  stderr = [];
  vi.mocked(daemonSpawn).mockClear();
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (isAlive(child)) child.kill('SIGKILL');
  }
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('afx tower start against a port it cannot get an answer from (#1901)', () => {
  it('signals nothing, exits non-zero, and names the process holding the port', async () => {
    const { child, port } = await startStalledServer();
    const kill = vi.spyOn(process, 'kill');

    await expect(towerStart({ port, wait: false })).rejects.toThrow('process.exit:1');

    expect(kill).not.toHaveBeenCalledWith(child.pid, expect.anything());
    expect(isAlive(child)).toBe(true);
    expect(daemonSpawn).not.toHaveBeenCalled();

    const output = stderr.join('\n');
    expect(output).toContain(`A process is listening on port ${port} but did not answer /health`);
    expect(output).toContain(`PID ${child.pid}: `);
    expect(output).toContain('createServer');
    expect(output).toContain('If the machine is busy, wait and run afx tower start again.');
    expect(output).toContain('To replace it deliberately: afx tower stop, then afx tower start.');
    expect(output).not.toContain('Tower is not running');
  }, 30_000);

  it('starts normally when the connection is refused (nothing listening)', async () => {
    const port = await refusedPort();

    await towerStart({ port, wait: false });

    expect(daemonSpawn).toHaveBeenCalledTimes(1);
    const [, args] = vi.mocked(daemonSpawn).mock.calls[0];
    expect(args).toEqual(expect.arrayContaining([path.join(h.dir, 'tower-server.js'), String(port)]));
  }, 30_000);
});

describe('afx tower stop against the same unresponsive holder (#1901)', () => {
  it('still stops it: replacing a hung Tower stays the deliberate path', async () => {
    const { child, port } = await startStalledServer();
    const exited = new Promise((resolve) => child.once('exit', resolve));

    await towerStop({ port });
    await exited;

    expect(isAlive(child)).toBe(false);
  }, 30_000);
});
