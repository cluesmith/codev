/**
 * Hover reading aid controller (#1802). Lights the word under the pointer (and, by style, its
 * line and paragraph) with soft shapes drawn BEHIND the text, so the reader's eye has an anchor
 * while the pointer travels across prose.
 *
 * The body's DOM is never written (it is imperatively owned: cards, composer host and `data-line`
 * anchoring depend on it), so the shapes live in a separate fixed layer appended to the canvas
 * root. The root is `isolation: isolate` and the layer `z-index: -1`, which paints the layer above
 * the root's background but below in-flow text, cards, the composer and every fixed overlay.
 *
 * Listeners are native (not React props) so this never interacts with the "+" affordance's
 * pointer handling. All work happens in at most one animation frame per pointer move or scroll.
 */

import * as React from 'react';
import type { HighlightLine, HoverHighlightStyle } from '../types.js';
import {
  type Box,
  type TextMetrics,
  bandForRow,
  blockOf,
  caretAt,
  containsPoint,
  fragmentContainingX,
  inGapBelow,
  isExcluded,
  isInlineCode,
  lastRow,
  lineBand,
  paragraphBlocks,
  previousBlock,
  rowAbove,
  rowsInColumn,
  shapesOf,
  textMetricsOf,
  wordBoundsAt,
  wordPills,
} from './hover-word.js';

const LAYER_CLASS = 'codev-canvas-hover-word-layer';
const COMPOSER_HOST_SELECTOR = '.codev-canvas-comment-composer-host';

type ShapeKind = 'paragraph' | 'line' | 'word';
/** Back-to-front: the paragraph tint under the line band under the word pill. */
const SHAPE_KINDS: readonly ShapeKind[] = ['paragraph', 'line', 'word'];

interface Pointer {
  x: number;
  y: number;
  buttons: number;
}

interface CurrentWord {
  node: Text;
  start: number;
  end: number;
  /** The word's line extent; the pointer may roam inside it (over spaces, punctuation) sticky. */
  lineBox: Box;
}

/**
 * The line being read (#1850) and the block that holds it: what the band marks, the paragraph tint
 * frames, and (under `abovePointer`) the "+" and a click-to-annotate click target.
 */
export interface ReadingTarget {
  block: Element;
  band: Box;
}

/** Called after each paint with the target just drawn, or null when nothing is drawn. */
export type ReadingTargetListener = (target: ReadingTarget | null) => void;

/** The controller surface the canvas reads (#1850). */
export interface ReadingTargetSource {
  /** The target that was lit when the primary button last went down (mousedown clears the shapes). */
  targetAtLastPress(): ReadingTarget | null;
}

/**
 * How far above the pointer's line a crossing "line above" may reach, in line-heights: past a
 * paragraph margin or a heading's, never over a tall figure.
 */
const MAX_CROSS_DISTANCE_LINES = 3;

function toBoxes(list: DOMRectList | DOMRect[]): Box[] {
  const out: Box[] = [];
  for (const r of Array.from(list)) {
    if (r.width > 0 && r.height > 0) {
      out.push({ left: r.left, top: r.top, width: r.width, height: r.height });
    }
  }
  return out;
}

function scheduleFrame(cb: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
  return window.setTimeout(cb, 16) as unknown as number;
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle);
    return;
  }
  window.clearTimeout(handle);
}

function rangeRects(doc: Document, el: Element): Box[] {
  const range = doc.createRange();
  range.selectNodeContents(el);
  return toBoxes(range.getClientRects());
}

