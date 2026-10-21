/**
 * HTML document for the Codev Markdown Preview webview (#859).
 *
 * Extracted from `preview-provider.ts` so the markup isn't interleaved with the
 * host logic — mirrors the backlog-search webview's template split (#920). Pure
 * string-building: the provider resolves the webview-relative script/style URIs
 * and the CSP source; this builds the document with a fresh per-render nonce.
 */

import { knownCursor, knownHighlight } from './reading-aids.js';

export interface MarkdownPreviewHtmlOptions {
  /** `webview.cspSource` — the origin the webview may load styles/images/fonts from. */
  cspSource: string;
  /** `asWebviewUri(...)` for the bundled React app (`markdown-preview.js`), stringified. */
  scriptUri: string;
  /** `asWebviewUri(...)` for the bundled stylesheet (`markdown-preview.css`), stringified. */
  styleUri: string;
  /**
   * Optional user typography overrides (#1053, Tier 3) from `codev.markdownPreview.*`. Each is
   * emitted as a `--codev-canvas-*` declaration that wins over the package default; an omitted
   * (or zero) value leaves the github-baseline default in place.
   */
  fontSizePx?: number;
  lineHeight?: number;
  /**
   * Persisted reading mode (spec 1380 D4), embedded in the bootstrap HTML because the canvas
   * mounts before the first host message. MUST be pre-validated by the provider
   * (`sanitizeReadingMode`) — only known mode names reach the template; anything else is
   * omitted and the canvas defaults to vertical.
   */
  initialReadingMode?: string;
  /**
   * Reading aids (#1802) from `codev.markdownPreview.hoverHighlight` / `readingCursor`. Emitted
   * as `#root` data attributes only when they name a known value; anything else is omitted and
   * the canvas uses its defaults (line and paragraph, arrow).
   */
  hoverHighlight?: string;
  readingCursor?: string;
}

