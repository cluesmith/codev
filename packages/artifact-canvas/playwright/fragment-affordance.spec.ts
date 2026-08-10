import { test, expect, type Page, type Locator } from '@playwright/test';

/**
 * Fragment-aware "+" placement in real Chromium (spec 1380 D2 + addendum, plan phase 4):
 * hovering a fragmented prose block's continuation fragment must light the "+" in THAT
 * column — never back at the block's first fragment (the cross-column travel bug the
 * addendum forbids). Plus the #1396 pre-row regression checks and the scenario-9
 * watch-reload pass (mode persistence, affordance re-hosting, focus restoration).
 */

async function openFixture(page: Page): Promise<Locator> {
  await page.goto('/?fixture=columns&mode=horizontal');
  const body = page.locator('.codev-artifact-canvas-body');
  await expect(body.locator('h1')).toHaveText('Columns fixture');
  await expect(body.locator('.codev-canvas-marker-card')).toHaveCount(6);
  return body;
}

/** The wrapper's rect, resolved after the browser maps its flow `top` into a fragment. */
const wrapperRect = (page: Page) =>
  page.locator('.codev-canvas-row-affordance').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });

test('hovering a continuation fragment anchors the "+" in that column (addendum)', async ({ page }) => {
  const body = await openFixture(page);
  const long = body.locator('p', { hasText: 'LONGPROSE' });
  const frags = await long.evaluate((el) =>
    Array.from(el.getClientRects()).map((r) => ({
      left: r.left, right: r.right, top: r.top, bottom: r.bottom,
    })),
  );
  expect(frags.length).toBeGreaterThan(1);

  // Hover the middle of the SECOND fragment.
  const f1 = frags[1];
  await page.mouse.move((f1.left + f1.right) / 2, (f1.top + f1.bottom) / 2);
  await expect(page.locator('.codev-canvas-add-comment')).toBeVisible();
  const w1 = await wrapperRect(page);
  // The "+" renders in the second fragment's column band (its gutter side), not back in
  // fragment 0's column.
  expect(w1.top).toBeGreaterThanOrEqual(f1.top - 20);
  expect(w1.left).toBeGreaterThan(frags[0].right);

  // Hover the FIRST fragment: the "+" moves back to column 1.
  const f0 = frags[0];
  await page.mouse.move((f0.left + f0.right) / 2, (f0.top + f0.bottom) / 2);
  const w0 = await wrapperRect(page);
  expect(w0.left).toBeLessThan(f1.left);
  expect(w0.top).toBeGreaterThanOrEqual(f0.top - 20);
  expect(w0.bottom).toBeLessThanOrEqual(f0.bottom + 20);
});

test('keyboard focus anchors the "+" at the block\'s FIRST fragment', async ({ page }) => {
  const body = await openFixture(page);
  const long = body.locator('p', { hasText: 'LONGPROSE' });
  await long.evaluate((el) => (el as HTMLElement).focus());
  await expect(page.locator('.codev-canvas-add-comment')).toBeVisible();
  const frags = await long.evaluate((el) =>
    Array.from(el.getClientRects()).map((r) => ({ left: r.left, right: r.right, top: r.top })),
  );
  const w = await wrapperRect(page);
  expect(w.left).toBeLessThan(frags[1].left); // column 1, not a continuation column
  expect(Math.abs(w.top - frags[0].top)).toBeLessThan(30); // first line of the block
});

test('fence row hosts the "+" inside the pre with row-local placement (#1396)', async ({ page }) => {
  const body = await openFixture(page);
  const pre = body.locator('pre', { hasText: 'short-fence' });
  await expect(pre).toHaveAttribute('data-line', /\d+/); // row identity on the pre now
  await pre.scrollIntoViewIfNeeded(); // the fence lives in an off-viewport column initially
  const preRect = await pre.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, bottom: r.bottom };
  });
  await page.mouse.move(preRect.left + 60, (preRect.top + preRect.bottom) / 2);
  await expect(page.locator('.codev-canvas-add-comment')).toBeVisible();
  const inPre = await page
    .locator('.codev-canvas-row-affordance')
    .evaluate((el) => el.parentElement?.tagName);
  expect(inPre).toBe('PRE');
  const w = await wrapperRect(page);
  expect(w.top).toBeGreaterThanOrEqual(preRect.top - 20);
  expect(w.bottom).toBeLessThanOrEqual(preRect.bottom + 20);
});

test('nested block inside a FRAGMENTED host row anchors in the hovered column (plan verification item)', async ({ page }) => {
  const body = await openFixture(page);
  // The filler lists are multi-item ULs; find one whose UL fragments across columns so an li
  // sits in a continuation fragment of its own host row.
  const probe = await body.evaluate((el) => {
    const uls = Array.from(el.querySelectorAll(':scope > ul[data-line]'));
    for (const ul of uls) {
      const ulRects = Array.from(ul.getClientRects());
      if (ulRects.length < 2) continue;
      for (const li of Array.from(ul.querySelectorAll('li'))) {
        const r = li.getClientRects()[0];
        // An li that starts in the host's SECOND fragment (right of the first fragment's band).
        if (r && r.left > ulRects[0].right) {
          li.scrollIntoView({ inline: 'center', block: 'nearest' });
          const rr = li.getClientRects()[0];
          return {
            x: (rr.left + rr.right) / 2,
            y: rr.top + 8,
            liLeft: rr.left,
            liRight: rr.right,
            hostFirstFragRight: ul.getClientRects()[0].right,
          };
        }
      }
    }
    return null;
  });
  // Hard assertion, not a conditional skip (PR consult): if the fixture stops producing a
  // cross-fragment list at the pinned 1600×900 viewport, this test must FAIL loudly — a
  // silent skip would retire the plan's verification item without anyone noticing.
  expect(probe, 'fixture must contain a list fragmenting across columns at 1600×900').not.toBeNull();
  await page.mouse.move(probe!.x, probe!.y);
  await expect(page.locator('.codev-canvas-add-comment')).toBeVisible();
  const w = await wrapperRect(page);
  // The "+" renders in the li's own column band — the host's continuation fragment — not back
  // in the host row's first column.
  expect(w.right).toBeLessThanOrEqual(probe!.liLeft + 5);
  expect(w.top).toBeGreaterThanOrEqual(probe!.y - 40);
  expect(w.bottom).toBeLessThanOrEqual(probe!.y + 40);
});

test('watch-reload in horizontal mode: mode, cards, focus, and affordance all recover (scenario 9)', async ({ page }) => {
  const body = await openFixture(page);
  const target = body.locator('p', { hasText: 'Intro paragraph.' });
  await target.hover();
  await page.locator('.codev-canvas-add-comment').click();
  const input = page.locator('.codev-canvas-comment-composer-input');
  await input.fill('scenario-9 comment');
  await page.locator('.codev-canvas-comment-composer-submit').click();

  // The submit writes into the text store → watch fires → body rebuilds (a real reload path).
  await expect(body.locator('.codev-canvas-marker-card', { hasText: 'scenario-9 comment' })).toBeVisible();
  // Mode survives the rebuild.
  await expect(page.locator('.codev-artifact-canvas')).toHaveClass(/codev-canvas-mode-horizontal/);
  // Focus restoration (#1237 machinery under columns): the annotated block has focus again.
  await expect(target).toBeFocused();
  // Affordance machinery is alive after the rebuild: hovering another block lights the "+".
  await body.locator('p', { hasText: 'Between blocks.' }).hover();
  await expect(page.locator('.codev-canvas-add-comment')).toBeVisible();
});
