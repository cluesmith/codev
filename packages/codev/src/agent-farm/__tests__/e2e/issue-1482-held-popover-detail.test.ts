/**
 * Issue #1482: browser-level guard for the gate detail in the held-mail popover.
 *
 * `afx inbox` renders a held row's verdict as a compound `reason:detail` sub-code, because
 * `busy` alone conflates two opposite situations: `busy:user-text` means a human is at that
 * composer and the hold clears itself, while `busy:no-region-end` /
 * `busy:no-composer-marker` mean the classifier could not verify the composer at all and the
 * hold does NOT clear on its own. The dashboard popover is the surface an operator reaches
 * for without a terminal, so a popover showing a bare `busy` cannot tell them which one they
 * are looking at — and would describe the same row differently from the CLI.
 *
 * This mocks `/api/state` (deterministic desktop layout), `/api/overview` (the badge's count)
 * and `/api/inbox` (the popover's rows) and asserts, in a real browser against the built
 * dashboard bundle, that the popover renders the sub-code and that a scheduled row still
 * reads `scheduled`.
 *
 * Prerequisites:
 *   - Tower running on TOWER_TEST_PORT — the playwright.config webServer starts/reuses it,
 *     serving the built dashboard from dashboard-dist.
 *   - npx playwright install chromium
 *
 * Run: npx playwright test issue-1482-held-popover-detail
 */

import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';

// NO DEFAULT PORT, deliberately. The repo's playwright.config defaults TOWER_TEST_PORT to
// 4100 — the port the user's REAL Tower runs on, with real agents behind it. A default here
// silently pointed an early run of this test at that live Tower (harmless: every route it
// reads is mocked and it only navigates, but it is not a mistake to leave available). Failing
// loudly is the correct behaviour for a test that must only ever talk to a throwaway server.
const TOWER_PORT = process.env.TOWER_TEST_PORT;
if (!TOWER_PORT) {
  throw new Error(
    'TOWER_TEST_PORT must be set for this test — refusing to default to 4100 (the live Tower). ' +
      'Run it against a throwaway server, e.g. TOWER_TEST_PORT=14100.',
  );
}
const TOWER_URL = `http://localhost:${TOWER_PORT}`;
const WORKSPACE_PATH = resolve(import.meta.dirname, '../../../../../../');
const ENCODED_PATH = Buffer.from(WORKSPACE_PATH).toString('base64url');
const DASH_URL = `${TOWER_URL}/workspace/${ENCODED_PATH}/`;

const STATE_BODY = JSON.stringify({
  architect: null,
  architects: [],
  builders: [],
  utils: [],
  annotations: [],
  version: '0.0.0-e2e',
  hostname: 'e2e',
  workspaceName: 'pir-1482',
});

function overviewBody(heldCount: number): string {
  return JSON.stringify({
    builders: [],
    pendingPRs: [],
    backlog: [],
    recentlyClosed: [],
    architects: [],
    heldCount,
    mailboxEscalated: false,
  });
}

/** A held row as `/api/inbox` projects it — metadata only, never a body. */
function heldRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'row-1',
    workspacePath: WORKSPACE_PATH,
    toAgent: 'pir-1482',
    fromAgent: 'architect',
    reason: 'busy',
    detail: null,
    escalated: false,
    createdAt: Date.now() - 90_000,
    notBefore: null,
    ...over,
  };
}

async function installRoutes(page: Page, rows: Record<string, unknown>[]): Promise<void> {
  await page.route('**/api/state', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: STATE_BODY }),
  );
  await page.route('**/api/overview', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: overviewBody(rows.length) }),
  );
  await page.route('**/api/inbox', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) }),
  );
}

async function openPopover(page: Page): Promise<void> {
  await page.goto(DASH_URL);
  await page.locator('#root').waitFor({ state: 'attached', timeout: 15_000 });
  await page.locator('.header-controls').waitFor({ state: 'attached', timeout: 15_000 });

  // The badge only appears once `/api/overview` has resolved and React has re-rendered with a
  // non-zero count, so wait for it to be actionable rather than merely attached — a click
  // dispatched at the empty-header frame lands on nothing and is not retried by `waitFor`.
  const badge = page.getByTestId('held-badge');
  await badge.waitFor({ state: 'visible', timeout: 15_000 });

  // Retry the open rather than assuming one click takes. `toPass` re-runs the whole body, so
  // the guard matters: without it a second attempt would TOGGLE a popover that had just
  // opened, and the test would flake in the confusing direction (passing, then failing on a
  // retry). Reading aria-expanded — the component's own disclosure state — makes the retry
  // idempotent.
  await expect(async () => {
    if ((await badge.getAttribute('aria-expanded')) !== 'true') await badge.click();
    await expect(page.getByTestId('held-popover')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

test.describe('Issue #1482: gate detail in the held-mail popover', () => {
  test('renders busy:user-text — the hold that clears itself', async ({ page }) => {
    await installRoutes(page, [heldRow({ reason: 'busy', detail: 'user-text' })]);
    await openPopover(page);
    await expect(page.getByTestId('held-row')).toContainText('busy:user-text');
  });

  test('renders busy:no-region-end — the hold that never clears', async ({ page }) => {
    await installRoutes(page, [heldRow({ reason: 'busy', detail: 'no-region-end' })]);
    await openPopover(page);
    await expect(page.getByTestId('held-row')).toContainText('busy:no-region-end');
  });

  test('renders busy:no-composer-marker', async ({ page }) => {
    await installRoutes(page, [heldRow({ reason: 'busy', detail: 'no-composer-marker' })]);
    await openPopover(page);
    await expect(page.getByTestId('held-row')).toContainText('busy:no-composer-marker');
  });

  test('renders a bare reason when the row carries no detail', async ({ page }) => {
    await installRoutes(page, [heldRow({ reason: 'no-live-pty', detail: null })]);
    await openPopover(page);
    const row = page.getByTestId('held-row');
    await expect(row).toContainText('no-live-pty');
    await expect(row).not.toContainText('no-live-pty:');
  });

  test('a scheduled row still reads "scheduled", detail notwithstanding', async ({ page }) => {
    // A scheduled row waits on the clock, not on a composer. Leaking a stale gate detail onto
    // it would describe a problem that does not exist.
    await installRoutes(page, [
      heldRow({ reason: 'busy', detail: 'user-text', notBefore: Date.now() + 60_000 }),
    ]);
    await openPopover(page);
    const row = page.getByTestId('held-row');
    await expect(row).toContainText('scheduled');
    await expect(row).not.toContainText('user-text');
  });

  test('distinct rows keep distinct verdicts side by side', async ({ page }) => {
    // The whole point of the sub-code: two rows held for opposite reasons must be
    // distinguishable at a glance, which a pair of bare `busy` cells cannot do.
    await installRoutes(page, [
      heldRow({ id: 'row-1', toAgent: 'agent-a', reason: 'busy', detail: 'user-text' }),
      heldRow({ id: 'row-2', toAgent: 'agent-b', reason: 'busy', detail: 'no-region-end' }),
    ]);
    await openPopover(page);
    const rows = page.getByTestId('held-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('busy:user-text');
    await expect(rows.nth(1)).toContainText('busy:no-region-end');
  });
});
