/**
 * Spec 1658 Phase 3b, native Windows only (the on-demand `windows.yml` targeted
 * job; it skips everywhere else). The real helper against real processes:
 *
 * - Cost gate: cold helper start (PowerShell start plus the in-memory bind) and
 *   the warm per-session assign round trip, printed as `JOB-COST` lines for the
 *   audit. The warm assign must stay under 1s.
 * - Assignment works while the target already sits in the runner's job (nested).
 * - A job name that already exists is never joined.
 * - Terminating the job ends a `cmd start /b` orphan that has no live parent,
 *   and a Node `detached: true` child (libuv never requests breakaway).
 * - A CIM `Win32_Process.Create` launch from inside the job escapes it (the
 *   mechanism Phase 4's daemon start relies on).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WindowsJobHelper, sessionJobName } from '../lib/windows-job.js';
import { listProcessCensus } from '../agent-farm/servers/process-census.js';

const onWindows = process.platform === 'win32';
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-1658-job-'));
const leftovers: number[] = [];
const helpers: WindowsJobHelper[] = [];

/**
 * `root` appends its pid, then in `orphan` mode runs `cmd /c start /b` on a
 * leaf (cmd exits at once, so the leaf's parent is dead), and in `detached`
 * mode spawns a detached leaf. Children append their pids too.
 */
const treeScript = path.join(workDir, 'tree.cjs');
fs.writeFileSync(treeScript, `
const { spawn } = require('child_process');
const fs = require('fs');
const [, , role, pidFile] = process.argv;
fs.appendFileSync(pidFile, role + ' ' + process.pid + '\\n');
if (role === 'orphan') {
  spawn('cmd.exe', ['/d', '/c', 'start', '""', '/b', process.execPath, __filename, 'leaf', pidFile], { stdio: 'ignore' });
} else if (role === 'detached') {
  spawn(process.execPath, [__filename, 'leaf-detached', pidFile], { stdio: 'ignore', detached: true }).unref();
}
setInterval(() => {}, 1000);
`);

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
    // Best effort
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

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
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

/** An idle node process to put in a job; leaves its own children alone. */
function idleProcess(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true });
  leftovers.push(child.pid!);
  return child;
}

const jobName = () => sessionJobName(`test-${crypto.randomUUID()}`);

