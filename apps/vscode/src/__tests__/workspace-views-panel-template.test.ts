/**
 * Spec 1963 scenario 22 (static): the Work and Decisions panels' document and Content Security
 * Policy. The bundle is inline (cluesmith/codev-ide issue #67), so the policy is parsed and held to
 * exactly that: the nonce for the one script, inline styles, nothing loaded from anywhere, and
 * nothing that could reach Tower. The bundle text is escaped so it cannot end its element.
 */

import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import {
  inlineScriptText,
  inlineStyleText,
  renderWorkspaceViewHtml,
  workspaceViewCsp,
} from '../workspace-views/panel-template.js';

const SCRIPT = 'window.mounted = true;';
const STYLE = '.decisions-card { color: var(--vscode-foreground); }';

function render(script = SCRIPT, style = STYLE) {
  return renderWorkspaceViewHtml({ script, style, title: 'Decisions' });
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

function nonceOf(html: string): string {
  return policyOf(html).get('script-src')![0].slice("'nonce-".length, -1);
}

/** Every `<script` / `<style` element's opening tag and its text. */
function elements(html: string, tag: 'script' | 'style'): Array<{ open: string; text: string }> {
  return [...html.matchAll(new RegExp(`(<${tag}\\b[^>]*>)([\\s\\S]*?)</${tag}>`, 'gi'))].map(m => ({ open: m[1], text: m[2] }));
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

  it('allows exactly the nonce for scripts: no unsafe-inline, no unsafe-eval, no source', () => {
    const scripts = policyOf(render()).get('script-src')!;
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatch(/^'nonce-[A-Za-z0-9+/]{24}'$/);
  });

  it("allows inline styles, with no nonce (it would switch 'unsafe-inline' off) and no source", () => {
    const policy = policyOf(render());
    expect(policy.get('style-src')).toEqual(["'unsafe-inline'"]);
    expect(render()).not.toContain('unsafe-eval');
  });

  it('allows images from blob: and http(s) only, and no other directive', () => {
    const policy = policyOf(render());
    expect(policy.get('img-src')).toEqual(['blob:', 'http:', 'https:']);
    expect([...policy.keys()].sort()).toEqual(['default-src', 'img-src', 'script-src', 'style-src']);
  });

  it('carries the bundle inline: one script with the nonce, one stylesheet, and nothing loaded by URL', () => {
    const html = render();
    const nonce = nonceOf(html);
    expect(elements(html, 'script')).toEqual([{ open: `<script nonce="${nonce}">`, text: SCRIPT }]);
    expect(elements(html, 'style')).toEqual([{ open: '<style>', text: STYLE }]);
    expect(html).not.toMatch(/\bsrc=|\bhref=|<link\b/);
  });

  it('draws a fresh nonce for every render', () => {
    expect(nonceOf(render())).not.toBe(nonceOf(render()));
  });

  it('mounts on #root and carries the title', () => {
    const html = render();
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<title>Decisions</title>');
  });

  it('builds the same policy directly', () => {
    expect(workspaceViewCsp('abc')).toBe("default-src 'none'; script-src 'nonce-abc'; style-src 'unsafe-inline'; img-src blob: http: https:");
  });
});

describe('escaping the bundle text', () => {
  // What a bundle can hold: React DOM's and DOMPurify's own strings and regular expressions.
  const HOSTILE_SCRIPT = String.raw`
    var tags = "</script><script>alert(1)</script>", upper = "</SCRIPT>";
    var comment = "<!-- x -->", empty = "<!---->";
    var re = /^<!--/, reU = /<!--|<\/script>/u, reI = /<\/(script|pre|style|textarea)>/i;
    var escaped = "\<!--", literal = "\\</script>";
    // a comment: </script> <!--
    window.result = { tags, upper, comment, empty, re: re.test("<!-- a"), reU: reU.test("a<!--"), reI: reI.test("</STYLE>"), escaped, literal };
  `;

  it('leaves no sequence that ends a script or opens an HTML comment in it, in any case', () => {
    const html = render(HOSTILE_SCRIPT, STYLE);
    const [script] = elements(html, 'script');
    expect(script.text).not.toMatch(/<\/script|<!--/i);
    expect(elements(html, 'script')).toHaveLength(1);
  });

  it('keeps the script meaning the same, the u flag and backslash runs included', () => {
    const run = (source: string) => {
      const window: Record<string, unknown> = {};
      runInNewContext(source, { window });
      return window.result;
    };
    const escaped = inlineScriptText(HOSTILE_SCRIPT);
    expect(escaped).not.toBe(HOSTILE_SCRIPT);
    expect(run(escaped)).toEqual(run(HOSTILE_SCRIPT));
    expect(run(escaped)).toMatchObject({ re: true, reU: true, reI: true, escaped: '<!--', literal: '\\</script>' });
  });

  it('leaves no sequence that ends a style in the stylesheet, and keeps the CSS string the same', () => {
    const style = `.a::after { content: "</style><script>alert(1)</script>"; } .b::after { content: "</STYLE>"; }`;
    const html = render(SCRIPT, style);
    const [element] = elements(html, 'style');
    expect(element.text).not.toMatch(/<\/style/i);
    expect(elements(html, 'style')).toHaveLength(1);
    expect(inlineStyleText(style)).toBe(String.raw`.a::after { content: "\3C /style><script>alert(1)</script>"; } .b::after { content: "\3C /STYLE>"; }`);
  });

  it('changes nothing in text without those sequences', () => {
    const plain = 'if (a < b && c <!- d) { x = "<div>" + "<scriptx" }';
    expect(inlineScriptText(plain)).toBe(plain);
    expect(inlineStyleText(STYLE)).toBe(STYLE);
  });
});
