/**
 * A tiny layout stand-in for jsdom (#1850), enough to drive the hover reading aid: rects per text
 * node (the word a caret lands in), per block's inline content (its rows) and per element (its
 * fragments), a caret API that snaps to the nearest registered text like the real one does, and
 * a manually flushed animation-frame queue.
 *
 * Each line of prose is one text node (markdown hard breaks), so a word range and a caret are just
 * that node; the controller only reads rects, never offsets, from these.
 */

import type { Box } from '../hover-word.js';

const wordRects = new Map<Node, Box>();
const contentRects = new Map<Node, Box[]>();
const elementRects = new Map<Element, Box[]>();
let frames: FrameRequestCallback[] = [];

const original = {
  rangeRects: Range.prototype.getClientRects,
  elementRects: Element.prototype.getClientRects,
  raf: window.requestAnimationFrame,
  caf: window.cancelAnimationFrame,
};

function rectList(boxes: readonly Box[]): DOMRectList {
  return boxes.map((b) => ({ ...b, right: b.left + b.width, bottom: b.top + b.height })) as unknown as DOMRectList;
}

export function installLayout(): void {
  Range.prototype.getClientRects = function getClientRects(this: Range): DOMRectList {
    const node = this.startContainer;
    if (node.nodeType === Node.TEXT_NODE) {
      const r = wordRects.get(node);
      return rectList(r ? [r] : []);
    }
    return rectList(contentRects.get(node) ?? []);
  };
  Element.prototype.getClientRects = function getClientRects(this: Element): DOMRectList {
    return rectList(elementRects.get(this) ?? []);
  };
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    frames.push(cb);
    return frames.length;
  };
  window.cancelAnimationFrame = (): void => {};
  const caretDoc = document as unknown as { caretPositionFromPoint?: (x: number, y: number) => unknown };
  caretDoc.caretPositionFromPoint = (x: number, y: number) => {
    let best: { node: Node; d: number } | null = null;
    for (const [node, r] of wordRects) {
      if (!node.isConnected) continue;
      const centre = r.top + r.height / 2;
      const d = Math.abs(centre - y) * 1000 + Math.abs(r.left + r.width / 2 - x);
      if (!best || d < best.d) best = { node, d };
    }
    if (!best) return null;
    return { offsetNode: best.node, offset: 1 };
  };
}

export function uninstallLayout(): void {
  Range.prototype.getClientRects = original.rangeRects;
  Element.prototype.getClientRects = original.elementRects;
  window.requestAnimationFrame = original.raf;
  window.cancelAnimationFrame = original.caf;
  delete (document as unknown as { caretPositionFromPoint?: unknown }).caretPositionFromPoint;
  wordRects.clear();
  contentRects.clear();
  elementRects.clear();
  frames = [];
}

/** Run every queued animation frame (frames queued while flushing run too). */
export function flushFrames(): void {
  while (frames.length > 0) {
    const pending = frames;
    frames = [];
    for (const cb of pending) cb(0);
  }
}

export const LINE_HEIGHT = 24;
const GLYPH_HEIGHT = 20;
export const TEXT_LEFT = 20;
const TEXT_WIDTH = 300;
const WORD_WIDTH = 60;

/**
 * Lay out `block` as one line per text node child, starting at line-box `top`: the block's
 * fragment, its rows, and one word rect per line (the first `WORD_WIDTH` px of the row). Returns
 * the glyph-box centre y of each line, for pointing at.
 */
export function layOutBlock(block: HTMLElement, top: number): number[] {
  block.style.fontSize = '16px';
  block.style.lineHeight = `${LINE_HEIGHT}px`;
  const lines = Array.from(block.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim() !== '');
  const rows: Box[] = [];
  const centres: number[] = [];
  lines.forEach((node, i) => {
    const glyphTop = top + i * LINE_HEIGHT + (LINE_HEIGHT - GLYPH_HEIGHT) / 2;
    rows.push({ left: TEXT_LEFT, top: glyphTop, width: TEXT_WIDTH, height: GLYPH_HEIGHT });
    wordRects.set(node, { left: TEXT_LEFT, top: glyphTop, width: WORD_WIDTH, height: GLYPH_HEIGHT });
    centres.push(glyphTop + GLYPH_HEIGHT / 2);
  });
  contentRects.set(block, rows);
  elementRects.set(block, [{ left: 0, top, width: 600, height: lines.length * LINE_HEIGHT }]);
  return centres;
}

/** A block with a rect but no hoverable text (a code block). */
export function layOutOpaque(el: HTMLElement, top: number, height: number): void {
  elementRects.set(el, [{ left: 0, top, width: 600, height }]);
}
