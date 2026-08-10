import type { ReadingMode } from '../types.js';

/**
 * Measured column geometry for horizontal mode (spec 1380, plan phase 3) — shared by keyboard
 * paging (phase 3) and the progress readout (phase 5).
 *
 * MEASURED, not derived from `--codev-canvas-column-width`: CSS `column-width` is a preferred
 * MINIMUM — real columns stretch to share leftover viewport width, so the token drifts from
 * the rendered width on almost every viewport (iter-1 plan consultation). The rendered column
 * width is read off layout: any direct child of the multicol element is laid out at the
 * column-box width, and its FIRST client rect is a single-fragment box even when the child
 * fragments across columns (a bounding-rect union would span columns and lie).
 */
export interface ColumnGeometry {
  /** Actual rendered column width in px (0 when unmeasurable, e.g. jsdom). */
  columnWidth: number;
  /** Resolved column gap in px. */
  gap: number;
  /** One paging step: column width + gap; falls back to the viewport width when unmeasurable. */
  step: number;
}

export function measureColumnGeometry(body: HTMLElement): ColumnGeometry {
  const gap = Number.parseFloat(getComputedStyle(body).columnGap) || 0;
  let columnWidth = 0;
  for (let child = body.firstElementChild; child; child = child.nextElementSibling) {
    const rect = child.getClientRects()[0];
    if (rect && rect.width > 0) {
      columnWidth = rect.width;
      break;
    }
  }
  let step = columnWidth + gap;
  if (columnWidth === 0) {
    step = body.clientWidth || 0;
  }
  return { columnWidth, gap, step };
}

/**
 * Axis-aware options for bringing a block into view (spec req. 3 / #1237 parity): vertical
 * mode centers on the block axis exactly as before; horizontal centers on the inline axis —
 * the axis the reader actually scrolls (spike finding 9).
 */
export function blockScrollOptions(mode: ReadingMode): ScrollIntoViewOptions {
  if (mode === 'horizontal') {
    return { behavior: 'smooth', inline: 'center', block: 'nearest' };
  }
  return { behavior: 'smooth', block: 'center' };
}

/**
 * True when `target` (or an ancestor up to `body`) is a vertical inner scroller that can still
 * consume a wheel delta of the given sign — the yield rule of the horizontal wheel remap
 * (spec Desired State): capped code, tables, card bodies, and the composer textarea keep their
 * native wheel scrolling; only input the content cannot consume drives the canvas.
 */
export function innerScrollerCanConsume(
  target: EventTarget | null,
  deltaY: number,
  body: HTMLElement,
): boolean {
  let el = target instanceof Element ? target : null;
  for (; el && el !== body; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;
    if (el.scrollHeight <= el.clientHeight) continue;
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY !== 'auto' && overflowY !== 'scroll') continue;
    if (deltaY > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
    if (deltaY < 0 && el.scrollTop > 0) return true;
  }
  return false;
}

/** The subset of DOMRect the fragment math reads — injectable in unit tests. */
export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  height: number;
}

/**
 * Index of the fragment rect containing (x, y). Fallbacks, in order: the fragment whose
 * horizontal band contains x (fragments in different columns overlap vertically, so x is the
 * discriminating axis), else 0. Never -1: the caller always has a fragment to anchor to.
 */
export function fragmentAtPoint(rects: readonly RectLike[], x: number, y: number): number {
  let idx = rects.findIndex((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  if (idx !== -1) return idx;
  idx = rects.findIndex((r) => x >= r.left && x <= r.right);
  if (idx !== -1) return idx;
  return 0;
}

/**
 * Flow distance from the element's flow start to the point (x, y): the heights of every
 * fragment before the one containing the point, plus the offset within it. This is the
 * coordinate an absolutely-positioned child's `top` is resolved in — Chromium maps a flow
 * `top` back into the correct column fragment (spec-1380 spike finding 6), which is what makes
 * pointer-side affordance anchoring a pure computation rather than a re-parenting scheme.
 */
export function flowOffsetAt(rects: readonly RectLike[], x: number, y: number): number {
  const i = fragmentAtPoint(rects, x, y);
  let offset = 0;
  for (let k = 0; k < i; k++) {
    offset += rects[k].height;
  }
  return offset + (y - rects[i].top);
}

/** Total flow height: the sum of fragment heights (NOT the union bounding box, which spans
 * columns and lies under fragmentation — spec D2's clamp requirement). */
export function flowHeight(rects: readonly RectLike[]): number {
  return rects.reduce((sum, r) => sum + r.height, 0);
}

/** Normalize a wheel delta to px (deltaMode: 0 px, 1 lines, 2 pages). The 16px/line factor is
 * a fixed convention: both v1 hosts are Chromium, which only ever emits pixel deltas (mode 0),
 * so the line branch exists for engine robustness, not calibration (iter-1 consult). */
export function wheelDeltaPx(e: WheelEvent, pageHeight: number): number {
  if (e.deltaMode === 1) return e.deltaY * 16;
  if (e.deltaMode === 2) return e.deltaY * pageHeight;
  return e.deltaY;
}
