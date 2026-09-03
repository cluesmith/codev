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
 * presented as the `codev-tower-key` header. Authentication is scoped to
 * Tower-bound traffic rather than installed as an all-origins
 * `use.extraHTTPHeaders`, so the key is never disclosed to a cross-origin
 * request: direct-API tests use the Tower-scoped `request` fixture from
 * `tower-auth.ts`, browser page fetches use the key Tower injects into the
 * shell same-origin, and raw WebSocket / `page.request` / `global-setup.ts`
 * calls carry the key explicitly via `tower-key.ts`.
 */

import { defineConfig } from '@playwright/test';

const port = Number(process.env.TOWER_TEST_PORT || '4100');

export default defineConfig({
  testDir: './src/agent-farm/__tests__/e2e',
  timeout: 60_000,
  retries: 0,
  globalSetup: './src/agent-farm/__tests__/e2e/global-setup.ts',
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
