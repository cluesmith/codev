/**
 * The HTML document of a Work or Decisions panel webview (Spec 1963), with its Content Security
 * Policy. Pure string building; the panel resolves the webview URIs and the CSP source.
 *
 * The policy admits only what the panels load:
 * - `default-src 'none'` first, so anything not listed is refused. In particular there is no
 *   `connect-src`, so `fetch`, XHR, WebSocket and EventSource fall back to `'none'`: a panel cannot
 *   reach Tower, or anywhere else;
 * - `script-src` is the per-render nonce only: no `'unsafe-inline'`, no `'unsafe-eval'`;
 * - `style-src` adds `'unsafe-inline'`, as the existing webviews do: the shared components set
 *   React `style` attributes (a progress bar's width), which a stricter policy would silently drop.
 *   Inline styles run no code;
 * - `img-src` admits the bundle's own origin, `blob:` (workspace images the host delivers as bytes,
 *   shown as object URLs) and `http:`/`https:` (remote images written in decision items, as the
 *   dashboard loads them).
 */

import { randomBytes } from 'node:crypto';

export interface WorkspaceViewHtmlOptions {
  /** `webview.cspSource`: the origin the bundle's script, stylesheet and images load from. */
  cspSource: string;
  /** `asWebviewUri(...)` of the bundled script, stringified. */
  scriptUri: string;
  /** `asWebviewUri(...)` of the bundled stylesheet, stringified. */
  styleUri: string;
  /** The document title. */
  title: string;
}

/** The policy for a given CSP source and nonce. */
export function workspaceViewCsp(cspSource: string, nonce: string): string {
  return [
    `default-src 'none'`,
    `script-src 'nonce-${nonce}'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `img-src ${cspSource} blob: http: https:`,
  ].join('; ');
}

/** A fresh nonce: 18 random bytes, base64 (24 characters, no padding). */
function createNonce(): string {
  return randomBytes(18).toString('base64');
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The webview document, with a fresh nonce bound into the policy and the script tag. */
export function renderWorkspaceViewHtml(opts: WorkspaceViewHtmlOptions): string {
  const nonce = createNonce();
  const csp = workspaceViewCsp(opts.cspSource, nonce);
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${escapeAttribute(opts.styleUri)}" rel="stylesheet" />
  <title>${escapeAttribute(opts.title)}</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${escapeAttribute(opts.scriptUri)}"></script>
</body>
</html>`;
}
