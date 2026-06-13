/**
 * Unit tests for the pure symbol/ref helpers behind the "Forward to Builder"
 * CodeLens actions (#789). No `vscode` dependency, so the live implementation
 * is imported directly (same pattern as `architect-reference-injection.test.ts`).
 */

import { describe, it, expect } from 'vitest';
import {
  buildBuilderFileRef,
  buildBuilderRangeRef,
  buildSymbolLensDescriptors,
  buildAllLensDescriptors,
  parseHunkRanges,
  type SymbolNode,
} from '../diff-inject-ref.js';

// Numeric vscode.SymbolKind values used by the tests.
const K = {
  Class: 4,
  Method: 5,
  Property: 6,
  Constructor: 8,
  Enum: 9,
  Interface: 10,
  Function: 11,
  Variable: 12,
  Constant: 13,
} as const;

function sym(kind: number, startLine: number, endLine: number, children: SymbolNode[] = []): SymbolNode {
  return { kind, startLine, endLine, children };
}

describe('ref builders', () => {
  it('builds a file ref with a trailing space and no newline', () => {
    expect(buildBuilderFileRef('packages/vscode/src/extension.ts'))
      .toBe('packages/vscode/src/extension.ts ');
  });

  it('builds a range ref with the L<start>-L<end> range', () => {
    expect(buildBuilderRangeRef('a/b.ts', 10, 20)).toBe('a/b.ts:L10-L20 ');
  });
});

describe('buildSymbolLensDescriptors', () => {
  it('always emits a file-level lens at line 0', () => {
    expect(buildSymbolLensDescriptors('a/b.ts', [])).toEqual([
      { line: 0, title: 'Forward to Builder', refText: 'a/b.ts ' },
    ]);
  });

  it('lenses top-level structural declarations with their full range', () => {
    const symbols = [
      sym(K.Function, 4, 9),    // function → line 4, L5-L10
      sym(K.Interface, 12, 18), // interface → line 12, L13-L19
      sym(K.Enum, 20, 24),      // enum → line 20, L21-L25
    ];
    expect(buildSymbolLensDescriptors('a/b.ts', symbols)).toEqual([
      { line: 0, title: 'Forward to Builder', refText: 'a/b.ts ' },
      { line: 4, title: 'Forward to Builder (lines 5-10)', refText: 'a/b.ts:L5-L10 ' },
      { line: 12, title: 'Forward to Builder (lines 13-19)', refText: 'a/b.ts:L13-L19 ' },
      { line: 20, title: 'Forward to Builder (lines 21-25)', refText: 'a/b.ts:L21-L25 ' },
    ]);
  });

  it('descends one level into a class for methods and the constructor', () => {
    const cls = sym(K.Class, 3, 40, [
      sym(K.Constructor, 5, 8),
      sym(K.Method, 10, 20),
      sym(K.Property, 22, 22), // excluded
    ]);
    expect(buildSymbolLensDescriptors('a/b.ts', [cls])).toEqual([
      { line: 0, title: 'Forward to Builder', refText: 'a/b.ts ' },
      { line: 3, title: 'Forward to Builder (lines 4-41)', refText: 'a/b.ts:L4-L41 ' },   // class
      { line: 5, title: 'Forward to Builder (lines 6-9)', refText: 'a/b.ts:L6-L9 ' },    // constructor
      { line: 10, title: 'Forward to Builder (lines 11-21)', refText: 'a/b.ts:L11-L21 ' }, // method
    ]);
  });

  it('lenses a top-level multi-line Variable/Constant but skips one-line ones', () => {
    const symbols = [
      sym(K.Variable, 4, 12),  // multi-line const (e.g. arrow component) → lensed
      sym(K.Constant, 14, 14), // one-line scalar → skipped
    ];
    expect(buildSymbolLensDescriptors('a/b.ts', symbols)).toEqual([
      { line: 0, title: 'Forward to Builder', refText: 'a/b.ts ' },
      { line: 4, title: 'Forward to Builder (lines 5-13)', refText: 'a/b.ts:L5-L13 ' },
    ]);
  });

  it('skips a symbol that anchors on line 0 (collides with the file-level lens)', () => {
    // A file whose first declaration starts at line 0.
    const symbols = [sym(K.Function, 0, 30)];
    expect(buildSymbolLensDescriptors('a/b.ts', symbols)).toEqual([
      { line: 0, title: 'Forward to Builder', refText: 'a/b.ts ' },
    ]);
  });

  it('does not lens excluded top-level kinds (Property) or recurse past one level', () => {
    const cls = sym(K.Class, 2, 50, [
      sym(K.Class, 10, 40, [   // nested class: not lensed, not recursed
        sym(K.Method, 12, 20),
      ]),
    ]);
    expect(buildSymbolLensDescriptors('a/b.ts', [cls])).toEqual([
      { line: 0, title: 'Forward to Builder', refText: 'a/b.ts ' },
      { line: 2, title: 'Forward to Builder (lines 3-51)', refText: 'a/b.ts:L3-L51 ' },
    ]);
  });
});

