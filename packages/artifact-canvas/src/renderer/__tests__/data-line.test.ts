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
