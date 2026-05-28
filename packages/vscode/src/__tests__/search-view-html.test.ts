/**
 * Issue #891: sentinel tests for the search webview's HTML scaffold.
 *
 * `renderSearchHtml` is a pure function; the only `vscode` shape it touches
 * is `Webview.cspSource`, mocked inline below. The assertions guard
 * structural invariants — if CSP, theme variables, or the message handlers
 * silently regress, the webview can render-but-not-function in production
 * (a fault that doesn't show up in either build or end-to-end checks).
 *
 * The renderer is parameterized so the same HTML scaffold serves both
 * the Backlog and Builders search views (#891 design revision: two
 * independent per-view inputs, not a shared one); only the placeholder
 * differs. Tests pin both placeholders separately to catch regressions
 * to either flavor.
 */

import { describe, it, expect } from 'vitest';
import { renderSearchHtml, makeNonce, SEARCH_DEBOUNCE_MS } from '../views/search-view-html.js';

 
const fakeWebview = { cspSource: 'vscode-webview://test' } as any;

describe('renderSearchHtml', () => {
  const html = renderSearchHtml(fakeWebview, { nonce: 'TEST_NONCE', placeholder: 'Search backlog...' });

  it('sets a Content-Security-Policy meta tag', () => {
    expect(html).toMatch(/<meta http-equiv="Content-Security-Policy"/);
  });

  it('substitutes the nonce into both script-src and the script tag', () => {
    expect(html).toMatch(/script-src 'nonce-TEST_NONCE'/);
    expect(html).toMatch(/<script nonce="TEST_NONCE">/);
  });

  it('references webview.cspSource for style-src so theme CSS resolves', () => {
    expect(html).toMatch(/style-src vscode-webview:\/\/test/);
  });

  it('uses --vscode-input-* theme variables for native styling', () => {
    expect(html).toMatch(/--vscode-input-background/);
    expect(html).toMatch(/--vscode-input-foreground/);
    expect(html).toMatch(/--vscode-input-border/);
    expect(html).toMatch(/--vscode-input-placeholderForeground/);
  });

  it('pins the debounce constant in the rendered script', () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(150);
    expect(html).toContain(`}, ${SEARCH_DEBOUNCE_MS});`);
  });

  it('posts {type:"query"} from the input handler', () => {
    expect(html).toMatch(/postMessage\(\s*\{\s*type:\s*'query'/);
  });

  it('posts {type:"ready"} on script load so the extension can push initial summary', () => {
    expect(html).toMatch(/postMessage\(\s*\{\s*type:\s*'ready'/);
  });

  it('handles {type:"summary"} messages from the extension', () => {
    expect(html).toMatch(/msg\.type === 'summary'/);
  });

  it('substitutes the placeholder for the Backlog flavor', () => {
    expect(html).toContain('placeholder="Search backlog..."');
  });

  it('substitutes the placeholder for the Builders flavor', () => {
    const buildersHtml = renderSearchHtml(fakeWebview, { nonce: 'X', placeholder: 'Search builders...' });
    expect(buildersHtml).toContain('placeholder="Search builders..."');
  });

  it('HTML-escapes the placeholder so " or < in the param cannot break out', () => {
    const evil = renderSearchHtml(fakeWebview, { nonce: 'X', placeholder: 'a" onfocus="alert(1)" b<' });
    expect(evil).not.toContain('onfocus="alert(1)"');
    expect(evil).toContain('a&quot; onfocus=&quot;alert(1)&quot; b&lt;');
  });

  it('contains no <button> elements (mode toggles are dropped from v1)', () => {
    expect(html.toLowerCase()).not.toMatch(/<button/);
  });
});

describe('makeNonce', () => {
  it('returns a 32-char alphanumeric string', () => {
    const nonce = makeNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9]{32}$/);
  });

  it('returns distinct values on successive calls', () => {
    const a = makeNonce();
    const b = makeNonce();
    expect(a).not.toBe(b);
  });
});
