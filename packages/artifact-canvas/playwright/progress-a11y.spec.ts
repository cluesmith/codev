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

test('progress readout appears in horizontal and tracks scrolling (formula-independent)', async ({ page }) => {
  // Deliberately NO reimplementation of the total formula here (iter-1 Claude: a mirrored
  // formula can't catch a wrong formula) — only behavioral invariants: a stable total, +1 per
  // column step, and "last column at max scroll".
  const body = await openFixture(page);
  const chip = page.locator('.codev-canvas-reading-progress [aria-hidden]');
  // Wait for async media: the tall diagram's load grows scrollWidth, shifting the total.
  await body.locator('img[alt="tall diagram"]').evaluate(
    (el) =>
      (el as HTMLImageElement).complete ||
      new Promise((resolve) => el.addEventListener('load', resolve, { once: true })),
  );
  await expect(chip).toHaveText(/^Column 1 of \d+$/);
  const total = Number((await chip.textContent())!.match(/of (\d+)$/)![1]);
  expect(total).toBeGreaterThan(3); // a 1100-line fixture is many columns

  await body.locator('[data-line]').first().click();
  await page.keyboard.press('PageDown');
  await expect(chip).toHaveText(`Column 2 of ${total}`);

  // At max scroll the chip reports the viewport-START column — the last screenful still shows
  // several columns, so `current` lands within one viewport of the total, never past it.
  await body.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  const visibleColumns = await body.evaluate((el) => {
    let width = 0;
    const r = el.firstElementChild?.getClientRects()[0];
    if (r) width = r.width;
    const gap = Number.parseFloat(getComputedStyle(el).columnGap) || 0;
    return Math.ceil(el.clientWidth / (width + gap));
  });
  await expect
    .poll(async () => Number((await chip.textContent())!.match(/^Column (\d+)/)![1]))
    .toBeGreaterThanOrEqual(total - visibleColumns);
  expect(Number((await chip.textContent())!.match(/^Column (\d+)/)![1])).toBeLessThanOrEqual(total);
});

test('progress stays fresh when the composer changes layout without a content change', async ({ page }) => {
  const body = await openFixture(page);
  const chip = page.locator('.codev-canvas-reading-progress [aria-hidden]');
  await expect(chip).toHaveText(/^Column 1 of \d+$/);

  // Opening the composer injects in-flow DOM (no html change, no border-box resize).
  await body.locator('p', { hasText: 'Intro paragraph.' }).hover();
  await page.locator('.codev-canvas-add-comment').click();
  await expect(page.locator('.codev-canvas-comment-composer-input')).toBeVisible();

  // Freshness, not formula: the total must reflect CURRENT layout. The mirror below uses the
  // component's exact sampling (first 10 children with nonzero rects) — acceptable here
  // because the claim under test is "recomputed after the layout change", not the formula.
  // Only the total is asserted: the composer's autofocus legitimately scrolls the container.
  const freshTotal = await body.evaluate((el) => {
    let width = 0;
    let sampled = 0;
    for (let c = el.firstElementChild; c && sampled < 10; c = c.nextElementSibling) {
      const r = c.getClientRects()[0];
      if (r && r.width > 0) {
        sampled++;
        if (r.width > width) width = r.width;
      }
    }
    const gap = Number.parseFloat(getComputedStyle(el).columnGap) || 0;
    return Math.max(1, Math.round((el.scrollWidth + gap) / (width + gap)));
  });
  await expect(chip).toHaveText(new RegExp(`of ${freshTotal}$`));
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

  // And the readout recomputed against post-resize geometry (plan phase-5 test item) —
  // component-identical sampling, asserting freshness rather than the formula.
  const postResizeTotal = await body.evaluate((el) => {
    let width = 0;
    let sampled = 0;
    for (let c = el.firstElementChild; c && sampled < 10; c = c.nextElementSibling) {
      const r = c.getClientRects()[0];
      if (r && r.width > 0) {
        sampled++;
        if (r.width > width) width = r.width;
      }
    }
    const gap = Number.parseFloat(getComputedStyle(el).columnGap) || 0;
    return Math.max(1, Math.round((el.scrollWidth + gap) / (width + gap)));
  });
  await expect(page.locator('.codev-canvas-reading-progress [aria-hidden]')).toHaveText(
    new RegExp(`of ${postResizeTotal}$`),
  );
});
