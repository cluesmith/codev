/**
 * Spec 1963 scenario 22 (static): the Work and Decisions panels' Content Security Policy. A webview
 * must not be able to reach Tower or anywhere else, so the policy is parsed and held to exactly
 * what the panels load.
 */

import { describe, it, expect } from 'vitest';
import { renderWorkspaceViewHtml, workspaceViewCsp } from '../workspace-views/panel-template.js';

const CSP_SOURCE = 'https://abc.vscode-cdn.net';

function render() {
  return renderWorkspaceViewHtml({
    cspSource: CSP_SOURCE,
    scriptUri: `${CSP_SOURCE}/dist/webview/decisions.js`,
    styleUri: `${CSP_SOURCE}/dist/webview/decisions.css`,
    title: 'Decisions',
  });
}

/** The policy in the document, as directive → sources. */
function policyOf(html: string): Map<string, string[]> {
  const match = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)" \/>/);
  expect(match, 'the document carries a CSP meta tag').not.toBeNull();
  const policy = new Map<string, string[]>();
  for (const directive of match![1].split(';').map(d => d.trim()).filter(Boolean)) {
    const [name, ...sources] = directive.split(/\s+/);
    expect(policy.has(name), `${name} appears once`).toBe(false);
    policy.set(name, sources);
  }
  return policy;
}

describe('the panel document', () => {
  it("starts with default-src 'none'", () => {
    const html = render();
    const directives = [...policyOf(html).keys()];
    expect(directives[0]).toBe('default-src');
    expect(policyOf(html).get('default-src')).toEqual(["'none'"]);
  });

  it('has no connect-src, so fetch, XHR, WebSocket and EventSource fall back to none', () => {
    expect(policyOf(render()).has('connect-src')).toBe(false);
  });

  it('allows exactly the nonce for scripts: no unsafe-inline, no unsafe-eval', () => {
    const html = render();
    const scripts = policyOf(html).get('script-src')!;
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatch(/^'nonce-[A-Za-z0-9+/]{24}'$/);
    const nonce = scripts[0].slice("'nonce-".length, -1);
    expect(html).toContain(`<script nonce="${nonce}" src="${CSP_SOURCE}/dist/webview/decisions.js"></script>`);
  });

  it('allows images from the bundle, blob: and http(s), and styles from the bundle plus inline', () => {
    const policy = policyOf(render());
    expect(policy.get('img-src')).toEqual([CSP_SOURCE, 'blob:', 'http:', 'https:']);
    expect(policy.get('style-src')).toEqual([CSP_SOURCE, "'unsafe-inline'"]);
    expect([...policy.keys()].sort()).toEqual(['default-src', 'img-src', 'script-src', 'style-src']);
  });

  it('draws a fresh nonce for every render', () => {
    const nonce = (html: string) => policyOf(html).get('script-src')![0];
    expect(nonce(render())).not.toBe(nonce(render()));
  });

  it('links the stylesheet, mounts on #root and carries the title', () => {
    const html = render();
    expect(html).toContain(`<link href="${CSP_SOURCE}/dist/webview/decisions.css" rel="stylesheet" />`);
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<title>Decisions</title>');
  });

  it('builds the same policy directly', () => {
    expect(workspaceViewCsp('vscode-resource:', 'abc')).toBe(
      "default-src 'none'; script-src 'nonce-abc'; style-src vscode-resource: 'unsafe-inline'; img-src vscode-resource: blob: http: https:",
    );
  });
});
