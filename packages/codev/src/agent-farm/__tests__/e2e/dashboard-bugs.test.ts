/**
 * E2E tests for the three bugs reported by the user:
 * 1. Tower proxy doesn't work for cluesmith.com project
 * 2. Fonts are messed up
 * 3. Panel layout is wrong (should be: info header, 2-col TABS+FILES, PROJECTS)
 *
 * Prerequisites:
 *   - af tower start (tower on :4100)
 *   - Workspace activated
 *   - npx playwright install chromium
 *
 * Run: npx playwright test dashboard-bugs
 */

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

const TOWER_URL = 'http://localhost:4100';
const WORKSPACE_PATH = resolve(import.meta.dirname, '../../../../../../');

function toBase64URL(str: string): string {
  return Buffer.from(str).toString('base64url');
}

// Dashboard is accessed through tower proxy (no separate dashboard server)
const ENCODED_PATH = toBase64URL(WORKSPACE_PATH);
// DASH_URL with trailing slash for page loads (needed for relative asset resolution)
const DASH_URL = `${TOWER_URL}/workspace/${ENCODED_PATH}/`;
// API_URL without trailing slash for API calls
const API_URL = `${TOWER_URL}/workspace/${ENCODED_PATH}`;

test.describe('Bug #1: Tower proxy for workspaces', () => {
  test('tower front page loads and lists running instances', async ({ page }) => {
    await page.goto(TOWER_URL);
    const header = page.locator('h1');
    await expect(header).toContainText('Control Tower', { timeout: 5_000 });

    // At least one instance visible
    const instance = page.locator('.instance');
    await expect(instance.first()).toBeVisible({ timeout: 10_000 });
  });

  test('clicking Open on a workspace opens proxied dashboard in new tab', async ({ page }) => {
    await page.goto(TOWER_URL);
    await page.waitForTimeout(2000);

    // Find an "Open" link inside an instance card (target="_blank")
    const openBtn = page.locator('.instance a:has-text("Open")').first();
    await expect(openBtn).toBeVisible({ timeout: 10_000 });

    // Click opens new tab (target="_blank" preserved for tower overview links)
    const [newPage] = await Promise.all([
      page.context().waitForEvent('page'),
      openBtn.click(),
    ]);
    await newPage.waitForLoadState('domcontentloaded');

    // Verify it's the React dashboard (not legacy)
    const root = newPage.locator('#root');
    await expect(root).toBeAttached({ timeout: 10_000 });

    // URL should point to a workspace proxy path
    expect(newPage.url()).toContain('/workspace/');

    // Should not contain legacy dashboard markers
    const html = await newPage.content();
    expect(html).not.toContain('STATE_INJECTION_POINT');

    await newPage.close();
  });

  test('tower proxy serves React dashboard with working CSS/JS', async ({ page }) => {
    // Test workspace through tower proxy
    const encoded = toBase64URL(WORKSPACE_PATH);
    const proxyUrl = `${TOWER_URL}/workspace/${encoded}/`;

    await page.goto(proxyUrl);
    await page.waitForTimeout(3000);

    // React root should render
    const root = page.locator('#root');
    await expect(root).toBeAttached({ timeout: 10_000 });

    // CSS should be loaded — check that body has the dark background
    const bgColor = await page.evaluate(() => {
      return getComputedStyle(document.body).backgroundColor;
    });
    // Should be dark (#1a1a1a = rgb(26, 26, 26))
    expect(bgColor).toContain('26');

    // App title should be visible
    await expect(page.locator('.app-title')).toBeVisible({ timeout: 5_000 });
  });

  test('tower proxy API endpoint works', async ({ request }) => {
    const encoded = toBase64URL(WORKSPACE_PATH);
    const res = await request.get(`${TOWER_URL}/workspace/${encoded}/api/state`);
    expect(res.ok()).toBe(true);
    const state = await res.json();
    expect(state).toHaveProperty('architect');
    expect(state).toHaveProperty('builders');
    expect(state).toHaveProperty('utils');
  });
});

test.describe('Bug #2: Fonts', () => {
  test('dashboard uses system font stack (not broken/fallback)', async ({ page }) => {
    await page.goto(DASH_URL);
    // Wait for React dashboard to load and render content
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });
    await page.waitForTimeout(2000);

    // Check body font-family
    const fontFamily = await page.evaluate(() => {
      return getComputedStyle(document.body).fontFamily;
    });
    // Should contain the system font stack, not just "serif" or empty
    expect(fontFamily).toMatch(/(-apple-system|BlinkMacSystemFont|system-ui|Segoe UI|monospace)/i);
  });

  test('dashboard text is readable (correct font size and color)', async ({ page }) => {
    await page.goto(DASH_URL);
    // Wait for React dashboard to load
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });
    await page.waitForTimeout(2000);

    const fontSize = await page.evaluate(() => {
      return getComputedStyle(document.body).fontSize;
    });
    // Should be 13px per CSS
    expect(fontSize).toBe('13px');

    const color = await page.evaluate(() => {
      return getComputedStyle(document.body).color;
    });
    // Should be light text (#e0e0e0 = rgb(224, 224, 224))
    expect(color).toContain('224');
  });

  test('CSS stylesheet is loaded (not 404)', async ({ page }) => {
    const cssResponses: number[] = [];
    page.on('response', (response) => {
      if (response.url().endsWith('.css')) {
        cssResponses.push(response.status());
      }
    });

    await page.goto(DASH_URL);
    // Wait for React dashboard to load
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });
    await page.waitForTimeout(2000);

    expect(cssResponses.length).toBeGreaterThan(0);
    for (const status of cssResponses) {
      expect(status).toBe(200);
    }
  });
});

// Bug #3 tests removed (Spec 425): These tested a legacy dashboard layout
// (.projects-info, .dashboard-header, .section-tabs, .section-files, .section-projects)
// that no longer exists in the current React UI (replaced by SplitPane + WorkView).
// The one layout test that remains valid is the split-pane test below.

test.describe('Dashboard layout', () => {
  test('split pane layout: left panel (architect) + right panel (tabs)', async ({ page }) => {
    await page.goto(DASH_URL);
    // Wait for React app to mount
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });
    await page.waitForTimeout(1000);

    // Should have split-pane container
    const splitPane = page.locator('.split-pane');
    await expect(splitPane).toBeVisible({ timeout: 10_000 });

    // Left pane should exist
    const leftPane = page.locator('.split-left');
    await expect(leftPane).toBeVisible();

    // Right pane should exist
    const rightPane = page.locator('.split-right');
    await expect(rightPane).toBeVisible();

    // Tab bar in right pane
    const tabBar = page.locator('.tab-bar');
    await expect(tabBar).toBeVisible();
  });
});
