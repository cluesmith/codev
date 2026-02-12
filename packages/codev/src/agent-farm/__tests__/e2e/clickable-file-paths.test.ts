/**
 * E2E tests for clickable file paths in terminal output (Spec 0101).
 *
 * Tests:
 *   1. File path decorations appear for detected file paths
 *   2. Cmd+Click on file path opens file viewer tab
 *   3. Plain click (no modifier) does NOT open file
 *   4. Decoration has dotted underline CSS style
 *   5. Plain text without file paths has no decorations
 *   6. URL still works via WebLinksAddon (not decorated as file path)
 *   7. Path resolution via API with terminalId
 *   8. Path traversal returns 403
 *
 * Prerequisites:
 *   - Tower running: `af tower start`
 *   - Project activated
 *   - npx playwright install chromium
 *
 * Run: npx playwright test clickable-file-paths
 */

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

const TOWER_URL = 'http://localhost:4100';
const PROJECT_PATH = resolve(import.meta.dirname, '../../../../../');
const ENCODED_PATH = Buffer.from(PROJECT_PATH).toString('base64url');
const BASE_URL = `${TOWER_URL}/project/${ENCODED_PATH}`;
const PAGE_URL = `${TOWER_URL}/project/${ENCODED_PATH}/`;

/**
 * Wait for the terminal to be ready (xterm.js rendered and connected).
 */
async function waitForTerminal(page: import('@playwright/test').Page) {
  await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });
  await page.locator('.split-pane').waitFor({ state: 'visible', timeout: 10_000 });

  const terminal = page.locator('.split-left .terminal-container');
  await expect(terminal).toBeVisible({ timeout: 15_000 });

  const canvas = terminal.locator('canvas').first();
  await expect(canvas).toBeVisible({ timeout: 10_000 });

  // Give terminal time to fully initialize and connect
  await page.waitForTimeout(1500);
  return terminal;
}

/**
 * Type a command and press Enter, then wait for output to appear
 * and file path decorations to render.
 */
