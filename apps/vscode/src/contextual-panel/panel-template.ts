/**
 * HTML document for the contextual panel webview view.
 *
 * Mirrors the markdown-preview / backlog-search template split: pure string-building with a
 * fresh per-render nonce bound into both the CSP and the script tag. The provider resolves the
 * webview-relative script/style URIs and the CSP source; this assembles the document.
 */

export interface ContextualPanelHtmlOptions {
  /** `webview.cspSource` — the origin the webview may load styles/images/fonts from. */
  cspSource: string;
  /** `asWebviewUri(...)` for the bundled script (contextual-panel.js), stringified. */
  scriptUri: string;
  /** `asWebviewUri(...)` for the bundled stylesheet (contextual-panel.css), stringified. */
  styleUri: string;
}

/** Build the full webview document with a fresh nonce bound into the CSP and the script tag. */
export function renderContextualPanelHtml(opts: ContextualPanelHtmlOptions): string {
  const nonce = getNonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${opts.cspSource} https: data:`,
    `font-src ${opts.cspSource}`,
    `style-src ${opts.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${opts.styleUri}" rel="stylesheet" />
  <title>Codev</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${opts.scriptUri}"></script>
</body>
</html>`;
}

/** CSP nonce — a fresh 32-char token per render (mirrors the markdown-preview webview). */
function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
