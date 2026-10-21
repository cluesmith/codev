import { test, expect, type Page } from '@playwright/test';

/**
 * Click-to-annotate and the Hidden prose cursor (#1850) in real Chromium: real selection, real
 * double-click, real computed cursors and the word underline's real geometry, none of which jsdom
 * has.
 *
 * Sample doc lines (0-based): 8/9/10 are the three list items. Labels are 1-based.
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

test('clickParagraph: no "+" at all; a click on prose opens the composer for that block', async ({ page }) => {
  await ready(page, '/?entry=clickParagraph');
  const r = await hover(page, LI, 'Surface', 1);
  expect(await page.locator('.codev-canvas-add-comment').count()).toBe(0);
  expect(await page.locator('.codev-canvas-row-affordance').count()).toBe(0);
  await page.mouse.click(centre(r).x, centre(r).y);
  await expect(page.getByRole('textbox', { name: 'Add comment on line 10' })).toBeVisible();
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

async function cursorAt(page: Page, selector: string): Promise<string> {
  return page.evaluate((selector) => getComputedStyle(document.querySelector(selector)!).cursor, selector);
}

test('Hidden cursor: no pointer over prose; code, cards and the "+" keep one', async ({ page }) => {
  await ready(page, '/?cursor=none');
  expect(await cursorAt(page, LI)).toBe('none');
  expect(await cursorAt(page, '.codev-artifact-canvas-body p')).toBe('none');
  expect(await cursorAt(page, '.codev-artifact-canvas-body pre')).toBe('default');
  expect(await cursorAt(page, '.codev-canvas-marker-cards')).toBe('default');
  // The "+" still shows a pointer, and the line band still marks where the hidden pointer is.
  await hover(page, LI, 'Surface', 1);
  await expect(page.locator('.codev-canvas-add-comment')).toBeVisible();
  expect(await cursorAt(page, '.codev-canvas-row-affordance')).toBe('default');
  await expect.poll(async () => page.locator('.codev-canvas-hover-line:not([hidden])').count()).toBe(1);
});

test('Hidden cursor: links keep the pointing hand', async ({ page }) => {
  await ready(page, '/?cursor=none');
  await page.evaluate(() => {
    const a = document.createElement('a');
    a.href = '#x';
    a.id = 'probe-link';
    a.textContent = 'link';
    document.querySelector('.codev-artifact-canvas-body p')!.append(a);
  });
  expect(await cursorAt(page, '#probe-link')).toBe('pointer');
});

async function underlines(page: Page): Promise<Rect[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.codev-canvas-hover-underline'))
      .filter((el) => !el.hidden)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      }),
  );
}

test('Hidden cursor: the word under the hidden pointer is underlined, with any highlight style', async ({ page }) => {
  await ready(page, '/?cursor=none&highlight=none');
  const r = await hover(page, LI, 'Surface', 1);
  await expect.poll(async () => (await underlines(page)).length).toBe(1);
  let [bar] = await underlines(page);
  expect(Math.abs(bar.left - r.left)).toBeLessThan(1);
  expect(Math.abs(bar.width - r.width)).toBeLessThan(1);
  expect(bar.top).toBeGreaterThanOrEqual(r.top + r.height - 0.5);
  expect(bar.top).toBeLessThan(r.top + r.height + 6);
  // highlight=none draws nothing else.
  expect(await page.locator('.codev-canvas-hover-line:not([hidden]), .codev-canvas-hover-word:not([hidden])').count()).toBe(0);

  // It follows the pointer to the next word.
  const next = await hover(page, LI, 'review', 1);
  await expect.poll(async () => Math.abs((await underlines(page))[0]?.left - next.left) < 1).toBe(true);

  // Leaving the canvas clears it.
  await page.mouse.move(2, 2);
  await page.mouse.move(-1, -1);
  [bar] = await underlines(page);
  expect(bar).toBeUndefined();
});

test('Hidden cursor: the underline sits below an inline code chip, not hidden under it', async ({ page }) => {
  await ready(page, '/?cursor=none');
  await page.evaluate(() => {
    const p = document.querySelector('.codev-artifact-canvas-body p')!;
    const code = document.createElement('code');
    code.textContent = 'chipword';
    p.append(' ', code);
  });
  const r = await hover(page, '.codev-artifact-canvas-body p code', 'chipword');
  const chip = await page.evaluate(() => {
    const b = document.querySelector('.codev-artifact-canvas-body p code')!.getBoundingClientRect();
    return { top: b.top, height: b.height };
  });
  await expect.poll(async () => (await underlines(page)).length).toBe(1);
  const [bar] = await underlines(page);
  expect(bar.top).toBeGreaterThanOrEqual(chip.top + chip.height - 0.5);
  expect(Math.abs(bar.left - r.left)).toBeLessThan(1);
});

test('no underline with a visible cursor', async ({ page }) => {
  await ready(page, '/');
  await hover(page, LI, 'Surface', 1);
  await expect.poll(async () => page.locator('.codev-canvas-hover-line:not([hidden])').count()).toBe(1);
  expect(await underlines(page)).toHaveLength(0);
});
