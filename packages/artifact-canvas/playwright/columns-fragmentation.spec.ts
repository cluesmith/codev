import { test, expect, type Page, type Locator } from '@playwright/test';

/**
 * Fragmentation regression suite (spec 1380, plan phase 2): the spec-phase spike findings as
 * living assertions over the real canvas DOM + theme CSS in Chromium, via the examples page in
 * fixture mode (`?fixture=columns`). What is asserted here is the spec's success criteria 1
 * (no clipped/unreachable content), 4 (no protected block straddles a boundary), 5 (tall code
 * readable via inner scroll), plus the self-bounding height fallback.
 */

const FIXTURE_URL = '/?fixture=columns&mode=horizontal';

async function openFixture(page: Page, url: string = FIXTURE_URL): Promise<Locator> {
  await page.goto(url);
  const body = page.locator('.codev-artifact-canvas-body');
  await expect(body.locator('h1')).toHaveText('Columns fixture');
  // Marker cards load async through the stub adapter round-trip; the fixture carries a
  // five-card stack plus the tall card, so wait until every card is present.
  await expect(body.locator('.codev-canvas-marker-card')).toHaveCount(6);
  return body;
}

const fragmentCount = (loc: Locator): Promise<number> =>
  loc.evaluate((el) => el.getClientRects().length);

test('overflow columns scroll horizontally and nothing overflows vertically', async ({ page }) => {
  const body = await openFixture(page);
  const metrics = await body.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth); // spike finding 1
  // Under `overflow-y: hidden`, vertical overflow would be UNREACHABLE content (spec success
  // criterion 1) — with every cap in place there must be none.
  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight);
});

test('protected blocks each report exactly one fragment rect', async ({ page }) => {
  const body = await openFixture(page);
  const shortFence = body.locator('pre', { hasText: 'short-fence' });
  expect(await fragmentCount(shortFence)).toBe(1);

  const wideTable = body.locator('table', { hasText: 'WideTable' });
  expect(await fragmentCount(wideTable)).toBe(1);

  const cards = body.locator('.codev-canvas-marker-card');
  const cardCount = await cards.count();
  expect(cardCount).toBe(6);
  for (let i = 0; i < cardCount; i++) {
    expect(await fragmentCount(cards.nth(i)), `card ${i} must not straddle a boundary`).toBe(1);
  }

  const img = body.locator('img[alt="tall diagram"]');
  await expect(img).toBeVisible();
  expect(await fragmentCount(img)).toBe(1);
});

test('over-tall code fits its column with a working inner scroll (D1)', async ({ page }) => {
  const body = await openFixture(page);
  const tallPre = body.locator('pre', { hasText: 'tall-fence' });
  expect(await fragmentCount(tallPre)).toBe(1);

  const columnHeight = await body.evaluate((el) => el.clientHeight);
  const preBox = await tallPre.boundingBox();
  expect(preBox).not.toBeNull();
  expect(preBox!.height).toBeLessThanOrEqual(columnHeight);

  // The inner `code` is the scroll container (#1343): it must actually scroll.
  const inner = tallPre.locator('code');
  const scrolls = await inner.evaluate((el) => {
    if (el.scrollHeight <= el.clientHeight) return false;
    el.scrollTop = 200;
    return el.scrollTop > 0;
  });
  expect(scrolls).toBe(true);
});

test('over-tall table fits its column with a working inner scroll (D1)', async ({ page }) => {
  const body = await openFixture(page);
  const tallTable = body.locator('table', { hasText: 'TallTable' });
  expect(await fragmentCount(tallTable)).toBe(1);

  const columnHeight = await body.evaluate((el) => el.clientHeight);
  const box = await tallTable.boundingBox();
  expect(box!.height).toBeLessThanOrEqual(columnHeight);

  const scrolls = await tallTable.evaluate((el) => {
    if (el.scrollHeight <= el.clientHeight) return false;
    el.scrollTop = 200;
    return el.scrollTop > 0;
  });
  expect(scrolls).toBe(true);
});

test('over-long comment card fits its column; the card body inner-scrolls (D1)', async ({ page }) => {
  const body = await openFixture(page);
  const tallCard = body.locator('.codev-canvas-marker-card', { hasText: 'TALLCARD' });
  expect(await fragmentCount(tallCard)).toBe(1);

  const columnHeight = await body.evaluate((el) => el.clientHeight);
  const box = await tallCard.boundingBox();
  expect(box!.height).toBeLessThanOrEqual(columnHeight);

  const scrolls = await tallCard.locator('.codev-canvas-marker-card-body').evaluate((el) => {
    if (el.scrollHeight <= el.clientHeight) return false;
    el.scrollTop = 50;
    return el.scrollTop > 0;
  });
  expect(scrolls).toBe(true);
});

test('tall image scales to fit the column (monolithic, capped)', async ({ page }) => {
  const body = await openFixture(page);
  const img = body.locator('img[alt="tall diagram"]');
  await expect(img).toBeVisible();
  const columnHeight = await body.evaluate((el) => el.clientHeight);
  const box = await img.boundingBox();
  expect(box!.height).toBeLessThanOrEqual(columnHeight);
  expect(box!.height).toBeGreaterThan(0);
});

test('fragmenting prose reports one client rect per column fragment (spike finding 5)', async ({ page }) => {
  const body = await openFixture(page);
  const long = body.locator('p', { hasText: 'LONGPROSE' });
  const rects = await long.evaluate((el) =>
    Array.from(el.getClientRects()).map((r) => ({ left: Math.round(r.left) })),
  );
  expect(rects.length).toBeGreaterThan(1);
  // Fragments live in different columns: distinct left edges.
  expect(new Set(rects.map((r) => r.left)).size).toBe(rects.length);
});

test('an open composer never fragments (Constraint 4)', async ({ page }) => {
  const body = await openFixture(page);
  const target = body.locator('p', { hasText: 'Intro paragraph.' });
  await target.hover();
  await page.locator('.codev-canvas-add-comment').click();

  const host = body.locator('.codev-canvas-comment-composer-host');
  await expect(host).toBeVisible();
  expect(await fragmentCount(host)).toBe(1);
  await expect(page.locator('.codev-canvas-comment-composer-input')).toBeVisible();
});

test('without a host height context the canvas self-bounds to the viewport', async ({ page }) => {
  // `column-fill: auto` against an INDEFINITE height with a definite max-height is exactly the
  // engine behavior the spec's unbounded-embed criterion rests on (iter-1 Claude) — assert it.
  const body = await openFixture(page, `${FIXTURE_URL}&height=unbounded`);
  const metrics = await body.evaluate((el) => ({
    clientHeight: el.clientHeight,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    viewport: window.innerHeight,
  }));
  expect(metrics.clientHeight).toBeLessThanOrEqual(metrics.viewport);
  expect(metrics.clientHeight).toBeGreaterThan(0);
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth); // still columns, not one tall column
});

test('vertical mode lays out single-column (no mode class, no columns)', async ({ page }) => {
  await page.goto('/?fixture=columns');
  const body = page.locator('.codev-artifact-canvas-body');
  await expect(body.locator('h1')).toHaveText('Columns fixture');
  const root = page.locator('.codev-artifact-canvas');
  await expect(root).not.toHaveClass(/codev-canvas-mode-horizontal/);
  const metrics = await body.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
});
