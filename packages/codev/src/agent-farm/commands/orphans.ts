/**
 * afx orphans — #1915. Lists, and on request ends, the processes left running
 * in a session's job after their parent exited (typically the children of an
 * agent tool call that timed out). Windows only.
 *
 * Read-only by default, like `afx tower sweep-husks`: `--apply` lists what it
 * will end, asks, then ends exactly those (Tower re-checks each). `--apply`
 * needs an agent name or `--all`, so ending every session's orphans is always
 * asked for in so many words. Never prints command lines (they can carry
 * secrets). Nothing is ever ended automatically.
 */

import { logger } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';
import { getTowerClient } from '../lib/tower-client.js';
import { confirm } from '../../lib/cli-prompts.js';
import { isWindows } from '../../lib/platform.js';
import type { ListedProcess, OrphanEndTarget, SessionOrphans } from '../lib/session-orphans-api.js';

export interface OrphansOptions {
  /** A builder id or architect name (or shell name) in this workspace. */
  agent?: string;
  all?: boolean;
  apply?: boolean;
  yes?: boolean;
  port?: number;
}

export const ORPHANS_NOT_WINDOWS = "Windows only: on macOS and Linux a timed-out command's children end with it.";

export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 > 0 ? `${minutes % 60}m` : ''}`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatCpu(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
}

const WIDTHS = [22, 8, 24, 8, 9];

/** The orphan rows for one or more sessions: SESSION, PID, NAME, AGE, CPU, descendants indented. */
export function orphanRows(sessions: SessionOrphans[], now: number): string[][] {
  const rows: string[][] = [];
  const row = (session: string, p: ListedProcess, indent: string) => [session, String(p.pid), `${indent}${p.name || '?'}`, formatAge(now - p.createdAt), formatCpu(p.cpuMs)];
  for (const s of sessions) {
    for (const orphan of s.orphans) {
      rows.push(row(s.agent, orphan, ''));
      for (const d of orphan.descendants) rows.push(row('', d, '  └ '));
    }
  }
  return rows;
}

export function printOrphanTable(sessions: SessionOrphans[], now: number = Date.now()): void {
  logger.row(['SESSION', 'PID', 'NAME', 'AGE', 'CPU'], WIDTHS);
  logger.row(WIDTHS.map((w) => '─'.repeat(w - 1)), WIDTHS);
  for (const r of orphanRows(sessions, now)) logger.row(r, WIDTHS);
}

/** Every process a session's listing would end: each orphan and its descendants. */
export function endTargets(sessions: SessionOrphans[]): OrphanEndTarget[] {
  const targets: OrphanEndTarget[] = [];
  for (const s of sessions) {
    for (const orphan of s.orphans) {
      targets.push({ terminalId: s.terminalId, pid: orphan.pid, createdAt: orphan.createdAt });
      for (const d of orphan.descendants) targets.push({ terminalId: s.terminalId, pid: d.pid, createdAt: d.createdAt });
    }
  }
  return targets;
}

export async function orphans(options: OrphansOptions = {}): Promise<void> {
  if (!isWindows()) {
    logger.info(ORPHANS_NOT_WINDOWS);
    return;
  }
  if (options.apply && !options.agent && !options.all) {
    logger.error('--apply needs an agent name (afx orphans <agent> --apply) or --all for every session in this workspace.');
    process.exitCode = 1;
    return;
  }
  if (options.agent && options.all) {
    logger.error('Name an agent or pass --all, not both.');
    process.exitCode = 1;
    return;
  }

  const client = getTowerClient(options.port);
  if (!(await client.isRunning())) {
    logger.error('Tower is not running. Start it with `afx tower start`.');
    process.exitCode = 1;
    return;
  }

  const workspacePath = getConfig().workspaceRoot;
  const listed = await client.listOrphans(workspacePath);
  if (!listed.ok) {
    logger.error(`Could not list orphaned processes: ${listed.error}`);
    process.exitCode = 1;
    return;
  }

  let sessions = listed.listing.sessions;
  if (options.agent) {
    const wanted = options.agent.toLowerCase();
    sessions = sessions.filter((s) => s.agent.toLowerCase() === wanted);
    if (sessions.length === 0) {
      logger.error(`No running session named "${options.agent}" in this workspace.`);
      process.exitCode = 1;
      return;
    }
  }

  logger.header(`Orphaned processes${options.apply ? '' : ' (preview)'}`);
  for (const s of sessions) {
    if (s.error !== undefined) logger.warn(`${s.agent}: ${s.error}`);
    else if (!s.job) logger.warn(`${s.agent}: no job, so its orphans cannot be listed`);
  }
  const withOrphans = sessions.filter((s) => s.orphans.length > 0);
  const targets = endTargets(withOrphans);
  if (targets.length === 0) {
    logger.info('No orphaned processes.');
    return;
  }

  printOrphanTable(withOrphans);
  logger.blank();
  logger.info('A process listed here has no living parent. It may be the leftover of a timed-out command, or a background process you started on purpose.');

  if (!options.apply) {
    const target = options.agent ?? '<agent>';
    logger.info(`Run \`afx orphans ${target} --apply\` (or \`afx orphans --all --apply\`) to end them.`);
    return;
  }

  if (!options.yes) {
    const proceed = await confirm(`End these ${targets.length} process(es)?`, false);
    if (!proceed) {
      logger.info('Aborted. Nothing was ended.');
      return;
    }
  }

  const ended = await client.endOrphans(workspacePath, targets);
  if (!ended.ok) {
    logger.error(`Could not end orphaned processes: ${ended.error}`);
    process.exitCode = 1;
    return;
  }
  logger.blank();
  let count = 0;
  for (const r of ended.response.results) {
    if (r.outcome === 'ended') count++;
    else if (r.outcome === 'gone') logger.info(`pid ${r.pid}: already gone`);
    else logger.warn(`pid ${r.pid}: not ended (${r.reason ?? r.outcome})`);
  }
  logger.kv('Ended', String(count));
  if (ended.response.results.some((r) => r.outcome === 'failed')) process.exitCode = 1;
}
