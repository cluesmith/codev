/**
 * Issue #891: sentinel tests for the search webview's HTML scaffold.
 *
 * `renderSearchHtml` is a pure function; the only `vscode` shape it touches
 * is `Webview.cspSource`, mocked inline below. The assertions guard
 * structural invariants — if CSP, theme variables, or the message handlers
 * silently regress, the webview can render-but-not-function in production
 * (a fault that doesn't show up in either build or end-to-end checks).
 */

import { describe, it, expect } from 'vitest';
import { renderSearchHtml, makeNonce, SEARCH_DEBOUNCE_MS } from '../views/search-view-html.js';

const fakeWebview = { cspSource: 'vscode-webview://test' } as any;  

describe('renderSearchHtml', () => {
  const html = renderSearchHtml(fakeWebview, 'TEST_NONCE');

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

  it('contains the placeholder copy specified in the plan', () => {
    expect(html).toContain('Search backlog and builders...');
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
