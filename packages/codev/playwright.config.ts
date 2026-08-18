/**
 * Playwright configuration for dashboard E2E tests.
 *
 * Run with: npx playwright test
 *
 * The webServer option auto-starts tower on port 4100.
 * If tower is already running locally, it reuses the existing server.
 *
 * Tower enforces request authentication (advisory GHSA-xvjp-7748-v88v): every
 * non-public route requires the shared local key (`~/.agent-farm/local-key`)
 * presented as the `codev-tower-key` header. The `use.extraHTTPHeaders` below
 * injects it into every request Playwright makes — the `request` fixture,
 * `page.request`, and page navigations — so this harness authenticates the way
 * a real client does, mirroring what `vitest-e2e-setup.ts` did for the vitest
 * harness. (Raw WebSocket opens and `global-setup.ts`'s node-`fetch` calls run
 * outside Playwright's request contexts and carry the key separately.)
 */

import { defineConfig } from '@playwright/test';
import { ensureLocalKey } from '@cluesmith/codev-core/auth';
import { TOWER_KEY_HEADER } from '@cluesmith/codev-types';

const port = Number(process.env.TOWER_TEST_PORT || '4100');

export default defineConfig({
  testDir: './src/agent-farm/__tests__/e2e',
  timeout: 60_000,
  retries: 0,
  globalSetup: './src/agent-farm/__tests__/e2e/global-setup.ts',
  use: {
    baseURL: `http://localhost:${port}`,
    extraHTTPHeaders: {
      [TOWER_KEY_HEADER]: ensureLocalKey(),
    },
  },
  webServer: {
    command: `node dist/agent-farm/servers/tower-server.js ${port}`,
    port,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
