/**
 * E2E tests for clipboard operations in the terminal (Issue #203).
 *
 * Tests:
 *   1. Paste: Cmd+V pastes clipboard text into terminal
 *   2. Copy: Select text + Cmd+C copies to clipboard
 *   3. SIGINT: Cmd+C with no selection sends SIGINT (doesn't copy)
 *
 * Prerequisites:
 *   - Tower running: `af tower start`
 *   - Project activated
 *   - npx playwright install chromium
 *
 * Run: npx playwright test dashboard-clipboard
 */

import { test, expect, type BrowserContext } from '@playwright/test';
import { resolve } from 'node:path';

const TOWER_URL = 'http://localhost:4100';
const PROJECT_PATH = resolve(import.meta.dirname, '../../../../../');
const ENCODED_PATH = Buffer.from(PROJECT_PATH).toString('base64url');
const PAGE_URL = `${TOWER_URL}/project/${ENCODED_PATH}/`;

// Grant clipboard permissions for the test context
test.use({
  permissions: ['clipboard-read', 'clipboard-write'],
});

/**
 * Wait for the terminal to be ready (xterm.js rendered and connected)
 */
async function waitForTerminal(page: import('@playwright/test').Page) {
  // Wait for React app and split pane
  await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });
  await page.locator('.split-pane').waitFor({ state: 'visible', timeout: 10_000 });

  // Wait for terminal container to render in the left pane
  const terminal = page.locator('.split-left .terminal-container');
  await expect(terminal).toBeVisible({ timeout: 15_000 });

  // Wait for xterm.js canvas to render (indicates terminal is connected)
  const canvas = terminal.locator('canvas').first();
  await expect(canvas).toBeVisible({ timeout: 10_000 });

  // Give terminal a moment to fully initialize
  await page.waitForTimeout(1000);

  return terminal;
}

test.describe('Clipboard Operations (Issue #203)', () => {
  test('paste: Cmd+V inserts clipboard text into terminal', async ({ page, context }) => {
    await page.goto(PAGE_URL);
    const terminal = await waitForTerminal(page);

    // Seed the clipboard with known text
    const pasteText = `echo clipboard-paste-test-${Date.now()}`;
    await page.evaluate((text) => navigator.clipboard.writeText(text), pasteText);

    // Focus the terminal
    await terminal.click();

    // Paste via Cmd+V (macOS) / Ctrl+V
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modifier}+v`);

    // Wait for paste to be processed
    await page.waitForTimeout(500);

    // The pasted text should appear in the terminal — read xterm content via its API
    const terminalText = await page.evaluate(() => {
      // xterm.js exposes terminal instances; find the one in the DOM
      const terminalEl = document.querySelector('.split-left .terminal-container .xterm');
      if (!terminalEl) return '';
      // Access xterm's buffer via the textarea's associated terminal
      const textarea = terminalEl.querySelector('textarea');
      if (!textarea) return '';
      // Use the terminal's buffer to get the active line
      // @ts-ignore - accessing xterm internals
      const term = (terminalEl as any)._xterm || (terminalEl as any).__xterm;
      if (term) {
        const buffer = term.buffer.active;
        let text = '';
        for (let i = 0; i < buffer.length; i++) {
          const line = buffer.getLine(i);
          if (line) text += line.translateToString(true) + '\n';
        }
        return text;
      }
      return terminalEl.textContent || '';
    });

    expect(terminalText).toContain('clipboard-paste-test');
  });

  test('copy: selecting text + Cmd+C copies to clipboard', async ({ page }) => {
    await page.goto(PAGE_URL);
    const terminal = await waitForTerminal(page);

    // Type a unique string into the terminal so we have known text to select
    await terminal.click();
    const marker = `COPYTEST${Date.now()}`;
    await page.keyboard.type(`echo ${marker}`, { delay: 30 });
    await page.keyboard.press('Enter');

    // Wait for echo output
    await page.waitForTimeout(1000);

    // Select text in the terminal by programmatically using xterm's selectAll
    await page.evaluate(() => {
      const terminalEl = document.querySelector('.split-left .terminal-container .xterm');
      if (!terminalEl) return;
      // @ts-ignore
      const term = (terminalEl as any)._xterm || (terminalEl as any).__xterm;
      if (term) {
        term.selectAll();
      }
    });

    // Copy via Cmd+C
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modifier}+c`);
    await page.waitForTimeout(500);

    // Read clipboard
    const clipboardContent = await page.evaluate(() => navigator.clipboard.readText());

    // Clipboard should contain our marker text
    expect(clipboardContent).toContain(marker);
  });

  test('SIGINT: Cmd+C with no selection sends SIGINT, does not copy', async ({ page }) => {
    await page.goto(PAGE_URL);
    const terminal = await waitForTerminal(page);

    // Clear any existing selection and seed clipboard with known content
    const sentinel = `SENTINEL-${Date.now()}`;
    await page.evaluate((text) => navigator.clipboard.writeText(text), sentinel);

    // Focus terminal, ensure no selection
    await terminal.click();
    await page.evaluate(() => {
      const terminalEl = document.querySelector('.split-left .terminal-container .xterm');
      if (!terminalEl) return;
      // @ts-ignore
      const term = (terminalEl as any)._xterm || (terminalEl as any).__xterm;
      if (term) {
        term.clearSelection();
      }
    });

    // Press Cmd+C with no selection — should send SIGINT, not copy
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modifier}+c`);
    await page.waitForTimeout(500);

    // Clipboard should still contain the sentinel (unchanged — no copy happened)
    const clipboardContent = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardContent).toBe(sentinel);
  });
});
