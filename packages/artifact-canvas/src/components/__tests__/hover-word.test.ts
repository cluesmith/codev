import { describe, expect, it } from 'vitest';
import {
  blockOf,
  fragmentContainingX,
  isExcluded,
  isInlineCode,
  lineBand,
  paragraphBlocks,
  parseHighlightStyle,
  parseReadingCursor,
  shapesOf,
  wordBoundsAt,
  wordPills,
  type Box,
} from '../hover-word.js';

const word = (text: string, offset: number, useSegmenter = true): string | null => {
  const b = wordBoundsAt(text, offset, useSegmenter);
  if (!b) return null;
  return text.slice(b.start, b.end);
};

describe.each([
  ['Intl.Segmenter', true],
  ['regex fallback', false],
])('wordBoundsAt (%s)', (_name, seg) => {
  it('resolves mid-word, word start and word end', () => {
    const text = 'the phonetic alphabet';
    expect(word(text, 6, seg)).toBe('phonetic');
    expect(word(text, 4, seg)).toBe('phonetic');
    // Offset 12 is the boundary AFTER "phonetic": the caret on its last letter's right half.
    expect(word(text, 12, seg)).toBe('phonetic');
  });

  it('returns null in whitespace and punctuation runs', () => {
    expect(word('one  two', 4, seg)).toBeNull();
    expect(word('end. -- next', 6, seg)).toBeNull();
  });

  it('strips trailing punctuation and keeps apostrophes inside the word', () => {
    expect(word('the phonetic.', 9, seg)).toBe('phonetic');
    expect(word("they're here", 2, seg)).toBe("they're");
  });

  it('handles non-Latin letters', () => {
    expect(word('слово другое', 2, seg)).toBe('слово');
  });

  it('rejects out-of-range offsets and empty text', () => {
    expect(word('abc', -1, seg)).toBeNull();
    expect(word('abc', 4, seg)).toBeNull();
    expect(word('', 0, seg)).toBeNull();
  });
});

describe('parseHighlightStyle / parseReadingCursor', () => {
  it('accepts the vocabulary case-insensitively', () => {
    expect(parseHighlightStyle('word')).toBe('word');
    expect(parseHighlightStyle('wordline')).toBe('wordLine');
    expect(parseHighlightStyle('WordLineParagraph')).toBe('wordLineParagraph');
    expect(parseHighlightStyle('none')).toBe('none');
    expect(parseHighlightStyle('line')).toBe('line');
    expect(parseHighlightStyle('LINEPARAGRAPH')).toBe('lineParagraph');
    expect(parseReadingCursor('ibeam')).toBe('iBeam');
    expect(parseReadingCursor('hand')).toBe('hand');
  });

  it('falls back to the defaults for unknown or missing values', () => {
    expect(parseHighlightStyle(undefined)).toBe('lineParagraph');
    expect(parseHighlightStyle('sparkle')).toBe('lineParagraph');
    expect(parseHighlightStyle(3)).toBe('lineParagraph');
    expect(parseReadingCursor(undefined)).toBe('arrow');
    expect(parseReadingCursor('finger')).toBe('arrow');
  });
});

function bodyWith(html: string): HTMLElement {
  const body = document.createElement('div');
  body.className = 'codev-artifact-canvas-body';
  body.innerHTML = html;
  document.body.append(body);
  return body;
}

describe('shapesOf', () => {
  it('draws exactly the shapes each style names', () => {
    expect(shapesOf('none')).toEqual({ word: false, line: false, paragraph: false });
    expect(shapesOf('word')).toEqual({ word: true, line: false, paragraph: false });
    expect(shapesOf('wordLine')).toEqual({ word: true, line: true, paragraph: false });
    expect(shapesOf('wordLineParagraph')).toEqual({ word: true, line: true, paragraph: true });
    expect(shapesOf('line')).toEqual({ word: false, line: true, paragraph: false });
    expect(shapesOf('lineParagraph')).toEqual({ word: false, line: true, paragraph: true });
  });
});

