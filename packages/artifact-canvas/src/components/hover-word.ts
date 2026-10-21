/**
 * Pure helpers for the hover reading aid (#1802): which word sits under the pointer, which block
 * counts as its paragraph, and the geometry of the three highlight shapes (word pill, line band,
 * paragraph block). No React, no state: the controller hook (`useHoverWordHighlight`) owns the
 * listeners and the DOM layer and calls into these.
 *
 * Geometry is in client (viewport) coordinates, matching the fixed overlay layer the shapes are
 * drawn into, so no scroll offsets are involved.
 */

import type { HoverHighlightStyle, ReadingCursor } from '../types.js';

/** A client-coordinate rectangle (left, top, width, height). */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Half-open `[start, end)` character range of a word inside one text node. */
export interface WordBounds {
  start: number;
  end: number;
}

const HIGHLIGHT_STYLES: readonly HoverHighlightStyle[] = [
  'none',
  'word',
  'wordLine',
  'wordLineParagraph',
  'line',
  'lineParagraph',
];
const READING_CURSORS: readonly ReadingCursor[] = ['arrow', 'iBeam', 'hand'];

/** Default highlight style (owner ruling at the dev gate, #1802): line band plus paragraph tint. */
export const DEFAULT_HIGHLIGHT_STYLE: HoverHighlightStyle = 'lineParagraph';

/** Which shapes a style draws. */
export function shapesOf(style: HoverHighlightStyle): { word: boolean; line: boolean; paragraph: boolean } {
  return {
    word: style === 'word' || style === 'wordLine' || style === 'wordLineParagraph',
    line: style === 'wordLine' || style === 'wordLineParagraph' || style === 'line' || style === 'lineParagraph',
    paragraph: style === 'wordLineParagraph' || style === 'lineParagraph',
  };
}
/** Default cursor: the arrow, keeping #1232's `cursor: default`. */
export const DEFAULT_READING_CURSOR: ReadingCursor = 'arrow';

/** Case-insensitive match against a closed vocabulary; null when nothing matches. */
function matchVocabulary<T extends string>(value: unknown, vocabulary: readonly T[]): T | null {
  if (typeof value !== 'string') return null;
  const wanted = value.trim().toLowerCase();
  for (const candidate of vocabulary) {
    if (candidate.toLowerCase() === wanted) return candidate;
  }
  return null;
}

/**
 * Coerce an untrusted (host-persisted) highlight style to the closed vocabulary. Matching ignores
 * case, so a hand-typed `wordline` in settings.json still lands on `wordLine`; anything unknown
 * falls back to the default.
 */
export function parseHighlightStyle(value: unknown): HoverHighlightStyle {
  return matchVocabulary(value, HIGHLIGHT_STYLES) ?? DEFAULT_HIGHLIGHT_STYLE;
}

/** Coerce an untrusted cursor value (case-insensitive, so `ibeam` is `iBeam`); unknown → arrow. */
export function parseReadingCursor(value: unknown): ReadingCursor {
  return matchVocabulary(value, READING_CURSORS) ?? DEFAULT_READING_CURSOR;
}

/** Word-character fallback for engines without `Intl.Segmenter`. */
const WORD_CHAR = /[\p{L}\p{N}_'’-]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

let cachedSegmenter: Intl.Segmenter | null | undefined;

function segmenter(): Intl.Segmenter | null {
  if (cachedSegmenter !== undefined) return cachedSegmenter;
  cachedSegmenter = null;
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    cachedSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  }
  return cachedSegmenter;
}

/** Fallback word expansion over a run of word characters around `offset`. */
function regexWordBounds(text: string, offset: number): WordBounds | null {
  let probe = offset;
  if (probe >= text.length || !WORD_CHAR.test(text[probe])) {
    // Caret at a word's end (between its last character and a space or punctuation).
    probe = offset - 1;
  }
  if (probe < 0 || probe >= text.length || !WORD_CHAR.test(text[probe])) return null;
  let start = probe;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start -= 1;
  let end = probe + 1;
  while (end < text.length && WORD_CHAR.test(text[end])) end += 1;
  // A run of only joiners (`--`, `'`) is punctuation, not a word.
  if (!LETTER_OR_DIGIT.test(text.slice(start, end))) return null;
  return { start, end };
}

