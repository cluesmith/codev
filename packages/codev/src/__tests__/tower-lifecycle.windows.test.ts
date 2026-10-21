/**
 * Spec 1658 Phase 4, native Windows only (the on-demand `windows.yml` targeted
 * job runs it against the built checkout; it skips everywhere else). A real,
 * isolated Tower (throwaway CODEV_AGENT_FARM_DIR, socket dir and port):
 *
 * - Scenario 3 (stop/start half): `afx tower stop` stops Tower gracefully and
 *   releases the owner lock; a second start reaches ready.
 * - Scenario 4: a persistent session's shellper survives `tower stop`/`start`
 *   with the same pid; the restarted Tower replays its output and input works.
 * - Scenario 5: a row whose shellper pid now belongs to another process is
 *   refused on identity and removed, and that process is never signaled.
 * - Phase 4 (b): `afx tower start` from inside a session job creates Tower
 *   through CIM; tearing the session down leaves Tower and its shellper alive.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { TOWER_KEY_HEADER } from '@cluesmith/codev-types';
import { WindowsJobHelper, sessionJobName } from '../lib/windows-job.js';
import { killSessionTree } from '../lib/process-tree.js';

const onWindows = process.platform === 'win32';
const afx = fileURLToPath(new URL('../../bin/afx.js', import.meta.url));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-1658-tower-'));
const stubScript = path.join(workDir, 'stub.cjs');
const leftovers: number[] = [];
const helpers: WindowsJobHelper[] = [];

/** A builder stub: prints a banner, then echoes each input line back. */
fs.writeFileSync(stubScript, `
process.stdout.write('STUB-READY ' + process.pid + '\\r\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => process.stdout.write('ECHO:' + d.trim() + '\\r\\n'));
setInterval(() => {}, 1000);
`);

interface IsolatedTower {
  stateDir: string;
  port: number;
  env: NodeJS.ProcessEnv;
}

afterAll(() => {
  for (const helper of helpers) helper.stop();
  for (const pid of leftovers) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone
    }
  }
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    // A just-killed process may still hold a handle
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      server.close(() => resolve(address.port));
    });
    server.on('error', reject);
  });
}

