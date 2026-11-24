/**
 * #1915, native Windows only (the on-demand `windows.yml` targeted job runs it
 * against the built checkout; it skips everywhere else). Real shellper
 * sessions in real per-session jobs, which allow no breakaway:
 *
 * - A command's child whose parent has exited (what a timed-out agent command
 *   leaves behind) ends when its session is closed; a process outside every
 *   session job survives.
 * - A Tower started inside a session (not through `afx tower start`, which
 *   uses CIM) refuses to run, whether or not the session marker is set: it
 *   would be in that session's job, and ending the session would end it.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { trackedPids } from './helpers/tracked-pids.js';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '../terminal/session-manager.js';
import { WindowsJobHelper } from '../lib/platform/windows/job-objects.js';
import { resolveGitBash } from '../lib/platform/windows/git-bash.js';

const onWindows = process.platform === 'win32';
const shellperScript = fileURLToPath(new URL('../../dist/terminal/shellper-main.js', import.meta.url));
const towerServer = fileURLToPath(new URL('../../dist/agent-farm/servers/tower-server.js', import.meta.url));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-1915-containment-'));
const leftovers = trackedPids();
const helpers: WindowsJobHelper[] = [];
const managers: Array<{ manager: SessionManager; sessionId: string }> = [];

/** Appends `<role> <pid>` to the pid file, then idles. */
const leafScript = path.join(workDir, 'leaf.cjs');
fs.writeFileSync(leafScript, `
require('fs').appendFileSync(process.argv[3], process.argv[2] + ' ' + process.pid + '\\n');
setInterval(() => {}, 1000);
`);

afterAll(async () => {
  for (const { manager, sessionId } of managers) {
    await manager.killSession(sessionId).catch(() => {});
  }
  for (const helper of helpers) helper.stop();
  await leftovers.killSurvivors();
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    // A just-killed process may still hold a handle
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
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

const unix = (p: string) => p.replace(/\\/g, '/');

async function startSession(command: string, args: string[]): Promise<{ manager: SessionManager; sessionId: string; shellperPid: number }> {
  const helper = new WindowsJobHelper({ log: (m) => console.log(`[job-helper] ${m}`) });
  helpers.push(helper);
  expect(await helper.start()).toBeNull();
  const manager = new SessionManager({ socketDir: path.join(workDir, `run-${crypto.randomUUID()}`), shellperScript, nodeExecutable: process.execPath, jobHelper: () => helper });
  const sessionId = crypto.randomUUID();
  await manager.createSession({ sessionId, command, args, cwd: workDir, env: process.env as Record<string, string>, cols: 80, rows: 24 });
  managers.push({ manager, sessionId });
  const shellperPid = manager.getSessionInfo(sessionId)!.pid;
  leftovers.push(shellperPid);
  return { manager, sessionId, shellperPid };
}

describe.skipIf(!onWindows)('session job containment (native Windows)', () => {
  it('closing a session ends a child whose parent exited; a process outside every session job survives', async () => {
    const pidFile = path.join(workDir, `session-${crypto.randomUUID()}.txt`);
    const node = unix(process.execPath);
    // The subshell exits at once, so the leaf's parent chain is broken: what a timed-out command leaves.
    const script = `( "${node}" "${unix(leafScript)}" leaf "${unix(pidFile)}" & ) ; "${node}" "${unix(leafScript)}" shell-child "${unix(pidFile)}"`;
    const { manager, sessionId, shellperPid } = await startSession(resolveGitBash().path, ['-c', script]);
    await waitFor(() => readPids(pidFile).has('leaf') && readPids(pidFile).has('shell-child'), 30_000, 'the session to start its processes');
    const leaf = readPids(pidFile).get('leaf')!;
    const shellChild = readPids(pidFile).get('shell-child')!;
    leftovers.push(leaf, shellChild);

    const outsidePids = path.join(workDir, `outside-${crypto.randomUUID()}.txt`);
    spawn('cmd.exe', ['/d', '/c', 'start', '""', '/b', process.execPath, leafScript, 'outside', outsidePids], { stdio: 'ignore', windowsHide: true });
    await waitFor(() => readPids(outsidePids).has('outside'), 20_000, 'the outside process');
    const outside = readPids(outsidePids).get('outside')!;
    leftovers.push(outside);

    await manager.killSession(sessionId);
    await waitFor(() => !alive(leaf) && !alive(shellChild) && !alive(shellperPid), 15_000, 'the session and its leftover to end');
    expect(alive(outside)).toBe(true);
  }, 120_000);

  for (const withMarker of [true, false]) {
    it(`a Tower started inside a session refuses to run (session marker ${withMarker ? 'set' : 'cleared'})`, async () => {
      const stateDir = fs.mkdtempSync(path.join(workDir, 'tower-'));
      const port = await freePort();
      const exitFile = path.join(stateDir, 'exit.txt');
      const logFile = path.join(stateDir, 'tower.log');
      // The session's command starts Tower the unsupported way (a plain spawn), with its
      // own state, and records how it exited. The shellper sets the marker in the session.
      const launcher = `
        const env = { ...process.env, CODEV_AGENT_FARM_DIR: ${JSON.stringify(stateDir)}, SHELLPER_SOCKET_DIR: ${JSON.stringify(path.join(stateDir, 'run'))} };
        delete env.NODE_ENV;
        ${withMarker ? '' : 'delete env.CODEV_SHELLPER_SESSION;'}
        const t = require('child_process').spawn(process.execPath, [${JSON.stringify(towerServer)}, '${port}', '--log-file', ${JSON.stringify(logFile)}], { stdio: 'ignore', env });
        t.on('exit', (code) => require('fs').writeFileSync(${JSON.stringify(exitFile)}, String(code)));
        setInterval(() => {}, 1000);
      `;
      await startSession(process.execPath, ['-e', launcher]);
      await waitFor(() => fs.existsSync(exitFile), 90_000, 'the Tower to exit');
      expect(fs.readFileSync(exitFile, 'utf8')).toBe('1');
      expect(fs.readFileSync(logFile, 'utf8')).toContain("Tower refuses to run inside a codev session's job");
    }, 150_000);
  }
});
