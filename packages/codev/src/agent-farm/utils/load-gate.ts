/**
 * `afx spawn --max-load <n> [--wait <seconds>]` (#1950): refuse to spawn while the machine is
 * already loaded, before anything is created.
 */

import { loadavg } from 'node:os';
import { isWindows } from '../../lib/platform.js';
import { logger } from './logger.js';

/** EX_TEMPFAIL: the load is too high now; trying again later may succeed. */
export const LOAD_REFUSED_EXIT = 75;

/** How often `--wait` re-reads the load average. */
export const LOAD_RECHECK_MS = 15_000;

export interface LoadGateDeps {
  oneMinuteLoad(): number;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const defaultDeps: LoadGateDeps = {
  oneMinuteLoad: () => loadavg()[0],
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export type LoadVerdict = { ok: true } | { ok: false; exitCode: number; message: string };

const usage = (message: string): LoadVerdict => ({ ok: false, exitCode: 1, message });

export async function checkLoad(
  maxLoadArg: string | undefined,
  waitArg: string | undefined,
  deps: LoadGateDeps = defaultDeps,
): Promise<LoadVerdict> {
  if (maxLoadArg === undefined) return usage('--wait requires --max-load');
  const maxLoad = Number(maxLoadArg);
  if (!Number.isFinite(maxLoad) || maxLoad <= 0) {
    return usage(`--max-load '${maxLoadArg}': must be a positive number`);
  }
  const waitSeconds = waitArg === undefined ? 0 : Number(waitArg);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
    return usage(`--wait '${waitArg}': must be a non-negative number of seconds`);
  }
  // Native Windows has no load average: os.loadavg() reports zeros, which would always pass.
  if (isWindows()) {
    return usage('--max-load is not supported on Windows: the platform reports no load average.');
  }

  const deadline = deps.now() + waitSeconds * 1000;
  for (;;) {
    const load = deps.oneMinuteLoad();
    if (load < maxLoad) return { ok: true };
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      const waited = waitSeconds > 0 ? ` after waiting ${waitSeconds}s` : '';
      return {
        ok: false,
        exitCode: LOAD_REFUSED_EXIT,
        message:
          `One-minute load average is ${load.toFixed(2)}, at or above --max-load ${maxLoad}${waited}. ` +
          `Nothing was created.`,
      };
    }
    const pause = Math.min(LOAD_RECHECK_MS, remaining);
    logger.info(
      `One-minute load average is ${load.toFixed(2)} (limit ${maxLoad}); ` +
        `re-checking in ${Math.ceil(pause / 1000)}s (${Math.ceil(remaining / 1000)}s left).`,
    );
    await deps.sleep(pause);
  }
}
