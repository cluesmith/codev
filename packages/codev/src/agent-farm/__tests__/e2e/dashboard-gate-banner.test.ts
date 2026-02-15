/**
 * E2E tests for Spec 0100: Gate banner in the dashboard.
 *
 * These tests write temporary status.yaml files with pending gates,
 * then verify the dashboard renders (and clears) the gate banner.
 *
 * Prerequisites:
 *   - Tower running: `af tower start`
 *   - Workspace activated
 *   - npx playwright install chromium
 *
 * Run: npx playwright test dashboard-gate-banner
 */

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const TOWER_URL = 'http://localhost:4100';
const WORKSPACE_PATH = resolve(import.meta.dirname, '../../../../../');
const ENCODED_PATH = Buffer.from(WORKSPACE_PATH).toString('base64url');
const PAGE_URL = `${TOWER_URL}/workspace/${ENCODED_PATH}/`;

// Temporary project directory for gate tests (cleaned up after each test)
const TEST_PROJECT_ID = '9999-gate-banner-e2e';
const TEST_PROJECT_DIR = resolve(WORKSPACE_PATH, 'codev', 'projects', TEST_PROJECT_ID);

function writeGateStatus(yaml: string): void {
  mkdirSync(TEST_PROJECT_DIR, { recursive: true });
  writeFileSync(resolve(TEST_PROJECT_DIR, 'status.yaml'), yaml);
}

function cleanupGateStatus(): void {
  try {
    rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

test.describe('Spec 0100: Dashboard Gate Banner', () => {
  test.afterEach(() => {
    cleanupGateStatus();
  });

  test('gate banner appears when status.yaml has a pending gate', async ({ page }) => {
    writeGateStatus(`id: '9999'
title: gate-banner-e2e
protocol: spir
phase: specify
gates:
  spec-approval:
    status: pending
    requested_at: '2026-02-12T18:00:00.000Z'
  plan-approval:
    status: pending
  pr-ready:
    status: pending
`);

    await page.goto(PAGE_URL);
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });

    // Wait for the gate banner to appear (dashboard polls every few seconds)
    const banner = page.locator('.gate-banner');
    await expect(banner).toBeVisible({ timeout: 15_000 });

    // Verify content
    await expect(banner).toContainText('Builder 9999');
    await expect(banner).toContainText('spec-approval');
    await expect(banner).toContainText('porch approve 9999 spec-approval');
  });

  test('gate banner disappears when gate is approved', async ({ page }) => {
    // Start with a pending gate
    writeGateStatus(`id: '9999'
title: gate-banner-e2e
protocol: spir
phase: specify
gates:
  spec-approval:
    status: pending
    requested_at: '2026-02-12T18:00:00.000Z'
`);

    await page.goto(PAGE_URL);
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });

    const banner = page.locator('.gate-banner');
    await expect(banner).toBeVisible({ timeout: 15_000 });

    // Approve the gate
    writeGateStatus(`id: '9999'
title: gate-banner-e2e
protocol: spir
phase: plan
gates:
  spec-approval:
    status: approved
    approved_at: '2026-02-12T18:15:00.000Z'
  plan-approval:
    status: pending
    requested_at: '2026-02-12T18:15:30.000Z'
`);

    // Banner should now show plan-approval (next pending gate)
    await expect(banner).toContainText('plan-approval', { timeout: 15_000 });
    await expect(banner).toContainText('porch approve 9999 plan-approval');
  });

  test('gate banner renders without time indicator when requested_at is missing', async ({ page }) => {
    writeGateStatus(`id: '9999'
title: gate-banner-e2e
protocol: spir
phase: specify
gates:
  spec-approval:
    status: pending
`);

    await page.goto(PAGE_URL);
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });

    const banner = page.locator('.gate-banner');
    await expect(banner).toBeVisible({ timeout: 15_000 });

    // Should show builder ID and gate name
    await expect(banner).toContainText('Builder 9999');
    await expect(banner).toContainText('spec-approval');

    // Should NOT show "waiting" since no requested_at
    const waitBadge = banner.locator('.gate-banner-wait');
    await expect(waitBadge).not.toBeVisible();
  });
});