class HoverWordController implements ReadingTargetSource {
  private readonly doc: Document;
  private readonly layer: HTMLDivElement;
  private readonly groups: Record<ShapeKind, HTMLDivElement>;
  private readonly pools: Record<ShapeKind, HTMLDivElement[]> = { paragraph: [], line: [], word: [] };
  private pointer: Pointer | null = null;
  private frame = 0;
  private forceNext = false;
  private current: CurrentWord | null = null;
  private target: ReadingTarget | null = null;
  private pressTarget: ReadingTarget | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly body: HTMLElement,
    private readonly style: HoverHighlightStyle,
    private readonly highlightLine: HighlightLine,
    private readonly listener: ReadingTargetListener,
  ) {
    this.doc = root.ownerDocument;
    this.layer = this.doc.createElement('div');
    this.layer.className = LAYER_CLASS;
    this.layer.setAttribute('aria-hidden', 'true');
    const groups = {} as Record<ShapeKind, HTMLDivElement>;
    for (const kind of SHAPE_KINDS) {
      const g = this.doc.createElement('div');
      g.className = `codev-canvas-hover-${kind}-group`;
      this.layer.append(g);
      groups[kind] = g;
    }
    this.groups = groups;
    root.append(this.layer);

    body.addEventListener('mousemove', this.onMove);
    body.addEventListener('mouseleave', this.onLeave);
    body.addEventListener('mousedown', this.onDown);
    body.addEventListener('focusin', this.onFocusIn);
    this.doc.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    this.doc.defaultView?.addEventListener('resize', this.onScroll);
  }

  dispose(): void {
    this.body.removeEventListener('mousemove', this.onMove);
    this.body.removeEventListener('mouseleave', this.onLeave);
    this.body.removeEventListener('mousedown', this.onDown);
    this.body.removeEventListener('focusin', this.onFocusIn);
    this.doc.removeEventListener('scroll', this.onScroll, { capture: true });
    this.doc.defaultView?.removeEventListener('resize', this.onScroll);
    if (this.frame !== 0) cancelFrame(this.frame);
    this.frame = 0;
    this.layer.remove();
  }

  /** Content changed under the pointer (reload, cards injected, composer toggled): rebuild. */
  reset(): void {
    this.clear();
    if (this.pointer) this.schedule(true);
  }

  private readonly onMove = (e: MouseEvent): void => {
    this.pointer = { x: e.clientX, y: e.clientY, buttons: e.buttons };
    this.schedule(false);
  };

  private readonly onLeave = (): void => {
    this.pointer = null;
    this.clear();
  };

  private readonly onDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    this.pressTarget = this.target;
    this.clear();
  };

  targetAtLastPress(): ReadingTarget | null {
    const t = this.pressTarget;
    if (t && !t.block.isConnected) return null;
    return t;
  }

  private readonly onFocusIn = (e: FocusEvent): void => {
    const target = e.target as Element | null;
    if (target && typeof target.closest === 'function' && target.closest(COMPOSER_HOST_SELECTOR)) {
      this.clear();
    }
  };

  private readonly onScroll = (): void => {
    if (this.pointer) this.schedule(true);
  };

  private schedule(force: boolean): void {
    if (force) this.forceNext = true;
    if (this.frame !== 0) return;
    this.frame = scheduleFrame(() => {
      this.frame = 0;
      const forced = this.forceNext;
      this.forceNext = false;
      this.update(forced);
    });
  }

  private composerHasFocus(): boolean {
    const active = this.doc.activeElement;
    if (!active || typeof active.closest !== 'function') return false;
    return active.closest(COMPOSER_HOST_SELECTOR) !== null;
  }

  private update(force: boolean): void {
    const p = this.pointer;
    if (!p || (p.buttons & 1) !== 0 || this.composerHasFocus()) {
      this.clear();
      return;
    }
    const caret = caretAt(this.doc, p.x, p.y);
    if (caret && !isExcluded(caret.node, this.body)) {
      const bounds = wordBoundsAt(caret.node.data, caret.offset);
      if (bounds) {
        const cur = this.current;
        const same =
          cur !== null &&
          cur.node === caret.node &&
          cur.start === bounds.start &&
          cur.end === bounds.end &&
          cur.node.isConnected;
        if (same && !force) return;
        if (this.tryDraw(caret.node, bounds.start, bounds.end, p)) return;
      }
      // Sticky across gaps: over a space or punctuation still on the current word's line, keep it.
      // After a scroll the stored line box is stale, so re-measure before testing it.
      if (this.current && this.current.node.isConnected) {
        if (force) this.redrawCurrent();
        const cur = this.current;
        if (cur && containsPoint(cur.lineBox, p.x, p.y)) return;
      }
    }
    if (this.highlightLine === 'abovePointer' && caret && this.drawGap(caret.node, p)) return;
    this.clear();
  }

  /**
   * The finger resting in the gap just below a block (#1850, `abovePointer`): band that block's
   * last row. The caret API snaps to the nearest text, which may be the block below the gap, so
   * the caret's block and the block above it are both candidates. No word, so no pill and no
   * sticky state: the next frame re-resolves.
   */
  private drawGap(node: Text, p: Pointer): boolean {
    if (isExcluded(node, this.body)) return false;
    const caretBlock = blockOf(node, this.body);
    if (!caretBlock) return false;
    const candidates = [caretBlock];
    const above = previousBlock(caretBlock, this.body);
    if (above) candidates.push(above);
    for (const block of candidates) {
      const m = textMetricsOf(block);
      const column = fragmentContainingX(toBoxes(block.getClientRects()), p.x);
      const rows = rowsInColumn(rangeRects(this.doc, block), column, m);
      const last = lastRow(rows);
      if (last && inGapBelow(last, rows, p.x, p.y, m)) {
        this.current = null;
        this.paintTarget(bandForRow(last, m), block, [], m);
        return true;
      }
    }
    return false;
  }

  /**
   * The line above the pointer's row (#1850): the row above inside the same block and column, or
   * else the last row of the block above when it sits in the same column, close above. Null at
   * the top of a column, at the top of the document, or below a code block / card stack.
   */
  private lineAbove(block: Element, lineRects: Box[], column: Box | null, pointerBand: Box, m: TextMetrics): ReadingTarget | null {
    const above = rowAbove(rowsInColumn(lineRects, column, m), pointerBand);
    if (above) return { block, band: bandForRow(above, m) };
    const prev = previousBlock(block, this.body);
    if (!prev) return null;
    const prevMetrics = textMetricsOf(prev);
    const last = lastRow(rowsInColumn(rangeRects(this.doc, prev), column, prevMetrics));
    if (!last) return null;
    const centre = last.top + last.height / 2;
    if (centre >= pointerBand.top) return null;
    if (pointerBand.top - centre > MAX_CROSS_DISTANCE_LINES * m.lineHeight) return null;
    return { block: prev, band: bandForRow(last, prevMetrics) };
  }

  /** Measure the word and draw it if the pointer really is over it; false on a near-miss. */
  private tryDraw(node: Text, start: number, end: number, p: Pointer): boolean {
    const parent = node.parentElement;
    if (!parent) return false;
    const range = this.doc.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const wordRects = toBoxes(range.getClientRects());
    if (wordRects.length === 0) return false;
    const m = textMetricsOf(parent);
    // Caret APIs return the NEAREST text position, even for a point in a margin or past a short
    // line's end; only light the word when the pointer is actually on it.
    const padX = m.fontSize * 0.22;
    const padY = m.fontSize * 0.12;
    const hit = wordRects.find((r) => containsPoint(r, p.x, p.y, padX, padY));
    if (!hit) return false;
    this.draw(node, start, end, wordRects, hit, m);
    return true;
  }

  private redrawCurrent(): void {
    const cur = this.current;
    if (!cur || !cur.node.parentElement) {
      this.clear();
      return;
    }
    const range = this.doc.createRange();
    range.setStart(cur.node, cur.start);
    range.setEnd(cur.node, cur.end);
    const wordRects = toBoxes(range.getClientRects());
    if (wordRects.length === 0) {
      this.clear();
      return;
    }
    // Anchor on the fragment under the pointer (a word wrapped across lines or columns has two),
    // like `tryDraw` does, so a forced redraw never bands the other fragment.
    const m = textMetricsOf(cur.node.parentElement);
    let anchor = wordRects[0];
    const p = this.pointer;
    if (p) {
      const padX = m.fontSize * 0.22;
      const padY = m.fontSize * 0.12;
      anchor = wordRects.find((r) => containsPoint(r, p.x, p.y, padX, padY)) ?? anchor;
    }
    this.draw(cur.node, cur.start, cur.end, wordRects, anchor, m);
  }

  private draw(node: Text, start: number, end: number, wordRects: Box[], anchor: Box, m: TextMetrics): void {
    const block = blockOf(node, this.body);
    let lineRects: Box[] = [];
    let fragments: Box[] = [];
    if (block) {
      lineRects = rangeRects(this.doc, block);
      fragments = toBoxes(block.getClientRects());
    }
    const column = fragmentContainingX(fragments, anchor.left + anchor.width / 2);
    const band = lineBand(anchor, lineRects, column, m);
    // The sticky region stays the POINTER's line in both modes: crossing a space on that line
    // must not redraw, whichever line the band marks.
    this.current = { node, start, end, lineBox: band };

    let pills: Box[] = [];
    if (shapesOf(this.style).word && !isInlineCode(node)) {
      pills = wordPills(wordRects, m);
    }
    if (this.highlightLine !== 'abovePointer' || !block) {
      this.paintTarget(band, block, pills, m);
      return;
    }
    const above = this.lineAbove(block, lineRects, column, band, m);
    if (above) {
      this.paintTarget(above.band, above.block, pills, m);
      return;
    }
    // No line above: no band, but the paragraph tint still frames the pointer's block.
    this.paintTarget(null, block, pills, m);
  }

  /**
   * Paint the word pills, the band, and the tint behind `block`, then report the lit target (a
   * band inside a block). Either may be absent: no block (a stray `[data-line]`-less run of text)
   * still bands, and a block with no line above still tints.
   */
  private paintTarget(band: Box | null, block: Element | null, pills: Box[], m: TextMetrics): void {
    const drawn = shapesOf(this.style);
    const shapes: Record<ShapeKind, Box[]> = { paragraph: [], line: [], word: pills };
    if (drawn.line && band) {
      shapes.line = [band];
    }
    if (drawn.paragraph && block) {
      const cs = getComputedStyle(block);
      const insets = {
        left: parseFloat(cs.paddingLeft) || 0,
        right: parseFloat(cs.paddingRight) || 0,
        top: parseFloat(cs.paddingTop) || 0,
        bottom: parseFloat(cs.paddingBottom) || 0,
      };
      shapes.paragraph = paragraphBlocks(toBoxes(block.getClientRects()), insets, m);
    }
    const radius: Record<ShapeKind, number> = {
      paragraph: m.fontSize * 0.5,
      line: m.fontSize * 0.35,
      word: m.fontSize * 0.3,
    };
    for (const kind of SHAPE_KINDS) this.paint(kind, shapes[kind], radius[kind]);
    let lit: ReadingTarget | null = null;
    if (band && block) lit = { block, band };
    this.setTarget(lit);
  }

  private setTarget(next: ReadingTarget | null): void {
    const prev = this.target;
    this.target = next;
    const same =
      prev === next ||
      (prev !== null &&
        next !== null &&
        prev.block === next.block &&
        prev.band.top === next.band.top &&
        prev.band.left === next.band.left);
    if (!same) this.listener(next);
  }

  private paint(kind: ShapeKind, boxes: Box[], radius: number): void {
    const pool = this.pools[kind];
    while (pool.length < boxes.length) {
      const el = this.doc.createElement('div');
      el.className = `codev-canvas-hover-${kind}`;
      this.groups[kind].append(el);
      pool.push(el);
    }
    for (let i = 0; i < pool.length; i += 1) {
      const el = pool[i];
      const box = boxes[i];
      if (!box) {
        el.hidden = true;
        continue;
      }
      el.hidden = false;
      el.style.left = `${box.left}px`;
      el.style.top = `${box.top}px`;
      el.style.width = `${box.width}px`;
      el.style.height = `${box.height}px`;
      el.style.borderRadius = `${radius}px`;
    }
  }

  private clear(): void {
    this.current = null;
    this.setTarget(null);
    for (const kind of SHAPE_KINDS) {
      for (const el of this.pools[kind]) el.hidden = true;
    }
  }
}

