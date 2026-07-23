// afx tower sweep-husks — Issue #1227.
// Dry-run by default; --apply actually reaps, mirroring `afx workspace recover`'s
// preview/--apply/-y UX exactly (same rationale: an irreversible, fleet-wide
// operation gets a preview + confirmation gate, not a bare destructive default).

import { logger } from '../utils/logger.js';
import { getTowerClient } from '../lib/tower-client.js';
import { confirm } from '../../lib/cli-prompts.js';
import type { HuskCandidate } from '../lib/tower-client.js';

export interface TowerSweepHusksOptions {
  apply?: boolean;
  yes?: boolean;
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return '—';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function formatRss(rssKb: number): string {
  if (rssKb >= 1024) return `${(rssKb / 1024).toFixed(1)}MB`;
  return `${rssKb}KB`;
}

function printCandidates(candidates: HuskCandidate[]): void {
  const widths = [10, 8, 10];
  logger.row(['PID', 'AGE', 'RSS'], widths);
  logger.row(['─'.repeat(10), '─'.repeat(8), '─'.repeat(10)], widths);
  for (const candidate of candidates) {
    logger.row([String(candidate.pid), formatAge(candidate.ageMs), formatRss(candidate.rssKb)], widths);
  }
}

export async function towerSweepHusks(options: TowerSweepHusksOptions = {}): Promise<void> {
  const client = getTowerClient();
  const towerRunning = await client.isRunning();
  if (!towerRunning) {
    logger.error('Tower is not running. Start it with `afx tower start`.');
    process.exitCode = 1;
    return;
  }

  const apply = options.apply ?? false;
  logger.header(`Husk Sweep${apply ? '' : ' (preview)'}`);

  const preview = await client.findHuskCandidates();
  if (!preview) {
    logger.error('Failed to reach Tower for husk preview.');
    process.exitCode = 1;
    return;
  }

  logger.kv('Grace period', `${Math.round(preview.graceMs / 60_000)}m`);
  logger.blank();

  if (preview.candidates.length === 0) {
    logger.info('No husk shellpers found.');
    return;
  }

  printCandidates(preview.candidates);
  logger.blank();

  if (!apply) {
    logger.info(`Run with --apply to reap ${preview.candidates.length} husk shellper(s).`);
    return;
  }

  if (!options.yes) {
    const proceed = await confirm(`Proceed to reap ${preview.candidates.length} husk shellper(s)?`, false);
    if (!proceed) {
      logger.info('Aborted.');
      return;
    }
  }

  const result = await client.sweepHusks();
  if (!result) {
    logger.error('Failed to reach Tower for husk sweep.');
    process.exitCode = 1;
    return;
  }

  logger.blank();
  logger.kv('Reaped', String(result.swept));
}
