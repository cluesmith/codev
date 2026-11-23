/**
 * Pids a Windows test started and must not leave running (#1915).
 *
 * A test that kills every pid it ever recorded can kill an unrelated process:
 * Windows reuses pids quickly, and test files run in parallel, so a pid that
 * exited during the test may belong to another file's process by `afterAll`.
 * `killSurvivors` kills a pid only when the process holding it was created
 * before the test recorded it, which a reused pid's process cannot have been.
 */

import { listProcessCensus } from '../../agent-farm/servers/process-census.js';

/** How far a census creation time may sit after the recording and still be the same process. */
const CLOCK_SLACK_MS = 1000;

export interface TrackedPids {
  push(...pids: number[]): void;
  killSurvivors(): Promise<void>;
}

export function trackedPids(): TrackedPids {
  const recorded = new Map<number, number>();
  return {
    push(...pids: number[]) {
      const at = Date.now();
      for (const pid of pids) {
        if (Number.isInteger(pid) && pid > 0 && !recorded.has(pid)) recorded.set(pid, at);
      }
    },
    async killSurvivors() {
      if (recorded.size === 0) return;
      let census;
      try {
        census = await listProcessCensus({ fresh: true });
      } catch {
        return; // Without a census nothing can be told from a reused pid: kill nothing.
      }
      const created = new Map(census.map((entry) => [entry.pid, entry.creationTime]));
      for (const [pid, at] of recorded) {
        const creationTime = created.get(pid);
        if (creationTime === undefined || creationTime > at + CLOCK_SLACK_MS) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone
        }
      }
    },
  };
}
