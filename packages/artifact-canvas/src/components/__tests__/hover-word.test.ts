import { describe, expect, it } from 'vitest';
import {
  CLICK_EXCLUDED_SELECTOR,
  bandForRow,
  blockOf,
  fragmentContainingX,
  inGapBelow,
  isExcluded,
  isInlineCode,
  lastRow,
  lineBand,
  paragraphBlocks,
  parseAnnotationEntry,
  parseHighlightLine,
  parseHighlightStyle,
  parseReadingCursor,
  previousBlock,
  rowAbove,
  rowsInColumn,
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

describe('parseHighlightLine / parseAnnotationEntry (#1850)', () => {
  it('accepts the vocabulary case-insensitively', () => {
    expect(parseHighlightLine('abovePointer')).toBe('abovePointer');
    expect(parseHighlightLine(' ABOVEPOINTER ')).toBe('abovePointer');
    expect(parseHighlightLine('underpointer')).toBe('underPointer');
    expect(parseAnnotationEntry('clickparagraph')).toBe('clickParagraph');
    expect(parseAnnotationEntry('GutterButton')).toBe('gutterButton');
  });

  it("falls back to today's behavior for unknown or missing values", () => {
    for (const v of [undefined, null, 3, '', 'sideways']) {
      expect(parseHighlightLine(v)).toBe('underPointer');
      expect(parseAnnotationEntry(v)).toBe('gutterButton');
    }
  });
});

describe('line-above geometry (#1850)', () => {
  const m = { fontSize: 16, lineHeight: 24 };
  // Three 24px lines; glyph boxes 20px tall, starting 2px into each line box.
  const row = (top: number, left = 20, width = 300): Box => ({ left, top: top + 2, width, height: 20 });

  it('groups inline rects into rows, merging a taller inline-code chip into its line', () => {
    const rects = [row(0, 20, 100), { left: 130, top: 1, width: 40, height: 22 }, row(24), row(48)];
    const rows = rowsInColumn(rects, null, m);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ left: 20, top: 1, width: 150, height: 22 });
  });

  it('drops rects outside the column and orders rows top to bottom', () => {
    const column = { left: 0, top: 0, width: 400, height: 200 };
    const rects = [row(48), row(0, 500), row(0), row(24)];
    const rows = rowsInColumn(rects, column, m);
    expect(rows.map((r) => r.top)).toEqual([2, 26, 50]);
  });

  it('picks the row directly above the pointer row, and none on the top row', () => {
    const rows = [row(0), row(24), row(48)];
    const pointerOnThird = lineBand(row(48, 40, 30), rows, null, m);
    expect(rowAbove(rows, pointerOnThird)).toEqual(rows[1]);
    const pointerOnFirst = lineBand(row(0, 40, 30), rows, null, m);
    expect(rowAbove(rows, pointerOnFirst)).toBeNull();
  });

  it('never takes the line above from the neighbouring column', () => {
    // Column 2 (left 500) holds the block's continuation; the pointer is on its first line.
    const column2 = { left: 480, top: 0, width: 400, height: 200 };
    const rects = [row(0), row(24), row(48), row(0, 500), row(24, 500)];
    const rows = rowsInColumn(rects, column2, m);
    const pointer = lineBand(row(0, 520, 30), rows, column2, m);
    expect(rowAbove(rows, pointer)).toBeNull();
  });

  it('finds the last row and bands a row like lineBand does', () => {
    const rows = [row(0), row(24), row(48)];
    expect(lastRow(rows)).toEqual(rows[2]);
    expect(lastRow([])).toBeNull();
    expect(bandForRow(rows[1], m)).toEqual({ left: 20 - 7.2, top: 24, width: 300 + 14.4, height: 24 });
  });

  it('detects the gap just below a block, inside its text extent only', () => {
    const rows = [row(0), row(24)];
    const last = rows[1];
    // The last line box ends at 48; the gap test covers the next 24px.
    expect(inGapBelow(last, rows, 100, 50, m)).toBe(true);
    expect(inGapBelow(last, rows, 100, 72, m)).toBe(true);
    expect(inGapBelow(last, rows, 100, 73, m)).toBe(false); // too far below
    expect(inGapBelow(last, rows, 100, 40, m)).toBe(false); // still on the line
    expect(inGapBelow(last, rows, 5, 50, m)).toBe(false); // the gutter
  });
});

describe('previousBlock (#1850)', () => {
  const build = (html: string): HTMLElement => {
    const body = document.createElement('div');
    body.innerHTML = html;
    return body;
  };

  it('returns the preceding paragraph, skipping into its last nested block', () => {
    const body = build('<p id="a">a</p><ul><li id="b"><p id="b1">b1</p><p id="b2">b2</p></li></ul><p id="c">c</p>');
    expect(previousBlock(body.querySelector('#c')!, body)?.id).toBe('b2');
    expect(previousBlock(body.querySelector('#b2')!, body)?.id).toBe('b1');
  });

  it('skips ancestors of the block', () => {
    const body = build('<p id="a">a</p><blockquote id="q"><p id="q1">q1</p></blockquote>');
    expect(previousBlock(body.querySelector('#q1')!, body)?.id).toBe('a');
  });

  it('stops at a code block, a comment-card stack or the composer', () => {
    const body = build(
      '<p id="a">a</p><pre><code>x</code></pre><p id="b">b</p>' +
        '<div class="codev-canvas-marker-cards"><p>card</p></div><p id="c">c</p>' +
        '<div class="codev-canvas-comment-composer-host"></div><p id="d">d</p>',
    );
    expect(previousBlock(body.querySelector('#b')!, body)).toBeNull();
    expect(previousBlock(body.querySelector('#c')!, body)).toBeNull();
    expect(previousBlock(body.querySelector('#d')!, body)).toBeNull();
  });

  it('skips the "+" wrapper hosted inside the row above', () => {
    const body = build('<p id="a">a<span class="codev-canvas-row-affordance"><button>+</button></span></p><p id="b">b</p>');
    expect(previousBlock(body.querySelector('#b')!, body)?.id).toBe('a');
  });

  it('returns null at the top of the body', () => {
    const body = build('<h1 id="t">t</h1>');
    expect(previousBlock(body.querySelector('#t')!, body)).toBeNull();
  });
});

describe('CLICK_EXCLUDED_SELECTOR (#1850)', () => {
  it('covers links, code, images, cards, card actions and the composer, but not prose', () => {
    const body = document.createElement('div');
    body.innerHTML =
      '<p id="prose">text <a id="link">l</a> <code id="chip">c</code> <img id="img"></p><pre id="pre">x</pre>' +
      '<div class="codev-canvas-marker-cards"><span id="card">c</span><button data-action="edit" id="edit">e</button></div>' +
      '<div class="codev-canvas-comment-composer-host"><textarea id="ta"></textarea></div>';
    const hit = (id: string): boolean => body.querySelector(`#${id}`)!.closest(CLICK_EXCLUDED_SELECTOR) !== null;
    expect(hit('prose')).toBe(false);
    for (const id of ['link', 'chip', 'img', 'pre', 'card', 'edit', 'ta']) expect(hit(id)).toBe(true);
  });
});
