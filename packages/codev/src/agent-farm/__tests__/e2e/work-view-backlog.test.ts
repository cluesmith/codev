/**
 * E2E tests for Work view backlog improvements (bugfix #373):
 * 1. Backlog items are clickable (link to GitHub issue)
 * 2. Artifact links (spec, plan, review) displayed when available
 * 3. Recently-closed section shows when items exist
 *
 * Prerequisites:
 *   - npm run build (dist/ must exist)
 *   - npx playwright install chromium
 *
 * Run: npx playwright test work-view-backlog
 */

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

const TOWER_URL = `http://localhost:${process.env.TOWER_TEST_PORT || '4100'}`;
const WORKSPACE_PATH = resolve(import.meta.dirname, '../../../../../../');

function toBase64URL(str: string): string {
  return Buffer.from(str).toString('base64url');
}

const ENCODED_PATH = toBase64URL(WORKSPACE_PATH);
const DASH_URL = `${TOWER_URL}/workspace/${ENCODED_PATH}/`;
const API_URL = `${TOWER_URL}/workspace/${ENCODED_PATH}`;

test.describe('Work view: backlog clickability and artifacts', () => {
  test('overview API returns backlog items with url field', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/overview`);
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty('backlog');
    expect(Array.isArray(data.backlog)).toBe(true);

    // Each backlog item must have a url field
    for (const item of data.backlog) {
      expect(item).toHaveProperty('url');
      expect(item).toHaveProperty('number');
      expect(item).toHaveProperty('title');
      expect(item).toHaveProperty('type');
      expect(item).toHaveProperty('priority');
      expect(item).toHaveProperty('hasSpec');
      expect(item).toHaveProperty('hasPlan');
      expect(item).toHaveProperty('hasReview');
    }
  });

  test('overview API returns recentlyClosed array', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/overview`);
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty('recentlyClosed');
    expect(Array.isArray(data.recentlyClosed)).toBe(true);

    // Each recently-closed item must have url and closedAt
    for (const item of data.recentlyClosed) {
      expect(item).toHaveProperty('url');
      expect(item).toHaveProperty('number');
      expect(item).toHaveProperty('title');
      expect(item).toHaveProperty('closedAt');
    }
  });

  test('backlog items render as clickable links', async ({ page }) => {
    await page.goto(DASH_URL);
    // Wait for the dashboard to load and Work view to render
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });

    // Navigate to Work tab if not already selected
    const workTab = page.locator('.tab-bar-item:has-text("Work")');
    if (await workTab.isVisible()) {
      await workTab.click();
    }

    // Wait for backlog section to appear
    const backlogSection = page.locator('.work-section:has-text("Projects and Bugs")');
    await expect(backlogSection).toBeVisible({ timeout: 15_000 });

    // Check if there are backlog rows
    const backlogRows = page.locator('.backlog-row');
    const count = await backlogRows.count();

    if (count > 0) {
      // Each backlog row should contain a clickable anchor
      const firstRow = backlogRows.first();
      const link = firstRow.locator('.backlog-row-main');
      await expect(link).toBeVisible();

      // The anchor should have an href pointing to GitHub
      const href = await link.getAttribute('href');
      expect(href).toBeTruthy();
      expect(href).toContain('github.com');

      // Should open in new tab
      const target = await link.getAttribute('target');
      expect(target).toBe('_blank');

      // Row should contain issue number, type tag, and title
      await expect(firstRow.locator('.backlog-row-number')).toBeVisible();
      await expect(firstRow.locator('.backlog-type-tag')).toBeVisible();
      await expect(firstRow.locator('.backlog-row-title')).toBeVisible();
    }
  });

  test('artifact links display for items with specs/plans/reviews', async ({ page }) => {
    await page.goto(DASH_URL);
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });

    // Navigate to Work tab
    const workTab = page.locator('.tab-bar-item:has-text("Work")');
    if (await workTab.isVisible()) {
      await workTab.click();
    }

    const backlogSection = page.locator('.work-section:has-text("Projects and Bugs")');
    await expect(backlogSection).toBeVisible({ timeout: 15_000 });

    // Check for artifact link buttons (they appear when items have specs/plans/reviews)
    const artifactLinks = page.locator('.backlog-artifact-link');
    const artifactCount = await artifactLinks.count();

    // If any artifact links exist, verify they're buttons with correct labels
    if (artifactCount > 0) {
      for (let i = 0; i < artifactCount; i++) {
        const link = artifactLinks.nth(i);
        const text = await link.textContent();
        expect(['spec', 'plan', 'review']).toContain(text);
      }
    }
  });

  test('recently closed section renders when items exist', async ({ page }) => {
    await page.goto(DASH_URL);
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });

    // Navigate to Work tab
    const workTab = page.locator('.tab-bar-item:has-text("Work")');
    if (await workTab.isVisible()) {
      await workTab.click();
    }

    // Wait for work view content to load
    await page.locator('.work-section').first().waitFor({ state: 'visible', timeout: 15_000 });

    // Check the overview API for recently closed items
    const res = await page.request.get(`${API_URL}/api/overview`);
    const data = await res.json();

    if (data.recentlyClosed && data.recentlyClosed.length > 0) {
      // Recently Closed section should be visible
      const closedSection = page.locator('.work-section:has-text("Recently Closed")');
      await expect(closedSection).toBeVisible({ timeout: 5_000 });

      // Items should be clickable links
      const closedRows = page.locator('.recently-closed-row');
      const closedCount = await closedRows.count();
      expect(closedCount).toBeGreaterThan(0);

      // First closed item should be an anchor with href
      const firstClosed = closedRows.first();
      const href = await firstClosed.getAttribute('href');
      expect(href).toBeTruthy();
      expect(href).toContain('github.com');

      // Should have checkmark
      await expect(firstClosed.locator('.recently-closed-check')).toBeVisible();
    }
    // If no recently closed items, the section should not be visible
    else {
      const closedSection = page.locator('.work-section:has-text("Recently Closed")');
      await expect(closedSection).not.toBeVisible();
    }
  });
});
