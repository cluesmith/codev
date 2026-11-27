/**
 * The seeded generator the property tests draw from (Spec 1967, plan phase 2, layer A).
 * A property test is only as good as its inputs: this checks that a seed reproduces its
 * inputs exactly, and that each class yields what it says and nothing else.
 */

import { describe, it, expect } from 'vitest';
import {
  ALL_CODE_POINT_CLASSES,
  CODE_POINT_CLASSES,
  createSeededGenerator,
  type CodePointClass,
} from './helpers/seeded-generator.js';

const inClass = (cp: number, codePointClass: CodePointClass) =>
  CODE_POINT_CLASSES[codePointClass].some(([lo, hi]) => cp >= lo && cp <= hi);

describe('seeded generator', () => {
  it('reproduces its whole sequence from the seed alone, and another seed gives another', () => {
    const draw = (seed: number) => {
      const g = createSeededGenerator(seed);
      return [g.next(), g.int(-5, 5), g.bool(), g.pick(['a', 'b', 'c']), g.codePoint('astral'), g.string({ maxLength: 50 })];
    };
    expect(draw(1967)).toEqual(draw(1967));
    expect(draw(1967)).not.toEqual(draw(1968));
    expect(createSeededGenerator(7).seed).toBe(7);
    expect(() => createSeededGenerator(1.5)).toThrow(/integer/);
  });

  it('draws floats in [0, 1) and integers over the whole inclusive range', () => {
    const g = createSeededGenerator(42);
    const seen = new Set<number>();
    for (let i = 0; i < 2_000; i++) {
      const x = g.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      seen.add(g.int(3, 9));
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(g.int(4, 4)).toBe(4);
    expect(() => g.int(5, 4)).toThrow(/bad range/);
    expect(() => g.pick([])).toThrow(/empty/);
  });

  it('draws every code point of a class from that class, and reaches every range of it', () => {
    const g = createSeededGenerator(2028);
    for (const codePointClass of ALL_CODE_POINT_CLASSES) {
      const rangesHit = new Set<number>();
      for (let i = 0; i < 5_000; i++) {
        const cp = g.codePoint(codePointClass);
        expect(inClass(cp, codePointClass), `${codePointClass}: U+${cp.toString(16)}`).toBe(true);
        rangesHit.add(CODE_POINT_CLASSES[codePointClass].findIndex(([lo, hi]) => cp >= lo && cp <= hi));
      }
      expect(rangesHit.size, codePointClass).toBe(CODE_POINT_CLASSES[codePointClass].length);
    }
  });

  it('builds strings of the asked length in code points, from the asked classes only', () => {
    const g = createSeededGenerator(9);
    for (let i = 0; i < 500; i++) {
      const classes: CodePointClass[] = [g.pick(ALL_CODE_POINT_CLASSES), g.pick(ALL_CODE_POINT_CLASSES)];
      const text = g.string({ minLength: 3, maxLength: 12, classes });
      const codePoints = Array.from(text, (char) => char.codePointAt(0)!);
      expect(codePoints.length).toBeGreaterThanOrEqual(3);
      expect(codePoints.length).toBeLessThanOrEqual(12);
      for (const cp of codePoints) expect(classes.some((c) => inClass(cp, c)), `U+${cp.toString(16)} in ${classes}`).toBe(true);
    }
    expect(g.string({ minLength: 0, maxLength: 0 })).toBe('');
  });

  it('keeps every lone surrogate lone, so a string of them is never well-formed UTF-16', () => {
    const g = createSeededGenerator(55_296);
    for (let i = 0; i < 500; i++) {
      const length = g.int(1, 20);
      const text = g.string({ minLength: length, maxLength: length, classes: ['lone-surrogate'] });
      // No two units pair up: each drawn surrogate is still one code point.
      expect(Array.from(text)).toHaveLength(length);
      expect(text).toHaveLength(length);
      expect(text.isWellFormed()).toBe(false);

      const mixed = g.string({ minLength: length, maxLength: length, classes: ['lone-surrogate', 'astral'] });
      expect(Array.from(mixed)).toHaveLength(length);
    }
  });
});
