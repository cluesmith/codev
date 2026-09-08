import { describe, it, expect } from 'vitest';
import { fragmentAtPoint, flowOffsetAt, flowHeight, type RectLike } from '../column-geometry.js';

/**
 * Pure fragment math for the fragment-aware "+" placement (spec 1380 D2, plan phase 4).
 * Rect sets are fabricated — the same shapes Chromium produces for a prose block fragmented
 * across two columns (spike finding 5) — so the flow arithmetic is testable without layout.
 */

// A block fragmented across two 400px columns: fragment 0 fills the bottom of column 1
// (x 24..424, y 190..876), fragment 1 continues at the top of column 2 (x 472..872, y 24..696).
const twoFragments: RectLike[] = [
  { left: 24, right: 424, top: 190, bottom: 876, height: 686 },
  { left: 472, right: 872, top: 24, bottom: 696, height: 672 },
];

describe('fragmentAtPoint', () => {
  it('finds the fragment containing the point on both axes', () => {
    expect(fragmentAtPoint(twoFragments, 100, 500)).toBe(0);
    expect(fragmentAtPoint(twoFragments, 500, 100)).toBe(1);
  });

  it('falls back to the x band when y misses (fragments overlap vertically across columns)', () => {
    // y=900 is below both fragments; x=500 is column 2's band.
    expect(fragmentAtPoint(twoFragments, 500, 900)).toBe(1);
    expect(fragmentAtPoint(twoFragments, 100, 10)).toBe(0);
  });

  it('falls back to fragment 0 when nothing matches', () => {
    expect(fragmentAtPoint(twoFragments, 2000, 2000)).toBe(0);
  });

  it('degenerates to index 0 for the single-rect (vertical-mode) case', () => {
    const single: RectLike[] = [{ left: 0, right: 500, top: 100, bottom: 400, height: 300 }];
    expect(fragmentAtPoint(single, 250, 200)).toBe(0);
    expect(fragmentAtPoint(single, 9999, 9999)).toBe(0);
  });
});

describe('flowOffsetAt', () => {
  it('is the plain top-distance within the first fragment', () => {
    expect(flowOffsetAt(twoFragments, 100, 250)).toBe(60); // 250 - 190
  });

  it('adds preceding fragment heights for a point in a later fragment', () => {
    // Point at the top of fragment 1: flow offset = fragment 0's full height.
    expect(flowOffsetAt(twoFragments, 500, 24)).toBe(686);
    // 100px into fragment 1.
    expect(flowOffsetAt(twoFragments, 500, 124)).toBe(786);
  });

  it('matches the single-rect math in vertical mode', () => {
    const single: RectLike[] = [{ left: 0, right: 500, top: 100, bottom: 400, height: 300 }];
    expect(flowOffsetAt(single, 10, 175)).toBe(75);
  });
});

describe('flowHeight', () => {
  it('sums fragment heights (never the union box, which spans columns)', () => {
    expect(flowHeight(twoFragments)).toBe(1358);
    // The union box would be 876 - 24 = 852 — the wrong clamp bound under fragmentation.
    expect(flowHeight(twoFragments)).not.toBe(852);
  });

  it('is 0 for an empty rect list (jsdom)', () => {
    expect(flowHeight([])).toBe(0);
  });
});
