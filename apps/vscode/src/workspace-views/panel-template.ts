/**
 * The HTML document of a Work or Decisions panel webview (Spec 1963), with its Content Security
 * Policy. Pure string building; the panel reads the bundle.
 *
 * **The bundle's script and stylesheet are inline in the document, and the panel fetches nothing
 * from the extension.** Codev IDE 1.138 pins a webview host page that cannot deliver a webview's
 * resources: each fetch through its service worker fails (`DataCloneError`, cluesmith/codev-ide
 * issue #67), so a panel that loads its bundle by URL stays blank there. The document itself does
 * arrive. One form on every VS Code version: no detection of the IDE, no URL fallback.
 *
 * The policy admits only what the panels use:
 * - `default-src 'none'` first, so anything not listed is refused. In particular there is no
 *   `connect-src`, so `fetch`, XHR, WebSocket and EventSource fall back to `'none'`: a panel cannot
 *   reach Tower, or anywhere else;
 * - `script-src` is the per-render nonce only: no `'unsafe-inline'`, no `'unsafe-eval'`, and no
 *   source, since nothing is loaded from the extension;
 * - `style-src` is `'unsafe-inline'`, with no nonce (a nonce in the directive would switch
 *   `'unsafe-inline'` off) and no source. It admits the inline stylesheet and the `style`
 *   attributes a decision item's Markdown carries (an aligned table column, raw HTML), as the
 *   dashboard renders them. Inline styles run no code;
 * - `img-src` admits `blob:` (workspace images the host delivers as bytes, shown as object URLs)
 *   and `http:`/`https:` (remote images written in decision items, as the dashboard loads them).
 */

import { randomBytes } from 'node:crypto';

export interface WorkspaceViewHtmlOptions {
  /** The bundle's script, `dist/webview/<bundle>.js`, as text. */
  script: string;
  /** The bundle's stylesheet, `dist/webview/<bundle>.css`, as text. */
  style: string;
  /** The document title. */
  title: string;
}

/** The policy for a given nonce. */
export function workspaceViewCsp(nonce: string): string {
  return [
    `default-src 'none'`,
    `script-src 'nonce-${nonce}'`,
    `style-src 'unsafe-inline'`,
    `img-src blob: http: https:`,
  ].join('; ');
}

/** A fresh nonce: 18 random bytes, base64 (24 characters, no padding). */
function createNonce(): string {
  return randomBytes(18).toString('base64');
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Rewrite each `<` the `pattern` finds (by lookahead) as `escape`, an escape the content's own
 * language reads as `<`, so the text cannot end its element early. A backslash run before the `<`
 * is kept when its length is even (the backslashes are literal) and loses its last backslash when
 * odd (that one escaped the `<`, which `escape` now spells).
 */
function escapeLessThan(text: string, pattern: string, escape: string): string {
  return text.replace(new RegExp(`(\\\\*)<(?=${pattern})`, 'gi'), (_match, run: string) => run.slice(0, run.length - (run.length % 2)) + escape);
}

/**
 * Script text safe inside `<script>`: `</script` would end the element, and `<!--` can put the
 * parser where a later `</script>` no longer does. `\x3C` is `<` in a JavaScript string, template
 * or regular expression (the `u` flag included); the bundle has these only there and in comments.
 */
export function inlineScriptText(script: string): string {
  return escapeLessThan(script, '!--|/script', '\\x3C');
}

/** Stylesheet text safe inside `<style>`: `</style` would end the element. `\3C ` is `<` in CSS. */
export function inlineStyleText(style: string): string {
  return escapeLessThan(style, '/style', '\\3C ');
}

/** The webview document, with a fresh nonce bound into the policy and the script. */
export function renderWorkspaceViewHtml(opts: WorkspaceViewHtmlOptions): string {
  const nonce = createNonce();
  const csp = workspaceViewCsp(nonce);
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>${inlineStyleText(opts.style)}</style>
  <title>${escapeAttribute(opts.title)}</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">${inlineScriptText(opts.script)}</script>
</body>
</html>`;
}
