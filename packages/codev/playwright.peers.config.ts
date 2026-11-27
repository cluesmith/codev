/**
 * Playwright configuration for the Peers panel suite and the held-count suite (Spec 1967, plan
 * phase 12), alone.
 *
 * The default `playwright.config.ts` falls back to port 4100 with `reuseExistingServer: true`,
 * so it could reuse the live Tower. These two suites run only through this file, which starts a
 * fresh Tower every run and gives it directories of its own:
 *
 *   - **The port.** It refuses unless `TOWER_TEST_PORT` is set and is not 4100, before any Tower
 *     is started or reused.
 *   - **Its own directories.** In Playwright's main process it makes an agent-farm directory (the
 *     Tower's database and key), a socket directory and a `HOME` under the system temp directory,
 *     and passes them to the Tower. Workers, which evaluate this file again, find them recorded in
 *     the environment and reuse them (`peers-isolation.ts`).
 *   - **A check before the Tower starts.** Each must be under the system temp directory, and none
 *     may be or contain the live agent-farm directory, the default socket directory or the real home.
 *   - **Cleanup.** The global teardown stops the Tower and removes exactly those directories,
 *     checked again (`peers-teardown.ts`).
 *   - **A fresh Tower.** `reuseExistingServer: false`: a server already on the port fails the run.
 *   - **No repository workspace.** No global setup: the marked states are route mocks, and the
 *     one unmocked case wants a fresh Tower as it starts.
 *
 * Run (no directories needed from the caller):
 *   TOWER_TEST_PORT=14102 npx playwright test --config playwright.peers.config.ts
 */

import { defineConfig } from '@playwright/test';
import base, { PEERS_SUITE } from './playwright.config.js';
import { checkPeersDir, peersDirs } from './src/agent-farm/__tests__/e2e/peers-isolation.js';

const LIVE_TOWER_PORT = 4100;

const port = process.env.TOWER_TEST_PORT;
if (!port || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535 || Number(port) === LIVE_TOWER_PORT) {
  throw new Error(
    `TOWER_TEST_PORT must be set to a throwaway Tower port (not ${LIVE_TOWER_PORT}, the live Tower) for the Peers suites.`,
  );
}

const { dirs } = peersDirs();
for (const dir of Object.values(dirs)) checkPeersDir(dir);

export default defineConfig({
  ...base,
  testMatch: PEERS_SUITE,
  testIgnore: [],
  globalSetup: undefined,
  globalTeardown: './src/agent-farm/__tests__/e2e/peers-teardown.ts',
  webServer: {
    command: `node dist/agent-farm/servers/tower-server.js ${port}`,
    port: Number(port),
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      CODEV_AGENT_FARM_DIR: dirs.agentFarm,
      SHELLPER_SOCKET_DIR: dirs.socket,
      HOME: dirs.home,
      // The key is the one in the Tower's own state directory, never an override from the caller.
      CODEV_TOWER_KEY: '',
    },
  },
});
