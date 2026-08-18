import { test, expect, type Page, type Locator } from '@playwright/test';
import type { CanvasCommand } from '@cluesmith/codev-types';

/**
 * Remote command channel in real Chromium (spec 1401, plan phase 3).
 *
 * The unit suite drives the same `CommandAdapter`, but jsdom reports no layout, so column paging
 * and scroll-into-view can only be asserted for real here. The dev page exposes the adapter as
 * `window.__canvasCommand`, which is exactly the shape a host implements.
 */

async function openFixture(page: Page, mode: 'horizontal' | 'vertical'): Promise<Locator> {
  await page.goto(`/?fixture=columns&mode=${mode}`);
  const body = page.locator('.codev-artifact-canvas-body');
  await expect(body.locator('h1')).toHaveText('Columns fixture');
  await page.waitForFunction(() => typeof window.__canvasCommand === 'function');
  return body;
}

const send = (page: Page, command: CanvasCommand, count?: number) =>
  page.evaluate(
    ([c, n]) => window.__canvasCommand?.(c as CanvasCommand, n as number | undefined),
    [command, count] as const,
  );

const focusedLine = (page: Page) =>
  page.evaluate(
    () =>
      (document.activeElement as HTMLElement | null)
        ?.closest?.('[data-line]')
        ?.getAttribute('data-line') ?? null,
  );

const scrollLeft = (body: Locator) => body.evaluate((el) => el.scrollLeft);

/** The vertical scroll position of the host page — the scroller for vertical reading mode (#1501),
 *  not the canvas body. */
const docScrollTop = (page: Page) => page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
const resetDocScroll = (page: Page) =>
  page.evaluate(() => {
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  });

/** One column step: the first fragment's width plus the column gap. */
const measureStep = (body: Locator) =>
  body.evaluate((el) => {
    const first = el.firstElementChild as Element;
    const width = first.getClientRects()[0].width;
    const gap = Number.parseFloat(getComputedStyle(el).columnGap) || 0;
    return width + gap;
  });

test('remote column paging steps one measured column, forward and back', async ({ page }) => {
  const body = await openFixture(page, 'horizontal');
  const step = await measureStep(body);
  // scrollLeft rounds to device pixels while the measured step can be fractional, so assert
  // within a pixel of the grid rather than exact equality (same tolerance as the key-driven suite).
  const near = (target: number) => async () => Math.abs((await scrollLeft(body)) - target) <= 1;

  await send(page, 'column-forward');
  await expect.poll(near(step)).toBe(true);
  await send(page, 'column-forward');
  await expect.poll(near(2 * step)).toBe(true);
  await send(page, 'column-back');
  await expect.poll(near(step)).toBe(true);
});

test('count pages several columns in one command', async ({ page }) => {
  const body = await openFixture(page, 'horizontal');
  const step = await measureStep(body);

  await send(page, 'column-forward', 3);
  await expect.poll(async () => Math.abs((await scrollLeft(body)) - 3 * step) <= 1).toBe(true);
});

test('a huge count stops at the end instead of spinning', async ({ page }) => {
  const body = await openFixture(page, 'horizontal');

  const started = Date.now();
  await send(page, 'column-forward', 1_000_000);
  const elapsed = Date.now() - started;

  const max = await body.evaluate((el) => el.scrollWidth - el.clientWidth);
  await expect.poll(async () => Math.abs((await scrollLeft(body)) - max) <= 2).toBe(true);
  expect(elapsed).toBeLessThan(5000);
});

test('column paging is inert in vertical mode', async ({ page }) => {
  const body = await openFixture(page, 'vertical');

  // The body only becomes a horizontal scroll container under `.codev-canvas-mode-horizontal`
  // (`overflow-x: auto` is mode-scoped), so vertical mode has nothing to scroll and this pins
  // that. The mode check in the action is the guard for a host whose stylesheet makes the body
  // scrollable anyway; it cannot be provoked from here.
  const scrollable = await body.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(scrollable).toBe(false);

  await send(page, 'column-forward');
  await send(page, 'column-back');
  expect(await scrollLeft(body)).toBe(0);
});

