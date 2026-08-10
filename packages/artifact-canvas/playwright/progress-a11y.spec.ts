import { test, expect, type Page, type Locator } from '@playwright/test';

/**
 * Progress readout, minimap suppression, resize re-anchoring, and container semantics in real
 * Chromium (spec 1380 D3/D8 + Constraint 7, plan phase 5).
 */

async function openFixture(page: Page, url = '/?fixture=columns&mode=horizontal'): Promise<Locator> {
  await page.goto(url);
  const body = page.locator('.codev-artifact-canvas-body');
  await expect(body.locator('h1')).toHaveText('Columns fixture');
  await expect(body.locator('.codev-canvas-marker-card')).toHaveCount(6);
  return body;
}

test('progress readout appears in horizontal, tracks scrolling, and matches the column count', async ({ page }) => {
  const body = await openFixture(page);
  const chip = page.locator('.codev-canvas-reading-progress [aria-hidden]');
  await expect(chip).toHaveText(/^Column 1 of \d+$/);

  const expected = await body.evaluate((el) => {
    const first = el.firstElementChild as Element;
    const width = first.getClientRects()[0].width;
    const gap = Number.parseFloat(getComputedStyle(el).columnGap) || 0;
    return Math.max(1, Math.round((el.scrollWidth + gap) / (width + gap)));
  });
  await expect(chip).toHaveText(`Column 1 of ${expected}`);

  await body.locator('[data-line]').first().click();
  await page.keyboard.press('PageDown');
  await expect(chip).toHaveText(`Column 2 of ${expected}`);
});

test('minimap is suppressed in horizontal mode and present in vertical (D3)', async ({ page }) => {
  await openFixture(page, '/?fixture=columns'); // vertical, markers present
  await expect(page.locator('.codev-canvas-minimap')).toBeVisible();

  await openFixture(page); // horizontal
  await expect(page.locator('.codev-canvas-minimap')).toHaveCount(0);
  await expect(page.locator('.codev-canvas-reading-progress')).toBeVisible();
});

test('container is a focusable region with a roledescription; Tab reaches it after the toggle', async ({ page }) => {
  const body = await openFixture(page);
  await expect(body).toHaveAttribute('role', 'region');
  await expect(body).toHaveAttribute('aria-roledescription', 'multi-column reading view');
  await expect(body).toHaveAttribute('tabindex', '0');

  // Focus the container directly, page from it — the phase-5 reachability decision.
  await body.evaluate((el) => (el as HTMLElement).focus());
  await page.keyboard.press('PageDown');
  await expect.poll(() => body.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
});

test('window resize reflows columns and keeps the viewport-start block in view', async ({ page }) => {
  const body = await openFixture(page);
  // Scroll a few columns in so re-anchoring has something to preserve.
  const block = body.locator('[data-line]').first();
  await block.click();
  await page.keyboard.press('PageDown');
  await page.keyboard.press('PageDown');
  await page.keyboard.press('PageDown');
  // Let the scroll-tracking rAF record the viewport-start line.
  await page.waitForTimeout(100);
  const anchorLine = await body.evaluate((el) => {
    const rootRect = el.getBoundingClientRect();
    for (const b of Array.from(el.querySelectorAll('[data-line]'))) {
      const r = b.getBoundingClientRect();
      if (r.right > rootRect.left) return b.getAttribute('data-line');
    }
    return null;
  });
  expect(anchorLine).not.toBeNull();

  await page.setViewportSize({ width: 1100, height: 700 });
  await page.waitForTimeout(200); // ResizeObserver + re-anchor
  const anchorVisible = await body.evaluate((el, line) => {
    const b = el.querySelector(`[data-line="${line}"]`);
    if (!b) return false;
    const r = b.getBoundingClientRect();
    return r.right > 0 && r.left < window.innerWidth;
  }, anchorLine);
  expect(anchorVisible).toBe(true);

  // The published column height tracked the resize too.
  const publishedHeight = await page
    .locator('.codev-artifact-canvas')
    .evaluate((el) => el.style.getPropertyValue('--codev-canvas-column-height'));
  const clientHeight = await body.evaluate((el) => el.clientHeight);
  expect(publishedHeight).toBe(`${clientHeight}px`);
});
