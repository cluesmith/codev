import { describe, it, expect, vi } from 'vitest';
import DOMPurify from 'dompurify';
import { renderMarkdown } from '../renderer.js';

/**
 * HTML sanitization (spec D7, amended by #1042).
 *
 * The renderer now runs markdown-it with `html: true`, so **DOMPurify is the sole guard**: safe
 * static HTML renders (images, details, kbd, tables…) while scripts, event-handler attributes, and
 * dangerous URLs are stripped. Document-supplied JavaScript never executes. These tests pin that
 * boundary — they fail if the sanitize step is removed or if the policy regresses to passing
 * dangerous HTML through.
 */
describe('sanitization (D7, #1042: html:true + DOMPurify)', () => {
  it('exercises the DOMPurify sanitize step (regression guard — fails if the call is removed)', () => {
    const spy = vi.spyOn(DOMPurify, 'sanitize');
    const out = renderMarkdown('# Hello\n\nA paragraph with a [link](https://example.com).');
    expect(spy).toHaveBeenCalled();
    expect(out).toContain('data-line'); // sanitized output still carries data-line
    spy.mockRestore();
  });

  it('strips raw <script> (never executes document-supplied JS)', () => {
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

  it('renders SAFE static HTML (img, details) while stripping event handlers', () => {
    const doc = new DOMParser().parseFromString(
      renderMarkdown(
        '<img src="diagram.png" alt="d" onerror="alert(1)"> and ' +
          '<a href="#" onclick="alert(2)">x</a>\n\n<details><summary>More</summary>body</details>',
      ),
      'text/html',
    );
    // Safe static HTML now renders (the #1042 policy change)...
    expect(doc.querySelector('img')).not.toBeNull();
    expect(doc.querySelector('details')).not.toBeNull();
    expect(doc.querySelector('summary')).not.toBeNull();
    // ...but every dangerous handler / element is gone.
    expect(doc.querySelector('[onerror]')).toBeNull();
    expect(doc.querySelector('[onclick]')).toBeNull();
    expect(doc.querySelector('script')).toBeNull();
  });

  it('preserves data-line attributes through sanitization', () => {
    expect(renderMarkdown('# Title')).toContain('data-line="0"');
  });
});