describe.skipIf(!onWindows)('per-session job objects (native Windows)', () => {
  it('cost gate: cold start and warm assign round trip', async () => {
    const coldStarted = Date.now();
    const helper = newHelper();
    expect(await helper.start()).toBeNull();
    const coldMs = Date.now() - coldStarted;

    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const child = idleProcess();
      const started = Date.now();
      const outcome = await helper.assign(jobName(), child.pid!);
      samples.push(Date.now() - started);
      expect(outcome).toEqual({ assigned: true });
    }
    const warmMax = Math.max(...samples);
    console.log(`JOB-COST cold_start_bind_ms=${coldMs} warm_assign_ms=${samples.join(',')} warm_max_ms=${warmMax}`);

    // A second cold start in the same run, for a warm-cache PowerShell figure.
    const secondStarted = Date.now();
    const second = newHelper();
    expect(await second.start()).toBeNull();
    console.log(`JOB-COST second_cold_start_bind_ms=${Date.now() - secondStarted}`);

    expect(warmMax).toBeLessThan(1000);
  }, 120_000);

  it('assigns a process that already sits in the runner job (nested), or reports why not', async () => {
    const helper = newHelper();
    // A non-detached child stays in libuv's kill-on-close job, itself inside the
    // runner's job: assigning it needs nested jobs. (A detached child breaks away.)
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    leftovers.push(child.pid!);
    const outcome = await helper.assign(jobName(), child.pid!);
    console.log(`JOB-NESTED outcome=${JSON.stringify(outcome)}`);
    expect(outcome).toEqual({ assigned: true });
  }, 60_000);

  it('refuses to join a job name that already exists, and never terminates it for a non-member', async () => {
    const helper = newHelper();
    const name = jobName();
    const owner = idleProcess();
    const latecomer = idleProcess();
    expect(await helper.assign(name, owner.pid!)).toEqual({ assigned: true });
    const second = await helper.assign(name, latecomer.pid!);
    expect(second.assigned).toBe(false);
    if (!second.assigned) expect(second.reason).toMatch(/already exists/);

    // The latecomer's teardown names the same job, which is not its own.
    expect(await helper.terminate(name, latecomer.pid!)).toEqual({ ok: true, found: true, member: false });
    await new Promise((r) => setTimeout(r, 1000));
    expect(alive(owner.pid!)).toBe(true);
  }, 60_000);

  it('terminating the job ends a cmd start /b orphan and a Node detached child', async () => {
    const helper = newHelper();
    const name = jobName();
    const pidFile = path.join(workDir, `pids-${crypto.randomUUID()}.txt`);

    // Assign the root before it starts anything, as Tower does before the PTY exists:
    // a paused root would be ideal, but a root that starts its children after a delay
    // is equivalent here. The `gate` file releases it.
    const gate = path.join(workDir, `gate-${crypto.randomUUID()}`);
    const root = spawn(process.execPath, ['-e', `
      const fs = require('fs');
      const { spawn } = require('child_process');
      const wait = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(gate)})) return;
        clearInterval(wait);
        spawn(process.execPath, [${JSON.stringify(treeScript)}, 'orphan', ${JSON.stringify(pidFile)}], { stdio: 'ignore' });
        spawn(process.execPath, [${JSON.stringify(treeScript)}, 'detached', ${JSON.stringify(pidFile)}], { stdio: 'ignore' });
      }, 50);
      setInterval(() => {}, 1000);
    `], { stdio: 'ignore', detached: true, windowsHide: true });
    leftovers.push(root.pid!);

    expect(await helper.assign(name, root.pid!)).toEqual({ assigned: true });
    fs.writeFileSync(gate, '');

    expect(await waitFor(() => {
      const pids = readPids(pidFile);
      return pids.has('leaf') && pids.has('leaf-detached') && pids.has('orphan') && pids.has('detached');
    }, 20_000)).toBe(true);
    const pids = readPids(pidFile);
    for (const pid of pids.values()) leftovers.push(pid);

    // The setup this test exists for: the orphan leaf's parent (cmd) is gone.
    const census = await listProcessCensus({ fresh: true });
    const leaf = census.find((entry) => entry.pid === pids.get('leaf'));
    expect(leaf).toBeDefined();
    expect(census.some((entry) => entry.pid === leaf!.ppid)).toBe(false);

    expect(await helper.terminate(name, root.pid!)).toEqual({ ok: true, found: true, member: true });

    expect(await waitFor(() => !alive(root.pid!) && !alive(pids.get('leaf')!) && !alive(pids.get('orphan')!), 10_000)).toBe(true);
    // libuv never requests CREATE_BREAKAWAY_FROM_JOB, so a Node detached child
    // stays in the job and ends with it (no setsid parity; architect ruling).
    expect(await waitFor(() => !alive(pids.get('leaf-detached')!), 10_000)).toBe(true);
  }, 90_000);

  it('a CIM Win32_Process.Create launch from inside a session job escapes it', async () => {
    const helper = newHelper();
    const name = jobName();
    const pidFile = path.join(workDir, `cim-${crypto.randomUUID()}.txt`);
    const gate = path.join(workDir, `gate-${crypto.randomUUID()}`);
    const leafCmd = `"${process.execPath}" "${treeScript}" cim-leaf "${pidFile}"`;
    const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${leafCmd.replace(/'/g, "''")}' }; exit $r.ReturnValue`;
    const root = spawn(process.execPath, ['-e', `
      const fs = require('fs');
      const { spawn } = require('child_process');
      const wait = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(gate)})) return;
        clearInterval(wait);
        spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ${JSON.stringify(ps)}], { stdio: 'ignore', windowsHide: true });
      }, 50);
      setInterval(() => {}, 1000);
    `], { stdio: 'ignore', detached: true, windowsHide: true });
    leftovers.push(root.pid!);
    expect(await helper.assign(name, root.pid!)).toEqual({ assigned: true });
    fs.writeFileSync(gate, '');

    expect(await waitFor(() => readPids(pidFile).has('cim-leaf'), 30_000)).toBe(true);
    const leafPid = readPids(pidFile).get('cim-leaf')!;
    leftovers.push(leafPid);

    expect(await helper.terminate(name, root.pid!)).toEqual({ ok: true, found: true, member: true });
    expect(await waitFor(() => !alive(root.pid!), 10_000)).toBe(true);
    // Created by the WMI provider host, so never in the caller's job.
    await new Promise((r) => setTimeout(r, 1000));
    expect(alive(leafPid)).toBe(true);
  }, 90_000);

  it('a stopped helper (Tower restart) does not kill a job member, and a new helper still finds the job by name', async () => {
    const helper = newHelper();
    const child = idleProcess();
    const name = jobName();
    expect(await helper.assign(name, child.pid!)).toEqual({ assigned: true });
    helper.stop();
    await new Promise((r) => setTimeout(r, 2000));
    expect(alive(child.pid!)).toBe(true);

    const next = newHelper();
    expect(await next.terminate(name, child.pid!)).toEqual({ ok: true, found: true, member: true });
    expect(await waitFor(() => !alive(child.pid!), 10_000)).toBe(true);
  }, 60_000);

  it('terminate of an unknown job reports found:false', async () => {
    const helper = newHelper();
    expect(await helper.terminate(jobName(), process.pid)).toEqual({ ok: true, found: false });
  }, 60_000);
});
