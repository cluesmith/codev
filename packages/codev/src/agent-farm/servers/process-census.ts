/**
 * Issue #1227: a shared single-`ps`-call process snapshot, reused by both the
 * shellper husk sweep (predicate needs pid/ppid to detect "childless") and the
 * fleet-RSS observability feature (needs rss). Centralizing the scan avoids
 * growing a fourth bespoke `ps` caller alongside the three that already exist
 * (session-manager.ts, architect-session-holder.ts, commands/cleanup.ts).
 */

import { execFileSync } from 'node:child_process';

export interface ProcessCensusEntry {
  pid: number;
  ppid: number;
  /** Resident set size in kilobytes, as `ps -o rss=` reports it. */
  rssKb: number;
  /** The full joined argv (as `ps ... -o args=` reports it). */
  cmdline: string;
}

/**
 * Snapshot every running process as {pid, ppid, rssKb, cmdline}. `ps -ww`
 * prevents argv truncation (shellper config blobs are large) on both BSD and
 * coreutils `ps`. Throws on `ps` failure; callers decide how to degrade.
 */
export function listProcessCensus(): ProcessCensusEntry[] {
  const out = execFileSync('ps', ['-A', '-ww', '-eo', 'pid=,ppid=,rss=,args='], {
    encoding: 'utf-8',
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
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
