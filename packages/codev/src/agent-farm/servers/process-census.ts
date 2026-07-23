/**
 * Issue #1227: a shared single-`ps`-call process snapshot, reused by both the
 * shellper husk sweep (predicate needs pid/ppid to detect "childless") and the
 * fleet-RSS observability feature (needs rss). Centralizing the scan avoids
 * growing a fourth bespoke `ps` caller alongside the three that already exist
 * (session-manager.ts, architect-session-holder.ts, commands/cleanup.ts).
 *
 * Async (`execFile`, not `execFileSync`) is load-bearing, not a style choice:
 * this is called from `/health` (tower-routes.ts), a hot Tower HTTP path.
 * `execFileSync` blocks the entire Node.js event loop for the duration of the
 * `ps` call, freezing every open terminal's WebSocket traffic — the exact
 * previously-fixed anti-pattern documented at lessons-learned.md:160
 * ("execSync in HTTP request handlers blocks the entire Node.js event loop").
 */

import { execFile } from 'node:child_process';

export interface ProcessCensusEntry {
  pid: number;
  ppid: number;
  /** Resident set size in kilobytes, as `ps -o rss=` reports it. */
  rssKb: number;
  /** The full joined argv (as `ps ... -o args=` reports it). */
  cmdline: string;
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
 * Snapshot every running process as {pid, ppid, rssKb, cmdline}. `ps -ww`
 * prevents argv truncation (shellper config blobs are large) on both BSD and
 * coreutils `ps`. Resolves to `[]` on `ps` failure (missing binary, timeout,
 * non-zero exit) — callers decide how to degrade, mirroring the async
 * `findShellperProcesses` convention in `../../terminal/session-manager.ts`.
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
export function listProcessCensus(): Promise<ProcessCensusEntry[]> {
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