// Viewport pan (#1501): the Scroll dial's rotation on a spec/plan. In vertical mode the HOST PAGE
// scrolls the canvas, so these assert on the document scrolling element, not the body. Only a real
// layout can prove this — jsdom reports no scroll height.
test('remote viewport-scroll pans the page vertically, down and back to the top (#1501)', async ({ page }) => {
  await openFixture(page, 'vertical');
  // The document scrolling element is the vertical scroll container; confirm there is room to move.
  const scrollable = await page.evaluate(
    () =>
      (document.scrollingElement?.scrollHeight ?? 0) > (document.scrollingElement?.clientHeight ?? 0),
  );
  expect(scrollable).toBe(true);

  await send(page, 'viewport-down');
  await expect.poll(() => docScrollTop(page)).toBeGreaterThan(0);
  const afterOne = await docScrollTop(page);

  await send(page, 'viewport-down');
  await expect.poll(async () => (await docScrollTop(page)) > afterOne).toBe(true);

  // Up by two steps returns to the top and clamps there (no negative overshoot).
  await send(page, 'viewport-up', 2);
  await expect.poll(() => docScrollTop(page)).toBe(0);
});

test('viewport-scroll count N lands exactly where N single steps do (#1501)', async ({ page }) => {
  await openFixture(page, 'vertical');
  await send(page, 'viewport-down');
  await send(page, 'viewport-down');
  await send(page, 'viewport-down');
  const threeSingles = await docScrollTop(page);
  expect(threeSingles).toBeGreaterThan(0);

  await resetDocScroll(page);
  await send(page, 'viewport-down', 3);
  // count = |ticks| repeats the step, so one command with count 3 == three separate commands.
  await expect.poll(() => docScrollTop(page)).toBe(threeSingles);
});

test('viewport-scroll with a huge count stops at the bottom instead of spinning (#1501)', async ({ page }) => {
  await openFixture(page, 'vertical');
  const started = Date.now();
  await send(page, 'viewport-down', 1_000_000);
  const elapsed = Date.now() - started;

  const max = await page.evaluate(
    () =>
      (document.scrollingElement?.scrollHeight ?? 0) - (document.scrollingElement?.clientHeight ?? 0),
  );
  await expect.poll(() => docScrollTop(page)).toBe(max);
  expect(elapsed).toBeLessThan(5000);
});

test('viewport-scroll is a pure viewport move — block focus is untouched (#1501)', async ({ page }) => {
  await openFixture(page, 'vertical');
  await send(page, 'viewport-down', 2);
  expect(await focusedLine(page)).toBe(null); // nothing was focused; a pan never moves focus
});

// The clean-state origin rule has two halves. jsdom covers the unscrolled one (nothing focused,
// start from the top); only a real layout can prove the other, that a SCROLLED but never-focused
// view starts from the block the reviewer is actually looking at rather than the document start.
test('a scrolled, never-focused view starts from the topmost visible block', async ({ page }) => {
  const body = await openFixture(page, 'horizontal');

  // Scroll well into the document without touching focus, the way a reviewer who has only
  // scrolled (or a host that restored a position) would leave it.
  await body.evaluate((el) => {
    el.scrollLeft = Math.floor((el.scrollWidth - el.clientWidth) / 2);
  });

  const firstInDocument = await body.evaluate(
    (el) => el.querySelector('[data-line]')?.getAttribute('data-line') ?? null,
  );
  const topmostVisible = await body.evaluate((el) => {
    const host = el.getBoundingClientRect();
    for (const b of Array.from(el.querySelectorAll('[data-line]'))) {
      if (b.getBoundingClientRect().right > host.left) return b.getAttribute('data-line');
    }
    return null;
  });
  expect(topmostVisible).not.toBe(firstInDocument); // the scroll actually moved past the start

  await send(page, 'block-next');
  const landed = await focusedLine(page);

  // It stepped on from what was visible, not from the top of the document.
  expect(landed).not.toBe(firstInDocument);
  expect(Number(landed)).toBeGreaterThan(Number(topmostVisible));
});

test('remote navigation scrolls the target block into view', async ({ page }) => {
  const body = await openFixture(page, 'horizontal');

  // Mirrors the keyboard suite's `n` case, and deliberately uses a marked block rather than the
  // document end: the fixture's last block is a table row whose scrollable ancestor is the table
  // itself, so `doc-end` leaves the body's scroll alone — identically for the key and the
  // command, which is the parity that matters.
  await send(page, 'comment-next');
  const marked = body.locator('.codev-canvas-has-marker').first();
  await expect
    .poll(() =>
      marked.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.right <= window.innerWidth;
      }),
    )
    .toBe(true);
  await expect(marked).toBeFocused();
});
