import type * as vscode from 'vscode';

/**
 * Debounce delay for the search input (ms). Matches the value documented
 * in the issue body and the plan's acceptance criteria. Exported as a
 * named constant so the sentinel test can pin it without grepping.
 */
export const SEARCH_DEBOUNCE_MS = 150;

export interface SearchHtmlOptions {
  /** Per-instance nonce so the CSP can disable inline scripts globally. */
  nonce: string;
  /** Placeholder copy inside the input. E.g. `"Search backlog..."`. */
  placeholder: string;
}

/**
 * Render the HTML document for an embedded sidebar search webview (#891).
 *
 * Pure function — takes the `Webview` (for `cspSource`) and an options
 * bag, returns the full document string. Kept separate from
 * `search-view.ts` so unit tests can assert the rendered shape (CSP,
 * theme variables, debounce constant, message handlers) without
 * mocking the entire `vscode` namespace.
 *
 * This is the first webview shipped in the Codev extension. The CSP +
 * nonce + `--vscode-input-*` theme-variable scaffold here is intended
 * to be the template later webviews (#807 Reader View, #861-#863
 * preview-pane enhancements) copy from.
 *
 * One renderer covers both the backlog and builders search views (#891
 * landed two independent per-view inputs, not a shared one) — only the
 * placeholder copy differs, which `placeholder` parameterizes.
 */
export function renderSearchHtml(webview: vscode.Webview, opts: SearchHtmlOptions): string {
  const { nonce, placeholder } = opts;
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Codev Search</title>
  <style>
    body {
      padding: 4px 8px 8px;
      margin: 0;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    #q {
      width: 100%;
      box-sizing: border-box;
      padding: 4px 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder, transparent));
      border-radius: 2px;
      outline: none;
      font-family: inherit;
      font-size: inherit;
    }
    #q::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    #q:focus {
      border-color: var(--vscode-focusBorder);
    }
    #summary {
      margin-top: 4px;
      min-height: 1.2em;
      color: var(--vscode-descriptionForeground);
      font-size: calc(var(--vscode-font-size) - 1px);
    }
  </style>
</head>
<body>
  <input id="q" type="text" placeholder="${escapeHtml(placeholder)}" autocomplete="off" spellcheck="false" />
  <div id="summary"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const input = document.getElementById('q');
    const summary = document.getElementById('summary');
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        vscode.postMessage({ type: 'query', value: input.value });
      }, ${SEARCH_DEBOUNCE_MS});
    });
    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg && msg.type === 'summary') {
        summary.textContent = msg.text || '';
      }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

/**
 * Generate a 32-char nonce from random bytes. Kept here (rather than a
 * shared helper) since the only consumer is the search view; later
 * webviews can either share this or generate their own.
 */
export function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/** Escape an attribute value (placeholder) to keep injection out of the HTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
