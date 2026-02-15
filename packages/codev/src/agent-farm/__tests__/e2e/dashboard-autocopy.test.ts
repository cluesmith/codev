/**
 * E2E test for terminal auto-copy on selection.
 *
 * Verifies that selecting text in the xterm.js terminal automatically
 * copies it to the system clipboard.
 *
 * Run: npx playwright test dashboard-autocopy
 */

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

const TOWER_URL = 'http://localhost:4100';
const WORKSPACE_PATH = resolve(import.meta.dirname, '../../../../../');
const ENCODED_PATH = Buffer.from(WORKSPACE_PATH).toString('base64url');
const PAGE_URL = `${TOWER_URL}/workspace/${ENCODED_PATH}/`;

// Grant clipboard permissions
test.use({
  permissions: ['clipboard-read', 'clipboard-write'],
});

test.describe('Terminal Auto-Copy on Selection', () => {
  test('selecting text in terminal copies to clipboard', async ({ page }) => {
    // Collect console logs for debugging
    const consoleLogs: string[] = [];
    page.on('console', (msg) => {
      consoleLogs.push(msg.text());
    });

    await page.goto(PAGE_URL);

    // Wait for the React app to load and fetch state
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });

    // Wait for terminal to appear — the terminal-container class is on the
    // xterm wrapper div. It may be inside various layout containers depending
    // on whether split-pane is active. Use a broad selector.
    const terminal = page.locator('.terminal-container').first();
    await expect(terminal).toBeVisible({ timeout: 20_000 });

    // Wait for xterm canvas to render
    const canvas = terminal.locator('canvas').first();
    await expect(canvas).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1500);

    // Type a unique marker string so we have known text to select
    await terminal.click();
    const marker = `AUTOCOPY${Date.now()}`;
    await page.keyboard.type(`echo ${marker}`, { delay: 30 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);

    // Seed clipboard with sentinel to verify it changes
    await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'));

    // === Attempt 1: programmatic selectAll ===
    const selectResult = await page.evaluate(() => {
      // Find the xterm instance — it stores a reference on the DOM element
      const xtermEl = document.querySelector('.xterm');
      if (!xtermEl) return { error: 'no .xterm element found' };

      // xterm.js stores the Terminal instance in various places depending on version
      const term = (xtermEl as any)._xterm
        || (xtermEl as any).__xterm
        || (xtermEl as any).xterm;
      if (!term) {
        // List available properties for debugging
        const props = Object.keys(xtermEl).filter(k => k.includes('term') || k.startsWith('_'));
        return { error: 'no term instance', props };
      }

      term.selectAll();
      return { selection: term.getSelection()?.substring(0, 80) };
    });

    console.log('selectAll result:', JSON.stringify(selectResult));
    await page.waitForTimeout(500);

    let clipboard = await page.evaluate(() => navigator.clipboard.readText());
    console.log('Clipboard after selectAll:', clipboard.substring(0, 80));
    console.log('[Terminal] logs:', consoleLogs.filter(l => l.includes('[Terminal]')));

    if (clipboard !== 'SENTINEL' && clipboard.length > 0) {
      // selectAll auto-copy worked
      expect(clipboard).toContain(marker);
      return;
    }

    // === Attempt 2: mouse drag ===
    console.log('selectAll did not auto-copy. Trying mouse drag...');

    // Reset sentinel
    await page.evaluate(() => navigator.clipboard.writeText('SENTINEL2'));

    const box = await terminal.boundingBox();
    expect(box).not.toBeNull();

    // Drag across a line of terminal text
    await page.mouse.move(box!.x + 5, box!.y + 20);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width - 5, box!.y + 20, { steps: 15 });
    await page.mouse.up();
    await page.waitForTimeout(500);

    clipboard = await page.evaluate(() => navigator.clipboard.readText());
    console.log('Clipboard after mouse drag:', clipboard.substring(0, 80));
    console.log('[Terminal] logs:', consoleLogs.filter(l => l.includes('[Terminal]')));

    if (clipboard !== 'SENTINEL2' && clipboard.length > 0) {
      // Mouse drag auto-copy worked
      return;
    }

    // === If we get here, auto-copy is broken. Print all debug info. ===
    console.log('=== AUTO-COPY BROKEN - DEBUG INFO ===');
    console.log('All [Terminal] logs:', consoleLogs.filter(l => l.includes('[Terminal]')));
    console.log('All console logs (last 30):');
    for (const log of consoleLogs.slice(-30)) {
      console.log('  ', log);
    }

    // Fail with informative message
    expect(clipboard, 'Auto-copy did not fire. Check console logs above.').not.toBe('SENTINEL2');
  });
});
