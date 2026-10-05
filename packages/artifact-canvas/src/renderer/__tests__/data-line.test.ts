import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../renderer.js';

/**
 * Renderer data-line attribution (spec D5, plan Phase 2 / scenario 1).
 * `data-line` is 0-based, derived from markdown-it's `token.map[0]`.
 */
describe('data-line source mapping', () => {
  // Lines (0-based):
  // 0: # Heading
  // 1: (blank)
  // 2: A paragraph.
  // 3: (blank)
  // 4: - item one
  // 5: - item two
  // 6: (blank)
  // 7: > a quote
  // 8: (blank)
  // 9: ```
  // 10: code
  // 11: ```
  const source = [
    '# Heading',
    '',
    'A paragraph.',
    '',
    '- item one',
    '- item two',
    '',
    '> a quote',
    '',
    '```',
    'code',
    '```',
  ].join('\n');

  const doc = new DOMParser().parseFromString(renderMarkdown(source), 'text/html');

  it('stamps 0-based data-line on a heading', () => {
    expect(doc.querySelector('h1')?.getAttribute('data-line')).toBe('0');
  });

  it('stamps data-line on a paragraph', () => {
    expect(doc.querySelector('p')?.getAttribute('data-line')).toBe('2');
  });

  // #1738: the list WRAPPER is deliberately NOT stamped — it would be the outermost element for
  // its opening line and swallow the first `<li>` from navigation and marker anchoring. The first
  // item carries `data-line` itself, exactly like items 2..n.
  it('stamps data-line on list items but NOT the list wrapper (#1738)', () => {
    expect(doc.querySelector('ul')?.getAttribute('data-line')).toBeNull();
    expect(doc.querySelector('li')?.getAttribute('data-line')).toBe('4');
  });

  // #1738: same rule for a blockquote — the wrapper is not stamped, so its first paragraph is the
  // navigable/markable block for the opening line rather than the whole quote.
  it('stamps data-line on the blockquote’s paragraph but NOT the blockquote wrapper (#1738)', () => {
    expect(doc.querySelector('blockquote')?.getAttribute('data-line')).toBeNull();
    expect(doc.querySelector('blockquote p')?.getAttribute('data-line')).toBe('7');
  });

  it('stamps data-line on the fence PRE, tabindex on both pre and code (#1396)', () => {
    // The row identity lives on the top-level element — matching code_block, and making the
    // `> [data-line]` row rules (position context, gutter) true for fences. The inner code
    // keeps tabindex: it is the fence's scroll container and must stay keyboard-reachable.
    const pre = doc.querySelector('pre');
    expect(pre?.getAttribute('data-line')).toBe('9');
    expect(pre?.getAttribute('tabindex')).toBe('0');
    const code = pre?.querySelector('code');
    expect(code?.getAttribute('data-line')).toBeNull();
    expect(code?.getAttribute('tabindex')).toBe('0');
  });

  it('indented code_block keeps its pre-level data-line (parity with fences)', () => {
    const blockDoc = new DOMParser().parseFromString(
      renderMarkdown('text\n\n    indented code line'),
      'text/html',
    );
    expect(blockDoc.querySelector('pre')?.getAttribute('data-line')).toBe('2');
  });

  it('fence with a language info string keeps the language class alongside the row attrs', () => {
    const langDoc = new DOMParser().parseFromString(
      renderMarkdown('```js\nconst a = 1;\n```'),
      'text/html',
    );
    expect(langDoc.querySelector('pre')?.getAttribute('data-line')).toBe('0');
    expect(langDoc.querySelector('pre code')?.className).toContain('language-js');
  });

  it('stamps data-line on a table', () => {
    const tableDoc = new DOMParser().parseFromString(
      renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |'),
      'text/html',
    );
    expect(tableDoc.querySelector('table')?.getAttribute('data-line')).toBe('0');
  });

  // Focusability is stamped at RENDER time (not via a post-render effect) so a block is
  // keyboard-reachable the instant it mounts. This guards against the CI-only race where a test
  // (or a screen reader) read tabindex before a decoration effect had run. (DOMPurify preserves
  // the standard `tabindex` attribute.)
  it('stamps tabindex="0" on every mapped block at render time (accessibility AC)', () => {
    // Containers (ul/blockquote) are no longer mapped (#1738), so they are neither data-line'd nor
    // focusable; their focusable children (li, inner p) carry tabindex instead.
    for (const sel of ['h1', 'p', 'li']) {
      expect(doc.querySelector(sel)?.getAttribute('tabindex')).toBe('0');
    }
    expect(doc.querySelector('ul')?.getAttribute('tabindex')).toBeNull();
    expect(doc.querySelector('blockquote')?.getAttribute('tabindex')).toBeNull();
    expect(doc.querySelector('[data-line="9"]')?.getAttribute('tabindex')).toBe('0');
  });
});