/**
 * The word containing `offset` in `text`, or null when the offset sits in whitespace or
 * punctuation. An offset exactly at a word's end resolves to that word: a caret API reports the
 * boundary AFTER the last character when the pointer is on that character's right half.
 */
export function wordBoundsAt(text: string, offset: number, useSegmenter = true): WordBounds | null {
  if (offset < 0 || offset > text.length || text.length === 0) return null;
  let seg: Intl.Segmenter | null = null;
  if (useSegmenter) seg = segmenter();
  if (!seg) return regexWordBounds(text, offset);
  const segments = seg.segment(text);
  const probes = [offset];
  if (offset > 0) probes.push(offset - 1);
  for (const probe of probes) {
    if (probe >= text.length) continue;
    const hit = segments.containing(probe);
    if (hit && hit.isWordLike) {
      return { start: hit.index, end: hit.index + hit.segment.length };
    }
  }
  return null;
}

/** A caret position in a text node. */
export interface Caret {
  node: Text;
  offset: number;
}

interface CaretPositionLike {
  offsetNode: Node;
  offset: number;
}

type CaretDocument = Document & {
  caretPositionFromPoint?(x: number, y: number): CaretPositionLike | null;
  caretRangeFromPoint?(x: number, y: number): Range | null;
};

/**
 * The text position under a client point. Prefers the standard `caretPositionFromPoint`, falling
 * back to WebKit/Chromium's `caretRangeFromPoint`. Null when the point is not over text.
 */
