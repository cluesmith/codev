/**
 * Windows process census (Spec 1658): a PowerShell CIM query with a short TTL
 * cache and single-flight coalescing. The Windows implementation of the
 * processes capability (`lib/platform/processes.windows.ts`) reads it; it is
 * re-exported from `process-census.ts` for existing importers. It imports only
 * types from there, so it never reaches the capability accessor (no cycle).
 */

import { execFile } from 'node:child_process';
import { windowsPowerShellPath } from '../../lib/platform.js';
import type { CensusReadOptions, ProcessCensusEntry } from './process-census.js';

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
    windowsPowerShellPath(),
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
 * the last result without spawning PowerShell. A `fresh` read always runs its
 * own query (and refreshes the cache). A failed query is not cached.
 */
export function createWindowsCensusProvider(
  opts: WindowsCensusProviderOptions = {},
): (read?: CensusReadOptions) => Promise<ProcessCensusEntry[]> {
  const exec = opts.exec ?? runPowerShell;
  const ttlMs = opts.ttlMs ?? WINDOWS_CENSUS_TTL_MS;
  const timeoutMs = opts.timeoutMs ?? WINDOWS_CENSUS_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  let cached: { at: number; entries: ProcessCensusEntry[] } | null = null;
  let inFlight: Promise<ProcessCensusEntry[]> | null = null;

  return (read) => {
    const fresh = read?.fresh === true;
    if (!fresh) {
      if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.entries);
      if (inFlight) return inFlight;
    }
    const query = exec(WINDOWS_CENSUS_QUERY, timeoutMs).then((out) => {
      const entries = parseWindowsCensus(out);
      cached = { at: now(), entries };
      return entries;
    });
    const shared = query.finally(() => {
      if (inFlight === shared) inFlight = null;
    });
    inFlight = shared;
    return shared;
  };
}

/** The process-wide Windows census (one cache, one in-flight query). */
export const windowsCensus = createWindowsCensusProvider();
