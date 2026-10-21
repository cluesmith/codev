import { test, expect, type Page } from '@playwright/test';

/**
 * "Line above the pointer" and click-to-annotate (#1850) in real Chromium: the band, the "+" and
 * the click target follow one reading target, and the "+" stays reachable by mouse (the pointer
 * travels left into the gutter, then up, without the "+" re-anchoring away from it).
 *
 * Sample doc lines (0-based): 6 "## Requirements", 8/9/10 the three list items. Labels are 1-based.
 */

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

async function wordRect(page: Page, selector: string, word: string, nth = 0): Promise<Rect> {
  const rect = await page.evaluate(
    ({ selector, word, nth }) => {
      const root = document.querySelectorAll(selector)[nth];
      if (!root) return null;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        const m = new RegExp(`\\b${word}\\b`).exec(node.data);
        if (!m) continue;
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + word.length);
        const r = range.getClientRects()[0];
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      }
      return null;
    },
    { selector, word, nth },
  );
  if (!rect) throw new Error(`word ${word} not found in ${selector}`);
  return rect;
}

const centre = (r: Rect): { x: number; y: number } => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

async function band(page: Page): Promise<Rect | null> {
  return page.evaluate(() => {
    const el = Array.from(document.querySelectorAll<HTMLElement>('.codev-canvas-hover-line')).find((e) => !e.hidden);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
}

const vCentreInside = (outer: Rect, inner: Rect): boolean => {
  const c = inner.top + inner.height / 2;
  return c >= outer.top && c <= outer.top + outer.height;
};

async function hover(page: Page, selector: string, word: string, nth = 0): Promise<Rect> {
  const r = await wordRect(page, selector, word, nth);
  const c = centre(r);
  await page.mouse.move(c.x, c.y);
  return r;
}

async function ready(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator('.codev-artifact-canvas-body h1')).toBeVisible();
}

const LI = '.codev-artifact-canvas-body li[data-line]';

test('abovePointer: the band sits on the line above, crossing into the block above', async ({ page }) => {
  await ready(page, '/?line=abovePointer');
  // Pointer on the second list item: the band marks the first item's line.
  const first = await wordRect(page, LI, 'Render');
  const hovered = await hover(page, LI, 'Surface', 1);
  await expect.poll(async () => (await band(page)) !== null).toBe(true);
  let b = (await band(page))!;
  expect(vCentreInside(b, first)).toBe(true);
  expect(vCentreInside(b, hovered)).toBe(false);

  // Pointer on the first item: the band marks the heading above it.
  const heading = await wordRect(page, '.codev-artifact-canvas-body h2', 'Requirements', 1);
  await hover(page, LI, 'Render');
  await expect.poll(async () => {
    const now = await band(page);
    return now !== null && vCentreInside(now, heading);
  }).toBe(true);
  b = (await band(page))!;
  expect(vCentreInside(b, first)).toBe(false);
});

test('abovePointer: inside a wrapped paragraph the band is the previous visual line', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await ready(page, '/?line=abovePointer');
  const p = '.codev-artifact-canvas-body p';
  const top = await wordRect(page, p, 'This');
  const lower = await wordRect(page, p, 'render');
  expect(lower.top).toBeGreaterThan(top.top + top.height); // wrapped onto a later line
  await page.mouse.move(centre(lower).x, centre(lower).y);
  await expect.poll(async () => (await band(page)) !== null).toBe(true);
  const b = (await band(page))!;
  expect(vCentreInside(b, lower)).toBe(false);
  expect(b.top + b.height).toBeLessThanOrEqual(lower.top + 1);
});

test('abovePointer: the "+" is on the banded item and stays reachable by mouse', async ({ page }) => {
  await ready(page, '/?line=abovePointer');
  const hovered = await hover(page, LI, 'Surface', 1);
  const plus = page.getByRole('button', { name: 'Add comment on line 9' });
  await expect(plus).toBeVisible();
  const box = (await plus.boundingBox())!;
  // Travel like a hand would: left into the gutter at the pointer's height, then up to the "+".
  const start = centre(hovered);
  const gutterX = box.x + box.width / 2;
  await page.mouse.move(gutterX, start.y, { steps: 8 });
  await page.mouse.move(gutterX, box.y + box.height / 2, { steps: 8 });
  await expect(plus).toBeVisible();
  const after = (await plus.boundingBox())!;
  expect(Math.abs(after.y - box.y)).toBeLessThan(1);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByRole('textbox', { name: 'Add comment on line 9' })).toBeVisible();
});

test('clickParagraph + abovePointer: no "+" at all; a click opens the composer for the banded item', async ({ page }) => {
  await ready(page, '/?line=abovePointer&entry=clickParagraph');
  const r = await hover(page, LI, 'Surface', 1);
  await expect.poll(async () => (await band(page)) !== null).toBe(true);
  expect(await page.locator('.codev-canvas-add-comment').count()).toBe(0);
  expect(await page.locator('.codev-canvas-row-affordance').count()).toBe(0);
  await page.mouse.click(centre(r).x, centre(r).y);
  await expect(page.getByRole('textbox', { name: 'Add comment on line 9' })).toBeVisible();
});

test('clickParagraph: drag-select opens nothing; the click that dismisses it opens nothing; the next click does', async ({ page }) => {
  await ready(page, '/?entry=clickParagraph');
  const from = await wordRect(page, LI, 'Surface', 1);
  const to = await wordRect(page, LI, 'markers', 1);
  await page.mouse.move(from.left + 1, centre(from).y);
  await page.mouse.down();
  await page.mouse.move(to.left + to.width - 1, centre(to).y, { steps: 6 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('Surface');
  const textbox = page.locator('.codev-canvas-comment-composer-input');
  await expect(textbox).toHaveCount(0);

  const target = await wordRect(page, LI, 'Emit', 2);
  await page.mouse.click(centre(target).x, centre(target).y);
  await expect(textbox).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);

  await page.mouse.click(centre(target).x, centre(target).y);
  await expect(page.getByRole('textbox', { name: 'Add comment on line 11' })).toBeVisible();
});

test('clickParagraph: double-clicking a word selects it and opens one composer', async ({ page }) => {
  await ready(page, '/?entry=clickParagraph');
  const r = await wordRect(page, LI, 'Emit', 2);
  await page.mouse.dblclick(centre(r).x, centre(r).y);
  await expect(page.locator('.codev-canvas-comment-composer-input')).toHaveCount(1);
});