/**
 * Attach the hover reading aid to the canvas. `style: 'none'` attaches nothing. `contentKey`
 * changes whenever the body's layout-relevant content changes (html, cards, composer), which
 * drops the current shapes and re-resolves the word under a still pointer.
 *
 * `highlightLine` (#1850) picks the line the band marks. `onReadingTarget` hears each change of
 * the lit target (read through a ref, so a new callback identity never rebuilds the controller).
 * The returned ref exposes the target that was lit at the last primary press, for the canvas's
 * click-to-annotate path; it is null while no controller is attached.
 */
export function useHoverWordHighlight(
  rootRef: React.RefObject<HTMLElement | null>,
  bodyRef: React.RefObject<HTMLElement | null>,
  style: HoverHighlightStyle,
  contentKey: unknown,
  highlightLine: HighlightLine = 'underPointer',
  onReadingTarget?: ReadingTargetListener,
): React.RefObject<ReadingTargetSource | null> {
  const controllerRef = React.useRef<HoverWordController | null>(null);
  const listenerRef = React.useRef<ReadingTargetListener | undefined>(onReadingTarget);
  listenerRef.current = onReadingTarget;

  React.useEffect(() => {
    const root = rootRef.current;
    const body = bodyRef.current;
    if (style === 'none' || !root || !body) return undefined;
    const controller = new HoverWordController(root, body, style, highlightLine, (t) => listenerRef.current?.(t));
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, [rootRef, bodyRef, style, highlightLine]);

  React.useEffect(() => {
    controllerRef.current?.reset();
  }, [contentKey]);

  return controllerRef;
}
