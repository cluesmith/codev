/**
 * Video recordings of dashboard terminal functionality.
 *
 * Captures video proof that:
 * 1. React dashboard loads (not legacy)
 * 2. Architect terminal is interactive (xterm renders, can type)
 * 3. Shell tab can be created and used
 * 4. af open of projectlist.md works
 *
 * Videos saved to: packages/codev/test-results/videos/
 *
 * Run: npx playwright test dashboard-video
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';

const TOWER_URL = 'http://localhost:4100';
const PROJECT_PATH = '/Users/mwk/Development/cluesmith/codev-public';
const ENCODED_PATH = Buffer.from(PROJECT_PATH).toString('base64url');
const BASE_URL = `${TOWER_URL}/project/${ENCODED_PATH}`;
const VIDEO_DIR = path.resolve(
  import.meta.dirname,
  '../../../../test-results/videos',
);

async function createContextWithVideo(
  browser: ReturnType<typeof test.info>['_test'] extends never ? never : never,
  browserObj: any,
  name: string,
  viewport: { width: number; height: number },
): Promise<BrowserContext> {
  return browserObj.newContext({
    viewport,
    recordVideo: {
      dir: VIDEO_DIR,
      size: viewport,
    },
  });
}

test.describe('Dashboard Desktop Video', () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      recordVideo: {
        dir: VIDEO_DIR,
        size: { width: 1280, height: 800 },
      },
    });
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await page.close();
    await context.close();
  });

  test('desktop: full dashboard walkthrough', async () => {
    // 1. Navigate to dashboard
    await page.goto(BASE_URL);
    await page.waitForTimeout(2000);

    // Verify React dashboard loaded
    const root = page.locator('#root');
    await expect(root).toBeAttached({ timeout: 5_000 });

    // 2. Wait for xterm terminal to render
    const xterm = page.locator('.xterm, .xterm-screen, [class*="xterm"], [class*="terminal"]').first();
    await expect(xterm).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1000);

    // 3. Type a command in the architect terminal to prove interactivity
    // Focus the terminal and type
    await xterm.click();
    await page.waitForTimeout(500);
    await page.keyboard.type('echo "Dashboard terminal working!"', { delay: 50 });
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);

    // 4. Open projectlist.md via the open-file API route
    // This simulates what `af open codev/projectlist.md` does
    const openResponse = await page.evaluate(async () => {
      const res = await fetch('/api/tabs/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'codev/projectlist.md' }),
      });
      return { status: res.status, body: await res.json() };
    });
    expect([200, 201]).toContain(openResponse.status);
    await page.waitForTimeout(2000);

    // 5. Create a shell tab
    const shellResponse = await page.evaluate(async () => {
      const res = await fetch('/api/tabs/shell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'demo-shell' }),
      });
      return { status: res.status, body: await res.json() };
    });
    expect(shellResponse.status).toBe(201);
    await page.waitForTimeout(2000);

    // 6. Take a screenshot as well
    await page.screenshot({
      path: path.join(VIDEO_DIR, 'desktop-dashboard.png'),
      fullPage: true,
    });

    // Hold for a moment so the video captures the final state
    await page.waitForTimeout(2000);
  });
});

test.describe('Dashboard Mobile Video', () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({
      viewport: { width: 390, height: 844 }, // iPhone 14 dimensions
      recordVideo: {
        dir: VIDEO_DIR,
        size: { width: 390, height: 844 },
      },
      isMobile: true,
      hasTouch: true,
    });
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await page.close();
    await context.close();
  });

  test('mobile: dashboard renders and terminal works', async () => {
    // 1. Navigate to dashboard
    await page.goto(BASE_URL);
    await page.waitForTimeout(2000);

    // Verify React dashboard loaded
    const root = page.locator('#root');
    await expect(root).toBeAttached({ timeout: 5_000 });

    // 2. Wait for terminal to render
    const xterm = page.locator('.xterm, .xterm-screen, [class*="xterm"], [class*="terminal"]').first();
    await expect(xterm).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1000);

    // 3. Tap the terminal and type
    await xterm.tap();
    await page.waitForTimeout(500);
    await page.keyboard.type('echo "Mobile works!"', { delay: 50 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);

    // 4. Screenshot
    await page.screenshot({
      path: path.join(VIDEO_DIR, 'mobile-dashboard.png'),
      fullPage: true,
    });

    // Hold for video
    await page.waitForTimeout(2000);
  });
});