describe('parseHunkRanges (one range per contiguous changed run)', () => {
  it('splits a hunk into separate runs broken by context lines', () => {
    // Three `return;` → `return undefined;` edits separated by context, in one
    // git hunk — each is its own run, so each gets its own range.
    const patch = [
      '@@ -10,12 +10,12 @@',
      ' a',           // new 10 (ctx)
      '-return;',     // old only
      '+return undefined;', // new 11  ← run 1
      ' b',           // new 12 (ctx) — breaks run
      ' c',           // new 13
      '-return;',
      '+return undefined;', // new 14  ← run 2
      ' d',           // new 15 (ctx) — breaks run
      '-return;',
      '+return undefined;', // new 16  ← run 3
    ].join('\n');
    expect(parseHunkRanges(patch)).toEqual([
      { start: 11, end: 11 },
      { start: 14, end: 14 },
      { start: 16, end: 16 },
    ]);
  });

  it('groups consecutive added lines into one run; deletions do not break it', () => {
    const patch = ['@@ -1,3 +1,4 @@', ' a', '+b', '-x', '+c', ' d'].join('\n');
    // new 1=a(ctx), 2=b(+), 3=c(+) [x is old-only], 4=d(ctx) → one run 2-3
    expect(parseHunkRanges(patch)).toEqual([{ start: 2, end: 3 }]);
  });

  it('yields no range for a pure-deletion hunk', () => {
    expect(parseHunkRanges('@@ -5,3 +4,0 @@\n-gone1\n-gone2')).toEqual([]);
  });

  it('separates runs across multiple hunks', () => {
    const patch = ['@@ -1,1 +1,2 @@', '+a', '@@ -20,1 +22,2 @@', '+z'].join('\n');
    expect(parseHunkRanges(patch)).toEqual([
      { start: 1, end: 1 },
      { start: 22, end: 22 },
    ]);
  });
});

describe('buildAllLensDescriptors (symbol + change lenses)', () => {
  it('adds one lens per changed run below the symbol/file lenses', () => {
    const symbols = [sym(K.Function, 4, 30)]; // function lens at line 4
    const ranges = [{ start: 10, end: 12 }, { start: 18, end: 18 }];
    expect(buildAllLensDescriptors('a/b.ts', symbols, ranges)).toEqual([
      { line: 0, title: 'Forward to Builder', refText: 'a/b.ts ' },
      { line: 4, title: 'Forward to Builder (lines 5-31)', refText: 'a/b.ts:L5-L31 ' },
      { line: 9, title: 'Forward to Builder (lines 10-12)', refText: 'a/b.ts:L10-L12 ' },
      { line: 17, title: 'Forward to Builder (line 18)', refText: 'a/b.ts:L18 ' },
    ]);
  });

  it('skips a change lens that collides with a symbol lens line', () => {
    const symbols = [sym(K.Function, 9, 30)]; // function lens at line 9
    const ranges = [{ start: 10, end: 12 }]; // anchor line 9 → collides → skipped
    expect(buildAllLensDescriptors('a/b.ts', symbols, ranges)).toEqual([
      { line: 0, title: 'Forward to Builder', refText: 'a/b.ts ' },
      { line: 9, title: 'Forward to Builder (lines 10-31)', refText: 'a/b.ts:L10-L31 ' },
    ]);
  });

  it('skips a change run at line 1 that collides with the file-level lens', () => {
    expect(buildAllLensDescriptors('a/b.ts', [], [{ start: 1, end: 17 }])).toEqual([
      { line: 0, title: 'Forward to Builder', refText: 'a/b.ts ' },
    ]);
  });
});
