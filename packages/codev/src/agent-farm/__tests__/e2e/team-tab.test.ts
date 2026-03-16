/**
 * E2E tests for Team tab (Spec 587).
 *
 * Tests the /api/team endpoint response shape and the /api/state
 * teamEnabled field. These tests work regardless of whether a team
 * directory exists — they verify the API contract.
 *
 * Prerequisites:
 *   - npm run build (dist/ must exist)
 *   - npx playwright install chromium
 *
 * Run: npx playwright test team-tab
 */

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

const TOWER_URL = `http://localhost:${process.env.TOWER_TEST_PORT || '4100'}`;
const WORKSPACE_PATH = resolve(import.meta.dirname, '../../../../../../');

function toBase64URL(str: string): string {
  return Buffer.from(str).toString('base64url');
}

const ENCODED_PATH = toBase64URL(WORKSPACE_PATH);
const API_URL = `${TOWER_URL}/workspace/${ENCODED_PATH}`;
const DASH_URL = `${TOWER_URL}/workspace/${ENCODED_PATH}/`;

test.describe('Team tab: API contract', () => {
  test('/api/state includes teamEnabled boolean', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/state`);
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty('teamEnabled');
    expect(typeof data.teamEnabled).toBe('boolean');
  });

  test('/api/team returns valid response shape', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/team`);
    expect(res.ok()).toBe(true);
    const data = await res.json();

    // Must always have 'enabled' field
    expect(data).toHaveProperty('enabled');
    expect(typeof data.enabled).toBe('boolean');

    if (data.enabled) {
      // When enabled, must have members and messages arrays
      expect(Array.isArray(data.members)).toBe(true);
      expect(Array.isArray(data.messages)).toBe(true);

      // Verify member shape
      for (const member of data.members) {
        expect(member).toHaveProperty('name');
        expect(member).toHaveProperty('github');
        expect(member).toHaveProperty('role');
        expect(member).toHaveProperty('filePath');
        expect(member).toHaveProperty('github_data');
      }

      // Verify message shape
      for (const msg of data.messages) {
        expect(msg).toHaveProperty('author');
        expect(msg).toHaveProperty('timestamp');
        expect(msg).toHaveProperty('body');
        expect(msg).toHaveProperty('channel');
      }
    }
  });

  test('/api/state teamEnabled matches /api/team enabled', async ({ request }) => {
    const [stateRes, teamRes] = await Promise.all([
      request.get(`${API_URL}/api/state`),
      request.get(`${API_URL}/api/team`),
    ]);
    expect(stateRes.ok()).toBe(true);
    expect(teamRes.ok()).toBe(true);

    const state = await stateRes.json();
    const team = await teamRes.json();

    // Both endpoints should agree on team status
    expect(state.teamEnabled).toBe(team.enabled);
  });
});

test.describe('Team tab: UI visibility', () => {
  test('team tab appears only when teamEnabled is true', async ({ page, request }) => {
    // Check API first to know what to expect
    const stateRes = await request.get(`${API_URL}/api/state`);
    const state = await stateRes.json();

    await page.goto(DASH_URL);
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });

    // Wait for tabs to render
    await page.locator('.tab-bar').waitFor({ state: 'visible', timeout: 10_000 });

    const teamTab = page.locator('button[role="tab"]:has-text("Team")');

    if (state.teamEnabled) {
      await expect(teamTab).toBeVisible({ timeout: 5_000 });
    } else {
      await expect(teamTab).not.toBeVisible();
    }
  });
});
