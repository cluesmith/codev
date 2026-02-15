/**
 * E2E tests for dashboard terminal functionality after node-pty rewrite.
 *
 * Prerequisites:
 *   - Tower running: `af tower start`
 *   - Workspace activated (tests will activate codev-public)
 *   - Playwright browsers installed: `npx playwright install chromium`
 *
 * Run: npx playwright test
 */

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

const TOWER_URL = 'http://localhost:4100';
const WORKSPACE_PATH = resolve(import.meta.dirname, '../../../../../');
const ENCODED_PATH = Buffer.from(WORKSPACE_PATH).toString('base64url');
// BASE_URL without trailing slash for API calls
const BASE_URL = `${TOWER_URL}/workspace/${ENCODED_PATH}`;
// PAGE_URL with trailing slash for page loads (needed for relative asset resolution)
const PAGE_URL = `${TOWER_URL}/workspace/${ENCODED_PATH}/`;

test.describe('Dashboard Terminals E2E', () => {
  test('React dashboard loads (not legacy)', async ({ page }) => {
    const response = await page.goto(PAGE_URL);
    expect(response?.ok()).toBe(true);

    // React dashboard has <div id="root"> rendered by Vite
    const root = page.locator('#root');
    await expect(root).toBeAttached({ timeout: 5_000 });

    // Legacy dashboard injects STATE_INJECTION_POINT — React does not
    const html = await page.content();
    expect(html).not.toContain('STATE_INJECTION_POINT');
  });

  test('/api/state returns architect with terminalId', async ({ request }) => {
    // Poll for terminalId — the dashboard server creates the architect PTY session asynchronously
    let state: any;
    for (let i = 0; i < 30; i++) {
      const response = await request.get(`${BASE_URL}/api/state`);
      expect(response.ok()).toBe(true);
      state = await response.json();
      if (state.architect?.terminalId) break;
      await new Promise(r => setTimeout(r, 500));
    }
    expect(state.architect).toBeTruthy();
    expect(typeof state.architect.terminalId).toBe('string');
    expect(state.architect.terminalId.length).toBeGreaterThan(0);
    // port and pid exist in SQLite but are always 0 (vestigial columns)
  });

  test('shell tab creation returns terminalId and WebSocket works', async ({ page, request }) => {
    // Create a shell tab via the API
    const response = await request.post(`${BASE_URL}/api/tabs/shell`, {
      data: { name: 'e2e-test-shell' },
    });
    expect(response.status()).toBe(200); // Tower returns 200 for shell creation

    const body = await response.json();
    expect(body.id).toBeTruthy();
    expect(body.terminalId).toBeTruthy();

    const terminalId = body.terminalId;

    // Verify WebSocket connects to this terminal through tower proxy
    await page.goto(PAGE_URL);
    const wsConnected = await page.evaluate(({ tid, encodedPath }: { tid: string; encodedPath: string }) => {
      return new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`ws://localhost:4100/workspace/${encodedPath}/ws/terminal/${tid}`);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          ws.close();
          resolve(true);
        };
        ws.onerror = () => resolve(false);
        setTimeout(() => resolve(false), 5000);
      });
    }, { tid: terminalId, encodedPath: ENCODED_PATH });
    expect(wsConnected).toBe(true);

    // Clean up
    await request.delete(`${BASE_URL}/api/tabs/${body.id}`);
  });

  test('architect terminal WebSocket connects', async ({ page, request }) => {
    // Poll for terminalId (async PTY init)
    let terminalId: string | undefined;
    for (let i = 0; i < 30; i++) {
      const stateRes = await request.get(`${BASE_URL}/api/state`);
      const state = await stateRes.json();
      terminalId = state.architect?.terminalId;
      if (terminalId) break;
      await new Promise(r => setTimeout(r, 500));
    }
    expect(terminalId).toBeTruthy();

    await page.goto(PAGE_URL);
    const wsConnected = await page.evaluate(({ tid, encodedPath }: { tid: string; encodedPath: string }) => {
      return new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`ws://localhost:4100/workspace/${encodedPath}/ws/terminal/${tid}`);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          ws.close();
          resolve(true);
        };
        ws.onerror = () => resolve(false);
        setTimeout(() => resolve(false), 5000);
      });
    }, { tid: terminalId!, encodedPath: ENCODED_PATH });
    expect(wsConnected).toBe(true);
  });

  test('architect tab shows xterm terminal', async ({ page }) => {
    await page.goto(PAGE_URL);
    // Wait for React app to mount
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });
    await page.waitForTimeout(2000);

    // Desktop mode renders split-pane layout with architect terminal in left pane
    const splitPane = page.locator('.split-pane');
    await expect(splitPane).toBeVisible({ timeout: 10_000 });

    // Terminal container should be rendered in the left pane
    const terminal = page.locator('.split-left .terminal-container');
    await expect(terminal).toBeVisible({ timeout: 15_000 });
  });

  test('npm pack includes dashboard/dist', async () => {
    const { execSync } = await import('node:child_process');
    const output = execSync('npm pack --dry-run 2>&1', {
      cwd: resolve(WORKSPACE_PATH, 'packages/codev'),
      encoding: 'utf-8',
    });
    expect(output).toContain('dashboard/dist/index.html');
    expect(output).toContain('dashboard/dist/assets/');
  });
});
