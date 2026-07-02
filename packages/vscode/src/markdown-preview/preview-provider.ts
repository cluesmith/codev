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
  matchesExpectedMarker,
  rewriteReviewMarkerBody,
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
        return;
      }
      if (
        m.type === 'editComment' &&
        typeof m.markerLine === 'number' &&
        typeof m.expectedAuthor === 'string' &&
        typeof m.expectedBodyPrefix === 'string' &&
        typeof m.newBody === 'string'
      ) {
        editReviewMarker(document, m.markerLine, m.expectedAuthor, m.expectedBodyPrefix, m.newBody, pushUpdate);
        return;
      }
      if (
        m.type === 'deleteComment' &&
        typeof m.markerLine === 'number' &&
        typeof m.expectedAuthor === 'string' &&
        typeof m.expectedBodyPrefix === 'string'
      ) {
        deleteReviewMarker(document, m.markerLine, m.expectedAuthor, m.expectedBodyPrefix, pushUpdate);
        return;
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

/** The message shown when an edit/delete loses the optimistic-concurrency race (#1055). */
const RACE_REFRESH_MESSAGE = 'This comment changed since you opened it — showing the latest.';

/**
 * Optimistic-concurrency guard shared by edit + delete (#1055). Returns the line text at
 * `markerLine` if it is still the expected marker (author + body-prefix); otherwise re-pushes the
 * current document to the webview via `refresh` (so the stale card corrects itself), surfaces a
 * legible info message, and returns `null`. This is what makes a race fail loudly with a refresh
 * rather than silently mutating a different marker. Exported for unit testing.
 */
export function verifyReviewMarker(
  document: vscode.TextDocument,
  markerLine: number,
  expectedAuthor: string,
  expectedBodyPrefix: string,
  refresh: () => void,
): string | null {
  const inRange = markerLine >= 0 && markerLine < document.lineCount;
  const lineText = inRange ? document.lineAt(markerLine).text : '';
  if (!inRange || !matchesExpectedMarker(lineText, expectedAuthor, expectedBodyPrefix)) {
    refresh();
    void vscode.window.showInformationMessage(RACE_REFRESH_MESSAGE);
    return null;
  }
  return lineText;
}

/**
 * Rewrite the marker at `markerLine` with `newBody`, preserving its author (#1055). Verifies the
 * marker still matches first (race-safe); a mismatch refreshes instead of writing. Exported for
 * unit testing; the runtime entry point is the `editComment` message handler.
 */
export async function editReviewMarker(
  document: vscode.TextDocument,
  markerLine: number,
  expectedAuthor: string,
  expectedBodyPrefix: string,
  newBody: string,
  refresh: () => void,
): Promise<void> {
  if (!newBody.trim()) { return; }
  const lineText = verifyReviewMarker(document, markerLine, expectedAuthor, expectedBodyPrefix, refresh);
  if (lineText === null) { return; }
  const rewritten = rewriteReviewMarkerBody(lineText, newBody);
  if (rewritten === null) { return; }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(new vscode.Position(markerLine, 0), new vscode.Position(markerLine, lineText.length)),
    rewritten,
  );
  await vscode.workspace.applyEdit(edit);
  await document.save();
}

/**
 * Delete the marker line at `markerLine` (#1055) — the preview-surface counterpart of the
 * editor-gutter delete. Removes the whole line including its trailing newline after the same
 * race-safe verification. Exported for unit testing.
 */
export async function deleteReviewMarker(
  document: vscode.TextDocument,
  markerLine: number,
  expectedAuthor: string,
  expectedBodyPrefix: string,
  refresh: () => void,
): Promise<void> {
  const lineText = verifyReviewMarker(document, markerLine, expectedAuthor, expectedBodyPrefix, refresh);
  if (lineText === null) { return; }
  const edit = new vscode.WorkspaceEdit();
  const end =
    markerLine + 1 < document.lineCount
      ? new vscode.Position(markerLine + 1, 0)
      : new vscode.Position(markerLine, lineText.length);
  edit.delete(document.uri, new vscode.Range(new vscode.Position(markerLine, 0), end));
  await vscode.workspace.applyEdit(edit);
  await document.save();
}
