/**
 * Spec 1658 Phase 3, native Windows only (the on-demand `windows.yml` targeted
 * job runs it against the built checkout; it skips everywhere else). Real
 * node -> bash -> node trees, no mocks:
 *
 * - Scenario 6 (teardown): no descendant survives `killSessionTree`, including
 *   when the session root is already dead. Killing a real shellper session
 *   takes its PTY tree with it, including (through the Phase 3b session job) a
 *   descendant whose parent exited first and a Node `detached` child.
 * - Scenario 7 (orphan sweep): an unregistered shellper is detected by the
 *   census-backed sweeps and reaped by the husk sweep.
 * - A porch check that times out has its whole tree killed.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { killSessionTree, waitForTreeExit } from '../lib/process-tree.js';
import { listProcessCensus } from '../agent-farm/servers/process-census.js';
import { isConsoleHostEntry, sweepShellperHusks } from '../agent-farm/servers/shellper-husk-sweep.js';
import { SessionManager } from '../terminal/session-manager.js';
import { WindowsJobHelper } from '../lib/windows-job.js';
import { runCheck } from '../commands/porch/checks.js';

const onWindows = process.platform === 'win32';
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const shellperScript = fileURLToPath(new URL('../../dist/terminal/shellper-main.js', import.meta.url));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-1658-tree-'));
const treeScript = path.join(workDir, 'tree.cjs');
const leftovers: number[] = [];

/**
 * Each process appends its pid to the pid file, then:
 * - root: starts `mid` (through Git Bash in `bash` mode), then idles; in
 *   `reparent` mode it runs `cmd /c start /b` on `leaf`, and cmd exits at once,
 *   so the leaf's parent is dead before teardown (on POSIX the leaf would still
 *   be in the session's process group). A Git Bash `&` does not orphan: MSYS
 *   keeps the backgrounded job's Windows parent alive;
 * - mid: starts `leaf`;
 * - leaf: idles.
 * In `detached` mode root starts `leaf` with `detached: true`. On POSIX that
 * child would leave the session (setsid); on Windows it stays in the session
 * job, because libuv never requests job breakaway. Every other child is
 * non-detached.
 */
fs.writeFileSync(treeScript, `
const { spawn } = require('child_process');
const fs = require('fs');
const [, , role, pidFile, mode] = process.argv;
fs.appendFileSync(pidFile, process.pid + '\\n');
const node = process.execPath;
const fwd = (p) => p.split('\\\\').join('/');
if (role === 'root') {
  if (mode === 'bash') {
    spawn(${JSON.stringify(GIT_BASH)}, ['-c', '"' + fwd(node) + '" "' + fwd(__filename) + '" mid "' + fwd(pidFile) + '" ' + mode], { stdio: 'ignore' });
  } else if (mode === 'detached') {
    spawn(node, [__filename, 'leaf', pidFile, mode], { stdio: 'ignore', detached: true }).unref();
  } else if (mode === 'reparent') {
    fs.appendFileSync(pidFile, '0\\n');
    spawn('cmd.exe', ['/d', '/c', 'start', '""', '/b', node, __filename, 'leaf', pidFile, mode], { stdio: 'ignore', windowsVerbatimArguments: false });
  } else {
    spawn(node, [__filename, 'mid', pidFile, mode], { stdio: 'ignore' });
  }
} else if (role === 'mid') {
  spawn(node, [__filename, 'leaf', pidFile, mode], { stdio: 'ignore' });
}
setInterval(() => {}, 1000);
`);