export function caretAt(doc: Document, x: number, y: number): Caret | null {
  const d = doc as CaretDocument;
  let node: Node | null = null;
  let offset = 0;
  if (typeof d.caretPositionFromPoint === 'function') {
    const pos = d.caretPositionFromPoint(x, y);
    if (pos) {
      node = pos.offsetNode;
      offset = pos.offset;
    }
  } else if (typeof d.caretRangeFromPoint === 'function') {
    const range = d.caretRangeFromPoint(x, y);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  return { node: node as Text, offset };
}

/**
 * Regions the reading aid never lights: fenced code, injected comment cards, the inline composer,
 * and the in-row "+" affordance. Inline code is NOT excluded: it is part of the sentence, and
 * dropping the line band over every chip made it flicker along code-dense lines (dev-gate
 * feedback). It only skips the word pill (see `isInlineCode`).
 */
export const EXCLUDED_SELECTOR =
  'pre, .codev-canvas-marker-cards, .codev-canvas-comment-composer-host, .codev-canvas-row-affordance';

/**
 * True for text inside an inline code chip. The chip paints its own opaque background, which
 * would hide a pill behind it, so the word pill is skipped there; line and paragraph still draw.
 */
export function isInlineCode(node: Node): boolean {
  const el = node.parentElement;
  if (!el) return false;
  return el.closest('code') !== null;
}

/** True when `node` is outside `body` or inside a region the reading aid skips. */
export function isExcluded(node: Node, body: Element): boolean {
  if (!body.contains(node)) return true;
  let el: Element | null = null;
  if (node.nodeType === Node.ELEMENT_NODE) {
    el = node as Element;
  } else {
    el = node.parentElement;
  }
  if (!el) return true;
  const hit = el.closest(EXCLUDED_SELECTOR);
  return hit !== null && body.contains(hit);
}

/** Elements that count as "the paragraph" for the paragraph shape and the line band's extent. */
const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dd, dt';

/** The nearest paragraph-level block around `node` inside `body` (falls back to a `[data-line]`). */
export function blockOf(node: Node, body: Element): Element | null {
  let el: Element | null = null;
  if (node.nodeType === Node.ELEMENT_NODE) {
    el = node as Element;
  } else {
    el = node.parentElement;
  }
  if (!el) return null;
  const block = el.closest(BLOCK_SELECTOR);
  if (block && block !== body && body.contains(block)) return block;
  const line = el.closest('[data-line]');
  if (line && line !== body && body.contains(line)) return line;
  return null;
}

/** Typographic metrics the shapes scale with. */
export interface TextMetrics {
  fontSize: number;
  lineHeight: number;
}

/** Font size and line height (px) of `el`; `normal` line height resolves to 1.2em. */
export function textMetricsOf(el: Element): TextMetrics {
  const cs = getComputedStyle(el);
  let fontSize = parseFloat(cs.fontSize);
  if (!Number.isFinite(fontSize) || fontSize <= 0) fontSize = 16;
  let lineHeight = parseFloat(cs.lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) lineHeight = fontSize * 1.2;
  return { fontSize, lineHeight };
}

/** Padded pill(s) around a word's client rects (one per fragment when a word wraps). */
export function wordPills(wordRects: readonly Box[], m: TextMetrics): Box[] {
  const padX = m.fontSize * 0.22;
  const padY = m.fontSize * 0.12;
  return wordRects.map((r) => ({
    left: r.left - padX,
    top: r.top - padY,
    width: r.width + 2 * padX,
    height: r.height + 2 * padY,
  }));
}

/** True when `x, y` falls inside `box` widened by `pad`. */
export function containsPoint(box: Box, x: number, y: number, padX = 0, padY = 0): boolean {
  return (
    x >= box.left - padX &&
    x <= box.left + box.width + padX &&
    y >= box.top - padY &&
    y <= box.top + box.height + padY
  );
}

/** The fragment (column piece) of a block that horizontally contains `x`, if any. */
export function fragmentContainingX(fragments: readonly Box[], x: number): Box | null {
  for (const f of fragments) {
    if (x >= f.left && x <= f.left + f.width) return f;
  }
  return null;
}

/**
 * The line band: the horizontal extent of the text on the word's line, padded and line-box tall.
 * `lineRects` are the block's inline-content rects; those that share the word's line (vertical
 * centre inside the word rect's span) AND lie in the word's column (inside `column`, when given)
 * are unioned, so a block split across columns never bands into the neighbouring column.
 */
export function lineBand(
  wordRect: Box,
  lineRects: readonly Box[],
  column: Box | null,
  m: TextMetrics,
): Box {
  let left = wordRect.left;
  let right = wordRect.left + wordRect.width;
  const top = wordRect.top;
  const bottom = wordRect.top + wordRect.height;
  for (const r of lineRects) {
    if (r.width <= 0 || r.height <= 0) continue;
    const mid = r.top + r.height / 2;
    if (mid < top || mid > bottom) continue;
    if (column && (r.left + r.width < column.left || r.left > column.left + column.width)) continue;
    left = Math.min(left, r.left);
    right = Math.max(right, r.left + r.width);
  }
  const padX = m.fontSize * 0.45;
  const centre = (top + bottom) / 2;
  const height = Math.max(m.lineHeight, bottom - top);
  return { left: left - padX, top: centre - height / 2, width: right - left + 2 * padX, height };
}

/** Insets of a block's padding box to its content box. */
export interface Insets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Paragraph shape(s): each block fragment shrunk to its content box (rows carry the "+" gutter as
 * left padding, which is not text) and then padded outward a little.
 */
export function paragraphBlocks(fragments: readonly Box[], insets: Insets, m: TextMetrics): Box[] {
  const padX = m.fontSize * 0.6;
  const padY = m.fontSize * 0.35;
  const out: Box[] = [];
  for (const f of fragments) {
    const width = f.width - insets.left - insets.right;
    const height = f.height - insets.top - insets.bottom;
    if (width <= 0 || height <= 0) continue;
    out.push({
      left: f.left + insets.left - padX,
      top: f.top + insets.top - padY,
      width: width + 2 * padX,
      height: height + 2 * padY,
    });
  }
  return out;
}
