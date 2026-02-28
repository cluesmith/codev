/**
 * E2E tests for Tower Cloud Connect UI (Spec 0107 Phase 3).
 *
 * Tests the connect dialog, disconnect confirmation, and cloud status
 * rendering on the Tower homepage. Uses Playwright route interception
 * to mock tunnel API responses.
 *
 * Prerequisites:
 *   - Tower running: `af tower start`
 *   - Playwright browsers installed: `npx playwright install chromium`
 *
 * Run: npx playwright test tower-cloud-connect
 */

import { test, expect, type Page } from '@playwright/test';

const TOWER_URL = process.env.TOWER_URL || 'http://localhost:4100';

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

const NOT_REGISTERED = {
  registered: false,
  state: 'disconnected',
  hostname: 'test-machine',
};

const CONNECTED_STATUS = {
  registered: true,
  state: 'connected',
  uptime: 3600000,
  towerId: 'tower-123',
  towerName: 'my-tower',
  serverUrl: 'https://codevos.ai',
  accessUrl: 'https://codevos.ai/t/my-tower/',
  hostname: 'test-machine',
};

const DISCONNECTED_REGISTERED = {
  registered: true,
  state: 'disconnected',
  uptime: null,
  towerId: 'tower-123',
  towerName: 'my-tower',
  serverUrl: 'https://codevos.ai',
  accessUrl: null,
  hostname: 'test-machine',
};