afterAll(() => {
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
    // Left for the runner's temp cleanup
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
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function readPids(pidFile: string): number[] {
  if (!fs.existsSync(pidFile)) return [];
  return fs.readFileSync(pidFile, 'utf-8').split(/\r?\n/).filter(Boolean).map(Number);
}

/** Start a tree and wait until root, mid and leaf have all reported. */
async function startTree(mode: 'plain' | 'bash' | 'reparent'): Promise<{ rootPid: number; pids: number[] }> {
  const pidFile = path.join(workDir, `pids-${crypto.randomUUID()}.txt`);
  const root = spawn(process.execPath, [treeScript, 'root', pidFile, mode], { stdio: 'ignore' });
  root.unref();
  await waitFor(() => readPids(pidFile).length >= 3, 20_000, `${mode} tree to start`);
  const pids = readPids(pidFile);
  leftovers.push(...pids.filter((pid) => pid > 0));
  return { rootPid: root.pid!, pids };
}

async function expectAllGone(pids: number[]): Promise<void> {
  await waitFor(() => pids.every((pid) => !alive(pid)), 10_000, `pids ${pids.join(',')} to exit`);
  const census = await listProcessCensus({ fresh: true });
  expect(census.filter((entry) => pids.includes(entry.pid))).toEqual([]);
}

describe.skipIf(!onWindows)('session-tree teardown on real Windows process trees', () => {
  it('scenario 6: kills a node -> bash -> node tree with no survivors', async () => {
    const { rootPid, pids } = await startTree('bash');
    const { signaled, snapshot } = await killSessionTree(rootPid);
    expect(signaled).toBe(true);
    // The snapshot holds the Git Bash layer too, not only the processes that reported.
    expect(snapshot.members.length).toBeGreaterThan(pids.length);
    expect(await waitForTreeExit(rootPid, snapshot, 10_000)).toBe(true);
    await expectAllGone([...pids, ...snapshot.members.map((m) => m.pid)]);
  }, 60_000);

  it('scenario 6: clears the descendants when the session root is already dead', async () => {
    const { rootPid, pids } = await startTree('plain');
    process.kill(rootPid, 'SIGKILL');
    await waitFor(() => !alive(rootPid), 10_000, 'root to exit');

    // libuv places a Node process's non-detached children in a kill-on-close
    // job, so they may already have died with the root; whatever is left must go.
    await killSessionTree(rootPid);
    await expectAllGone(pids);
  }, 60_000);

  // Run 39574693242 found the gap: a descendant orphaned by a non-Node launcher
  // (`cmd start /b`) has a dead parent pid, so neither the pre-kill snapshot
  // nor `taskkill /T` can link it to its root. A bare `killSessionTree` on such
  // a tree still misses it; inside a shellper session, the per-session Job
  // Object (Phase 3b) ends it. The setup is checked before teardown, so a
  // broken setup cannot pass as a fix.
  it('scenario 6: a session descendant whose parent exited first (re-parented) does not survive killSession', async () => {
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-1658-reparent-'));
    const jobHelper = new WindowsJobHelper({ log: (msg) => console.log(`[job-helper] ${msg}`) });
    const manager = new SessionManager({ socketDir, shellperScript, nodeExecutable: process.execPath, jobHelper: () => jobHelper });
    try {
      const pidFile = path.join(workDir, `pids-${crypto.randomUUID()}.txt`);
      const sessionId = crypto.randomUUID();
      await manager.createSession({
        sessionId,
        command: process.execPath,
        args: [treeScript, 'root', pidFile, 'reparent'],
        cwd: workDir,
        env: process.env as Record<string, string>,
        cols: 80,
        rows: 24,
      });
      await waitFor(() => readPids(pidFile).length >= 3, 20_000, 'session tree to start');
      const shellperPid = manager.getSessionInfo(sessionId)!.pid;
      const [rootPid, , leafPid] = readPids(pidFile);
      leftovers.push(shellperPid, rootPid, leafPid);

      const census = await listProcessCensus({ fresh: true });
      const leaf = census.find((entry) => entry.pid === leafPid);
      const midPid = leaf?.ppid ?? -1;
      await waitFor(() => !alive(midPid), 10_000, `intermediate (pid ${midPid}) to exit`);
      expect(alive(leafPid)).toBe(true);

      await manager.killSession(sessionId);
      await expectAllGone([shellperPid, rootPid, leafPid]);
    } finally {
      jobHelper.stop();
    }
  }, 90_000);

  it('scenario 6: a Node detached child ends with its session (no setsid parity on Windows)', async () => {
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-1658-detached-'));
    const jobHelper = new WindowsJobHelper();
    const manager = new SessionManager({ socketDir, shellperScript, nodeExecutable: process.execPath, jobHelper: () => jobHelper });
    try {
      const pidFile = path.join(workDir, `pids-${crypto.randomUUID()}.txt`);
      const sessionId = crypto.randomUUID();
      await manager.createSession({
        sessionId,
        command: process.execPath,
        args: [treeScript, 'root', pidFile, 'detached'],
        cwd: workDir,
        env: process.env as Record<string, string>,
        cols: 80,
        rows: 24,
      });
      await waitFor(() => readPids(pidFile).length >= 2, 20_000, 'session tree to start');
      const shellperPid = manager.getSessionInfo(sessionId)!.pid;
      const [rootPid, detachedPid] = readPids(pidFile);
      leftovers.push(shellperPid, rootPid, detachedPid);

      await manager.killSession(sessionId);
      await expectAllGone([shellperPid, rootPid, detachedPid]);
    } finally {
      jobHelper.stop();
    }
  }, 90_000);

  it('a job helper exit (Tower restart) does not kill a running session; a one-shot helper still ends its job', async () => {
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-1658-helper-exit-'));
    const jobHelper = new WindowsJobHelper();
    const manager = new SessionManager({ socketDir, shellperScript, nodeExecutable: process.execPath, jobHelper: () => jobHelper });
    const pidFile = path.join(workDir, `pids-${crypto.randomUUID()}.txt`);
    const sessionId = crypto.randomUUID();
    await manager.createSession({
      sessionId,
      command: process.execPath,
      args: [treeScript, 'root', pidFile, 'reparent'],
      cwd: workDir,
      env: process.env as Record<string, string>,
      cols: 80,
      rows: 24,
    });
    await waitFor(() => readPids(pidFile).length >= 3, 20_000, 'session tree to start');
    const shellperPid = manager.getSessionInfo(sessionId)!.pid;
    const [rootPid, , leafPid] = readPids(pidFile);
    leftovers.push(shellperPid, rootPid, leafPid);

    jobHelper.stop();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect([shellperPid, rootPid, leafPid].filter(alive)).toEqual([shellperPid, rootPid, leafPid]);

    // No Tower helper is registered in this process, so teardown starts a
    // one-shot helper, which finds the job by name (the shellper holds it open).
    await manager.killSession(sessionId);
    await expectAllGone([shellperPid, rootPid, leafPid]);
  }, 90_000);

  it('scenario 6: killing a real shellper session takes its PTY tree with it', async () => {
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-1658-sess-'));
    const manager = new SessionManager({ socketDir, shellperScript, nodeExecutable: process.execPath });
    const pidFile = path.join(workDir, `pids-${crypto.randomUUID()}.txt`);
    const sessionId = crypto.randomUUID();
    await manager.createSession({
      sessionId,
      command: process.execPath,
      args: [treeScript, 'root', pidFile, 'bash'],
      cwd: workDir,
      env: process.env as Record<string, string>,
      cols: 80,
      rows: 24,
    });
    await waitFor(() => readPids(pidFile).length >= 3, 20_000, 'session tree to start');
    const shellperPid = manager.getSessionInfo(sessionId)!.pid;
    const pids = readPids(pidFile);
    leftovers.push(shellperPid, ...pids);

    await manager.killSession(sessionId);
    await expectAllGone([shellperPid, ...pids]);
  }, 90_000);

  it('scenario 7: an unregistered shellper husk is detected and reaped', async () => {
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-1658-husk-'));
    const first = new SessionManager({ socketDir, shellperScript, nodeExecutable: process.execPath });
    const sessionId = crypto.randomUUID();
    const client = await first.createSession({
      sessionId,
      command: 'cmd.exe',
      args: ['/d', '/c', 'exit 0'],
      cwd: workDir,
      env: process.env as Record<string, string>,
      cols: 80,
      rows: 24,
    });
    expect(client).toBeDefined();
    const shellperPid = first.getSessionInfo(sessionId)!.pid;
    leftovers.push(shellperPid);
    // The PTY child exits; the shellper lingers (a husk). Tower "crashes".
    let children: string[] = [];
    const deadline = Date.now() + 20_000;
    for (;;) {
      const census = await listProcessCensus({ fresh: true });
      children = census.filter((entry) => entry.ppid === shellperPid && !isConsoleHostEntry(entry)).map((entry) => `${entry.pid} ${entry.cmdline}`);
      if (children.length === 0) break;
      if (Date.now() > deadline) throw new Error(`shellper ${shellperPid} still has children: ${children.join(' | ')}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    first.shutdown();

    const db = new Database(':memory:');
    db.exec('CREATE TABLE terminal_sessions (shellper_pid INTEGER, shellper_start_time INTEGER)');
    const result = await sweepShellperHusks({ socketDir, db, graceMs: 0, now: Date.now() + 1000 });
    expect(result.pids).toEqual([shellperPid]);
    await waitFor(() => !alive(shellperPid), 15_000, 'husk to be reaped');
  }, 90_000);

  it('a porch check that times out has its whole tree killed', async () => {
    const pidFile = path.join(workDir, `pids-${crypto.randomUUID()}.txt`);
    const started = Date.now();
    const result = await runCheck(
      'tree',
      // A check string is a bash string (it runs in Git Bash, Spec 1658 Phase 6):
      // single quotes keep a Windows path's backslashes.
      `'${process.execPath}' '${treeScript}' root '${pidFile}' plain`,
      workDir,
      { PROJECT_ID: '1658', PROJECT_TITLE: 'tree' },
      5_000,
    );
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/Timed out/);
    expect(Date.now() - started).toBeLessThan(30_000);
    const pids = readPids(pidFile);
    expect(pids.length).toBeGreaterThanOrEqual(3);
    leftovers.push(...pids);
    await expectAllGone(pids);
  }, 60_000);
});
