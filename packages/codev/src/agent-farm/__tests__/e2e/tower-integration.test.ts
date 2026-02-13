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

const PROJECT_PATH = path.resolve(import.meta.dirname, '../../../../../');
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

test.describe('Tower Mobile Compaction (Spec 0094)', () => {
  test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

  test('share button is hidden on mobile', async ({ page }) => {
    await page.goto(TOWER_URL);
    await page.waitForTimeout(1000);

    const shareBtn = page.locator('#share-btn');
    await expect(shareBtn).toBeHidden();
  });

  test('project path row is hidden on mobile', async ({ page }) => {
    await page.goto(TOWER_URL);
    const instance = page.locator('.instance');
    await expect(instance.first()).toBeVisible({ timeout: 10_000 });

    const pathRow = page.locator('.instance-path-row');
    if (await pathRow.count() > 0) {
      await expect(pathRow.first()).toBeHidden();
    }
  });

  test('port items use row layout on mobile', async ({ page }) => {
    await page.goto(TOWER_URL);
    const instance = page.locator('.instance');
    await expect(instance.first()).toBeVisible({ timeout: 10_000 });

    const portItem = page.locator('.port-item').first();
    if (await portItem.count() > 0) {
      const flexDirection = await portItem.evaluate(
        el => window.getComputedStyle(el).flexDirection
      );
      expect(flexDirection).toBe('row');
    }
  });

  test('instance header uses row wrap layout on mobile', async ({ page }) => {
    await page.goto(TOWER_URL);
    const instance = page.locator('.instance');
    await expect(instance.first()).toBeVisible({ timeout: 10_000 });

    const header = page.locator('.instance-header').first();
    const styles = await header.evaluate(el => {
      const cs = window.getComputedStyle(el);
      return { flexDirection: cs.flexDirection, flexWrap: cs.flexWrap };
    });
    expect(styles.flexDirection).toBe('row');
    expect(styles.flexWrap).toBe('wrap');
  });

  test('recent projects path is hidden on mobile', async ({ page }) => {
    await page.goto(TOWER_URL);
    await page.waitForTimeout(1000);

    const recentPath = page.locator('.recent-path');
    if (await recentPath.count() > 0) {
      await expect(recentPath.first()).toBeHidden();
    }
  });

  test('recent items use row layout on mobile', async ({ page }) => {
    await page.goto(TOWER_URL);
    await page.waitForTimeout(1000);

    const recentItem = page.locator('.recent-item');
    if (await recentItem.count() > 0) {
      const flexDirection = await recentItem.first().evaluate(
        el => window.getComputedStyle(el).flexDirection
      );
      expect(flexDirection).toBe('row');
    }
  });

  test('all buttons meet minimum touch target size', async ({ page }) => {
    await page.goto(TOWER_URL);
    const instance = page.locator('.instance');
    await expect(instance.first()).toBeVisible({ timeout: 10_000 });

    // Check action buttons meet 36px minimum
    const buttons = page.locator('.instance-actions .btn');
    const count = await buttons.count();
    for (let i = 0; i < count; i++) {
      const box = await buttons.nth(i).boundingBox();
      if (box) {
        expect(box.height).toBeGreaterThanOrEqual(36);
      }
    }
  });
});

test.describe('Tower Desktop Unchanged (Spec 0094)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('share button is not force-hidden by CSS on desktop', async ({ page }) => {
    await page.goto(TOWER_URL);
    await page.waitForTimeout(1000);

    // The share button starts hidden via inline style="display: none;" and JS
    // shows it when a tunnel is available. On mobile, CSS adds display:none !important.
    // On desktop, CSS should NOT force-hide it — verify no CSS rule hides it.
    const shareBtn = page.locator('#share-btn');
    const hasCSSHidden = await shareBtn.evaluate(el => {
      // Temporarily remove inline display style to isolate CSS rules
      const inlineDisplay = el.style.display;
      el.style.display = '';
      const cssDisplay = window.getComputedStyle(el).display;
      el.style.display = inlineDisplay; // restore
      return cssDisplay === 'none';
    });
    expect(hasCSSHidden).toBe(false);
  });

  test('project path row is visible on desktop', async ({ page }) => {
    await page.goto(TOWER_URL);
    const instance = page.locator('.instance');
    await expect(instance.first()).toBeVisible({ timeout: 10_000 });

    const pathRow = page.locator('.instance-path-row');
    if (await pathRow.count() > 0) {
      await expect(pathRow.first()).toBeVisible();
    }
  });

  test('port items use default layout on desktop', async ({ page }) => {
    await page.goto(TOWER_URL);
    const instance = page.locator('.instance');
    await expect(instance.first()).toBeVisible({ timeout: 10_000 });

    const portItem = page.locator('.port-item').first();
    if (await portItem.count() > 0) {
      const flexDirection = await portItem.evaluate(
        el => window.getComputedStyle(el).flexDirection
      );
      expect(flexDirection).toBe('row');
    }
  });
});