/** Build the full webview document with a fresh nonce bound into the CSP and the script tag. */
export function renderMarkdownPreviewHtml(opts: MarkdownPreviewHtmlOptions): string {
  const nonce = getNonce();
  const userTokens = buildUserTypographyOverrides(opts);
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
  <style>
    html, body { background: var(--vscode-editor-background); margin: 0; padding: 0 14px; }
    /* Height context (spec 1380, Constraint 3): horizontal mode needs a bounded column height.
       Vertical mode is untouched by these — body overflow stays default, so the page scrolls
       exactly as before; only the mode class (package CSS) consumes the 100% chain. */
    html, body { height: 100%; box-sizing: border-box; }
    #root { height: 100%; }
    /* Bind the canvas color tokens to the active VS Code theme (package Model A). */
    .codev-artifact-canvas {
      --codev-canvas-foreground: var(--vscode-foreground);
      --codev-canvas-background: var(--vscode-editor-background);
      --codev-canvas-accent: var(--vscode-textLink-foreground);
      --codev-canvas-border: var(--vscode-panel-border);
      --codev-canvas-muted: var(--vscode-descriptionForeground);
      /* Inline code pairs VS Code's dedicated preformat tokens (foreground + background are
       * theme-tuned to contrast each other), fixing low-contrast inline code in dark themes
       * (#1053). textPreformat.* — not textCodeBlock.background + the general foreground, which
       * pair poorly because they come from different theme color groups. */
      --codev-canvas-code-background: var(--vscode-textPreformat-background);
      --codev-canvas-code-foreground: var(--vscode-textPreformat-foreground);
      --codev-canvas-link: var(--vscode-textLink-foreground);
      --codev-canvas-comment-marker: var(--vscode-editorWarning-foreground);
      /* Hover reading aid (#1802): the word pill uses the theme's own hover grey. The line band
       * and paragraph tint keep the package defaults, derived from the foreground above. */
      --codev-canvas-hover-word-background: var(--vscode-toolbar-hoverBackground);

      /*
       * Typography (#1053). The split is deliberate, mirroring github-markdown-css's own
       * convention (sans prose, mono code):
       *  - CODE tracks the reviewer's editor font (--vscode-editor-font-family) so fenced
       *    blocks and inline code look like the code they're showing.
       *  - PROSE is intentionally NOT bound to the editor/UI font — it keeps the package's
       *    github-style sans stack at 16px / 1.5. The editor font is frequently a small
       *    monospace, and inheriting it is exactly the cramped, code-tuned baseline this
       *    surface exists to fix. Do not "helpfully" rebind prose to --vscode-editor-font-*.
       *  - Code SIZE is left to the package default (~85% of prose) so code stays proportional
       *    rather than jumping to the editor's absolute point size.
       */
      --codev-canvas-code-font-family: var(--vscode-editor-font-family);
${userTokens}
      color: var(--codev-canvas-foreground);
      background: var(--codev-canvas-background);
    }
    /* Dark themes (#1802 dev-gate feedback): light text at the package's light-tuned strengths
     * reads too faint on a dark background, so the line band and paragraph tint are stronger
     * there. VS Code stamps the theme kind as a class on the webview body. */
    body.vscode-dark .codev-artifact-canvas,
    body.vscode-high-contrast:not(.vscode-high-contrast-light) .codev-artifact-canvas {
      --codev-canvas-hover-line-background: color-mix(in srgb, var(--codev-canvas-foreground) 12%, transparent);
      --codev-canvas-hover-paragraph-background: color-mix(in srgb, var(--codev-canvas-foreground) 6%, transparent);
    }
  </style>
  <title>Codev Markdown Preview</title>
</head>
<body>
  <div id="root"${readingModeAttr(opts.initialReadingMode)}${readingAidAttrs(opts)}></div>
  <script nonce="${nonce}" src="${opts.scriptUri}"></script>
</body>
</html>`;
}

/** The bootstrap `data-reading-mode` attribute. Values are provider-validated mode names, so
 * the interpolation is closed-vocabulary by construction; anything else contributes nothing. */
function readingModeAttr(mode: string | undefined): string {
  if (mode === 'horizontal' || mode === 'vertical') {
    return ` data-reading-mode="${mode}"`;
  }
  return '';
}

/** The bootstrap `data-hover-highlight` / `data-reading-cursor` attributes (#1802). Only known
 * vocabulary values are interpolated (the canonical spelling, not the stored text), so the markup
 * is closed-vocabulary by construction. */
function readingAidAttrs(opts: MarkdownPreviewHtmlOptions): string {
  let out = '';
  const highlight = knownHighlight(opts.hoverHighlight);
  if (highlight) {
    out += ` data-hover-highlight="${highlight}"`;
  }
  const cursor = knownCursor(opts.readingCursor);
  if (cursor) {
    out += ` data-reading-cursor="${cursor}"`;
  }
  return out;
}

/**
 * Build the `--codev-canvas-*` override declarations for the user's `codev.markdownPreview.*`
 * typography settings (#1053, Tier 3). A non-positive / missing value contributes nothing, so
 * the github-baseline package default stays in effect. The values are numeric (validated by the
 * VS Code settings schema), so there is no string interpolation of untrusted input into the CSS.
 */
function buildUserTypographyOverrides(opts: MarkdownPreviewHtmlOptions): string {
  const decls: string[] = [];
  if (typeof opts.fontSizePx === 'number' && opts.fontSizePx > 0) {
    decls.push(`      --codev-canvas-font-size: ${opts.fontSizePx}px;`);
  }
  if (typeof opts.lineHeight === 'number' && opts.lineHeight > 0) {
    decls.push(`      --codev-canvas-line-height: ${opts.lineHeight};`);
  }
  return decls.join('\n');
}

/** CSP nonce — a fresh 32-char token per render (mirrors the backlog-search webview, #920). */
function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
