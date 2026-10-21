import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import * as React from 'react';
import { ArtifactCanvas } from '../ArtifactCanvas.js';
import type { AnnotationEntry, HighlightLine, HoverHighlightStyle } from '../../types.js';
import { LINE_HEIGHT, TEXT_LEFT, flushFrames, installLayout, layOutBlock, layOutOpaque, uninstallLayout } from './layout-mock.js';

/**
 * "Line above the pointer" (#1850): the finger-below reading model. The hover aid resolves one
 * reading target (the line being read and its block) that the band, the paragraph tint, the "+"
 * and a click-to-annotate click all follow. jsdom has no layout, so `layout-mock` supplies rects:
 * every prose line is one text node, 24px line boxes, text from x=20.
 *
 *   h1  "Title"                      line box   0..24    (data-line 0)
 *   p   alpha / bravo / charlie       line boxes 40..112  (data-line 2)
 *   p   delta / echo                  line boxes 128..176 (data-line 6)
 *   pre (code)                        190..260
 *   p   foxtrot / golf                line boxes 290..338 (data-line 13)
 */
const DOC = [
  '# Title',
  '',
  'alpha  ',
  'bravo  ',
  'charlie',
  '',
  'delta  ',
  'echo',
  '',
  '```',
  'code',
  '```',
  '',
  'foxtrot  ',
  'golf',
].join('\n');

const TOPS = { title: 0, p0: 40, p1: 128, code: 190, p2: 290 };

beforeEach(installLayout);
afterEach(() => {
  cleanup();
  uninstallLayout();
});

interface Mounted {
  body: HTMLElement;
  centres: { title: number[]; p0: number[]; p1: number[]; p2: number[] };
  blocks: { title: HTMLElement; p0: HTMLElement; p1: HTMLElement; p2: HTMLElement };
  onAddComment: ReturnType<typeof vi.fn>;
}

async function mount(opts: {
  highlightLine?: HighlightLine;
  annotationEntry?: AnnotationEntry;
  hoverHighlight?: HoverHighlightStyle;
} = {}): Promise<Mounted> {
  const onAddComment = vi.fn();
  render(
    <ArtifactCanvas
      uri="x"
      fileAdapter={{ read: vi.fn(async () => DOC), watch: vi.fn(() => ({ dispose: vi.fn() })) }}
      themeAdapter={{ resolve: vi.fn(() => ''), onChange: vi.fn(() => ({ dispose: vi.fn() })) }}
      markerAdapter={{ list: vi.fn(async () => []), add: vi.fn(async () => {}) }}
      onAddComment={onAddComment}
      {...opts}
    />,
  );
  const paras = await waitFor(() => {
    const els = document.querySelectorAll<HTMLElement>('p[data-line]');
    if (els.length < 3) throw new Error('not rendered yet');
    return Array.from(els);
  });
  const title = document.querySelector<HTMLElement>('h1')!;
  layOutOpaque(document.querySelector<HTMLElement>('pre')!, TOPS.code, 70);
  const centres = {
    title: layOutBlock(title, TOPS.title),
    p0: layOutBlock(paras[0], TOPS.p0),
    p1: layOutBlock(paras[1], TOPS.p1),
    p2: layOutBlock(paras[2], TOPS.p2),
  };
  const body = document.querySelector<HTMLElement>('.codev-artifact-canvas-body')!;
  return { body, centres, blocks: { title, p0: paras[0], p1: paras[1], p2: paras[2] }, onAddComment };
}

/** Move the pointer to (x, y) over `target` and run the reading aid's frame. */
function pointAt(target: HTMLElement, x: number, y: number): void {
  fireEvent.mouseOver(target, { clientX: x, clientY: y });
  fireEvent.mouseMove(target, { clientX: x, clientY: y, buttons: 0 });
  act(() => flushFrames());
}

const WORD_X = TEXT_LEFT + 30;

function visible(kind: 'line' | 'paragraph' | 'word'): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`.codev-canvas-hover-${kind}`)).filter((el) => !el.hidden);
}

/** Top of the single visible band, or null when no band is drawn. */
function bandTop(): number | null {
  const lines = visible('line');
  if (lines.length === 0) return null;
  expect(lines).toHaveLength(1);
  return parseFloat(lines[0].style.top);
}

