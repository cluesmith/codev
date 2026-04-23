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

        // When github_data is present, reviewBlocking must always be an array (spec 694).
        if (member.github_data !== null) {
          expect(Array.isArray(member.github_data.reviewBlocking)).toBe(true);
        }
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

test.describe('Team tab: review-blocking rendering (spec 694)', () => {
  test('renders both-direction sentences with a mocked /api/team response', async ({ page }) => {
    const mockedTeam = {
      enabled: true,
      members: [
        {
          name: 'Amr',
          github: 'amr',
          role: 'Developer',
          filePath: 'codev/team/people/amr.md',
          github_data: {
            assignedIssues: [],
            openPRs: [
              { number: 688, title: 'local-install consolidation', url: 'https://github.com/org/repo/pull/688' },
            ],
            recentActivity: { mergedPRs: [], closedIssues: [] },
            reviewBlocking: [
              {
                direction: 'authored',
                otherName: 'Waleed',
                otherGithub: 'waleed',
                pr: {
                  number: 688,
                  title: 'local-install consolidation',
                  url: 'https://github.com/org/repo/pull/688',
                  createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
                },
              },
            ],
          },
        },
        {
          name: 'Waleed',
          github: 'waleed',
          role: 'Architect',
          filePath: 'codev/team/people/waleed.md',
          github_data: {
            assignedIssues: [],
            openPRs: [],
            recentActivity: { mergedPRs: [], closedIssues: [] },
            reviewBlocking: [
              {
                direction: 'reviewing',
                otherName: 'Amr',
                otherGithub: 'amr',
                pr: {
                  number: 688,
                  title: 'local-install consolidation',
                  url: 'https://github.com/org/repo/pull/688',
                  createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
                },
              },
            ],
          },
        },
      ],
      messages: [],
      warnings: [],
    };

    // Mock both /api/state (force teamEnabled: true) and /api/team so the render
    // test is deterministic regardless of whether the underlying workspace has
    // a team directory.
    await page.route('**/api/state', async (route) => {
      // Let the real response come through, then patch teamEnabled = true.
      const response = await route.fetch();
      const base = response.ok() ? await response.json().catch(() => ({})) : {};
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...base, teamEnabled: true }),
      });
    });
    await page.route('**/api/team', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockedTeam),
      }),
    );

    await page.goto(DASH_URL);
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });
    await page.locator('.tab-bar').waitFor({ state: 'visible', timeout: 10_000 });

    const teamTab = page.locator('button[role="tab"]:has-text("Team")');
    await expect(teamTab).toBeVisible({ timeout: 5_000 });
    await teamTab.click();
    await page.locator('.team-review-blocking').first().waitFor({ state: 'visible', timeout: 5_000 });

    // Identify each card by its GitHub handle element (unique per member),
    // not by substring match on the whole card — review-blocking sentences
    // legitimately mention the other member's name, which would otherwise
    // cause `hasText: 'Amr'` / `hasText: 'Waleed'` to match multiple cards.
    const amrCard = page
      .locator('.team-member-card')
      .filter({ has: page.locator('.team-member-github', { hasText: /^@amr$/ }) });
    const waleedCard = page
      .locator('.team-member-card')
      .filter({ has: page.locator('.team-member-github', { hasText: /^@waleed$/ }) });

    // Amr's card: second-person "You're waiting for Waleed".
    await expect(amrCard).toContainText("You're waiting for");
    await expect(amrCard).toContainText('Waleed');
    await expect(amrCard).toContainText('#688');

    // Waleed's card: "Amr is waiting for you".
    await expect(waleedCard).toContainText('is waiting for you to review');
    await expect(waleedCard).toContainText('#688');

    // Link href resolves to the GitHub PR.
    const link = amrCard.locator('.team-review-blocking-link').first();
    await expect(link).toHaveAttribute('href', 'https://github.com/org/repo/pull/688');
  });
});
