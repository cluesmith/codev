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

test('NESTED tall fence (inside a list item) is protected and inner-scrolls (#1396 shape)', async ({ page }) => {
  const body = await openFixture(page);
  const nested = body.locator('li pre', { hasText: 'nested-fence' });
  await expect(nested).toHaveCount(1);
  expect(await fragmentCount(nested)).toBe(1);

  const columnHeight = await body.evaluate((el) => el.clientHeight);
  const box = await nested.boundingBox();
  expect(box!.height).toBeLessThanOrEqual(columnHeight);

  const scrolls = await nested.locator('code').evaluate((el) => {
    if (el.scrollHeight <= el.clientHeight) return false;
    el.scrollTop = 100;
    return el.scrollTop > 0;
  });
  expect(scrolls).toBe(true);
});

test('NESTED table (inside a blockquote) is protected', async ({ page }) => {
  const body = await openFixture(page);
  const nested = body.locator('blockquote table', { hasText: 'NestedTable' });
  await expect(nested).toHaveCount(1);
  expect(await fragmentCount(nested)).toBe(1);
});

test('every data-line block is fully within the column viewport vertically (reachability)', async ({ page }) => {
  const body = await openFixture(page);
  const result = await body.evaluate((el) => {
    const bodyRect = el.getBoundingClientRect();
    const blocks = Array.from(el.querySelectorAll('[data-line]'));
    let checked = 0;
    const offenders: string[] = [];
    // Content INSIDE an inner scroll container (a capped table's rows, capped code's lines) is
    // reached via that container's own scrollbar — its rects legitimately extend past the
    // column box and are not clipped content.
    const insideInnerScroller = (node: Element): boolean => {
      for (let a = node.parentElement; a && a !== el; a = a.parentElement) {
        const oy = getComputedStyle(a).overflowY;
        if (oy === 'auto' || oy === 'scroll') return true;
      }
      return false;
    };
    for (const block of blocks) {
      if (insideInnerScroller(block)) continue;
      for (const r of Array.from(block.getClientRects())) {
        if (r.height === 0) continue;
        checked++;
        // Vertical containment is scroll-independent (only x scrolls); any fragment poking
        // past the body's vertical box is unreachable under overflow-y: hidden.
        if (r.top < bodyRect.top - 1 || r.bottom > bodyRect.bottom + 1) {
          offenders.push(`${block.tagName}@line=${block.getAttribute('data-line')}`);
        }
      }
    }
    return { blockCount: blocks.length, checked, offenders: offenders.slice(0, 10) };
  });
  // The fixture is a ≥1000-line mixed document — make sure we actually swept it.
  expect(result.blockCount).toBeGreaterThan(200);
  expect(result.checked).toBeGreaterThan(200);
  expect(result.offenders).toEqual([]);
});

test('a user-resized composer cannot exceed the column (textarea clamp, D1)', async ({ page }) => {
  const body = await openFixture(page);
  const target = body.locator('p', { hasText: 'Intro paragraph.' });
  await target.hover();
  await page.locator('.codev-canvas-add-comment').click();

  const input = page.locator('.codev-canvas-comment-composer-input');
  await expect(input).toBeVisible();
  await input.evaluate((el) => {
    el.style.height = '3000px'; // simulate the user dragging the resize handle far past the column
  });
  const columnHeight = await body.evaluate((el) => el.clientHeight);
  const host = body.locator('.codev-canvas-comment-composer-host');
  expect(await fragmentCount(host)).toBe(1);
  const box = await host.boundingBox();
  expect(box!.height).toBeLessThanOrEqual(columnHeight);
});

test('card STACK may break between cards; individual cards must not (D1 policy)', async ({ page }) => {
  const body = await openFixture(page);
  const stack = body.locator('.codev-canvas-marker-cards').first();
  // The policy pair: the stack is fragmentation-neutral (auto), each card is protected.
  expect(await stack.evaluate((el) => getComputedStyle(el).breakInside)).toBe('auto');
  const cards = stack.locator('.codev-canvas-marker-card');
  const n = await cards.count();
  for (let i = 0; i < n; i++) {
    expect(await cards.nth(i).evaluate((el) => getComputedStyle(el).breakInside)).toBe('avoid');
  }
});

test('dark-theme token override keeps the layout invariants (light/dark smoke)', async ({ page }) => {
  const body = await openFixture(page);
  await page.addStyleTag({
    content: `.codev-artifact-canvas {
      --codev-canvas-foreground: #e6edf3; --codev-canvas-background: #0d1117;
      --codev-canvas-border: #30363d; --codev-canvas-muted: #8d96a0;
      --codev-canvas-code-background: #161b22; --codev-canvas-code-foreground: #e6edf3;
    }`,
  });
  const metrics = await body.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight);
  await expect(page.locator('.codev-canvas-reading-mode-toggle')).toBeVisible();
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
