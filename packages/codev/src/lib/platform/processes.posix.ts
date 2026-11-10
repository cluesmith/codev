/**
 * Processes on macOS and Linux (Spec 1658, Amendment 2, phase A2-3).
 *
 * The POSIX branches of `listProcessCensus`, `getProcessStartTime`,
 * `getProcessesOnPort`, `killSessionTree` and `waitForTreeExit`, moved
 * verbatim. See `processes.ts` for the contract.
 */

import { execFile, execSync } from 'node:child_process';
import fs from 'node:fs';
import type { ProcessCensusEntry } from '../../agent-farm/servers/process-census.js';
import type { KillSessionTreeOptions, KillSessionTreeResult } from '../process-tree.js';
import type { Processes } from './processes.js';

function defaultKill(pid: number, signal: NodeJS.Signals | 0): void {
  process.kill(pid, signal);
}

function parseCensus(out: string): ProcessCensusEntry[] {
  const entries: ProcessCensusEntry[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed) continue;
    const fields = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/s);
    if (!fields) continue;
    const pid = parseInt(fields[1], 10);
    const ppid = parseInt(fields[2], 10);
    const rssKb = parseInt(fields[3], 10);
    if (Number.isNaN(pid) || pid <= 0 || Number.isNaN(ppid) || Number.isNaN(rssKb)) continue;
    entries.push({ pid, ppid, rssKb, cmdline: fields[4] });
  }
  return entries;
}

/**
 * POSIX provider: snapshot every running process as {pid, ppid, rssKb,
 * cmdline}. `ps -ww` prevents argv truncation (shellper config blobs are large)
 * on both BSD and coreutils `ps`. Resolves to `[]` on `ps` failure (missing
 * binary, timeout, non-zero exit) — callers decide how to degrade, mirroring
 * the async `findShellperProcesses` convention in
 * `../../terminal/session-manager.ts`.
 *
 * Deliberately raw `execFile` + a hand-rolled Promise, not `execFileSync` and
 * not `util.promisify(execFile)`: this is called from `/health`
 * (tower-routes.ts), a hot Tower HTTP path, so it must never block the event
 * loop — `execFileSync` would freeze every open terminal's WebSocket traffic
 * for the duration of the `ps` call, the exact previously-fixed anti-pattern
 * documented at lessons-learned.md:160. `util.promisify` is avoided because
 * `child_process.execFile` carries a built-in custom promisify resolving
 * `{stdout, stderr}` via a non-standard symbol that a test mock would need to
 * reproduce exactly to avoid silently promisifying to the wrong shape.
 */
function listPosixCensus(): Promise<ProcessCensusEntry[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-ww', '-eo', 'pid=,ppid=,rss=,args='], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) {
        resolve([]);
        return;
      }
      resolve(parseCensus(stdout));
    });
  });
}

/**
 * Get the start time of a process by PID.
 * Returns epoch milliseconds, or null if the process doesn't exist or can't be queried.
 *
 * Platform-specific:
 * - macOS: parse `ps -p {pid} -o lstart=`
 * - Linux: read `/proc/{pid}/stat` field 22 (starttime in clock ticks)
 */
function getProcessStartTime(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    try {
    if (process.platform === 'darwin') {
      // macOS: use ps to get launch time
      execFile('ps', ['-p', String(pid), '-o', 'lstart='], (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null);
          return;
        }
        const date = new Date(stdout.trim());
        if (isNaN(date.getTime())) {
          resolve(null);
          return;
        }
        resolve(date.getTime());
      });
    } else if (process.platform === 'linux') {
      // Linux: read /proc/{pid}/stat and parse starttime (field 22)
      fs.readFile(`/proc/${pid}/stat`, 'utf-8', (err, data) => {
        if (err) {
          resolve(null);
          return;
        }
        // Fields in /proc/PID/stat are space-separated, but field 2 (comm) may
        // contain spaces in parentheses. Find the last ')' to skip past it.
        const closeParenIdx = data.lastIndexOf(')');
        if (closeParenIdx === -1) {
          resolve(null);
          return;
        }
        const fields = data.substring(closeParenIdx + 2).split(' ');
        // Field 22 is starttime, but after stripping comm it's at index 19
        // (fields 3-51, so starttime = field 22 → index 22-3 = 19)
        const startTimeTicks = parseInt(fields[19], 10);
        if (isNaN(startTimeTicks)) {
          resolve(null);
          return;
        }
        // Convert clock ticks to ms: we need the system boot time + starttime
        // This is complex — use a simpler approach via /proc/PID/stat creation time
        fs.stat(`/proc/${pid}`, (statErr, stat) => {
          if (statErr) {
            resolve(null);
            return;
          }
          // /proc/PID directory creation time approximates process start time
          resolve(stat.ctimeMs);
        });
      });
    } else {
      resolve(null);
    }
    } catch {
      // Defensive: if execFile/readFile throws synchronously (e.g., EPERM
      // in restricted environments), return null instead of rejecting.
      resolve(null);
    }
  });
}

function getProcessesOnPort(port: number): number[] {
  try {
    const result = execSync(`lsof -ti :${port} -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf-8' });
    return result
      .trim()
      .split('\n')
      .map((line) => parseInt(line, 10))
      .filter((pid) => !isNaN(pid));
  } catch {
    return [];
  }
}


function killPosixGroup(rootPid: number, opts: KillSessionTreeOptions): KillSessionTreeResult {
  const kill = opts.kill ?? defaultKill;
  const signal = opts.signal ?? 'SIGTERM';
  let signaled = false;
  try {
    kill(-rootPid, signal);
    signaled = true;
  } catch {
    if (opts.fallbackToPid) {
      try {
        kill(rootPid, signal);
        signaled = true;
      } catch {
        // Already dead
      }
    }
  }
  if (signaled && opts.escalateAfterMs !== undefined) {
    setTimeout(() => {
      try {
        kill(-rootPid, 'SIGKILL');
      } catch {
        // Already dead
      }
    }, opts.escalateAfterMs);
  }
  return { signaled, snapshot: { rootPid, members: [] } };
}


export const posixProcesses: Processes = Object.freeze<Processes>({
  census() {
    return listPosixCensus();
  },

  startTime: getProcessStartTime,

  startTimeLookup() {
    // Per-PID `getProcessStartTime`: the POSIX census carries no creation time.
    return getProcessStartTime;
  },

  listeningPids: getProcessesOnPort,

  listeningPidsAsync(port) {
    return Promise.resolve(getProcessesOnPort(port));
  },

  killTree(rootPid, opts) {
    // Synchronous: the signals leave in the same tick as the old inline
    // `process.kill(-pid)` calls, before the returned promise settles.
    return Promise.resolve(killPosixGroup(rootPid, opts));
  },

  async waitForTreeExit(rootPid, _snapshot, timeoutMs, opts) {
    // Probes the process group (`process.kill(-rootPid, 0)`); the snapshot is unused.
    const pollMs = opts.pollMs ?? 100;
    const kill = opts.kill ?? defaultKill;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        kill(-rootPid, 0);
      } catch {
        return true; // Group is empty
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  },

  isConsoleInfrastructure() {
    return false;
  },
});