async function typeAndWait(
  page: import('@playwright/test').Page,
  terminal: import('@playwright/test').Locator,
  command: string,
  waitMs = 2000,
) {
  await terminal.click();
  await page.keyboard.type(command, { delay: 30 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(waitMs);
}

/**
 * Count the number of file tab annotations in the dashboard state.
 */
async function getFileTabCount(request: import('@playwright/test').APIRequestContext): Promise<number> {
  const response = await request.get(`${BASE_URL}/api/state`);
  const state = await response.json();
  return (state.annotations ?? []).length;
}

test.describe('Clickable File Paths (Spec 0101)', () => {
  test.describe('Decorations', () => {
    test('file path decorations appear for terminal output', async ({ page }) => {
      await page.goto(PAGE_URL);
      const terminal = await waitForTerminal(page);

      // Type a command that outputs a known file path
      await typeAndWait(page, terminal, 'echo "src/index.ts:42"');

      // File path decoration overlays should appear in the DOM
      const decorations = page.locator('.file-path-decoration');
      const count = await decorations.count();
      expect(count).toBeGreaterThan(0);
    });

    test('decorations have dotted underline CSS style', async ({ page }) => {
      await page.goto(PAGE_URL);
      const terminal = await waitForTerminal(page);

      await typeAndWait(page, terminal, 'echo "src/index.ts:42"');

      const decoration = page.locator('.file-path-decoration').first();
      await expect(decoration).toBeVisible({ timeout: 5_000 });

      // Verify the decoration has the dotted underline border-bottom style
      const borderBottom = await decoration.evaluate(el => {
        const style = window.getComputedStyle(el);
        return style.borderBottomStyle;
      });
      expect(borderBottom).toBe('dotted');
    });

    test('plain text without file paths has no decorations', async ({ page }) => {
      await page.goto(PAGE_URL);
      const terminal = await waitForTerminal(page);

      // Count decorations before
      const beforeCount = await page.locator('.file-path-decoration').count();

      // Type plain text with no file paths
      await typeAndWait(page, terminal, 'echo "hello world no files here"');

      // No new decorations should appear for the plain text
      // (The command line itself "echo ..." has no file-like tokens)
      const afterCount = await page.locator('.file-path-decoration').count();
      // Allow for decorations from any prior terminal output (prompt, etc.),
      // but the "hello world" line itself should not add any
      expect(afterCount).toBeLessThanOrEqual(beforeCount + 0);
    });

    test('URL text does not get file-path-decoration', async ({ page }) => {
      await page.goto(PAGE_URL);
      const terminal = await waitForTerminal(page);

      // Clear any existing decorations reference
      const beforeCount = await page.locator('.file-path-decoration').count();

      // Output a URL — should be handled by WebLinksAddon, not FilePathLinkProvider
      await typeAndWait(page, terminal, 'echo "https://example.com/path/to/resource"');

      // No new file-path decorations should appear for URLs
      const afterCount = await page.locator('.file-path-decoration').count();
      expect(afterCount).toBe(beforeCount);
    });
  });

  test.describe('Click behavior', () => {
    test('Cmd+Click on file path opens file viewer tab', async ({ page, request }) => {
      await page.goto(PAGE_URL);
      const terminal = await waitForTerminal(page);

      // Count existing file tabs
      const beforeTabCount = await getFileTabCount(request);

      // Output a real file path that exists in the project
      await typeAndWait(page, terminal, 'echo "package.json"');

      // Find a file-path decoration and get its center position
      const decoration = page.locator('.file-path-decoration').last();
      await expect(decoration).toBeVisible({ timeout: 5_000 });
      const box = await decoration.boundingBox();
      expect(box).not.toBeNull();

      // Cmd+Click (macOS) / Ctrl+Click (Linux) at the decoration position
      // pointer-events:none on decoration means the click passes through to xterm canvas
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, {
        modifiers: [modifier],
      });

      // Wait for the file tab to be created via API
      await page.waitForTimeout(2000);

      // A new file tab should have been created
      const afterTabCount = await getFileTabCount(request);
      expect(afterTabCount).toBeGreaterThan(beforeTabCount);
    });

    test('plain click (no modifier) does NOT open file', async ({ page, request }) => {
      await page.goto(PAGE_URL);
      const terminal = await waitForTerminal(page);

      // Output a file path
      await typeAndWait(page, terminal, 'echo "package.json"');

      const beforeTabCount = await getFileTabCount(request);

      // Find a decoration and plain click (no modifier key)
      const decoration = page.locator('.file-path-decoration').last();
      await expect(decoration).toBeVisible({ timeout: 5_000 });
      const box = await decoration.boundingBox();
      expect(box).not.toBeNull();

      // Click without modifier — should NOT open file
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.waitForTimeout(1000);

      const afterTabCount = await getFileTabCount(request);
      expect(afterTabCount).toBe(beforeTabCount);
    });
  });

  test.describe('API path resolution', () => {
    test('POST /api/tabs/file resolves relative path within project', async ({ request }) => {
      const response = await request.post(`${BASE_URL}/api/tabs/file`, {
        data: { path: 'package.json' },
      });
      expect(response.ok()).toBe(true);
      const body = await response.json();
      expect(body.id).toBeTruthy();
      // notFound should be false for an existing file
      expect(body.notFound).toBeFalsy();
    });

    test('POST /api/tabs/file with terminalId resolves using terminal cwd', async ({ request }) => {
      // Get the architect's terminalId from the state
      let terminalId: string | undefined;
      for (let i = 0; i < 20; i++) {
        const stateResp = await request.get(`${BASE_URL}/api/state`);
        const state = await stateResp.json();
        terminalId = state.architect?.terminalId;
        if (terminalId) break;
        await new Promise(r => setTimeout(r, 500));
      }
      expect(terminalId).toBeTruthy();

      // Use terminalId to resolve a relative path
      const response = await request.post(`${BASE_URL}/api/tabs/file`, {
        data: { path: 'package.json', terminalId },
      });
      expect(response.ok()).toBe(true);
      const body = await response.json();
      expect(body.id).toBeTruthy();
    });

    test('POST /api/tabs/file rejects path traversal (403)', async ({ request }) => {
      const response = await request.post(`${BASE_URL}/api/tabs/file`, {
        data: { path: '../../../etc/passwd' },
      });
      expect(response.status()).toBe(403);
    });

    test('POST /api/tabs/file with line number returns line', async ({ request }) => {
      const response = await request.post(`${BASE_URL}/api/tabs/file`, {
        data: { path: 'package.json', line: 42 },
      });
      expect(response.ok()).toBe(true);
      const body = await response.json();
      expect(body.line).toBe(42);
    });
  });
});
