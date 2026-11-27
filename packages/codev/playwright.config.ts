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

/**
 * The Decisions tab suite (Spec 1819) writes files and drives only throwaway workspaces, so it
 * runs through `playwright.decisions.config.ts` instead — without the global setup below, which
 * activates the repository workspace and starts an architect shell in it.
 */
export const DECISIONS_SUITE = '**/decisions-tab.test.ts';

/**
 * The Peers panel suite and the held-count suite (Spec 1967) run only through
 * `playwright.peers.config.ts`, which starts a fresh Tower on a throwaway port with directories of
 * its own. Both route-mock what they assert, but the page comes from whatever Tower serves it, and
 * this config may reuse the live one on port 4100. The nightly `dashboard-e2e.yml` runs them in a
 * step of their own.
 */
export const PEERS_SUITE = ['**/peers-panel.test.ts', '**/spec-1313-held-count-indicator.test.ts'];

export default defineConfig({
  testDir: './src/agent-farm/__tests__/e2e',
  testIgnore: [DECISIONS_SUITE, ...PEERS_SUITE],
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
