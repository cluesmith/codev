import { test, expect, type Page } from '@playwright/test';

/**
 * Hover reading aid (#1802) in real Chromium: the caret APIs, Range rects, column fragments and
 * the behind-the-text stacking all need real layout, which jsdom does not have.
 */

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Client rect of the first occurrence of `word` inside the first element matching `selector`. */
async function wordRect(page: Page, selector: string, word: string, nth = 0): Promise<Rect> {
  const rect = await page.evaluate(
    ({ selector, word, nth }) => {
      const els = Array.from(document.querySelectorAll(selector));
      const root = els[nth];
      if (!root) return null;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode() as Text | null;
      while (node) {
        const re = new RegExp(`\\b${word}\\b`);
        const m = re.exec(node.data);
        if (m) {
          const range = document.createRange();
          range.setStart(node, m.index);
          range.setEnd(node, m.index + word.length);
          const r = range.getClientRects()[0];
          return { left: r.left, top: r.top, width: r.width, height: r.height };
        }
        node = walker.nextNode() as Text | null;
      }
      return null;
    },
    { selector, word, nth },
  );
  if (!rect) throw new Error(`word ${word} not found in ${selector}`);
  return rect;
}

function centre(r: Rect): { x: number; y: number } {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Visible shapes of one kind, as client rects. */
async function shapes(page: Page, kind: 'word' | 'line' | 'paragraph'): Promise<Rect[]> {
  return page.evaluate((kind) => {
    return Array.from(document.querySelectorAll<HTMLElement>(`.codev-canvas-hover-${kind}`))
      .filter((el) => !el.hidden)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      });
  }, kind);
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    outer.left <= inner.left + 0.5 &&
    outer.top <= inner.top + 0.5 &&
    outer.left + outer.width >= inner.left + inner.width - 0.5 &&
    outer.top + outer.height >= inner.top + inner.height - 0.5
  );
}

async function hoverWord(page: Page, selector: string, word: string, nth = 0): Promise<Rect> {
  const r = await wordRect(page, selector, word, nth);
  const c = centre(r);
  await page.mouse.move(c.x, c.y);
  return r;
}

async function ready(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator('.codev-artifact-canvas-body h1')).toBeVisible();
}

test('word: one pill behind the hovered word, no line or paragraph shapes', async ({ page }) => {
  await ready(page, '/?highlight=word');
  const r = await hoverWord(page, '.codev-artifact-canvas-body p', 'realistic');
  await expect.poll(async () => (await shapes(page, 'word')).length).toBe(1);
  const [pill] = await shapes(page, 'word');
  expect(contains(pill, r)).toBe(true);
  expect(await shapes(page, 'line')).toHaveLength(0);
  expect(await shapes(page, 'paragraph')).toHaveLength(0);

  // Behind the text: the topmost element at the word is still the prose, not the pill.
  const c = centre(r);
  const tag = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, c);
  expect(tag).toBe('P');
});

test('word: moving within a word keeps the same pill; the next word moves it with no empty frame', async ({ page }) => {
  await ready(page, '/?highlight=word');
  const a = await wordRect(page, '.codev-artifact-canvas-body p', 'canvas');
  const b = await wordRect(page, '.codev-artifact-canvas-body p', 'has');
  await page.mouse.move(a.left + 2, a.top + a.height / 2);
  await expect.poll(async () => (await shapes(page, 'word')).length).toBe(1);
  const first = (await shapes(page, 'word'))[0];
  await page.mouse.move(a.left + a.width - 2, a.top + a.height / 2);
  await page.waitForTimeout(50);
  expect((await shapes(page, 'word'))[0]).toEqual(first);

  // Sweep across the gap in small steps, sampling the pill count after each step.
  const counts: number[] = [];
  const y = a.top + a.height / 2;
  for (let x = a.left + a.width - 2; x <= b.left + 2; x += 1) {
    await page.mouse.move(x, y);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    counts.push((await shapes(page, 'word')).length);
  }
  expect(counts.every((n) => n === 1)).toBe(true);
  const last = (await shapes(page, 'word'))[0];
  expect(contains(last, b)).toBe(true);
});