/** Line box top of line `i` of a block laid out at `top`. */
const lineBox = (top: number, i: number): number => top + i * LINE_HEIGHT;

const plusFor = (line1Based: number): HTMLElement | null =>
  screen.queryByRole('button', { name: `Add comment on line ${line1Based}` });

async function composerLabel(): Promise<string> {
  const ta = await waitFor(() => {
    const el = document.querySelector<HTMLTextAreaElement>('.codev-canvas-comment-composer-input');
    if (!el) throw new Error('composer not open yet');
    return el;
  });
  return ta.getAttribute('aria-label')!;
}

describe('highlightLine: underPointer (default) is unchanged', () => {
  it('bands the pointer line and lights the "+" on the pointer row', async () => {
    const { blocks, centres } = await mount();
    pointAt(blocks.p0, WORD_X, centres.p0[1]);
    expect(bandTop()).toBe(lineBox(TOPS.p0, 1));
    expect(plusFor(3)).not.toBeNull();
  });
});

describe('highlightLine: abovePointer (#1850)', () => {
  it('bands the line above the pointer inside the same block', async () => {
    const { blocks, centres } = await mount({ highlightLine: 'abovePointer' });
    pointAt(blocks.p0, WORD_X, centres.p0[2]);
    expect(bandTop()).toBe(lineBox(TOPS.p0, 1));
    pointAt(blocks.p0, WORD_X, centres.p0[1]);
    expect(bandTop()).toBe(lineBox(TOPS.p0, 0));
  });

  it("crosses into the block above on a block's first line, and the tint moves with it", async () => {
    const { blocks, centres } = await mount({ highlightLine: 'abovePointer' });
    pointAt(blocks.p1, WORD_X, centres.p1[0]);
    expect(bandTop()).toBe(lineBox(TOPS.p0, 2));
    const tint = visible('paragraph');
    expect(tint).toHaveLength(1);
    // The tint frames p0 (40..112), padded outward, not p1.
    expect(parseFloat(tint[0].style.top)).toBeLessThan(TOPS.p0);
  });

  it('highlights a heading from the line just below it', async () => {
    const { blocks, centres } = await mount({ highlightLine: 'abovePointer' });
    pointAt(blocks.p0, WORD_X, centres.p0[0]);
    expect(bandTop()).toBe(lineBox(TOPS.title, 0));
  });

  it('bands the last line of a block from the gap just below it', async () => {
    const { blocks, body } = await mount({ highlightLine: 'abovePointer' });
    // charlie's line box ends at 112; the next block starts at 128.
    pointAt(body, WORD_X, 118);
    expect(bandTop()).toBe(lineBox(TOPS.p0, 2));
    expect(blocks.p0).toBeTruthy();
  });

  it('never jumps over a code block: no band on the first line below it, tint stays', async () => {
    const { blocks, centres } = await mount({ highlightLine: 'abovePointer' });
    pointAt(blocks.p2, WORD_X, centres.p2[0]);
    expect(bandTop()).toBeNull();
    const tint = visible('paragraph');
    expect(tint).toHaveLength(1);
    expect(parseFloat(tint[0].style.top)).toBeGreaterThan(TOPS.code);
  });

  it('keeps the word pill under the pointer', async () => {
    const { blocks, centres } = await mount({ highlightLine: 'abovePointer', hoverHighlight: 'wordLineParagraph' });
    pointAt(blocks.p0, WORD_X, centres.p0[2]);
    const pills = visible('word');
    expect(pills).toHaveLength(1);
    expect(parseFloat(pills[0].style.top)).toBeGreaterThan(lineBox(TOPS.p0, 2));
    expect(bandTop()).toBe(lineBox(TOPS.p0, 1));
  });

  it('puts the "+" on the banded line, in the block above when the band crossed', async () => {
    const { blocks, centres } = await mount({ highlightLine: 'abovePointer' });
    pointAt(blocks.p0, WORD_X, centres.p0[2]);
    expect(plusFor(3)).not.toBeNull();
    const wrap = document.querySelector<HTMLElement>('.codev-canvas-row-affordance')!;
    expect(wrap.parentElement).toBe(blocks.p0);
    expect(wrap.style.top).toBe(`${LINE_HEIGHT + LINE_HEIGHT / 2}px`); // row 1 of p0
    pointAt(blocks.p1, WORD_X, centres.p1[0]);
    expect(plusFor(7)).toBeNull();
    expect(plusFor(3)).not.toBeNull(); // p1's first line annotates p0, where the band is
    expect(wrap.style.top).toBe(`${2 * LINE_HEIGHT + LINE_HEIGHT / 2}px`); // row 2 of p0
  });

  it('keeps the "+" still while the pointer travels left into the gutter and up to it', async () => {
    const { blocks, centres } = await mount({ highlightLine: 'abovePointer' });
    pointAt(blocks.p0, WORD_X, centres.p0[2]);
    const wrap = document.querySelector<HTMLElement>('.codev-canvas-row-affordance')!;
    const top = wrap.style.top;
    pointAt(blocks.p0, 5, centres.p0[2]); // left, into the gutter
    pointAt(blocks.p0, 5, centres.p0[1]); // up, onto the "+" row
    expect(plusFor(3)).not.toBeNull();
    expect(wrap.style.top).toBe(top);
  });

  it('does not move the "+" during a primary-button drag', async () => {
    const { blocks, centres } = await mount({ highlightLine: 'abovePointer' });
    pointAt(blocks.p0, WORD_X, centres.p0[2]);
    fireEvent.mouseDown(blocks.p0, { button: 0, buttons: 1, clientX: WORD_X, clientY: centres.p0[2] });
    fireEvent.mouseMove(blocks.p1, { buttons: 1, clientX: WORD_X, clientY: centres.p1[1] });
    act(() => flushFrames());
    expect(plusFor(3)).not.toBeNull();
    expect(plusFor(7)).toBeNull();
  });

  it('is inert for styles without a band: the "+" stays on the pointer row', async () => {
    const { blocks, centres } = await mount({ highlightLine: 'abovePointer', hoverHighlight: 'word' });
    pointAt(blocks.p1, WORD_X, centres.p1[0]);
    expect(bandTop()).toBeNull();
    expect(plusFor(7)).not.toBeNull();
  });

  it('keyboard focus still lights the "+" on the focused block', async () => {
    const { blocks } = await mount({ highlightLine: 'abovePointer' });
    act(() => blocks.p1.focus());
    expect(plusFor(7)).not.toBeNull();
  });
});

