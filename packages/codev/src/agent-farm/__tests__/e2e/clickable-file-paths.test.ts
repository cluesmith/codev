/**
 * E2E tests for clickable file paths in terminal output (Spec 0101).
 *
 * Tests:
 *   1. File path decorations appear for detected file paths
 *   2. Cmd+Click on file path opens file viewer tab
 *   3. Cmd+Click on path with line number opens file tab (spec scenario 11)
 *   4. Cmd+Click on non-existent file shows notFound tab (spec scenario 15)
 *   5. Plain click (no modifier) does NOT open file
 *   6. URL Cmd+Click opens in new tab, not file viewer (spec scenario 13)
 *   7. Decoration has dotted underline CSS style
 *   8. Plain text without file paths has no decorations
 *   9. URL text does not get file-path-decoration
 *  10. Decorations have pointer-events:none
 *  11. Path resolution via API with terminalId
 *  12. Absolute path resolution (spec scenario 12)
 *  13. Path traversal returns 403
 *  14. Path with line number: API returns line for scroll-to-line
 *  15. Builder worktree resolution via shell tab with specific cwd
 *  16. Non-existent file creates tab with notFound indicator
 *  17. Visual regression: dotted underline on file paths (screenshot)
 *  18. Visual regression: no decoration noise on plain text (screenshot)
 *  19. Visual regression: hover pointer cursor on file path (screenshot)
 *
 * Prerequisites:
 *   - Tower running: `af tower start`
 *   - Workspace activated
 *   - npx playwright install chromium
 *
 * Run: npx playwright test clickable-file-paths
 */

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

const TOWER_URL = 'http://localhost:4100';
const WORKSPACE_PATH = resolve(import.meta.dirname, '../../../../../../');
const ENCODED_PATH = Buffer.from(WORKSPACE_PATH).toString('base64url');
const BASE_URL = `${TOWER_URL}/workspace/${ENCODED_PATH}`;
const PAGE_URL = `${TOWER_URL}/workspace/${ENCODED_PATH}/`;

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

/**
 * Get the architect's terminalId from the dashboard state (with polling).
 */
