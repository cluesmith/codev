/**
 * Codev Markdown Preview (#859) — a read-only `CustomTextEditor` that renders a
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
 * - The host posts the **raw** document text and parses markers via `parseReviewMarkers`
 *   (from `@cluesmith/codev-core/review-markers`); the canvas renderer strips full-line
 *   REVIEW/comment lines itself before block parsing (the #1036/#1042 fix), so the host no
 *   longer pre-hides them. The shared core codec means this surface and the editor
 *   Comments-API path write/parse identical bytes.
 * - Content + markers are pushed into the webview, which mounts `<ArtifactCanvas>`
 *   (see `webview/main.ts`). The canvas's inline composer (#1107) collects the
 *   comment body and emits an `addComment` intent carrying `{ line, text }`; the
 *   host writes the marker with a `WorkspaceEdit`. The document change re-pushes —
 *   the round-trip goes through the file text, matching the package's design.
 *   (Pre-#1107 the host collected the body via a center-top `showInputBox`.)
 *
 * Registered with `priority: "option"` so it never replaces the default `.md`
 * editor or the built-in preview; it is opt-in via "Reopen With…" or the
 * `codev.openMarkdownPreview` command.
 */

import * as vscode from 'vscode';
import {
  serializeReviewMarker,
  markerAppendLine,
  parseReviewMarkers,
} from '@cluesmith/codev-core/review-markers';
import { renderMarkdownPreviewHtml } from './preview-template.js';
import type { HostToWebviewMessage, WebviewToHostMessage } from './messages.js';
import type { OverviewCache } from '../views/overview-data.js';

export class MarkdownPreviewProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'codev.markdownPreview';

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

    // Live-reflow on a typography settings change (#1053, Tier 3): re-render the document so the
    // new `--codev-canvas-*` overrides take effect without the reviewer reopening the preview.
    // The webview re-sends `ready`, which re-pushes the current content + markers.
    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codev.markdownPreview')) {
        panel.webview.html = this.renderHtml(panel.webview);
      }
    });
    panel.onDidDispose(() => configSub.dispose());

    const pushUpdate = (): void => {
      // Send the raw document text: the canvas renderer strips REVIEW/comment lines itself
      // (and keeps blocks intact + data-line accurate), so the host no longer pre-hides them.
      const text = document.getText();
      const message: HostToWebviewMessage = {
        type: 'update',
        content: text,
        markers: parseReviewMarkers(text),
      };
      panel.webview.postMessage(message);
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) { pushUpdate(); }
    });
    panel.onDidDispose(() => changeSub.dispose());

    panel.webview.onDidReceiveMessage((msg: unknown) => {
      if (!msg || typeof msg !== 'object') { return; }
      // Untrusted input from the webview: cast to the protocol union for the discriminant, but still
      // validate the `addComment` payload fields at runtime before acting on them.
      const m = msg as WebviewToHostMessage;
      if (m.type === 'ready') { pushUpdate(); return; }
      if (m.type === 'addComment' && typeof m.line === 'number' && typeof m.text === 'string') {
        this.addComment(document, m.line, m.text);
      }
    });
  }

  /**
   * Write the marker for a comment the inline composer collected (host side of D6, #1107). The
   * body arrives with the `addComment` message — the canvas's composer replaced the old
   * `showInputBox` (#1107), so there is no host-side text prompt anymore.
   */
  private async addComment(document: vscode.TextDocument, line: number, text: string): Promise<void> {
    if (!text.trim()) { return; }
    const author = this.overviewCache.getData()?.currentUser ?? 'architect';
    const indent =
      line < document.lineCount
        ? (document.lineAt(line).text.match(/^\s*/)?.[0] ?? '')
        : '';
    const edit = new vscode.WorkspaceEdit();
    // Append below any markers already stacked on this block so the new comment lands where the
    // inline composer appeared (in-flow below the existing cards), not at the top of the thread
    // (#1107). markerInsertionLine alone (line+1) would prepend ahead of an existing run.
    edit.insert(
      document.uri,
      new vscode.Position(markerAppendLine(document.getText(), line), 0),
      serializeReviewMarker(author, text, indent) + '\n',
    );
    await vscode.workspace.applyEdit(edit);
    await document.save();
    // The resulting document change fires onDidChangeTextDocument -> pushUpdate.
  }

  private renderHtml(webview: vscode.Webview): string {
    const asUri = (file: string): string =>
      webview
        .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', file))
        .toString();
    // User typography overrides (#1053, Tier 3). 0 = "use the built-in github-baseline default".
    const cfg = vscode.workspace.getConfiguration('codev.markdownPreview');
    return renderMarkdownPreviewHtml({
      cspSource: webview.cspSource,
      scriptUri: asUri('markdown-preview.js'),
      styleUri: asUri('markdown-preview.css'),
      fontSizePx: cfg.get<number>('fontSize', 0),
      lineHeight: cfg.get<number>('lineHeight', 0),
    });
  }
}