/**
 * #1738 — container open tokens are not stamped, so the first child of every container is
 * individually navigable/markable instead of being swallowed by its wrapper. A container's source
 * map always STARTS on its first child's line, so dropping the wrapper never orphans a line: the
 * first child re-supplies the identical `data-line`.
 */
describe('container open tokens are not stamped (#1738)', () => {
  it('an ordered list gives its FIRST item its own data-line (not the <ol>)', () => {
    const doc = new DOMParser().parseFromString(
      renderMarkdown('Intro.\n\n1. first\n2. second\n3. third'),
      'text/html',
    );
    const ol = doc.querySelector('ol');
    expect(ol?.getAttribute('data-line')).toBeNull();
    // The wrapper is a CSS row (hosts the "+"), so it carries `data-row` but no tabindex.
    expect(ol?.getAttribute('data-row')).toBe('');
    expect(ol?.getAttribute('tabindex')).toBeNull();
    const items = Array.from(doc.querySelectorAll('li'));
    // first item on its own line (2), then 3, then 4 — no line is exclusive to the <ol>.
    expect(items.map((li) => li.getAttribute('data-line'))).toEqual(['2', '3', '4']);
    expect(items[0].textContent).toContain('first');
  });

  it('a nested list stamps every item, and neither the outer nor the inner <ul>', () => {
    // 0: - outer
    // 1:   - nested one
    // 2:   - nested two
    const doc = new DOMParser().parseFromString(
      renderMarkdown('- outer\n  - nested one\n  - nested two'),
      'text/html',
    );
    expect(Array.from(doc.querySelectorAll('ul')).every((ul) => ul.getAttribute('data-line') === null)).toBe(true);
    const lines = Array.from(doc.querySelectorAll('li')).map((li) => li.getAttribute('data-line'));
    expect(lines).toEqual(['0', '1', '2']); // outer item, nested one, nested two — each reachable
  });

  it('a multi-paragraph blockquote stamps each inner paragraph, not the blockquote', () => {
    // 0: > para one
    // 1: >
    // 2: > para two
    const doc = new DOMParser().parseFromString(
      renderMarkdown('> para one\n>\n> para two'),
      'text/html',
    );
    const bq = doc.querySelector('blockquote');
    expect(bq?.getAttribute('data-line')).toBeNull();
    expect(bq?.getAttribute('data-row')).toBe(''); // CSS row hook, no navigation identity
    const paras = Array.from(doc.querySelectorAll('blockquote p')).map((p) => p.getAttribute('data-line'));
    expect(paras).toEqual(['0', '2']); // first paragraph no longer swallowed by the wrapper
  });
});

/**
 * Comment stripping + line mapping (#1036 / #1042). Full-line HTML comments are removed before
 * block parsing so they neither render as text nor split a block, while `data-line` still reports
 * the ORIGINAL source line.
 */
describe('comment stripping + line map', () => {
  it('removes a full-line HTML comment from the rendered output', () => {
    const out = renderMarkdown('# H\n<!-- REVIEW(@a): note -->\n\ntext');
    expect(out).not.toContain('REVIEW');
    expect(out).not.toContain('&lt;!--');
  });

  it('does NOT split a multi-line paragraph when a comment sits inside it, and keeps the original data-line', () => {
    // 0: line one of the paragraph
    // 1: <!-- comment -->   (written "below the start", as the editor/canvas do)
    // 2: line two of the paragraph
    const doc = new DOMParser().parseFromString(
      renderMarkdown('line one of the paragraph\n<!-- REVIEW(@a): x -->\nline two of the paragraph'),
      'text/html',
    );
    const paras = doc.querySelectorAll('p');
    expect(paras.length).toBe(1); // rejoined — not split into two
    expect(paras[0].getAttribute('data-line')).toBe('0'); // original first line
    expect(paras[0].textContent).toContain('line one');
    expect(paras[0].textContent).toContain('line two');
  });

  it('maps data-line back to original lines for blocks after a stripped comment', () => {
    // 0: # Heading
    // 1: <!-- c -->
    // 2: A paragraph.   ← original line 2 even though it is the 2nd parsed line
    const doc = new DOMParser().parseFromString(
      renderMarkdown('# Heading\n<!-- c -->\nA paragraph.'),
      'text/html',
    );
    expect(doc.querySelector('h1')?.getAttribute('data-line')).toBe('0');
    expect(doc.querySelector('p')?.getAttribute('data-line')).toBe('2');
  });

  it('does NOT strip a comment-looking line inside a fenced code block', () => {
    const out = renderMarkdown('```html\n<!-- keep me -->\n```');
    expect(out).toContain('keep me'); // preserved as literal code (escaped) inside the fence
  });
});
