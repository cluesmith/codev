/**
 * Bugfix #766: regression guard for the multi-architect (N>1) left pane layout.
 *
 * PR #762 introduced `.architect-pane` / `.architect-pane-body` wrappers in the
 * N>1 branch of `App.tsx` but never added matching CSS, so the architect
 * terminal collapsed to ~1/4 of the SplitPane left side. The fix in
 * `packages/dashboard/src/index.css` makes `.architect-pane` a `flex-direction:
 * column` host with `height: 100%` and `.architect-pane-body` a `flex: 1`
 * filler. This test pins the layout invariant by mocking `/api/state` with
 * N=2 architects and asserting the architect-pane-body fills almost all of the
 * SplitPane left side minus the tab strip.
 *
 * Prerequisites:
 *   - Tower running on TOWER_TEST_PORT (default 4100)
 *   - npx playwright install chromium
 *
 * Run: npx playwright test architect-pane-layout
 */

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

const TOWER_URL = `http://localhost:${process.env.TOWER_TEST_PORT || '4100'}`;
const WORKSPACE_PATH = resolve(import.meta.dirname, '../../../../../../');
const ENCODED_PATH = Buffer.from(WORKSPACE_PATH).toString('base64url');
const DASH_URL = `${TOWER_URL}/workspace/${ENCODED_PATH}/`;

test.describe('Bugfix #766: multi-architect pane fills SplitPane left side', () => {
  test('N=2 architect-pane-body fills the SplitPane left side', async ({ page }) => {
    // Mock /api/state with two architects so the N>1 branch in App.tsx renders
    // the `.architect-pane` / `.architect-pane-body` wrappers.
    await page.route('**/api/state', async (route) => {
      const response = await route.fetch();
      const base = response.ok() ? await response.json().catch(() => ({})) : {};
      const mainArchitect = { name: 'main', port: 0, pid: 1, terminalId: 'term-766-main', persistent: false };
      const siblingArchitect = { name: 'sibling-766', port: 0, pid: 2, terminalId: 'term-766-sibling', persistent: false };
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...base,
          architect: mainArchitect,
          architects: [mainArchitect, siblingArchitect],
          builders: [],
          utils: [],
          annotations: [],
        }),
      });
    });

    await page.goto(DASH_URL);
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });

    // Confirm the N>1 branch rendered: architect tab strip is visible.
    const tabStrip = page.locator('[aria-label="Architect tabs"]');
    await expect(tabStrip).toBeVisible({ timeout: 10_000 });

    const splitLeft = page.locator('.split-left');
    const architectPane = page.locator('.architect-pane');
    const architectBody = page.locator('.architect-pane-body');

    await expect(splitLeft).toBeVisible();
    await expect(architectPane).toBeVisible();
    await expect(architectBody).toBeAttached();

    // The architect-pane wrapper should fill the full height of the SplitPane
    // left side. Allow a small delta for borders / sub-pixel rounding.
    const [leftBox, paneBox, stripBox, bodyBox] = await Promise.all([
      splitLeft.boundingBox(),
      architectPane.boundingBox(),
      tabStrip.boundingBox(),
      architectBody.boundingBox(),
    ]);

    expect(leftBox, '.split-left must have a bounding box').not.toBeNull();
    expect(paneBox, '.architect-pane must have a bounding box').not.toBeNull();
    expect(stripBox, 'architect tab strip must have a bounding box').not.toBeNull();
    expect(bodyBox, '.architect-pane-body must have a bounding box').not.toBeNull();

    // .architect-pane fills .split-left vertically (within 2px tolerance).
    expect(Math.abs(paneBox!.height - leftBox!.height)).toBeLessThanOrEqual(2);

    // .architect-pane-body fills the remaining space below the tab strip.
    // Pre-fix, the body collapsed to ~0px (children-only intrinsic height
    // since `Terminal` had no fixed height inside an undefined-height flex
    // child). Post-fix it must be at least 60% of the left pane height.
    const expectedMinBodyHeight = (leftBox!.height - stripBox!.height) * 0.6;
    expect(bodyBox!.height).toBeGreaterThanOrEqual(expectedMinBodyHeight);

    // And the body's bottom should reach (within 2px) the bottom of the
    // split-left container — i.e. the pane is not collapsed to ~1/4 height.
    const leftBottom = leftBox!.y + leftBox!.height;
    const bodyBottom = bodyBox!.y + bodyBox!.height;
    expect(Math.abs(leftBottom - bodyBottom)).toBeLessThanOrEqual(2);
  });
});
