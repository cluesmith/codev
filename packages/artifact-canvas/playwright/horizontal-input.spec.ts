import { test, expect, type Page, type Locator } from '@playwright/test';

/**
 * Input semantics in real Chromium (spec 1380, plan phase 3): wheel remap efficacy (including
 * "no residual vertical scroll", which only a real event pipeline can prove), yield to inner
 * scrollers, column paging on the measured grid, and axis-aware jump keys.
 */

async function openFixture(page: Page): Promise<Locator> {
  await page.goto('/?fixture=columns&mode=horizontal');
  const body = page.locator('.codev-artifact-canvas-body');
  await expect(body.locator('h1')).toHaveText('Columns fixture');
  await expect(body.locator('.codev-canvas-marker-card')).toHaveCount(6);
  return body;
}

const scrollState = (body: Locator) =>
  body.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }));

test('vertical wheel deltas travel horizontally with NO residual vertical scroll', async ({ page }) => {
  const body = await openFixture(page);
  // Park the pointer over plain prose (not an inner scroller).
  await body.locator('p', { hasText: 'LONGPROSE' }).hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(async () => (await scrollState(body)).left).toBeGreaterThan(0);
  expect((await scrollState(body)).top).toBe(0);
});

test('wheel over a capped code block scrolls the code, not the canvas', async ({ page }) => {
  const body = await openFixture(page);
  const tallPre = body.locator('pre', { hasText: 'tall-fence' });
  await tallPre.scrollIntoViewIfNeeded();
  const before = await scrollState(body);
  await tallPre.hover();
  await page.mouse.wheel(0, 300);
  const inner = tallPre.locator('code');
  await expect.poll(() => inner.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect((await scrollState(body)).left).toBe(before.left);
});

test('PageDown/PageUp step one measured column, landing on the step grid', async ({ page }) => {
  const body = await openFixture(page);
  const block = body.locator('[data-line]').first();
  await block.click(); // focus lands on the block (tabindex=0)
  await page.keyboard.press('PageDown');
  const step = await body.evaluate((el) => {
    const first = el.firstElementChild as Element;
    const width = first.getClientRects()[0].width;
    const gap = Number.parseFloat(getComputedStyle(el).columnGap) || 0;
    return width + gap;
  });
  // scrollLeft rounds to device pixels while the measured step can be fractional (columns
  // stretch to share leftover width) — assert within a pixel of the grid, not exact equality.
  const near = (target: number) => async () =>
    Math.abs((await scrollState(body)).left - target) <= 1;
  await expect.poll(near(step)).toBe(true);
  await page.keyboard.press('PageDown');
  await expect.poll(near(2 * step)).toBe(true);
  await page.keyboard.press('PageUp');
  await expect.poll(near(step)).toBe(true);
});

test('n (next marked block) scrolls the marked block into the viewport horizontally', async ({ page }) => {
  const body = await openFixture(page);
  const first = body.locator('[data-line]').first();
  await first.click();
  await page.keyboard.press('n');
  const marked = body.locator('.codev-canvas-has-marker').first();
  await expect.poll(async () => {
    const visible = await marked.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.right <= window.innerWidth;
    });
    return visible;
  }).toBe(true);
  await expect(marked).toBeFocused();
});
