/**
 * Unit tests for the contextual panel webview HTML template.
 *
 * The template is a pure string builder (no `vscode` import), so it is testable without a host.
 * These pin the security-relevant invariants — nonce-bound CSP, no inline/remote scripts, resources
 * scoped to the webview `cspSource` — which Phase 3 will extend with header-text escaping.
 */

import { describe, it, expect } from 'vitest';
import { renderContextualPanelHtml } from '../contextual-panel/panel-template.js';

const CSP_SOURCE = 'vscode-webview://abc123';
const html = renderContextualPanelHtml({
  cspSource: CSP_SOURCE,
  scriptUri: 'https://host/dist/webview/contextual-panel.js',
  styleUri: 'https://host/dist/webview/contextual-panel.css',
});

describe('renderContextualPanelHtml — CSP / nonce hardening', () => {
  it('binds the same fresh nonce into both the CSP and the script tag', () => {
    const cspNonce = html.match(/script-src 'nonce-([A-Za-z0-9]+)'/)?.[1];
    const tagNonce = html.match(/<script nonce="([A-Za-z0-9]+)"/)?.[1];
    expect(cspNonce).toBeDefined();
    expect(tagNonce).toBe(cspNonce);
  });

  it('locks default-src to none and admits no inline or wildcard scripts', () => {
    expect(html).toMatch(/default-src 'none'/);
    const scriptSrc = html.match(/script-src ([^;"]+)/)?.[1] ?? '';
    expect(scriptSrc).not.toMatch(/unsafe-inline/);
    expect(scriptSrc).not.toContain('*');
  });

  it('scopes styles, images, and fonts to the webview cspSource', () => {
    expect(html).toContain(`style-src ${CSP_SOURCE} 'unsafe-inline'`);
    expect(html).toContain(`img-src ${CSP_SOURCE}`);
    expect(html).toContain(`font-src ${CSP_SOURCE}`);
  });

  it('references exactly the provided script and style URIs', () => {
    expect(html).toContain('src="https://host/dist/webview/contextual-panel.js"');
    expect(html).toContain('href="https://host/dist/webview/contextual-panel.css"');
  });

  it('mounts a single #root and produces a distinct nonce per render', () => {
    expect(html).toContain('<div id="root"></div>');
    const again = renderContextualPanelHtml({ cspSource: CSP_SOURCE, scriptUri: 's', styleUri: 't' });
    const first = html.match(/nonce-([A-Za-z0-9]+)/)?.[1];
    const second = again.match(/nonce-([A-Za-z0-9]+)/)?.[1];
    expect(first).not.toBe(second);
  });
});
