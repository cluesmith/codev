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
      { line: 4, title: 'Forward to Builder', refText: 'a/b.ts:L5-L10 ' },
      { line: 12, title: 'Forward to Builder', refText: 'a/b.ts:L13-L19 ' },
      { line: 20, title: 'Forward to Builder', refText: 'a/b.ts:L21-L25 ' },
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
      { line: 3, title: 'Forward to Builder', refText: 'a/b.ts:L4-L41 ' },   // class
      { line: 5, title: 'Forward to Builder', refText: 'a/b.ts:L6-L9 ' },    // constructor
      { line: 10, title: 'Forward to Builder', refText: 'a/b.ts:L11-L21 ' }, // method
    ]);
  });

  it('lenses a top-level multi-line Variable/Constant but skips one-line ones', () => {
    const symbols = [
      sym(K.Variable, 4, 12),  // multi-line const (e.g. arrow component) → lensed
      sym(K.Constant, 14, 14), // one-line scalar → skipped
    ];
    expect(buildSymbolLensDescriptors('a/b.ts', symbols)).toEqual([
      { line: 0, title: 'Forward to Builder', refText: 'a/b.ts ' },
      { line: 4, title: 'Forward to Builder', refText: 'a/b.ts:L5-L13 ' },
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
      { line: 2, title: 'Forward to Builder', refText: 'a/b.ts:L3-L51 ' },
    ]);
  });
});