async function isolatedTower(): Promise<IsolatedTower> {
  const stateDir = fs.mkdtempSync(path.join(workDir, 'state-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, CODEV_AGENT_FARM_DIR: stateDir, SHELLPER_SOCKET_DIR: path.join(stateDir, 'run') };
  delete env.CODEV_SHELLPER_SESSION;
  // vitest sets NODE_ENV=test, which would point the daemon at test.db.
  delete env.NODE_ENV;
  delete env.AF_TEST_DB;
  return { stateDir, port, env };
}

function afxRun(tower: IsolatedTower, args: string[], extraEnv: NodeJS.ProcessEnv = {}): { code: number | null; output: string } {
  const r = spawnSync(process.execPath, [afx, ...args, '--port', String(tower.port)], {
    env: { ...tower.env, ...extraEnv },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
  return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function lockFile(tower: IsolatedTower): string {
  return path.join(tower.stateDir, 'global.db.tower-owner');
}

function ownerPid(tower: IsolatedTower): number | null {
  try {
    return (JSON.parse(fs.readFileSync(lockFile(tower), 'utf8')) as { pid: number }).pid;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function api(tower: IsolatedTower, method: string, urlPath: string, body?: unknown, hostname = '127.0.0.1'): Promise<{ status: number; json: any }> {
  const key = fs.readFileSync(path.join(tower.stateDir, 'local-key'), 'utf8').trim();
  return new Promise((resolve, reject) => {
    let payload: string | undefined;
    if (body !== undefined) payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname,
        port: tower.port,
        path: urlPath,
        method,
        timeout: 60_000,
        headers: { [TOWER_KEY_HEADER]: key, 'content-type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json: unknown = null;
          try {
            json = JSON.parse(data);
          } catch {
            json = data;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function createStubSession(tower: IsolatedTower, roleId: string): Promise<{ terminalId: string; shellperPid: number }> {
  const created = await api(tower, 'POST', '/api/terminals', {
    command: process.execPath,
    args: [stubScript],
    cwd: workDir,
    persistent: true,
    workspacePath: workDir,
    type: 'builder',
    roleId,
    label: roleId,
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  expect(created.json.persistent).toBe(true);
  const terminalId = created.json.id as string;
  const db = new Database(path.join(tower.stateDir, 'global.db'), { readonly: true });
  try {
    const row = db.prepare('SELECT shellper_pid FROM terminal_sessions WHERE id = ?').get(terminalId) as { shellper_pid: number };
    leftovers.push(row.shellper_pid);
    return { terminalId, shellperPid: row.shellper_pid };
  } finally {
    db.close();
  }
}

async function output(tower: IsolatedTower, terminalId: string): Promise<string> {
  const r = await api(tower, 'GET', `/api/terminals/${terminalId}/output?lines=200`);
  if (r.status !== 200) return '';
  return JSON.stringify(r.json);
}

async function terminalIdFor(tower: IsolatedTower, label: string): Promise<string | null> {
  const r = await api(tower, 'GET', '/api/terminals');
  const found = (r.json.terminals as Array<{ id: string; label: string }>).find((t) => t.label === label);
  return found?.id ?? null;
}

async function endSession(shellperPid: number): Promise<void> {
  try {
    await killSessionTree(shellperPid);
  } catch {
    // Best effort
  }
}

describe.skipIf(!onWindows)('Tower lifecycle on native Windows', () => {
  it('scenario 3: stop is graceful and releases the owner lock; start reaches ready again', async () => {
    const tower = await isolatedTower();
    const first = afxRun(tower, ['tower', 'start']);
    expect(first.code, first.output).toBe(0);
    const pid = ownerPid(tower);
    expect(pid).not.toBeNull();
    leftovers.push(pid!);

    const stop = afxRun(tower, ['tower', 'stop']);
    expect(stop.code, stop.output).toBe(0);
    expect(stop.output).toContain('Tower stopped');
    expect(alive(pid!)).toBe(false);
    expect(fs.existsSync(lockFile(tower))).toBe(false);
    const log = fs.readFileSync(path.join(tower.stateDir, 'tower.log'), 'utf8');
    expect(log).toContain('Graceful shutdown complete');

    const second = afxRun(tower, ['tower', 'start']);
    expect(second.code, second.output).toBe(0);
    const secondPid = ownerPid(tower);
    leftovers.push(secondPid!);
    expect(afxRun(tower, ['tower', 'stop']).code).toBe(0);
    expect(fs.readFileSync(path.join(tower.stateDir, 'tower.log'), 'utf8')).not.toContain('Tower is not running');
  }, 300_000);

  it('bridge mode: a Tower bound to this machine\'s LAN address is stopped gracefully, not killed', async () => {
    const lanAddress = Object.values(os.networkInterfaces())
      .flat()
      .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address;
    if (!lanAddress) {
      console.log('BRIDGE-SKIP no non-internal IPv4 address on this host');
      return;
    }
    const tower = await isolatedTower();
    tower.env.BRIDGE_MODE = '1';
    tower.env.BRIDGE_TOWER_HOST = lanAddress;
    // `tower start` probes readiness on loopback, which a LAN-bound Tower does not
    // answer (a limitation of the start command on every platform), so its exit
    // code is not checked; the daemon itself is.
    afxRun(tower, ['tower', 'start']);
    await waitFor(async () => {
      try {
        return (await api(tower, 'GET', '/health', undefined, lanAddress)).status === 200;
      } catch {
        return false;
      }
    }, 60_000, 'the bridge-mode Tower to answer on its LAN address');
    const pid = ownerPid(tower)!;
    leftovers.push(pid);

    const stop = afxRun(tower, ['tower', 'stop']);
    expect(stop.code, stop.output).toBe(0);
    await waitFor(() => !alive(pid), 15_000, 'Tower to exit');
    expect(fs.existsSync(lockFile(tower))).toBe(false);
    expect(fs.readFileSync(path.join(tower.stateDir, 'tower.log'), 'utf8')).toContain('Graceful shutdown complete');
  }, 300_000);

  it('scenario 4: a session survives tower stop/start with the same pid, replays, and takes input', async () => {
    const tower = await isolatedTower();
    expect(afxRun(tower, ['tower', 'start']).code).toBe(0);
    leftovers.push(ownerPid(tower)!);
    const { terminalId, shellperPid } = await createStubSession(tower, 'stub-4');
    await waitFor(async () => (await output(tower, terminalId)).includes('STUB-READY'), 30_000, 'stub banner');
    // The agent process itself (the PTY child), not only its shellper, must survive.
    const banner = (await output(tower, terminalId)).match(/STUB-READY (\d+)/);
    expect(banner).not.toBeNull();
    const agentPid = Number(banner![1]);
    leftovers.push(agentPid);

    expect(afxRun(tower, ['tower', 'stop']).code).toBe(0);
    await new Promise((r) => setTimeout(r, 2000));
    expect(alive(shellperPid)).toBe(true);
    expect(alive(agentPid)).toBe(true);

    expect(afxRun(tower, ['tower', 'start']).code).toBe(0);
    leftovers.push(ownerPid(tower)!);
    let restartedId: string | null = null;
    await waitFor(async () => {
      restartedId = await terminalIdFor(tower, 'stub-4');
      return restartedId !== null;
    }, 60_000, 'the session to be reconnected');
    const db = new Database(path.join(tower.stateDir, 'global.db'), { readonly: true });
    try {
      const row = db.prepare('SELECT shellper_pid FROM terminal_sessions WHERE id = ?').get(restartedId!) as { shellper_pid: number } | undefined;
      expect(row?.shellper_pid).toBe(shellperPid);
    } finally {
      db.close();
    }
    await waitFor(async () => (await output(tower, restartedId!)).includes(`STUB-READY ${agentPid}`), 30_000, 'replay of the same agent\'s banner');
    expect(alive(agentPid)).toBe(true);
    // Exactly one banner: a respawned stub would print a second one (the old one stays in the replay).
    expect((await output(tower, restartedId!)).match(/STUB-READY \d+/g)).toHaveLength(1);

    const write = await api(tower, 'POST', `/api/terminals/${restartedId}/write`, { data: 'ping-1658\r' });
    expect(write.status).toBe(200);
    await waitFor(async () => (await output(tower, restartedId!)).includes('ECHO:ping-1658'), 30_000, 'the echoed input');

    afxRun(tower, ['tower', 'stop']);
    await endSession(shellperPid);
  }, 300_000);

  it('scenario 5: a row whose shellper pid was reused is refused and removed, and the pid is never signaled', async () => {
    const tower = await isolatedTower();
    expect(afxRun(tower, ['tower', 'start']).code).toBe(0);
    leftovers.push(ownerPid(tower)!);
    const { terminalId, shellperPid } = await createStubSession(tower, 'stub-5');
    expect(afxRun(tower, ['tower', 'stop']).code).toBe(0);

    // The shellper dies, and an unrelated process now holds "its" pid: point
    // the row at a live decoy (a real reuse cannot be forced).
    await endSession(shellperPid);
    await waitFor(() => !alive(shellperPid), 15_000, 'the shellper to exit');
    const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true });
    leftovers.push(decoy.pid!);
    const db = new Database(path.join(tower.stateDir, 'global.db'));
    try {
      db.prepare('UPDATE terminal_sessions SET shellper_pid = ?, pid = ? WHERE id = ?').run(decoy.pid, decoy.pid, terminalId);
    } finally {
      db.close();
    }

    expect(afxRun(tower, ['tower', 'start']).code).toBe(0);
    leftovers.push(ownerPid(tower)!);
    await waitFor(() => {
      const check = new Database(path.join(tower.stateDir, 'global.db'), { readonly: true });
      try {
        return check.prepare('SELECT 1 FROM terminal_sessions WHERE id = ?').get(terminalId) === undefined;
      } finally {
        check.close();
      }
    }, 60_000, 'the reused-pid row to be removed');
    expect(alive(decoy.pid!)).toBe(true);
    const log = fs.readFileSync(path.join(tower.stateDir, 'tower.log'), 'utf8');
    expect(log).toContain('refused reconnect on identity');
    afxRun(tower, ['tower', 'stop']);
  }, 300_000);

  it('Phase 4 (b): started from inside a session job, Tower is created through CIM and survives the session teardown, with its shellper', async () => {
    const tower = await isolatedTower();
    const helper = new WindowsJobHelper();
    helpers.push(helper);
    const name = sessionJobName(`launcher-${crypto.randomUUID()}`);
    const gate = path.join(workDir, `gate-${crypto.randomUUID()}`);
    const resultFile = path.join(workDir, `start-${crypto.randomUUID()}.json`);

    // The launcher waits for the gate (so it is in the job before it starts
    // anything), then runs `afx tower start` as a plain child, the way a
    // command typed in a session's shell would.
    const launcher = spawn(process.execPath, ['-e', `
      const fs = require('fs');
      const { spawnSync } = require('child_process');
      const wait = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(gate)})) return;
        clearInterval(wait);
        const r = spawnSync(process.execPath, [${JSON.stringify(afx)}, 'tower', 'start', '--port', '${tower.port}'], { encoding: 'utf8', windowsHide: true });
        fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ code: r.status, output: (r.stdout || '') + (r.stderr || '') }));
      }, 50);
      setInterval(() => {}, 1000);
    `], { stdio: 'ignore', detached: true, windowsHide: true, env: { ...tower.env, CODEV_SHELLPER_SESSION: 'launcher-session' } });
    leftovers.push(launcher.pid!);
    expect(await helper.assign(name, launcher.pid!)).toEqual({ assigned: true });
    fs.writeFileSync(gate, '');

    await waitFor(() => fs.existsSync(resultFile), 180_000, 'afx tower start to finish');
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as { code: number; output: string };
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('outside the session job (CIM)');
    const towerPid = ownerPid(tower)!;
    leftovers.push(towerPid);

    const sessionCheck = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `"$((Get-Process -Id ${towerPid}).SessionId),$((Get-Process -Id ${process.pid}).SessionId)"`], { encoding: 'utf8', windowsHide: true });
    console.log(`TOWER-CIM-SESSION tower_and_test_session_ids=${sessionCheck.stdout.trim()}`);

    // The CIM-created Tower does not carry the marker, and neither does what it spawns.
    const health = await api(tower, 'GET', '/health');
    expect(health.json.insideCodevSession).toBe(false);
    const { terminalId: stubTerminal, shellperPid } = await createStubSession(tower, 'stub-b');
    // The PTY under a CIM-created Tower works (ConPTY output reaches Tower).
    await waitFor(async () => (await output(tower, stubTerminal)).includes('STUB-READY'), 30_000, 'stub banner under the CIM Tower');

    expect(await helper.terminate(name, launcher.pid!)).toEqual({ ok: true, found: true, member: true });
    await waitFor(() => !alive(launcher.pid!), 15_000, 'the launcher session to end');
    await new Promise((r) => setTimeout(r, 2000));
    expect(alive(towerPid)).toBe(true);
    expect(alive(shellperPid)).toBe(true);
    expect((await api(tower, 'GET', '/health')).status).toBe(200);

    afxRun(tower, ['tower', 'stop']);
    await endSession(shellperPid);
  }, 300_000);
});
