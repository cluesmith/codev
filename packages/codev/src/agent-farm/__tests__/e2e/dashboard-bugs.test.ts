/**
 * E2E tests for the three bugs reported by the user:
 * 1. Tower proxy doesn't work for cluesmith.com project
 * 2. Fonts are messed up
 * 3. Panel layout is wrong (should be: info header, 2-col TABS+FILES, PROJECTS)
 *
 * Prerequisites:
 *   - af tower start (tower on :4100)
 *   - Project activated
 *   - npx playwright install chromium
 *
 * Run: npx playwright test dashboard-bugs
 */

import { test, expect } from '@playwright/test';

const TOWER_URL = 'http://localhost:4100';
const PROJECT_PATH = '/Users/mwk/Development/cluesmith/codev-public';

function toBase64URL(str: string): string {
  return Buffer.from(str).toString('base64url');
}

// Dashboard is accessed through tower proxy (no separate dashboard server)
const ENCODED_PATH = toBase64URL(PROJECT_PATH);
const DASH_URL = `${TOWER_URL}/project/${ENCODED_PATH}`;

test.describe('Bug #1: Tower proxy for projects', () => {
  test('tower front page loads and lists running instances', async ({ page }) => {
    await page.goto(TOWER_URL);
    const header = page.locator('h1');
    await expect(header).toContainText('Control Tower', { timeout: 5_000 });

    // At least one instance visible
    const instance = page.locator('.instance');
    await expect(instance.first()).toBeVisible({ timeout: 10_000 });
  });

  test('clicking Open on a project navigates to proxied dashboard', async ({ page }) => {
    await page.goto(TOWER_URL);
    await page.waitForTimeout(2000);

    // Find an "Open" button inside an instance card
    const openBtn = page.locator('.instance button:has-text("Open"), .instance a:has-text("Open")').first();
    await expect(openBtn).toBeVisible({ timeout: 10_000 });

    // Click and wait for navigation (opens in new tab)
    const [newPage] = await Promise.all([
      page.context().waitForEvent('page'),
      openBtn.click(),
    ]);
    await newPage.waitForLoadState('domcontentloaded');

    // Verify it's the React dashboard (not legacy)
    const root = newPage.locator('#root');
    await expect(root).toBeAttached({ timeout: 10_000 });

    // Should not contain legacy dashboard markers
    const html = await newPage.content();
    expect(html).not.toContain('STATE_INJECTION_POINT');

    await newPage.close();
  });

  test('tower proxy serves React dashboard with working CSS/JS', async ({ page }) => {
    // Test with codev-public project through proxy
    const encoded = toBase64URL('/Users/mwk/Development/cluesmith/codev-public');
    const proxyUrl = `${TOWER_URL}/project/${encoded}/`;

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
    const encoded = toBase64URL('/Users/mwk/Development/cluesmith/codev-public');
    const res = await request.get(`${TOWER_URL}/project/${encoded}/api/state`);
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
    await page.waitForTimeout(2000);

    expect(cssResponses.length).toBeGreaterThan(0);
    for (const status of cssResponses) {
      expect(status).toBe(200);
    }
  });
});