test('wordLine: a line band spanning the line, containing the word', async ({ page }) => {
  await ready(page, '/?highlight=wordLine');
  const r = await hoverWord(page, '.codev-artifact-canvas-body p', 'realistic');
  await expect.poll(async () => (await shapes(page, 'line')).length).toBe(1);
  const [band] = await shapes(page, 'line');
  expect(contains(band, r)).toBe(true);
  // The band reaches the paragraph's first word on that line.
  const first = await wordRect(page, '.codev-artifact-canvas-body p', 'This');
  if (Math.abs(first.top - r.top) < 2) expect(band.left).toBeLessThanOrEqual(first.left);
  expect(await shapes(page, 'word')).toHaveLength(1);
  expect(await shapes(page, 'paragraph')).toHaveLength(0);
});

test('wordLineParagraph: paragraph tint covers the paragraph text', async ({ page }) => {
  await ready(page, '/?highlight=wordLineParagraph');
  await hoverWord(page, '.codev-artifact-canvas-body p', 'realistic');
  await expect.poll(async () => (await shapes(page, 'paragraph')).length).toBeGreaterThan(0);
  const para = await page.evaluate(() => {
    // The text node only: the row also hosts the "+" affordance in its gutter.
    const p = document.querySelector('.codev-artifact-canvas-body p')!;
    const range = document.createRange();
    range.selectNodeContents(p.firstChild!);
    const r = range.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  const [tint] = await shapes(page, 'paragraph');
  expect(contains(tint, para)).toBe(true);
  expect(await shapes(page, 'line')).toHaveLength(1);
  expect(await shapes(page, 'word')).toHaveLength(1);
});

test('line: the band alone, no word pill', async ({ page }) => {
  await ready(page, '/?highlight=line');
  const r = await hoverWord(page, '.codev-artifact-canvas-body p', 'realistic');
  await expect.poll(async () => (await shapes(page, 'line')).length).toBe(1);
  expect(contains((await shapes(page, 'line'))[0], r)).toBe(true);
  expect(await shapes(page, 'word')).toHaveLength(0);
  expect(await shapes(page, 'paragraph')).toHaveLength(0);
});

test('lineParagraph (default): band and paragraph tint, no word pill', async ({ page }) => {
  await ready(page, '/');
  const r = await hoverWord(page, '.codev-artifact-canvas-body p', 'realistic');
  await expect.poll(async () => (await shapes(page, 'line')).length).toBe(1);
  expect(contains((await shapes(page, 'line'))[0], r)).toBe(true);
  expect((await shapes(page, 'paragraph')).length).toBeGreaterThan(0);
  expect(await shapes(page, 'word')).toHaveLength(0);
  // Moving to the next line moves the band with it.
  const before = (await shapes(page, 'line'))[0];
  const next = await wordRect(page, '.codev-artifact-canvas-body li', 'markers', 2);
  await page.mouse.move(next.left + next.width / 2, next.top + next.height / 2);
  await expect.poll(async () => (await shapes(page, 'line'))[0]?.top).not.toBe(before.top);
});

test('inline code: the line band stays (no flicker), the word pill is skipped', async ({ page }) => {
  await ready(page, '/?highlight=wordLineParagraph');
  await page.evaluate(() => {
    const p = document.querySelector('.codev-artifact-canvas-body p')!;
    const code = document.createElement('code');
    code.textContent = 'password_hash';
    p.prepend(code, ' ');
  });
  const r = await hoverWord(page, '.codev-artifact-canvas-body p code', 'password_hash');
  await expect.poll(async () => (await shapes(page, 'line')).length).toBe(1);
  expect(contains((await shapes(page, 'line'))[0], r)).toBe(true);
  expect((await shapes(page, 'paragraph')).length).toBeGreaterThan(0);
  expect(await shapes(page, 'word')).toHaveLength(0);
});

test('none: no layer at all', async ({ page }) => {
  await ready(page, '/?highlight=none');
  await hoverWord(page, '.codev-artifact-canvas-body p', 'realistic');
  await page.waitForTimeout(50);
  await expect(page.locator('.codev-canvas-hover-word-layer')).toHaveCount(0);
});

test('no shapes past a short line end, over code, or over a comment card', async ({ page }) => {
  await ready(page, '/?highlight=wordLineParagraph');
  // Past the end of a short list item.
  // nth 1: the marker card is also an `li`, and comes first.
  const item = await wordRect(page, '.codev-artifact-canvas-body li', 'safely', 1);
  await page.mouse.move(item.left + item.width + 120, item.top + item.height / 2);
  await page.waitForTimeout(50);
  expect(await shapes(page, 'word')).toHaveLength(0);
  expect(await shapes(page, 'line')).toHaveLength(0);
  // Over fenced code.
  await hoverWord(page, '.codev-artifact-canvas-body pre', 'example');
  await page.waitForTimeout(50);
  expect(await shapes(page, 'word')).toHaveLength(0);
  // Over a marker card.
  await hoverWord(page, '.codev-canvas-marker-card', 'scoped');
  await page.waitForTimeout(50);
  expect(await shapes(page, 'word')).toHaveLength(0);
});

test('drag-select shows no shapes and selects the dragged text; leaving clears', async ({ page }) => {
  await ready(page, '/?highlight=wordLineParagraph');
  const a = await wordRect(page, '.codev-artifact-canvas-body p', 'describes');
  const b = await wordRect(page, '.codev-artifact-canvas-body p', 'feature');
  await page.mouse.move(a.left + 1, a.top + a.height / 2);
  await expect.poll(async () => (await shapes(page, 'word')).length).toBe(1);
  await page.mouse.down();
  await page.mouse.move(b.left + b.width - 1, b.top + b.height / 2, { steps: 8 });
  await page.waitForTimeout(50);
  expect(await shapes(page, 'word')).toHaveLength(0);
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected).toContain('describes an example feature');

  await hoverWord(page, '.codev-artifact-canvas-body p', 'realistic');
  await expect.poll(async () => (await shapes(page, 'word')).length).toBe(1);
  await page.mouse.move(2, 2);
  await expect.poll(async () => (await shapes(page, 'word')).length).toBe(0);
});

test('horizontal mode: the line band stays inside the hovered word column', async ({ page }) => {
  await page.goto('/?fixture=columns&mode=horizontal&highlight=wordLine');
  await expect(page.locator('.codev-artifact-canvas-body h1')).toHaveText('Columns fixture');
  // LONGPROSE fragments across columns; pick a word occurrence in the second column.
  const target = await page.evaluate(() => {
    const p = Array.from(document.querySelectorAll('.codev-artifact-canvas-body p')).find((el) =>
      el.textContent?.startsWith('LONGPROSE'),
    )!;
    const frags = Array.from(p.getClientRects());
    if (frags.length < 2) return null;
    const col2 = frags[1];
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode() as Text;
    const re = /\breviewer\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(node.data)) !== null) {
      const range = document.createRange();
      range.setStart(node, m.index);
      range.setEnd(node, m.index + 8);
      const r = range.getClientRects()[0];
      if (r && r.left >= col2.left && r.right <= col2.right && r.top > 0 && r.bottom < window.innerHeight) {
        return { word: { left: r.left, top: r.top, width: r.width, height: r.height }, col: { left: col2.left, right: col2.right } };
      }
    }
    return null;
  });
  expect(target).not.toBeNull();
  const c = centre(target!.word);
  await page.mouse.move(c.x, c.y);
  await expect.poll(async () => (await shapes(page, 'line')).length).toBe(1);
  const [band] = await shapes(page, 'line');
  const slack = 16; // the band's own padding
  expect(band.left).toBeGreaterThanOrEqual(target!.col.left - slack);
  expect(band.left + band.width).toBeLessThanOrEqual(target!.col.right + slack);
  const [pill] = await shapes(page, 'word');
  expect(contains(pill, target!.word)).toBe(true);
});

