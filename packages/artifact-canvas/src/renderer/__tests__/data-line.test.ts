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

  it('stamps data-line on a list and its items', () => {
    expect(doc.querySelector('ul')?.getAttribute('data-line')).toBe('4');
    expect(doc.querySelector('li')?.getAttribute('data-line')).toBe('4');
  });

  it('stamps data-line on a blockquote', () => {
    expect(doc.querySelector('blockquote')?.getAttribute('data-line')).toBe('7');
  });

  it('stamps data-line on a fenced code block', () => {
    expect(doc.querySelector('[data-line="9"]')).not.toBeNull();
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
    for (const sel of ['h1', 'p', 'ul', 'li', 'blockquote']) {
      expect(doc.querySelector(sel)?.getAttribute('tabindex')).toBe('0');
    }
    expect(doc.querySelector('[data-line="9"]')?.getAttribute('tabindex')).toBe('0');
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
