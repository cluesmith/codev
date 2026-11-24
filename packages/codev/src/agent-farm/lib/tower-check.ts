/**
 * The one Tower liveness gate every CLI command goes through (#1901).
 *
 * A bare `isRunning()` boolean turned every `/health` failure into "Tower is not running.
 * Start it with: afx tower start". Under heavy load a live Tower accepts the connection at
 * once but its starved event loop misses the 10 s request timeout, so commands told people to
 * start a second Tower while the first was up. Here only a refused connection reads as "not
 * running". Anything else is retried once after a short pause, then reported with the
 * underlying error and no advice to start Tower.
 */

import type { TowerHealthProbe } from './tower-client.js';

export const TOWER_RETRY_DELAY_MS = 1000;

export type TowerCheck =
  | { state: 'running' }
  | { state: 'not-running'; message: string }
  | { state: 'unresponsive'; message: string; error: string; elapsedMs: number };

export interface TowerCheckOptions {
  /** The command a "not running" message tells the reader to run. */
  startCommand?: string;
  retryDelayMs?: number;
}

export async function checkTower(
  client: { probeHealth(): Promise<TowerHealthProbe> },
  options: TowerCheckOptions = {},
): Promise<TowerCheck> {
  const startedAt = Date.now();
  let probe = await client.probeHealth();
  if (probe.state === 'unresponsive') {
    await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? TOWER_RETRY_DELAY_MS));
    probe = await client.probeHealth();
  }

  switch (probe.state) {
    case 'running':
      return { state: 'running' };
    case 'not-running':
      return {
        state: 'not-running',
        message: `Tower is not running. Start it with: ${options.startCommand ?? 'afx tower start'}`,
      };
    case 'unresponsive': {
      const elapsedMs = Date.now() - startedAt;
      return {
        state: 'unresponsive',
        error: probe.error,
        elapsedMs,
        message: `Tower did not answer /health (${probe.error}) after ${elapsedMs} ms; it appears to be up, retry`,
      };
    }
  }
}
