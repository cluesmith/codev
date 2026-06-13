import { describe, it, expect, vi } from 'vitest';
import DOMPurify from 'dompurify';
import { renderMarkdown } from '../renderer.js';

/**
 * HTML sanitization (spec D7, plan Phase 2 / scenario 8; deferred item #3).
 *
 * PLAN DEVIATION (documented): the plan proposed proving DOMPurify by a markdown
 * `[x](javascript:alert(1))` link "surviving html:false". In practice markdown-it's default
 * `validateLink` already neutralizes `javascript:`/`data:` URLs *before* DOMPurify, so that
 * vector does not isolate DOMPurify — it would pass even if the sanitize step were removed.
 * The correct regression guard that the sanitize step *itself* runs is to assert
 * `DOMPurify.sanitize` is actually invoked by `renderMarkdown` (it fails if the call is removed).
 * We keep all three defense layers: markdown-it `html:false` + `validateLink` + DOMPurify.
 */
describe('sanitization (D7)', () => {
  it('exercises the DOMPurify sanitize step (regression guard — fails if the call is removed)', () => {
    const spy = vi.spyOn(DOMPurify, 'sanitize');
    const out = renderMarkdown('# Hello\n\nA paragraph with a [link](https://example.com).');
    expect(spy).toHaveBeenCalled();
    // renderMarkdown returns the sanitized output, not the raw markdown-it HTML.
    expect(out).toContain('data-line'); // sanitized output still carries data-line
    spy.mockRestore();
  });

  it('does not pass raw <script> through (html:false) and it is absent from the output', () => {
    const out = renderMarkdown('Hello <script>window.__pwned = true;</script> world');
    expect(out.toLowerCase()).not.toContain('<script');
  });

  it('does not emit a live javascript: link href', () => {
    const doc = new DOMParser().parseFromString(
      renderMarkdown('[click me](javascript:alert(1))'),
      'text/html',
    );
    const href = doc.querySelector('a')?.getAttribute('href')?.toLowerCase() ?? '';
    expect(href).not.toContain('javascript:');
  });

  it('produces no live event-handler attributes or raw HTML elements (html:false + DOMPurify)', () => {
    // Raw HTML in the source is escaped to text by html:false, so it never becomes a live node.
    // Assert via the DOM (string-matching would false-positive on the escaped text content).
    const doc = new DOMParser().parseFromString(
      renderMarkdown('<img src=x onerror="alert(1)"> and <a href="#" onclick="alert(2)">x</a>'),
      'text/html',
    );
    expect(doc.querySelector('[onerror]')).toBeNull();
    expect(doc.querySelector('[onclick]')).toBeNull();
    expect(doc.querySelector('img')).toBeNull();
  });

  it('preserves data-line attributes through sanitization', () => {
    expect(renderMarkdown('# Title')).toContain('data-line="0"');
  });
});
