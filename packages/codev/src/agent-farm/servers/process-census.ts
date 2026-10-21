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
import { isWindows } from '../../lib/platform.js';

export interface ProcessCensusEntry {
  pid: number;
  ppid: number;
  /** Resident set size in kilobytes, as `ps -o rss=` reports it (working set on Windows). */
  rssKb: number;
  /**
   * The full joined argv (as `ps ... -o args=` reports it). On Windows this is
   * the raw command line, still carrying its argv quoting; a process whose
   * command line the current user cannot read reports `''` ("not ours").
   */
  cmdline: string;
  /**
   * Process creation time, epoch ms. Set by the Windows provider (Spec 1658),
   * where it is what tells a live PID from a reused one; the POSIX provider
   * leaves it unset and callers use `getProcessStartTime` there.
   */
  creationTime?: number;
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

// ============================================================================
// Windows provider (Spec 1658)
// ============================================================================

/**
 * Inline CIM query: pid, ppid, command line, creation time (UTC ISO-8601) and
 * working set, as one compact JSON document. Single quotes only, so the command
 * survives Windows argv quoting unchanged; UTF-8 output so a non-ASCII path in
 * a command line is not mangled by the console code page. Inline commands are
 * not governed by script execution policy.
 */
export const WINDOWS_CENSUS_QUERY = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; '
  + 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,'
  + "@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}},WorkingSetSize"
  + ' | ConvertTo-Json -Compress';

/**
 * Measured on windows-latest and the owner machine (audit 1.3): a warm query
 * takes about 0.5 s and the first one in a fresh PowerShell up to 4.3 s. The
 * timeout leaves room for a cold query on a loaded machine.
 */
export const WINDOWS_CENSUS_TIMEOUT_MS = 10_000;

/**
 * How long a Windows census result is reused. `/health` awaits the census, and
 * a warm query costs ~10x `ps -A`, so back-to-back callers inside this window
 * share one snapshot. Short enough that a sweep never acts on a stale table:
 * every kill decision is re-checked against creation time.
 */
export const WINDOWS_CENSUS_TTL_MS = 2_000;

interface CimProcess {
  ProcessId?: unknown;
  ParentProcessId?: unknown;
  CommandLine?: unknown;
  CreationDate?: unknown;
  WorkingSetSize?: unknown;
}

/**
 * Parse the CIM query's JSON. `ConvertTo-Json` emits an object rather than an
 * array when there is exactly one row, and nothing at all when there are none.
 * Throws on output that is not the expected JSON: on Windows a census failure
 * is reported, never read as an empty process table.
 */
export function parseWindowsCensus(out: string): ProcessCensusEntry[] {
  const text = out.replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  const parsed: unknown = JSON.parse(text);
  const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const entries: ProcessCensusEntry[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const cim = row as CimProcess;
    const pid = Number(cim.ProcessId);
    const ppid = Number(cim.ParentProcessId);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) continue;
    const entry: ProcessCensusEntry = {
      pid,
      ppid,
      rssKb: Math.round((Number(cim.WorkingSetSize) || 0) / 1024),
      cmdline: typeof cim.CommandLine === 'string' ? cim.CommandLine : '',
    };
    if (typeof cim.CreationDate === 'string') {
      const creationTime = Date.parse(cim.CreationDate);
      if (!Number.isNaN(creationTime)) entry.creationTime = creationTime;
    }
    entries.push(entry);
  }
  return entries;
}

/** Runs one PowerShell command and resolves to its stdout. */
export type PowerShellExec = (command: string, timeoutMs: number) => Promise<string>;

const runPowerShell: PowerShellExec = (command, timeoutMs) => new Promise((resolve, reject) => {
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    (err, stdout) => {
      if (err) {
        reject(new Error(`process census failed (PowerShell CIM query): ${err.message}`));
        return;
      }
      resolve(String(stdout));
    },
  );
});

export interface WindowsCensusProviderOptions {
  exec?: PowerShellExec;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * A Windows census with a short TTL cache and single-flight coalescing: callers
 * arriving while a query is in flight share it, and callers inside the TTL get
 * the last result without spawning PowerShell. A failed query is not cached.
 */
export function createWindowsCensusProvider(opts: WindowsCensusProviderOptions = {}): () => Promise<ProcessCensusEntry[]> {
  const exec = opts.exec ?? runPowerShell;
  const ttlMs = opts.ttlMs ?? WINDOWS_CENSUS_TTL_MS;
  const timeoutMs = opts.timeoutMs ?? WINDOWS_CENSUS_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  let cached: { at: number; entries: ProcessCensusEntry[] } | null = null;
  let inFlight: Promise<ProcessCensusEntry[]> | null = null;

  return () => {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.entries);
    if (inFlight) return inFlight;
    const query = exec(WINDOWS_CENSUS_QUERY, timeoutMs).then((out) => {
      const entries = parseWindowsCensus(out);
      cached = { at: now(), entries };
      return entries;
    });
    inFlight = query.finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

const windowsCensus = createWindowsCensusProvider();

/**
 * Snapshot every running process. POSIX resolves to `[]` when `ps` fails (see
 * `listPosixCensus`). On Windows a failure REJECTS: the census is load-bearing
 * for teardown and the sweeps (Spec 1658), so an unreadable process table must
 * surface as an error rather than look like a machine with no processes.
 */
export function listProcessCensus(): Promise<ProcessCensusEntry[]> {
  if (isWindows()) return windowsCensus();
  return listPosixCensus();
}
