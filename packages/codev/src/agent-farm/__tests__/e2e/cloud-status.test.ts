/**
 * E2E tests for CloudStatus component (Spec 0097 Phase 6).
 *
 * Tests the cloud connection status indicator in the dashboard header,
 * verifying correct rendering for each tunnel state and button interactions.
 * Uses Playwright route interception to mock tunnel API responses.
 *
 * Prerequisites:
 *   - Tower running: `af tower start`
 *   - Playwright browsers installed: `npx playwright install chromium`
 *
 * Run: npx playwright test cloud-status
 */

import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

const TOWER_URL = process.env.TOWER_URL || 'http://localhost:4100';
// Derive project root from this file's location (packages/codev/src/agent-farm/__tests__/e2e/)
const PROJECT_PATH = process.env.PROJECT_PATH || path.resolve(import.meta.dirname, '../../../../../..');
const ENCODED_PATH = Buffer.from(PROJECT_PATH).toString('base64url');
const PAGE_URL = `${TOWER_URL}/project/${ENCODED_PATH}/`;
const BASE_URL = `${TOWER_URL}/project/${ENCODED_PATH}`;

/** Intercept the tunnel status API to return a mocked response. */
async function mockTunnelStatus(page: Page, body: Record<string, unknown> | null, status = 200) {
  await page.route('**/api/tunnel/status', (route) => {
    if (body === null) {
      return route.fulfill({ status: 404, body: 'Not Found' });
    }
    return route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

const CONNECTED_STATUS = {
  registered: true,
  state: 'connected',
  uptime: 3600000,
  towerId: 'tower-123',
  towerName: 'my-tower',
  serverUrl: 'https://codevos.ai',
  accessUrl: 'https://codevos.ai/t/my-tower/',
};

const DISCONNECTED_STATUS = {
  registered: true,
  state: 'disconnected',
  uptime: null,
  towerId: 'tower-123',
  towerName: 'my-tower',
  serverUrl: 'https://codevos.ai',
  accessUrl: null,
};

test.describe('Cloud Status E2E', () => {
  test('CloudStatus renders in dashboard header', async ({ page }) => {
    await page.goto(PAGE_URL);
    const root = page.locator('#root');
    await expect(root).toBeAttached({ timeout: 5_000 });
    const cloudStatus = page.locator('[data-testid="cloud-status"]');
    await expect(cloudStatus).toBeAttached({ timeout: 5_000 });
  });

  test('/api/tunnel/status endpoint responds', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/tunnel/status`);
    expect([200, 404]).toContain(response.status());
    if (response.ok()) {
      const data = await response.json();
      expect(data).toHaveProperty('registered');
      expect(data).toHaveProperty('state');
    }
  });

  test('shows "not registered" when tunnel status returns 404', async ({ page }) => {
    await mockTunnelStatus(page, null);
    await page.goto(PAGE_URL);
    const cloudStatus = page.locator('[data-testid="cloud-status"]');
    await expect(cloudStatus).toBeAttached({ timeout: 5_000 });
    await expect(cloudStatus).toContainText('Cloud: not registered');
  });

  test('shows "disconnected" with Connect button', async ({ page }) => {
    await mockTunnelStatus(page, DISCONNECTED_STATUS);
    await page.goto(PAGE_URL);
    const cloudStatus = page.locator('[data-testid="cloud-status"]');
    await expect(cloudStatus).toBeAttached({ timeout: 5_000 });
    await expect(cloudStatus).toContainText('Cloud: disconnected');
    const connectBtn = page.locator('[data-testid="cloud-connect-btn"]');
    await expect(connectBtn).toBeVisible();
    await expect(connectBtn).toHaveText('Connect');
  });

  test('shows "connecting" state', async ({ page }) => {
    await mockTunnelStatus(page, {
      registered: true,
      state: 'connecting',
      uptime: null,
      towerId: 'tower-123',
      towerName: 'my-tower',
      serverUrl: 'https://codevos.ai',
      accessUrl: null,
    });
    await page.goto(PAGE_URL);
    const cloudStatus = page.locator('[data-testid="cloud-status"]');
    await expect(cloudStatus).toBeAttached({ timeout: 5_000 });
    await expect(cloudStatus).toContainText('Cloud: connecting...');
  });

  test('shows connected state with tower name, uptime, and Disconnect button', async ({ page }) => {
    await mockTunnelStatus(page, CONNECTED_STATUS);
    await page.goto(PAGE_URL);
    const cloudStatus = page.locator('[data-testid="cloud-status"]');
    await expect(cloudStatus).toBeAttached({ timeout: 5_000 });
    await expect(cloudStatus).toContainText('Cloud: my-tower');
    await expect(cloudStatus).toContainText('1h 0m');
    const disconnectBtn = page.locator('[data-testid="cloud-disconnect-btn"]');
    await expect(disconnectBtn).toBeVisible();
    await expect(disconnectBtn).toHaveText('Disconnect');
  });

  test('connected state shows access URL as external link', async ({ page }) => {
    await mockTunnelStatus(page, CONNECTED_STATUS);
    await page.goto(PAGE_URL);
    const cloudStatus = page.locator('[data-testid="cloud-status"]');
    await expect(cloudStatus).toBeAttached({ timeout: 5_000 });
    const link = cloudStatus.locator('a.cloud-link');
    await expect(link).toBeVisible();
    expect(await link.getAttribute('target')).toBe('_blank');
    expect(await link.getAttribute('href')).toContain('codevos.ai');
  });

  test('shows "auth failed" state', async ({ page }) => {
    await mockTunnelStatus(page, {
      registered: true,
      state: 'auth_failed',
      uptime: null,
      towerId: 'tower-123',
      towerName: 'my-tower',
      serverUrl: 'https://codevos.ai',
      accessUrl: null,
    });
    await page.goto(PAGE_URL);
    const cloudStatus = page.locator('[data-testid="cloud-status"]');
    await expect(cloudStatus).toBeAttached({ timeout: 5_000 });
    await expect(cloudStatus).toContainText('Cloud: auth failed');
  });

  test('shows "error" state on server error', async ({ page }) => {
    await mockTunnelStatus(page, { error: 'Internal Server Error' }, 500);
    await page.goto(PAGE_URL);
    const cloudStatus = page.locator('[data-testid="cloud-status"]');
    await expect(cloudStatus).toBeAttached({ timeout: 5_000 });
    await expect(cloudStatus).toContainText('Cloud: error');
  });

  test('Connect button triggers tunnel connect API call', async ({ page }) => {
    await mockTunnelStatus(page, DISCONNECTED_STATUS);
    let connectCalled = false;
    await page.route('**/api/tunnel/connect', (route) => {
      connectCalled = true;
      return route.fulfill({ status: 200, body: '{}' });
    });
    await page.goto(PAGE_URL);
    const connectBtn = page.locator('[data-testid="cloud-connect-btn"]');
    await expect(connectBtn).toBeVisible({ timeout: 5_000 });
    await connectBtn.click();
    // Wait for the API call to be made
    await page.waitForTimeout(500);
    expect(connectCalled).toBe(true);
  });

  test('Disconnect button triggers tunnel disconnect API call', async ({ page }) => {
    await mockTunnelStatus(page, CONNECTED_STATUS);
    let disconnectCalled = false;
    await page.route('**/api/tunnel/disconnect', (route) => {
      disconnectCalled = true;
      return route.fulfill({ status: 200, body: '{}' });
    });
    await page.goto(PAGE_URL);
    const disconnectBtn = page.locator('[data-testid="cloud-disconnect-btn"]');
    await expect(disconnectBtn).toBeVisible({ timeout: 5_000 });
    await disconnectBtn.click();
    await page.waitForTimeout(500);
    expect(disconnectCalled).toBe(true);
  });
});
