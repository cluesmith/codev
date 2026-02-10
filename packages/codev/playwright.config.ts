/**
 * Playwright configuration for dashboard E2E tests.
 *
 * Run with: npx playwright test
 *
 * The webServer option auto-starts tower on port 4100.
 * If tower is already running locally, it reuses the existing server.
 */

import { defineConfig } from '@playwright/test';

const port = Number(process.env.TOWER_TEST_PORT || '4100');

export default defineConfig({
  testDir: './src/agent-farm/__tests__/e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${port}`,
  },
  webServer: {
    command: `node dist/agent-farm/servers/tower-server.js ${port}`,
    port,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