test('scrolling under a still pointer moves the shapes to the word now under it', async ({ page }) => {
  await page.goto('/?fixture=columns&highlight=word');
  await expect(page.locator('.codev-artifact-canvas-body h1')).toHaveText('Columns fixture');
  const r = await hoverWord(page, '.codev-artifact-canvas-body p', 'reviewer');
  await expect.poll(async () => (await shapes(page, 'word')).length).toBe(1);
  const before = (await shapes(page, 'word'))[0];
  const c = centre(r);
  // Scroll by whole lines to a line whose text at the pointer's x is a letter, so a word (not a
  // space) is guaranteed to end up under the still pointer.
  const delta = await page.evaluate(({ x, y }) => {
    const p = document.querySelector('.codev-artifact-canvas-body p')!;
    const lh = parseFloat(getComputedStyle(p).lineHeight);
    for (let k = 1; k <= 6; k += 1) {
      const range = document.caretRangeFromPoint(x, y + k * lh);
      const node = range?.startContainer;
      if (node && node.nodeType === Node.TEXT_NODE && /\p{L}/u.test((node as Text).data[range!.startOffset] ?? '')) {
        return k * lh;
      }
    }
    return 0;
  }, c);
  expect(delta).toBeGreaterThan(0);
  await page.mouse.wheel(0, delta);
  // A shape must exist, must have moved, and must sit under the pointer: an empty layer fails.
  await expect
    .poll(async () => {
      const now = await shapes(page, 'word');
      if (now.length !== 1) return `count ${now.length}`;
      const s = now[0];
      // Whole-line scrolling brings the next line to the same y, so a new word shows as a new
      // horizontal extent (or a new top when the line spacing differs).
      const moved =
        Math.abs(s.left - before.left) >= 0.5 ||
        Math.abs(s.width - before.width) >= 0.5 ||
        Math.abs(s.top - before.top) >= 0.5;
      const underPointer = s.top <= c.y && s.top + s.height >= c.y && s.left <= c.x && s.left + s.width >= c.x;
      if (moved && underPointer) return 'ok';
      return 'stale';
    })
    .toBe('ok');
});