describe('isExcluded / blockOf', () => {
  it('excludes fenced code, cards, the composer host and the affordance, but not prose or inline code', () => {
    const body = bodyWith(`
      <p id="prose">plain <a href="#">link</a> <code id="inline">x</code></p>
      <pre id="fence"><code>let a = 1;</code></pre>
      <div class="codev-canvas-marker-cards"><ul><li id="card">note</li></ul></div>
      <div class="codev-canvas-comment-composer-host" id="composer">draft</div>
      <p><span class="codev-canvas-row-affordance" id="plus">+</span></p>
    `);
    const text = (id: string): Node => body.querySelector(`#${id}`)!.firstChild!;
    expect(isExcluded(text('prose'), body)).toBe(false);
    expect(isExcluded(body.querySelector('a')!.firstChild!, body)).toBe(false);
    expect(isExcluded(text('inline'), body)).toBe(false);
    expect(isInlineCode(text('inline'))).toBe(true);
    expect(isInlineCode(text('prose'))).toBe(false);
    expect(isExcluded(body.querySelector('#fence code')!.firstChild!, body)).toBe(true);
    expect(isExcluded(text('card'), body)).toBe(true);
    expect(isExcluded(text('composer'), body)).toBe(true);
    expect(isExcluded(text('plus'), body)).toBe(true);
    expect(isExcluded(document.createTextNode('detached'), body)).toBe(true);
    body.remove();
  });

  it('finds the paragraph-level block around a text node', () => {
    const body = bodyWith(`
      <p id="p">a <em>b</em></p>
      <ul><li id="li">item</li></ul>
      <h2 id="h">Heading</h2>
      <div data-line="9" id="raw">raw block</div>
    `);
    expect(blockOf(body.querySelector('em')!.firstChild!, body)?.id).toBe('p');
    expect(blockOf(body.querySelector('#li')!.firstChild!, body)?.id).toBe('li');
    expect(blockOf(body.querySelector('#h')!.firstChild!, body)?.id).toBe('h');
    expect(blockOf(body.querySelector('#raw')!.firstChild!, body)?.id).toBe('raw');
    body.remove();
  });
});

describe('shape geometry', () => {
  const m = { fontSize: 16, lineHeight: 24 };

  it('pads each word fragment into a pill', () => {
    const pills = wordPills([{ left: 100, top: 10, width: 40, height: 18 }], m);
    expect(pills).toHaveLength(1);
    expect(pills[0].left).toBeCloseTo(100 - 16 * 0.22);
    expect(pills[0].width).toBeCloseTo(40 + 2 * 16 * 0.22);
    expect(pills[0].top).toBeCloseTo(10 - 16 * 0.12);
  });

  it('bands the word line across its text, line-box tall', () => {
    const wordRect: Box = { left: 100, top: 10, width: 40, height: 18 };
    const lineRects: Box[] = [
      { left: 20, top: 10, width: 300, height: 18 }, // same line
      { left: 20, top: 34, width: 280, height: 18 }, // next line
    ];
    const band = lineBand(wordRect, lineRects, null, m);
    expect(band.left).toBeCloseTo(20 - 16 * 0.45);
    expect(band.left + band.width).toBeCloseTo(320 + 16 * 0.45);
    expect(band.height).toBe(24);
    expect(band.top + band.height / 2).toBeCloseTo(19);
  });

  it('keeps the band inside the word column when a block spans two columns', () => {
    const fragments: Box[] = [
      { left: 0, top: 0, width: 400, height: 800 },
      { left: 450, top: 0, width: 400, height: 300 },
    ];
    const wordRect: Box = { left: 500, top: 10, width: 40, height: 18 };
    const lineRects: Box[] = [
      { left: 10, top: 10, width: 380, height: 18 }, // column 1, same y
      { left: 460, top: 10, width: 370, height: 18 }, // column 2, same y
    ];
    const column = fragmentContainingX(fragments, 520);
    expect(column).toBe(fragments[1]);
    const band = lineBand(wordRect, lineRects, column, m);
    expect(band.left).toBeGreaterThan(440);
    expect(band.left + band.width).toBeLessThan(850);
  });

  it('shrinks paragraph fragments to their content box, then pads them', () => {
    const fragments: Box[] = [
      { left: 0, top: 0, width: 400, height: 48 },
      { left: 450, top: 0, width: 400, height: 24 },
    ];
    const blocks = paragraphBlocks(fragments, { left: 30, right: 0, top: 0, bottom: 0 }, m);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].left).toBeCloseTo(30 - 16 * 0.6);
    expect(blocks[0].width).toBeCloseTo(370 + 2 * 16 * 0.6);
    expect(blocks[1].left).toBeCloseTo(480 - 16 * 0.6);
  });
});