describe('clickParagraph with abovePointer (#1850)', () => {
  function clickAt(target: HTMLElement, x: number, y: number): void {
    fireEvent.mouseDown(target, { button: 0, clientX: x, clientY: y });
    fireEvent.mouseUp(target, { button: 0, clientX: x, clientY: y });
    fireEvent.click(target, { button: 0, detail: 1, clientX: x, clientY: y });
  }

  it('opens the composer for the block whose line is lit, even the block above', async () => {
    const { blocks, centres } = await mount({ highlightLine: 'abovePointer', annotationEntry: 'clickParagraph' });
    pointAt(blocks.p1, WORD_X, centres.p1[0]);
    clickAt(blocks.p1, WORD_X, centres.p1[0]);
    expect(await composerLabel()).toBe('Add comment on line 3');
  });

  it('falls back to the clicked block when nothing is lit', async () => {
    const { blocks, centres } = await mount({ highlightLine: 'abovePointer', annotationEntry: 'clickParagraph' });
    pointAt(blocks.p2, WORD_X, centres.p2[0]);
    clickAt(blocks.p2, WORD_X, centres.p2[0]);
    expect(await composerLabel()).toBe('Add comment on line 14');
  });

  it('never mounts the "+"', async () => {
    const { blocks, centres } = await mount({ highlightLine: 'abovePointer', annotationEntry: 'clickParagraph' });
    pointAt(blocks.p0, WORD_X, centres.p0[2]);
    expect(document.querySelector('.codev-canvas-add-comment')).toBeNull();
    expect(document.querySelector('.codev-canvas-row-affordance')).toBeNull();
  });
});