test('cursor: arrow by default, I-beam and hand opt-in, cards keep the arrow', async ({ page }) => {
  const cursorAt = (selector: string) =>
    page.evaluate((sel) => getComputedStyle(document.querySelector(sel)!).cursor, selector);
  await ready(page, '/');
  expect(await cursorAt('.codev-artifact-canvas-body p')).toBe('default');
  await ready(page, '/?cursor=iBeam');
  expect(await cursorAt('.codev-artifact-canvas-body p')).toBe('text');
  expect(await cursorAt('.codev-canvas-marker-card')).toBe('default');
  expect(await cursorAt('.codev-artifact-canvas-body pre')).toBe('default');
  await ready(page, '/?cursor=hand');
  expect(await cursorAt('.codev-artifact-canvas-body p')).toBe('pointer');
  expect(await cursorAt('.codev-canvas-marker-card')).toBe('default');
  expect(await cursorAt('.codev-artifact-canvas-body pre code')).toBe('default');
});

test('cursor: inline code inside prose keeps the chosen cursor (no flicker along code-dense lines)', async ({ page }) => {
  await ready(page, '/?cursor=hand');
  // The sample has no inline code; add a chip to a paragraph to read its computed cursor.
  const cursor = await page.evaluate(() => {
    const p = document.querySelector('.codev-artifact-canvas-body p')!;
    const code = document.createElement('code');
    code.textContent = 'password_hash';
    p.append(code);
    return getComputedStyle(code).cursor;
  });
  expect(cursor).toBe('pointer');
});
