/**
 * E2E tests for CloudStatus component (Spec 0097 Phase 6).
 *
 * Tests the cloud connection status indicator in the dashboard header,
 * verifying correct rendering for each tunnel state and button interactions.
 *
 * Prerequisites:
 *   - Tower running: `af tower start`
 *   - Playwright browsers installed: `npx playwright install chromium`
 *
 * Run: npx playwright test cloud-status
 */

import { test, expect } from '@playwright/test';

const TOWER_URL = 'http://localhost:4100';
const PROJECT_PATH = '/Users/mwk/Development/cluesmith/codev-public';
const ENCODED_PATH = Buffer.from(PROJECT_PATH).toString('base64url');
const PAGE_URL = `${TOWER_URL}/project/${ENCODED_PATH}/`;
const BASE_URL = `${TOWER_URL}/project/${ENCODED_PATH}`;

test.describe('Cloud Status E2E', () => {
  test('CloudStatus renders in dashboard header', async ({ page }) => {
    await page.goto(PAGE_URL);

    // Wait for the React app to load
    const root = page.locator('#root');
    await expect(root).toBeAttached({ timeout: 5_000 });

    // CloudStatus should be present in the header via data-testid
    const cloudStatus = page.locator('[data-testid="cloud-status"]');
    await expect(cloudStatus).toBeAttached({ timeout: 5_000 });
  });

  test('/api/tunnel/status endpoint responds', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/tunnel/status`);
    // Endpoint should respond (200 or 404 if tunnel not configured)
    expect([200, 404]).toContain(response.status());

    if (response.ok()) {
      const data = await response.json();
      expect(data).toHaveProperty('registered');
      expect(data).toHaveProperty('state');
    }
  });

  test('cloud status shows correct state based on tunnel', async ({ page }) => {
    await page.goto(PAGE_URL);

    const cloudStatus = page.locator('[data-testid="cloud-status"]');
    await expect(cloudStatus).toBeAttached({ timeout: 5_000 });

    // Should show one of the valid cloud status texts
    const text = await cloudStatus.textContent();
    expect(text).toMatch(
      /Cloud: (not registered|disconnected|connecting|connected|auth failed)/,
    );
  });

  test('cloud status shows connect button when disconnected', async ({ page }) => {
    await page.goto(PAGE_URL);

    const cloudStatus = page.locator('[data-testid="cloud-status"]');
    await expect(cloudStatus).toBeAttached({ timeout: 5_000 });

    const text = await cloudStatus.textContent();

    // If disconnected, Connect button should be visible
    if (text?.includes('disconnected')) {
      const connectBtn = page.locator('[data-testid="cloud-connect-btn"]');
      await expect(connectBtn).toBeVisible();
      expect(await connectBtn.textContent()).toBe('Connect');
    }

    // If connected, Disconnect button should be visible
    if (text?.includes('Cloud:') && !text?.includes('not registered') && !text?.includes('disconnected') && !text?.includes('connecting') && !text?.includes('auth failed')) {
      const disconnectBtn = page.locator('[data-testid="cloud-disconnect-btn"]');
      await expect(disconnectBtn).toBeVisible();
      expect(await disconnectBtn.textContent()).toBe('Disconnect');
    }
  });

  test('connected state shows access URL as external link', async ({ page }) => {
    await page.goto(PAGE_URL);

    const cloudStatus = page.locator('[data-testid="cloud-status"]');
    await expect(cloudStatus).toBeAttached({ timeout: 5_000 });

    const text = await cloudStatus.textContent();

    // If connected, access URL link should open in new tab
    if (text?.includes('Open')) {
      const link = cloudStatus.locator('a.cloud-link');
      await expect(link).toBeVisible();
      expect(await link.getAttribute('target')).toBe('_blank');
      expect(await link.getAttribute('href')).toContain('codevos.ai');
    }
  });
});
