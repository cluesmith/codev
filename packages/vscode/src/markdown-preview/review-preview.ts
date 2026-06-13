/**
 * Codev Review Preview (#859) — a read-only `CustomTextEditor` that renders a
 * spec/plan/review in the shared `@cluesmith/codev-artifact-canvas` surface and
 * lets a reviewer add a comment without dropping to the raw `.md` editor.
 *
 * Why a custom editor instead of extending VS Code's built-in markdown preview:
 * the built-in preview is a webview we don't own, and it exposes no channel for
 * an injected script to message the extension host (verified — see issue #859
 * comment #4586600146). So we render the markdown ourselves in a webview we own,
 * which is exactly what the artifact-canvas package is for.
 *
 * Architecture (host side of the package's adapter contract):
 * - The host reads `document.getText()`, hides markers for rendering via the
 *   shared `stripMarkersForRender` (the #1036 fix), and parses markers via
 *   `parseReviewMarkers`. Both come from `@cluesmith/codev-core/review-markers`,
 *   so this surface and the editor Comments-API path write/parse identical bytes.
 * - Content + markers are pushed into the webview, which mounts `<ArtifactCanvas>`
 *   (see `webview/main.ts`). The canvas emits an `addComment` intent; the host
 *   collects the text via `showInputBox` and writes the marker with a
 *   `WorkspaceEdit`. The document change re-pushes — the round-trip goes through
 *   the file text, matching the package's design.
 *
 * Registered with `priority: "option"` so it never replaces the default `.md`
 * editor or the built-in preview; it is opt-in via "Reopen With…" or the
 * `codev.openReviewCanvas` command.
 */

import * as vscode from 'vscode';
import {
  serializeReviewMarker,
  markerInsertionLine,
  parseReviewMarkers,
  stripMarkersForRender,
} from '@cluesmith/codev-core/review-markers';
import type { OverviewCache } from '../views/overview-data.js';

export class ReviewPreviewProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'codev.reviewPreview';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly overviewCache: OverviewCache,
  ) {}

  public resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): void {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    panel.webview.html = this.renderHtml(panel.webview);

    const pushUpdate = (): void => {
      const text = document.getText();
      panel.webview.postMessage({
        type: 'update',
        content: stripMarkersForRender(text),
        markers: parseReviewMarkers(text),
      });
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) { pushUpdate(); }
    });
    panel.onDidDispose(() => changeSub.dispose());

    panel.webview.onDidReceiveMessage((msg: unknown) => {
      if (!msg || typeof msg !== 'object') { return; }
      const m = msg as { type?: string; line?: number };
      if (m.type === 'ready') { pushUpdate(); return; }
      if (m.type === 'addComment' && typeof m.line === 'number') {
        void this.addComment(document, m.line);
      }
    });
  }

  /** Collect comment text from the user and write the marker (host side of D6). */
  private async addComment(document: vscode.TextDocument, line: number): Promise<void> {
    const text = await vscode.window.showInputBox({
      prompt: 'Add review comment',
      placeHolder: 'Type your review comment, then Enter to submit',
    });
    if (!text) { return; }
    const author = this.overviewCache.getData()?.currentUser ?? 'architect';
    const indent =
      line < document.lineCount
        ? (document.lineAt(line).text.match(/^\s*/)?.[0] ?? '')
        : '';
    const edit = new vscode.WorkspaceEdit();
    edit.insert(
      document.uri,
      new vscode.Position(markerInsertionLine(line), 0),
      serializeReviewMarker(author, text, indent) + '\n',
    );
    await vscode.workspace.applyEdit(edit);
    await document.save();
    // The resulting document change fires onDidChangeTextDocument -> pushUpdate.
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'review-canvas.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'review-canvas.css'),
    );
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `font-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <style>
    html, body { background: var(--vscode-editor-background); margin: 0; padding: 0 14px; }
    /* Bind the canvas tokens to the active VS Code theme (package Model A). */
    .codev-artifact-canvas {
      --codev-canvas-foreground: var(--vscode-foreground);
      --codev-canvas-background: var(--vscode-editor-background);
      --codev-canvas-accent: var(--vscode-textLink-foreground);
      --codev-canvas-border: var(--vscode-panel-border);
      --codev-canvas-muted: var(--vscode-descriptionForeground);
      --codev-canvas-code-background: var(--vscode-textCodeBlock-background);
      --codev-canvas-link: var(--vscode-textLink-foreground);
      --codev-canvas-comment-marker: var(--vscode-editorWarning-foreground);
      color: var(--codev-canvas-foreground);
      background: var(--codev-canvas-background);
    }
  </style>
  <title>Codev Review Preview</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
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
