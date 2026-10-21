/**
 * Playwright configuration for the Decisions tab suite (Spec 1819) alone.
 *
 * The suite writes files, so it never touches the repository workspace: it runs without the
 * default config's global setup (which activates the repository workspace on the test Tower and
 * starts an architect shell there) and drives only throwaway `mkdtemp` workspaces, which need
 * no activation. The default config ignores the suite, so it runs only through this file.
 *
 * Run:
 *   TOWER_TEST_PORT=14101 CODEV_AGENT_FARM_DIR="$(mktemp -d)" SHELLPER_SOCKET_DIR="$(mktemp -d)" \
 *     npx playwright test --config playwright.decisions.config.ts
 */

import { defineConfig } from '@playwright/test';
import base, { DECISIONS_SUITE } from './playwright.config.js';

// The Tower this config starts must share nothing with a live one, so refuse before it starts:
//   TOWER_TEST_PORT      — not 4100, the live Tower's port.
//   CODEV_AGENT_FARM_DIR — its own state dir: the live global.db is owner-locked, and the key
//                          the suite presents must be this Tower's.
//   SHELLPER_SOCKET_DIR  — its own socket dir: Tower probes and sweeps every shellper socket
//                          there, judging each against its own (here empty) database.
const port = process.env.TOWER_TEST_PORT;
if (!port || port === '4100') {
  throw new Error('TOWER_TEST_PORT must be set to a throwaway Tower port (not 4100, the live Tower) for the Decisions tab suite.');
}
for (const name of ['CODEV_AGENT_FARM_DIR', 'SHELLPER_SOCKET_DIR']) {
  if (!process.env[name]) {
    throw new Error(`${name} must be set to a throwaway directory for the Decisions tab suite, so its Tower shares nothing with a live one.`);
  }
}

export default defineConfig({
  ...base,
  testMatch: DECISIONS_SUITE,
  testIgnore: [],
  globalSetup: undefined,
  // Always start a fresh Tower with the environment checked above. A server already listening on
  // the port (a stale test Tower started with other dirs) fails the run instead of being reused.
  webServer: {
    command: `node dist/agent-farm/servers/tower-server.js ${port}`,
    port: Number(port),
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
