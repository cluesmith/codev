/**
 * #1915, native Windows only (the on-demand `windows.yml` targeted job runs it
 * against the built checkout; it skips everywhere else). Real sessions, the
 * real job helper and real processes:
 *
 * - A shellper session plants a child whose parent then exits: it is listed
 *   as an orphan (never the shellper, its console host or its shell), and
 *   closing the session ends it with everything else the session started.
 * - A process outside every session job, also with a dead parent, is never
 *   listed, and survives that session's end.
 * - A Tower started from inside a session by a plain spawn: with the session
 *   marker set it refuses to start; with the marker removed it starts, the
 *   listing never shows it, its helper or its session, and tearing the outer
 *   session down leaves Tower and its session running.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOWER_KEY_HEADER } from '@cluesmith/codev-types';
import { SessionManager } from '../terminal/session-manager.js';
import { WindowsJobHelper, sessionJobName } from '../lib/platform/windows/job-objects.js';
import { resolveGitBash } from '../lib/platform/windows/git-bash.js';
import { shellperTransport } from '../lib/platform/shellper-transport.js';
import { listProcessCensus } from '../agent-farm/servers/process-census.js';
import { listOrphans, type OrphanDeps, type OrphanSessionRef } from '../agent-farm/servers/session-orphans.js';
import { killSessionTree } from '../lib/process-tree.js';

const onWindows = process.platform === 'win32';
const shellperScript = fileURLToPath(new URL('../../dist/terminal/shellper-main.js', import.meta.url));
const towerServer = fileURLToPath(new URL('../../dist/agent-farm/servers/tower-server.js', import.meta.url));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-1915-orphans-'));
const leftovers: number[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
const helpers: WindowsJobHelper[] = [];

/** Appends `<role> <pid>` to the pid file, then idles. */
const leafScript = path.join(workDir, 'leaf.cjs');
fs.writeFileSync(leafScript, `
require('fs').appendFileSync(process.argv[3], process.argv[2] + ' ' + process.pid + '\\n');
setInterval(() => {}, 1000);
`);

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      // Best effort
    }
  }
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

function newHelper(): WindowsJobHelper {
  const helper = new WindowsJobHelper({ log: (m) => console.log(`[job-helper] ${m}`) });
  helpers.push(helper);
  return helper;
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
    await new Promise((r) => setTimeout(r, 200));
  }
}

function readPids(pidFile: string): Map<string, number> {
  const pids = new Map<string, number>();
  if (!fs.existsSync(pidFile)) return pids;
  for (const line of fs.readFileSync(pidFile, 'utf8').split(/\r?\n/)) {
    const [role, pid] = line.trim().split(' ');
    if (role && pid) pids.set(role, Number(pid));
  }
  return pids;
}

const unix = (p: string) => p.replace(/\\/g, '/');