test.describe('Bug #3: Layout matches legacy dashboard', () => {
  test('info header with description and doc links', async ({ page }) => {
    await page.goto(DASH_URL);
    await page.waitForTimeout(3000);

    const infoHeader = page.locator('.projects-info');
    await expect(infoHeader).toBeVisible({ timeout: 10_000 });

    // Should have title
    await expect(infoHeader.locator('h1')).toContainText('Agent Farm Dashboard');

    // Should have doc links
    await expect(infoHeader.locator('a:has-text("README")')).toBeVisible();
    await expect(infoHeader.locator('a:has-text("Discord")')).toBeVisible();
  });

  test('two-column layout: TABS on left, FILES on right', async ({ page }) => {
    await page.goto(DASH_URL);
    await page.waitForTimeout(3000);

    const dashHeader = page.locator('.dashboard-header');
    await expect(dashHeader).toBeVisible({ timeout: 10_000 });

    // Both sections within dashboard-header (side by side)
    const tabsSection = dashHeader.locator('.section-tabs');
    const filesSection = dashHeader.locator('.section-files');
    await expect(tabsSection).toBeVisible();
    await expect(filesSection).toBeVisible();

    // Verify they're side by side (flexbox row) — tabs left of files
    const tabsBox = await tabsSection.boundingBox();
    const filesBox = await filesSection.boundingBox();
    expect(tabsBox).not.toBeNull();
    expect(filesBox).not.toBeNull();
    expect(tabsBox!.x).toBeLessThan(filesBox!.x);
  });

  test('TABS section has collapsible header', async ({ page }) => {
    await page.goto(DASH_URL);
    await page.waitForTimeout(3000);

    const tabsHeader = page.locator('.section-tabs .dashboard-section-header');
    await expect(tabsHeader).toBeVisible({ timeout: 10_000 });
    await expect(tabsHeader).toContainText('Tabs');

    // Collapse icon present
    await expect(tabsHeader.locator('.collapse-icon')).toBeVisible();
  });

  test('TABS section lists architect entry', async ({ page }) => {
    await page.goto(DASH_URL);
    await page.waitForTimeout(3000);

    const architectItem = page.locator('.dashboard-tab-item:has-text("Architect")');
    await expect(architectItem).toBeVisible({ timeout: 10_000 });
  });

  test('FILES section shows file tree', async ({ page }) => {
    await page.goto(DASH_URL);
    await page.waitForTimeout(3000);

    const filesSection = page.locator('.section-files');
    await expect(filesSection).toBeVisible({ timeout: 10_000 });

    // File tree nodes should be present
    const fileNode = filesSection.locator('.file-node').first();
    await expect(fileNode).toBeVisible({ timeout: 10_000 });
  });

  test('PROJECTS section below TABS+FILES', async ({ page }) => {
    await page.goto(DASH_URL);
    await page.waitForTimeout(3000);

    const projectsSection = page.locator('.section-projects');
    await expect(projectsSection).toBeVisible({ timeout: 10_000 });

    // Projects should be below the dashboard-header
    const headerBox = await page.locator('.dashboard-header').boundingBox();
    const projectsBox = await projectsSection.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(projectsBox).not.toBeNull();
    expect(projectsBox!.y).toBeGreaterThan(headerBox!.y);
  });

  test('split pane layout: left panel (architect) + right panel (tabs)', async ({ page }) => {
    await page.goto(DASH_URL);
    await page.waitForTimeout(3000);

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

    // Dashboard tab should be active by default
    const dashboardTab = page.locator('.tab-active:has-text("Dashboard")');
    await expect(dashboardTab).toBeVisible();
  });

  test('sections are collapsible', async ({ page }) => {
    await page.goto(DASH_URL);
    await page.waitForTimeout(3000);

    // Find TABS section header and click to collapse
    const tabsSection = page.locator('.section-tabs');
    const tabsHeader = tabsSection.locator('.dashboard-section-header');
    await expect(tabsHeader).toBeVisible({ timeout: 10_000 });

    // Content should be visible initially
    const tabsContent = tabsSection.locator('.dashboard-section-content');
    await expect(tabsContent).toBeVisible();

    // Click to collapse
    await tabsHeader.click();

    // Content should now be hidden
    await expect(tabsContent).not.toBeVisible();

    // Click again to expand
    await tabsHeader.click();
    await expect(tabsContent).toBeVisible();
  });
});

test.describe('Bug #3 via Tower Proxy', () => {
  test('layout works through tower proxy', async ({ page }) => {
    const encoded = toBase64URL('/Users/mwk/Development/cluesmith/codev-public');
    await page.goto(`${TOWER_URL}/project/${encoded}/`);
    await page.waitForTimeout(3000);

    // Two-column layout should exist through proxy
    const tabsSection = page.locator('.section-tabs');
    const filesSection = page.locator('.section-files');
    const projectsSection = page.locator('.section-projects');

    await expect(tabsSection).toBeVisible({ timeout: 10_000 });
    await expect(filesSection).toBeVisible();
    await expect(projectsSection).toBeVisible();
  });
});
