/**
 * Global teardown for `playwright.peers.config.ts` (Spec 1967, plan phase 12): stop the
 * throwaway Tower, then remove exactly the run folder the config made in this process.
 *
 * Playwright runs a global teardown before it stops its `webServer`, so the Tower would still
 * hold its database open in those directories. It is stopped first through its own graceful
 * shutdown route, keyed with the key in its own state directory (never the live one), and the
 * directories are removed once its process has exited.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TOWER_KEY_HEADER } from '@cluesmith/codev-types';
import { ownedPeersDirs, removePeersDirs } from './peers-isolation.js';

const EXIT_WAIT_MS = 20_000;

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Ask the throwaway Tower to shut down, and wait for its process to exit. A Tower that is not listening is already stopped. */
async function stopTower(port: string, agentFarmDir: string): Promise<void> {
  let key: string;
  try {
    key = readFileSync(path.join(agentFarmDir, 'local-key'), 'utf-8').trim();
  } catch {
    return; // No key: the Tower never started.
  }
  let response: Response;
  try {
    response = await fetch(`http://localhost:${port}/api/shutdown`, { method: 'POST', headers: { [TOWER_KEY_HEADER]: key } });
  } catch {
    return; // Not listening: already stopped.
  }
  if (response.status !== 202) {
    throw new Error(`The test Tower on port ${port} refused to shut down (${response.status}); its directories are left in place.`);
  }
  const { pid } = (await response.json()) as { pid: number };
  const deadline = Date.now() + EXIT_WAIT_MS;
  while (isRunning(pid)) {
    if (Date.now() > deadline) throw new Error(`The test Tower (pid ${pid}) did not exit within ${EXIT_WAIT_MS} ms; its directories are left in place.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export default async function peersTeardown(): Promise<void> {
  // Only the run this process made: one recorded by another process is refused, not stopped or removed.
  const dirs = ownedPeersDirs();
  if (dirs === null) return;
  const port = process.env.TOWER_TEST_PORT;
  if (port) await stopTower(port, dirs.agentFarm);
  removePeersDirs();
}
