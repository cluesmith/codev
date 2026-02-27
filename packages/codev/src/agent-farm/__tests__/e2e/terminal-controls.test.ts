/**
 * E2E tests for floating terminal controls (refresh + scroll-to-bottom).
 * Spec 0364.
 *
 * Prerequisites:
 *   - Tower running: `af tower start`
 *   - Workspace activated
 *   - Playwright browsers installed: `npx playwright install chromium`
 *
 * Run: npx playwright test terminal-controls
 */

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

const TOWER_URL = 'http://localhost:4100';
const WORKSPACE_PATH = resolve(import.meta.dirname, '../../../../../../');
const ENCODED_PATH = Buffer.from(WORKSPACE_PATH).toString('base64url');
const PAGE_URL = `${TOWER_URL}/workspace/${ENCODED_PATH}/`;

test.describe('Terminal Controls (Spec 0364)', () => {
  test('controls visible in architect terminal — desktop viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(PAGE_URL);
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });

    // Wait for the terminal to render
    const terminal = page.locator('.split-left .terminal-container');
    await expect(terminal).toBeVisible({ timeout: 15_000 });

    // Both control buttons should be visible
    const refreshBtn = page.locator('button[aria-label="Refresh terminal"]').first();
    const scrollBtn = page.locator('button[aria-label="Scroll to bottom"]').first();
    await expect(refreshBtn).toBeVisible({ timeout: 5_000 });
    await expect(scrollBtn).toBeVisible({ timeout: 5_000 });
  });

  test('controls visible in architect terminal — mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(PAGE_URL);
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });

    // Wait for the terminal to render (mobile layout uses different structure)
    const terminal = page.locator('.terminal-container').first();
    await expect(terminal).toBeVisible({ timeout: 15_000 });

    // Both control buttons should be visible on mobile too
    const refreshBtn = page.locator('button[aria-label="Refresh terminal"]').first();
    const scrollBtn = page.locator('button[aria-label="Scroll to bottom"]').first();
    await expect(refreshBtn).toBeVisible({ timeout: 5_000 });
    await expect(scrollBtn).toBeVisible({ timeout: 5_000 });
  });

  test('clicking controls does not steal focus — desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(PAGE_URL);
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });

    // Wait for terminal to be interactive
    const terminal = page.locator('.split-left .terminal-container');
    await expect(terminal).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(2000);

    // Click inside the terminal to give it focus
    await terminal.click();
    const xTermFocused = page.locator('.split-left .xterm-helper-textarea');

    // Click refresh button with real mouse click — should not steal focus.
    // IMPORTANT: Do NOT use { force: true } here — we need Playwright's
    // actionability check to verify the button isn't obscured by xterm overlays.
    // See Issue #382: force:true masked a z-index stacking bug.
    const refreshBtn = page.locator('button[aria-label="Refresh terminal"]').first();
    await refreshBtn.click();
    await expect(xTermFocused).toBeFocused({ timeout: 2_000 });

    // Re-focus terminal in case
    await terminal.click();

    // Click scroll-to-bottom button with real mouse click — should not steal focus
    const scrollBtn = page.locator('button[aria-label="Scroll to bottom"]').first();
    await scrollBtn.click();
    await expect(xTermFocused).toBeFocused({ timeout: 2_000 });
  });

  test('tapping controls does not steal focus — mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(PAGE_URL);
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });

    // Wait for terminal to be interactive
    const terminal = page.locator('.terminal-container').first();
    await expect(terminal).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(2000);

    // Tap inside the terminal to give it focus
    await terminal.tap();
    const xTermFocused = page.locator('.xterm-helper-textarea').first();

    // Tap refresh button — should not steal focus
    const refreshBtn = page.locator('button[aria-label="Refresh terminal"]').first();
    await refreshBtn.tap();
    await expect(xTermFocused).toBeFocused({ timeout: 2_000 });

    // Re-focus terminal
    await terminal.tap();

    // Tap scroll-to-bottom button — should not steal focus
    const scrollBtn = page.locator('button[aria-label="Scroll to bottom"]').first();
    await scrollBtn.tap();
    await expect(xTermFocused).toBeFocused({ timeout: 2_000 });
  });
});