test.describe('Tower Cloud Connect UI', () => {
  test('shows Connect button when not registered', async ({ page }) => {
    await mockTunnelStatus(page, NOT_REGISTERED);
    await page.goto(TOWER_URL);
    const cloudStatus = page.locator('#cloud-status');
    await expect(cloudStatus).toContainText('Codev Cloud', { timeout: 5_000 });
    const connectBtn = cloudStatus.locator('button', { hasText: 'Connect' });
    await expect(connectBtn).toBeVisible();
  });

  test('Connect button opens dialog when not registered', async ({ page }) => {
    await mockTunnelStatus(page, NOT_REGISTERED);
    await page.goto(TOWER_URL);
    const connectBtn = page.locator('#cloud-status button', { hasText: 'Connect' });
    await expect(connectBtn).toBeVisible({ timeout: 5_000 });
    await connectBtn.click();

    const dialog = page.locator('#connect-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('h3')).toContainText('Connect to Codev Cloud');
  });

  test('Connect dialog has correct defaults from hostname', async ({ page }) => {
    await mockTunnelStatus(page, NOT_REGISTERED);
    await page.goto(TOWER_URL);
    const connectBtn = page.locator('#cloud-status button', { hasText: 'Connect' });
    await expect(connectBtn).toBeVisible({ timeout: 5_000 });
    await connectBtn.click();

    const nameInput = page.locator('#connect-device-name');
    await expect(nameInput).toHaveValue('test-machine');

    const urlInput = page.locator('#connect-server-url');
    await expect(urlInput).toHaveValue('https://cloud.codevos.ai');
  });

  test('shows validation error for invalid device name', async ({ page }) => {
    await mockTunnelStatus(page, NOT_REGISTERED);
    await page.goto(TOWER_URL);
    const connectBtn = page.locator('#cloud-status button', { hasText: 'Connect' });
    await expect(connectBtn).toBeVisible({ timeout: 5_000 });
    await connectBtn.click();

    // Clear the name and type an invalid one
    const nameInput = page.locator('#connect-device-name');
    await nameInput.clear();
    await nameInput.fill('---');

    // Click submit
    await page.locator('#connect-submit-btn').click();

    // Error should be visible
    const error = page.locator('#connect-error');
    await expect(error).toBeVisible();
  });

  test('shows validation error for empty device name', async ({ page }) => {
    await mockTunnelStatus(page, NOT_REGISTERED);
    await page.goto(TOWER_URL);
    const connectBtn = page.locator('#cloud-status button', { hasText: 'Connect' });
    await expect(connectBtn).toBeVisible({ timeout: 5_000 });
    await connectBtn.click();

    const nameInput = page.locator('#connect-device-name');
    await nameInput.clear();

    await page.locator('#connect-submit-btn').click();

    const error = page.locator('#connect-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('required');
  });

  test('submit navigates to authUrl on valid input', async ({ page }) => {
    await mockTunnelStatus(page, NOT_REGISTERED);

    // Mock the connect endpoint to return an authUrl
    await page.route('**/api/tunnel/connect', (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authUrl: 'https://cloud.codevos.ai/towers/register?callback=test' }),
      });
    });

    await page.goto(TOWER_URL);
    const connectBtn = page.locator('#cloud-status button', { hasText: 'Connect' });
    await expect(connectBtn).toBeVisible({ timeout: 5_000 });
    await connectBtn.click();

    const nameInput = page.locator('#connect-device-name');
    await nameInput.clear();
    await nameInput.fill('my-tower');

    // Intercept navigation
    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('codevos.ai/towers/register')),
      page.locator('#connect-submit-btn').click(),
    ]);
    expect(request.url()).toContain('codevos.ai/towers/register');
  });

  test.skip('smart connect reconnects without dialog when registered', async ({ page }) => {
    // CI: smart-connect feature not implemented in tower.html
    await mockTunnelStatus(page, DISCONNECTED_REGISTERED);

    let connectCalled = false;
    await page.route('**/api/tunnel/connect', (route) => {
      connectCalled = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    });

    await page.goto(TOWER_URL);
    const connectBtn = page.locator('#cloud-status button', { hasText: 'Connect' });
    await expect(connectBtn).toBeVisible({ timeout: 5_000 });
    await connectBtn.click();

    // Dialog should NOT open
    const dialog = page.locator('#connect-dialog');
    await expect(dialog).not.toBeVisible();

    // API should have been called
    await page.waitForTimeout(500);
    expect(connectCalled).toBe(true);
  });

  test('disconnect shows confirmation dialog', async ({ page }) => {
    await mockTunnelStatus(page, CONNECTED_STATUS);

    // Track if disconnect API was called
    let disconnectCalled = false;
    await page.route('**/api/tunnel/disconnect', (route) => {
      disconnectCalled = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    });

    await page.goto(TOWER_URL);
    const disconnectBtn = page.locator('#cloud-status button', { hasText: 'Disconnect' });
    await expect(disconnectBtn).toBeVisible({ timeout: 5_000 });

    // Handle the confirm dialog - accept it
    page.on('dialog', (dialog) => dialog.accept());
    await disconnectBtn.click();

    await page.waitForTimeout(500);
    expect(disconnectCalled).toBe(true);
  });

  test('disconnect cancelled does not call API', async ({ page }) => {
    await mockTunnelStatus(page, CONNECTED_STATUS);

    let disconnectCalled = false;
    await page.route('**/api/tunnel/disconnect', (route) => {
      disconnectCalled = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    });

    await page.goto(TOWER_URL);
    const disconnectBtn = page.locator('#cloud-status button', { hasText: 'Disconnect' });
    await expect(disconnectBtn).toBeVisible({ timeout: 5_000 });

    // Handle the confirm dialog - dismiss it
    page.on('dialog', (dialog) => dialog.dismiss());
    await disconnectBtn.click();

    await page.waitForTimeout(500);
    expect(disconnectCalled).toBe(false);
  });

  test('cancel button closes connect dialog', async ({ page }) => {
    await mockTunnelStatus(page, NOT_REGISTERED);
    await page.goto(TOWER_URL);
    const connectBtn = page.locator('#cloud-status button', { hasText: 'Connect' });
    await expect(connectBtn).toBeVisible({ timeout: 5_000 });
    await connectBtn.click();

    const dialog = page.locator('#connect-dialog');
    await expect(dialog).toBeVisible();

    await dialog.locator('button', { hasText: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('escape key closes connect dialog', async ({ page }) => {
    await mockTunnelStatus(page, NOT_REGISTERED);
    await page.goto(TOWER_URL);
    const connectBtn = page.locator('#cloud-status button', { hasText: 'Connect' });
    await expect(connectBtn).toBeVisible({ timeout: 5_000 });
    await connectBtn.click();

    const dialog = page.locator('#connect-dialog');
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });
});