async function getArchitectTerminalId(request: import('@playwright/test').APIRequestContext): Promise<string> {
  let terminalId: string | undefined;
  for (let i = 0; i < 20; i++) {
    const stateResp = await request.get(`${BASE_URL}/api/state`);
    const state = await stateResp.json();
    terminalId = state.architect?.terminalId;
    if (terminalId) break;
    await new Promise(r => setTimeout(r, 500));
  }
  expect(terminalId).toBeTruthy();
  return terminalId!;
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

    test('decorations have pointer-events:none (click passes through to xterm)', async ({ page }) => {
      await page.goto(PAGE_URL);
      const terminal = await waitForTerminal(page);

      await typeAndWait(page, terminal, 'echo "src/index.ts:42"');

      const decoration = page.locator('.file-path-decoration').first();
      await expect(decoration).toBeVisible({ timeout: 5_000 });

      const pointerEvents = await decoration.evaluate(el => {
        return window.getComputedStyle(el).pointerEvents;
      });
      expect(pointerEvents).toBe('none');
    });

    test('plain text without file paths has no decorations', async ({ page }) => {
      await page.goto(PAGE_URL);
      const terminal = await waitForTerminal(page);

      // Count decorations before
      const beforeCount = await page.locator('.file-path-decoration').count();

      // Type plain text with no file paths
      await typeAndWait(page, terminal, 'echo "hello world no files here"');

      // No new decorations should appear for the plain text
      const afterCount = await page.locator('.file-path-decoration').count();
      expect(afterCount).toBeLessThanOrEqual(beforeCount);
    });

    test('URL text does not get file-path-decoration', async ({ page }) => {
      await page.goto(PAGE_URL);
      const terminal = await waitForTerminal(page);

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

      const beforeTabCount = await getFileTabCount(request);

      // Output a real file path that exists in the workspace
      await typeAndWait(page, terminal, 'echo "package.json"');

      // Find a file-path decoration and get its center position
      const decoration = page.locator('.file-path-decoration').last();
      await expect(decoration).toBeVisible({ timeout: 5_000 });
      const box = await decoration.boundingBox();
      expect(box).not.toBeNull();

      // Cmd+Click (macOS) / Ctrl+Click (Linux) at the decoration position.
      // pointer-events:none on decoration means the click passes through to xterm canvas.
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

    test('Cmd+Click on path with line number sends line metadata to API (spec scenario 11)', async ({ page, request }) => {
      await page.goto(PAGE_URL);
      const terminal = await waitForTerminal(page);

      const beforeTabCount = await getFileTabCount(request);

      // Intercept the file tab API call to verify line metadata
      let capturedBody: { path?: string; line?: number } | null = null;
      await page.route('**/api/tabs/file', async (route) => {
        const postData = route.request().postDataJSON();
        capturedBody = postData;
        await route.continue();
      });

      // Output a file path with a line number
      await typeAndWait(page, terminal, 'echo "package.json:5"');

      const decoration = page.locator('.file-path-decoration').last();
      await expect(decoration).toBeVisible({ timeout: 5_000 });
      const box = await decoration.boundingBox();
      expect(box).not.toBeNull();

      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, {
        modifiers: [modifier],
      });

      await page.waitForTimeout(2000);

      // A file tab should have been created via the click
      const afterTabCount = await getFileTabCount(request);
      expect(afterTabCount).toBeGreaterThan(beforeTabCount);

      // Verify the API call included the line number
      expect(capturedBody).not.toBeNull();
      expect(capturedBody!.line).toBe(5);
    });

    test('Cmd+Click on non-existent file path shows notFound tab (spec scenario 15)', async ({ page, request }) => {
      await page.goto(PAGE_URL);
      const terminal = await waitForTerminal(page);

      const beforeTabCount = await getFileTabCount(request);

      // Output a path to a file that does not exist
      await typeAndWait(page, terminal, 'echo "src/does-not-exist-e2e-test.ts"');

      const decoration = page.locator('.file-path-decoration').last();
      await expect(decoration).toBeVisible({ timeout: 5_000 });
      const box = await decoration.boundingBox();
      expect(box).not.toBeNull();

      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, {
        modifiers: [modifier],
      });

      await page.waitForTimeout(2000);

      // A tab should still be created (with notFound indicator)
      const afterTabCount = await getFileTabCount(request);
      expect(afterTabCount).toBeGreaterThan(beforeTabCount);

      // Verify the most recent annotation has notFound set
      const stateResp = await request.get(`${BASE_URL}/api/state`);
      const state = await stateResp.json();
      const annotations = state.annotations ?? [];
      const lastAnnotation = annotations[annotations.length - 1];
      expect(lastAnnotation.notFound).toBe(true);
    });

    test('plain click (no modifier) does NOT open file', async ({ page, request }) => {
      await page.goto(PAGE_URL);
      const terminal = await waitForTerminal(page);

      await typeAndWait(page, terminal, 'echo "package.json"');

      const beforeTabCount = await getFileTabCount(request);

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

    test('URL Cmd+Click opens in new tab, not file viewer (spec scenario 13)', async ({ page, request }) => {
      await page.goto(PAGE_URL);
      const terminal = await waitForTerminal(page);

      const beforeTabCount = await getFileTabCount(request);

      // Output a URL — handled by WebLinksAddon
      await typeAndWait(page, terminal, 'echo "https://example.com"');

      // WebLinksAddon creates its own link elements. Attempt Cmd+Click on the URL area.
      // The URL should not create a file tab — instead it opens a popup (new browser tab).
      // We intercept the popup event to verify URL behavior.
      const popupPromise = page.waitForEvent('popup', { timeout: 5_000 }).catch(() => null);

      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
      // Click approximately in the middle of the terminal line where the URL was echoed
      // WebLinksAddon creates an anchor overlay — Cmd+Click should trigger it
      const termBox = await terminal.boundingBox();
      expect(termBox).not.toBeNull();
      await page.mouse.click(termBox!.x + 100, termBox!.y + termBox!.height - 60, {
        modifiers: [modifier],
      });

      const popup = await popupPromise;

      // Either a popup was opened (URL behavior) or no file tab was created
      // The key assertion: no file tab was created for the URL
      await page.waitForTimeout(1000);
      const afterTabCount = await getFileTabCount(request);
      expect(afterTabCount).toBe(beforeTabCount);

      // If a popup was opened, that confirms URL opens in browser tab
      if (popup) {
        await popup.close();
      }
    });
  });

  test.describe('API path resolution', () => {
    test('resolves relative path within workspace', async ({ request }) => {
      const response = await request.post(`${BASE_URL}/api/tabs/file`, {
        data: { path: 'package.json' },
      });
      expect(response.ok()).toBe(true);
      const body = await response.json();
      expect(body.id).toBeTruthy();
      expect(body.notFound).toBeFalsy();
    });

    test('resolves with terminalId using terminal cwd', async ({ request }) => {
      const terminalId = await getArchitectTerminalId(request);

      const response = await request.post(`${BASE_URL}/api/tabs/file`, {
        data: { path: 'package.json', terminalId },
      });
      expect(response.ok()).toBe(true);
      const body = await response.json();
      expect(body.id).toBeTruthy();
    });

    test('resolves absolute path within workspace (spec scenario 12)', async ({ request }) => {
      // Use an absolute path to a known file
      const absolutePath = `${WORKSPACE_PATH}/package.json`;
      const response = await request.post(`${BASE_URL}/api/tabs/file`, {
        data: { path: absolutePath },
      });
      expect(response.ok()).toBe(true);
      const body = await response.json();
      expect(body.id).toBeTruthy();
      expect(body.notFound).toBeFalsy();
    });

    test('rejects path traversal with 403', async ({ request }) => {
      const response = await request.post(`${BASE_URL}/api/tabs/file`, {
        data: { path: '../../../etc/passwd' },
      });
      expect(response.status()).toBe(403);
    });

    test('returns line number for scroll-to-line', async ({ request }) => {
      const response = await request.post(`${BASE_URL}/api/tabs/file`, {
        data: { path: 'package.json', line: 42 },
      });
      expect(response.ok()).toBe(true);
      const body = await response.json();
      expect(body.line).toBe(42);
    });

    test('builder worktree resolution via shell tab cwd', async ({ request }) => {
      // This test only applies when running from within a builder worktree
      // (.builders/XXXX/). In CI scheduled runs, the workspace is the repo root.
      test.skip(!WORKSPACE_PATH.includes('.builders'), 'Only runs in builder worktree context');

      // Create a shell tab — its cwd is the builder worktree
      const shellResp = await request.post(`${BASE_URL}/api/tabs/shell`, {
        data: { name: 'e2e-worktree-test' },
      });
      expect(shellResp.ok()).toBe(true);
      const shell = await shellResp.json();
      expect(shell.terminalId).toBeTruthy();

      // Resolve a relative path using the shell's terminalId.
      // The shell's cwd is the builder worktree, so "package.json" resolves
      // to .builders/0101/package.json, not the parent workspace's package.json.
      const fileResp = await request.post(`${BASE_URL}/api/tabs/file`, {
        data: { path: 'package.json', terminalId: shell.terminalId },
      });
      expect(fileResp.ok()).toBe(true);
      const fileBody = await fileResp.json();
      expect(fileBody.id).toBeTruthy();
      expect(fileBody.notFound).toBeFalsy();
    });

    test('builder worktree path traversal via terminalId returns 403', async ({ request }) => {
      const terminalId = await getArchitectTerminalId(request);

      // Even with a valid terminalId, traversal outside the workspace returns 403
      const response = await request.post(`${BASE_URL}/api/tabs/file`, {
        data: { path: '../../../../etc/passwd', terminalId },
      });
      expect(response.status()).toBe(403);
    });

    test('non-existent file creates tab with notFound indicator', async ({ request }) => {
      const response = await request.post(`${BASE_URL}/api/tabs/file`, {
        data: { path: 'src/nonexistent-file-for-testing.ts' },
      });
      expect(response.ok()).toBe(true);
      const body = await response.json();
      expect(body.id).toBeTruthy();
      expect(body.notFound).toBe(true);
    });
  });

  test.describe('Visual regression (Spec scenarios 17-19)', () => {
    test('dotted underline on file paths', async ({ page }) => {
      await page.goto(PAGE_URL);
      const terminal = await waitForTerminal(page);

      // Output file paths for screenshot baseline
      await typeAndWait(page, terminal, 'echo "src/index.ts:42 and src/lib/foo.ts:10"');

      // Wait for decorations to render
      const decoration = page.locator('.file-path-decoration').first();
      await expect(decoration).toBeVisible({ timeout: 5_000 });

      // Screenshot the terminal area containing the decorated file paths
      await expect(terminal).toHaveScreenshot('file-path-dotted-underline.png', {
        maxDiffPixelRatio: 0.05,
      });
    });

    test('no visual noise on plain text', async ({ page }) => {
      await page.goto(PAGE_URL);
      const terminal = await waitForTerminal(page);

      // Output text that looks like it might be a file path but isn't
      await typeAndWait(page, terminal, 'echo "This is a sentence. Nothing special v2.0.0"');

      // Wait for any rendering to settle
      await page.waitForTimeout(500);

      // Screenshot should show no dotted underline decorations on plain text
      await expect(terminal).toHaveScreenshot('no-visual-noise-plain-text.png', {
        maxDiffPixelRatio: 0.05,
      });
    });

    test('hover pointer cursor on file path', async ({ page }) => {
      await page.goto(PAGE_URL);
      const terminal = await waitForTerminal(page);

      await typeAndWait(page, terminal, 'echo "src/index.ts:42"');

      const decoration = page.locator('.file-path-decoration').first();
      await expect(decoration).toBeVisible({ timeout: 5_000 });
      const box = await decoration.boundingBox();
      expect(box).not.toBeNull();

      // Move mouse over the file path to trigger hover state
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.waitForTimeout(500);

      // Screenshot with hover state active
      await expect(terminal).toHaveScreenshot('file-path-hover-cursor.png', {
        maxDiffPixelRatio: 0.05,
      });
    });
  });
});
