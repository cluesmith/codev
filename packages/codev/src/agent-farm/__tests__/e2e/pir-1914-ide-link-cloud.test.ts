/**
 * E2E for Issue #1914: the dashboard's Open IDE link, locally and over Codev
 * Cloud, driven in a real browser against a real Tower's dashboard shell.
 *
 * `/api/status` is intercepted to present one running workspace plus the IDE
 * signal Tower now carries (`ide: { available, viaTunnel }`); the cookie mint
 * and the `/ide/` navigation are intercepted at the context level, so the
 * popup tab is covered too and no IDE server is needed.
 *
 * Run (throwaway Tower, shares nothing with a live one):
 *   TOWER_TEST_PORT=14114 CODEV_AGENT_FARM_DIR="$(mktemp -d)" SHELLPER_SOCKET_DIR="$(mktemp -d)" \
 *     npx playwright test pir-1914-ide-link-cloud
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';

// NO DEFAULT PORT, deliberately (same rule as issue-1482-held-popover-detail.test.ts):
// the repo's playwright.config defaults to 4100, the live Tower. Every route here is
// mocked, but a test meant for a throwaway server must fail loudly rather than drive
// the live one.
const TOWER_PORT = process.env.TOWER_TEST_PORT;
if (!TOWER_PORT) {
  throw new Error(
    'TOWER_TEST_PORT must be set for this test — refusing to default to 4100 (the live Tower). ' +
      'Run it against a throwaway server, e.g. TOWER_TEST_PORT=14114.',
  );
}
const TOWER_URL = `http://localhost:${TOWER_PORT}`;
const WORKSPACE = '/home/dev/proj';
const IDE_PATH = `/ide/?folder=${encodeURIComponent(WORKSPACE)}`;

interface Intercepts {
  mints: number;
  ideRequests: string[];
}

async function setup(page: Page, context: BrowserContext, ide: { available: boolean; viaTunnel: boolean }): Promise<Intercepts> {
  const seen: Intercepts = { mints: 0, ideRequests: [] };
  await context.route('**/api/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        instances: [{ workspacePath: WORKSPACE, workspaceName: 'proj', running: true, proxyUrl: '/workspace/x/', terminals: [] }],
        ide,
      }),
    }),
  );
  // Matched by exact pathname: a `**/ide/**` glob would also catch /api/ide/session.
  await context.route((url) => url.pathname === '/api/ide/session', (route) => {
    seen.mints += 1;
    return route.fulfill({ status: 204 });
  });
  await context.route((url) => url.pathname.startsWith('/ide/'), (route) => {
    const url = new URL(route.request().url());
    seen.ideRequests.push(url.pathname + url.search);
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>workbench</body></html>' });
  });
  await page.goto(TOWER_URL);
  return seen;
}

test.describe('Issue #1914: Open IDE link', () => {
  test('locally: the link shows, the click mints the forward cookie, then opens /ide/?folder=', async ({ page, context }) => {
    const seen = await setup(page, context, { available: true, viaTunnel: false });
    const link = page.locator('a[data-ide-path]');
    await expect(link).toBeVisible({ timeout: 10_000 });

    const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);
    await popup.waitForURL(`**${IDE_PATH}`);
    expect(seen.mints).toBe(1);
    expect(seen.ideRequests).toContain(IDE_PATH);
  });

  test('over the tunnel: the link shows and opens /ide/?folder= with no mint request', async ({ page, context }) => {
    const seen = await setup(page, context, { available: true, viaTunnel: true });
    const link = page.locator('a[data-ide-path]');
    await expect(link).toBeVisible({ timeout: 10_000 });

    const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);
    await popup.waitForURL(`**${IDE_PATH}`);
    expect(seen.mints).toBe(0);
    expect(seen.ideRequests).toContain(IDE_PATH);
  });

  test('no IDE available: no link', async ({ page, context }) => {
    await setup(page, context, { available: false, viaTunnel: true });
    await expect(page.locator('.port-type', { hasText: 'Overview' })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('a[data-ide-path]')).toHaveCount(0);
  });
});
