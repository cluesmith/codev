/**
 * Spec 1313 Phase 8: browser-level guard for the dashboard held-count indicator.
 *
 * The header badge (`HeldCountBadge`, `data-testid="held-badge"`) renders the
 * count of currently-held mailbox rows from `OverviewData.heldCount`, entering a
 * distinct attention state (a pulsing amber dot, `held-badge--attention` /
 * `held-dot--attention`) when `OverviewData.mailboxEscalated` is true. It is
 * count-only and read-only (spec Decision 8).
 *
 * This test mocks `/api/state` (to keep the desktop layout deterministic) and
 * `/api/overview` (the badge's data source) and asserts, in a real browser
 * against the built dashboard bundle:
 *
 *   - heldCount 0 → the badge is not rendered (stays out of the way).
 *   - heldCount 3, not escalated → "3 held", no attention class/dot.
 *   - heldCount 1, escalated → "1 held", attention class + pulsing dot.
 *   - live update → mutating the overview stub from 2/not-escalated to
 *     4/escalated flips the badge WITHOUT a reload (via the `useOverview` poll /
 *     SSE refetch), proving the count updates live and escalation moves it into
 *     the attention state.
 *
 * Prerequisites:
 *   - Tower running on TOWER_TEST_PORT (default 4100) — the playwright.config
 *     webServer starts/reuses it, serving the built dashboard from dashboard-dist.
 *   - npx playwright install chromium
 *
 * Run: npx playwright test spec-1313-held-count-indicator
 */

import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const TOWER_URL = `http://localhost:${process.env.TOWER_TEST_PORT || '4100'}`;
const WORKSPACE_PATH = resolve(import.meta.dirname, '../../../../../../');
const ENCODED_PATH = Buffer.from(WORKSPACE_PATH).toString('base64url');
const DASH_URL = `${TOWER_URL}/workspace/${ENCODED_PATH}/`;

/**
 * A minimal OverviewData payload carrying the Phase 8 held fields. Every other
 * list is empty — the header badge reads only `heldCount`/`mailboxEscalated`,
 * and empty builders/PRs/backlog keep the Work view inert for the assertion.
 */
function overviewBody(heldCount: number, mailboxEscalated: boolean): string {
  return JSON.stringify({
    builders: [],
    pendingPRs: [],
    backlog: [],
    recentlyClosed: [],
    architects: [],
    heldCount,
    mailboxEscalated,
  });
}

/**
 * A static, minimal DashboardState so the desktop layout mounts deterministically
 * (empty terminals → no architect/builder tabs; the header renders regardless).
 * Static (not a `route.fetch` passthrough) so no route callback is left in flight
 * when the page closes between assertions.
 */
const STATE_BODY = JSON.stringify({
  architect: null,
  architects: [],
  builders: [],
  utils: [],
  annotations: [],
  version: '0.0.0-e2e',
  hostname: 'e2e',
  workspaceName: 'spir-1313',
});

/**
 * Installs the `/api/state` + `/api/overview` mocks. `getOverview` is read on
 * every `/api/overview` request, so a test can mutate it mid-run to simulate a
 * held-state-change broadcast and prove the badge updates live. `/api/state` is
 * a fixed minimal payload — the header badge reads only the overview, so the
 * state just needs to let the desktop layout mount.
 */
async function installRoutes(page: Page, getOverview: () => string): Promise<void> {
  await page.route('**/api/state', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: STATE_BODY }),
  );

  await page.route('**/api/overview', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: getOverview() }),
  );
}

async function gotoDashboard(page: Page): Promise<void> {
  await page.goto(DASH_URL);
  await page.locator('#root').waitFor({ state: 'attached', timeout: 15_000 });
  // The header controls always render in the desktop layout; anchor on them so
  // an absent badge (count 0) is a real absence, not an un-mounted page.
  await page.locator('.header-controls').waitFor({ state: 'attached', timeout: 15_000 });
}

test.describe('Spec 1313 Phase 8: dashboard held-count indicator', () => {
  test('renders no badge when nothing is held', async ({ page }) => {
    await installRoutes(page, () => overviewBody(0, false));
    await gotoDashboard(page);
    await expect(page.getByTestId('held-badge')).toHaveCount(0);
  });

  test('shows the held count without the attention state when not escalated', async ({ page }) => {
    await installRoutes(page, () => overviewBody(3, false));
    await gotoDashboard(page);

    const badge = page.getByTestId('held-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('3 held');
    await expect(badge).not.toHaveClass(/held-badge--attention/);
    await expect(page.locator('.held-dot--attention')).toHaveCount(0);
  });

  test('enters the attention state (pulsing dot) when escalated', async ({ page }) => {
    await installRoutes(page, () => overviewBody(1, true));
    await gotoDashboard(page);

    const badge = page.getByTestId('held-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('1 held');
    await expect(badge).toHaveClass(/held-badge--attention/);
    await expect(badge.locator('.held-dot--attention')).toHaveCount(1);
  });

  test('updates the count and attention state live, without a reload', async ({ page }) => {
    // A mutable holder the /api/overview mock reads each request — flipping it
    // mid-test simulates a held-state-change broadcast + an age crossing.
    const holder = { body: overviewBody(2, false) };
    await installRoutes(page, () => holder.body);
    await gotoDashboard(page);

    const badge = page.getByTestId('held-badge');
    await expect(badge).toContainText('2 held');
    await expect(badge).not.toHaveClass(/held-badge--attention/);

    // Two more rows are held and one escalates. `useOverview` refetches on its
    // poll / SSE tick, so the badge converges without a page reload.
    holder.body = overviewBody(4, true);
    await expect(badge).toContainText('4 held', { timeout: 8_000 });
    await expect(badge).toHaveClass(/held-badge--attention/);
    await expect(badge.locator('.held-dot--attention')).toHaveCount(1);
  });
});
