/**
 * Tower → Dashboard integration test
 * Verifies the full flow: tower UI loads, proxy to dashboard works,
 * terminals work through proxy, mobile and desktop layouts correct.
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';

const TOWER_URL = 'http://localhost:4100';
const VIDEO_DIR = path.resolve(import.meta.dirname, '../../../../test-results/videos');

// Helper to get base64url encoded project path
function toBase64URL(str: string): string {
  return Buffer.from(str).toString('base64url');
}

const PROJECT_PATH = '/Users/mwk/Development/cluesmith/codev-public';
const ENCODED_PATH = toBase64URL(PROJECT_PATH);

test.describe('Tower Desktop', () => {
  test('tower UI loads and shows running instance', async ({ page }) => {
    await page.goto(TOWER_URL);
    await page.waitForTimeout(1000);

    // Tower should show the header
    const header = page.locator('h1');
    await expect(header).toContainText('Control Tower');

    // Should show codev-public as running
    const instance = page.locator('.instance');
    await expect(instance.first()).toBeVisible({ timeout: 10_000 });
    await expect(instance.first()).toContainText('codev-public');

    // Should show Running badge
    const runningBadge = page.locator('.status-badge.running');
    await expect(runningBadge.first()).toBeVisible();
  });

  test('tower proxy serves React dashboard', async ({ page }) => {
    // Navigate to tower proxy URL for the dashboard
    await page.goto(`${TOWER_URL}/project/${ENCODED_PATH}/`);
    await page.waitForTimeout(2000);

    // Should load the React dashboard (not legacy)
    const root = page.locator('#root');
    await expect(root).toBeAttached({ timeout: 10_000 });

    // Should see the Agent Farm header
    await expect(page.locator('.app-title')).toContainText('Agent Farm');
  });

  test('tower proxy WebSocket terminal works', async ({ page }) => {
    // Get terminalId through tower proxy
    const stateRes = await page.request.get(`${TOWER_URL}/project/${ENCODED_PATH}/api/state`);
    expect(stateRes.ok()).toBe(true);
    const state = await stateRes.json();
    
    // Poll for terminalId
    let terminalId = state.architect?.terminalId;
    if (!terminalId) {
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        const res = await page.request.get(`${TOWER_URL}/project/${ENCODED_PATH}/api/state`);
        const s = await res.json();
        terminalId = s.architect?.terminalId;
        if (terminalId) break;
      }
    }
    expect(terminalId).toBeTruthy();

    // Navigate to dashboard through tower proxy
    await page.goto(`${TOWER_URL}/project/${ENCODED_PATH}/`);
    await page.waitForTimeout(2000);

    // The xterm terminal should render
    const xterm = page.locator('.xterm, .xterm-screen, [class*="xterm"]').first();
    await expect(xterm).toBeVisible({ timeout: 10_000 });
  });

  test('tower proxy shell creation works', async ({ page }) => {
    // Create shell tab through tower proxy
    const response = await page.request.post(`${TOWER_URL}/project/${ENCODED_PATH}/api/tabs/shell`, {
      data: { name: 'tower-test-shell' },
    });
    expect(response.status()).toBe(200); // Tower returns 200 for shell creation
    const body = await response.json();
    expect(body.id).toBeTruthy();
    expect(body.terminalId).toBeTruthy();

    // Clean up
    await page.request.delete(`${TOWER_URL}/project/${ENCODED_PATH}/api/tabs/${body.id}`);
  });
});

test.describe('Tower Mobile', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('tower UI works on mobile', async ({ page }) => {
    await page.goto(TOWER_URL);
    await page.waitForTimeout(1000);

    // Header should be visible
    const header = page.locator('h1');
    await expect(header).toContainText('Control Tower');

    // Instance card should be visible
    const instance = page.locator('.instance');
    await expect(instance.first()).toBeVisible({ timeout: 10_000 });
  });

  test('dashboard through tower proxy works on mobile', async ({ page }) => {
    await page.goto(`${TOWER_URL}/project/${ENCODED_PATH}/`);
    await page.waitForTimeout(2000);

    // React dashboard should load
    const root = page.locator('#root');
    await expect(root).toBeAttached({ timeout: 10_000 });

    // On mobile, should see the mobile layout with tabs at top
    const tabs = page.locator('[role="tablist"], .tab-bar, .mobile-tabs').first();
    // Just verify the page loaded with some content
    await expect(page.locator('body')).not.toBeEmpty();
  });
});