function depsFor(helper: WindowsJobHelper, sessions: OrphanSessionRef[], infrastructurePids: number[] = []): OrphanDeps {
  return {
    helper: () => helper,
    sessions: () => sessions,
    infrastructurePids: () => infrastructurePids,
    census: () => listProcessCensus({ fresh: true }),
    shellperJobName: (cmdline) => shellperTransport().sessionJobName(cmdline),
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function healthy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function api(port: number, stateDir: string, method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: any }> {
  const key = fs.readFileSync(path.join(stateDir, 'local-key'), 'utf8').trim();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, timeout: 60_000, headers: { [TOWER_KEY_HEADER]: key, 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json: unknown = data;
          try {
            json = JSON.parse(data);
          } catch {
            // Not JSON
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * A stand-in session root in its own job (as Tower's assign makes one), which
 * runs `script` (node source) once the job holds it.
 */
async function rootInJob(helper: WindowsJobHelper, shellperSessionId: string, script: string, env: NodeJS.ProcessEnv = process.env): Promise<ChildProcess> {
  const gate = path.join(workDir, `gate-${crypto.randomUUID()}`);
  const root = spawn(process.execPath, ['-e', `
    const fs = require('fs');
    const wait = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(gate)})) return;
      clearInterval(wait);
      ${script}
    }, 50);
    setInterval(() => {}, 1000);
  `], { stdio: 'ignore', detached: true, windowsHide: true, env });
  leftovers.push(root.pid!);
  expect(await helper.assign(sessionJobName(shellperSessionId), root.pid!)).toEqual({ assigned: true });
  fs.writeFileSync(gate, '');
  return root;
}

describe.skipIf(!onWindows)('orphaned processes in session jobs (native Windows)', () => {
  it('lists a real session\'s orphan (never its shellper, console host or shell, nor a process outside the job); closing the session ends it', async () => {
    const helper = newHelper();
    expect(await helper.start()).toBeNull();
    const manager = new SessionManager({ socketDir: path.join(workDir, 'run'), shellperScript, nodeExecutable: process.execPath, jobHelper: () => helper });
    const pidFile = path.join(workDir, `session-${crypto.randomUUID()}.txt`);
    // The subshell exits at once, so the leaf's parent is gone: what a timed-out tool call leaves.
    const script = `( "${unix(process.execPath)}" "${unix(leafScript)}" leaf "${unix(pidFile)}" & ) ; "${unix(process.execPath)}" "${unix(leafScript)}" shell-child "${unix(pidFile)}"`;
    const sessionId = crypto.randomUUID();
    await manager.createSession({ sessionId, command: resolveGitBash().path, args: ['-c', script], cwd: workDir, env: process.env as Record<string, string>, cols: 80, rows: 24 });
    cleanups.push(() => manager.killSession(sessionId));
    const info = manager.getSessionInfo(sessionId)!;
    await waitFor(() => readPids(pidFile).has('leaf') && readPids(pidFile).has('shell-child'), 30_000, 'the session to plant its processes');
    const leaf = readPids(pidFile).get('leaf')!;
    const shellChild = readPids(pidFile).get('shell-child')!;
    leftovers.push(leaf, shellChild);

    // Outside every job: a cmd start /b leaf from this test process, its parent (cmd) gone.
    const outsidePids = path.join(workDir, `outside-${crypto.randomUUID()}.txt`);
    spawn('cmd.exe', ['/d', '/c', 'start', '""', '/b', process.execPath, leafScript, 'outside', outsidePids], { stdio: 'ignore', windowsHide: true });
    await waitFor(() => readPids(outsidePids).has('outside'), 20_000, 'the outside process');
    const outside = readPids(outsidePids).get('outside')!;
    leftovers.push(outside);

    const session: OrphanSessionRef = { workspacePath: workDir, terminalId: 't-1', agent: 'builder-1', kind: 'builder', rootPid: info.pid, jobName: sessionJobName(info.shellperSessionId) };
    const deps = depsFor(helper, [session], [process.pid, helper.pid!]);
    const listing = await listOrphans(deps);
    expect(listing.sessions[0].job).toBe(true);
    // Git Bash keeps a bash.exe stub alive as the parent of each native program it starts, so the
    // process whose parent (the subshell) is gone may be that stub, with the leaf as its descendant.
    expect(listing.sessions[0].orphans).toHaveLength(1);
    const orphan = listing.sessions[0].orphans[0];
    const listedPids = [orphan.pid, ...orphan.descendants.map((d) => d.pid)];
    console.log(`ORPHAN-SHAPE ${orphan.name} pid=${orphan.pid} descendants=${orphan.descendants.map((d) => `${d.name}:${d.pid}`).join(',')} leaf=${leaf}`);
    expect(listedPids).toContain(leaf);
    for (const pid of [info.pid, shellChild, outside]) expect(listedPids).not.toContain(pid);

    // Closing the session ends the orphan with everything else it started; the outside process survives.
    await manager.killSession(sessionId);
    await waitFor(() => listedPids.every((pid) => !alive(pid)) && !alive(shellChild) && !alive(info.pid), 15_000, 'the session and its orphan to end');
    expect(alive(outside)).toBe(true);
  }, 120_000);

  it('a Tower started inside a session job refuses to start while the session marker names that job', async () => {
    const helper = newHelper();
    const stateDir = fs.mkdtempSync(path.join(workDir, 'refuse-'));
    const port = await freePort();
    const marker = crypto.randomUUID();
    const env: NodeJS.ProcessEnv = { ...process.env, CODEV_AGENT_FARM_DIR: stateDir, SHELLPER_SOCKET_DIR: path.join(stateDir, 'run'), CODEV_SHELLPER_SESSION: marker };
    delete env.NODE_ENV;
    delete env.AF_TEST_DB;
    const exitFile = path.join(stateDir, 'exit.txt');
    await rootInJob(helper, marker, `
      const t = require('child_process').spawn(process.execPath, [${JSON.stringify(towerServer)}, '${port}', '--log-file', ${JSON.stringify(path.join(stateDir, 'tower.log'))}], { stdio: 'ignore', windowsHide: true });
      t.on('exit', (code) => fs.writeFileSync(${JSON.stringify(exitFile)}, String(code)));
    `, env);
    await waitFor(() => fs.existsSync(exitFile), 60_000, 'the Tower to exit');
    expect(fs.readFileSync(exitFile, 'utf8')).toBe('1');
    const log = fs.readFileSync(path.join(stateDir, 'tower.log'), 'utf8');
    expect(log).toContain("Tower refuses to start inside a codev session's job");
    expect(await healthy(port)).toBe(false);
  }, 90_000);

  it('a Tower started inside a session job without the marker: never listed, and that session\'s teardown leaves it and its sessions running', async () => {
    const helper = newHelper();
    const stateDir = fs.mkdtempSync(path.join(workDir, 'nested-'));
    const port = await freePort();
    const env: NodeJS.ProcessEnv = { ...process.env, CODEV_AGENT_FARM_DIR: stateDir, SHELLPER_SOCKET_DIR: path.join(stateDir, 'run') };
    delete env.CODEV_SHELLPER_SESSION;
    delete env.NODE_ENV;
    delete env.AF_TEST_DB;
    const outerId = crypto.randomUUID();
    // `cmd start /b` exits at once, so the Tower's parent is gone: by parent alone it would look orphaned.
    const root = await rootInJob(helper, outerId, `
      require('child_process').spawn('cmd.exe', ['/d', '/c', 'start', '""', '/b', process.execPath, ${JSON.stringify(towerServer)}, '${port}', '--log-file', ${JSON.stringify(path.join(stateDir, 'tower.log'))}], { stdio: 'ignore', windowsHide: true });
    `, env);
    cleanups.push(() => {
      spawnSync(process.execPath, [fileURLToPath(new URL('../../bin/afx.js', import.meta.url)), 'tower', 'stop', '--port', String(port)], { env, windowsHide: true, timeout: 60_000 });
    });
    await waitFor(() => healthy(port), 60_000, 'the inner Tower to answer');
    const towerPid = (JSON.parse(fs.readFileSync(path.join(stateDir, 'global.db.tower-owner'), 'utf8')) as { pid: number }).pid;
    leftovers.push(towerPid);

    const created = await api(port, stateDir, 'POST', '/api/terminals', {
      command: process.execPath, args: [leafScript, 'inner-agent', path.join(stateDir, 'inner.txt')], cwd: workDir, persistent: true, workspacePath: workDir, type: 'builder', roleId: 'inner', label: 'inner',
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    await waitFor(() => readPids(path.join(stateDir, 'inner.txt')).has('inner-agent'), 30_000, 'the inner session to start');
    const innerAgent = readPids(path.join(stateDir, 'inner.txt')).get('inner-agent')!;
    const innerShellper = (await listProcessCensus({ fresh: true })).find((e) => e.pid !== towerPid && e.ppid === towerPid && e.cmdline.includes('shellper-main.js'))!.pid;
    leftovers.push(innerAgent, innerShellper);

    // The outer session's listing (from a different Tower's point of view) never shows any of it.
    const outer: OrphanSessionRef = { workspacePath: workDir, terminalId: 't-outer', agent: 'outer', kind: 'builder', rootPid: root.pid!, jobName: sessionJobName(outerId) };
    const listing = await listOrphans(depsFor(helper, [outer]));
    const cen = await listProcessCensus({ fresh: true });
    for (const orphan of listing.sessions[0].orphans) {
      const e = cen.find((c) => c.pid === orphan.pid);
      console.log(`UNEXPECTED ${JSON.stringify(orphan)} cmd=${e?.cmdline} ppid=${e?.ppid} tower=${towerPid} root=${root.pid}`);
    }
    expect(listing.sessions[0].orphans).toEqual([]);

    // Tearing the outer session down must not take the inner Tower or its session with it.
    const result = await killSessionTree(root.pid!, { jobName: sessionJobName(outerId), terminateJob: (n, p) => helper.terminate(n, p), jobMembers: (n, p) => helper.jobMembers(n, p) });
    // The guard protects it, or, if the job could not be listed, teardown fails closed and leaves the job.
    console.log(`TEARDOWN-GUARD ${result.jobError}`);
    expect(result.jobError).toMatch(/holds Tower or another session's shellper|its processes could not be listed/);
    await waitFor(() => !alive(root.pid!), 10_000, 'the outer root to end');
    await new Promise((r) => setTimeout(r, 1000));
    expect(alive(towerPid)).toBe(true);
    expect(alive(innerShellper)).toBe(true);
    expect(alive(innerAgent)).toBe(true);
    expect(await healthy(port)).toBe(true);
  }, 180_000);
});
