/**
 * WebviewViewProvider for the contextual `Codev` bottom-panel tab — the first webview *view* in
 * the extension (existing webviews are a custom editor and a floating panel).
 *
 * Phase 2 renders a static shell (header + pills + empty body). The context adapter, resolver
 * wiring, and host<->webview messaging arrive in Phase 3; the descriptor cache + re-post on
 * visibility change (a hidden webview cannot receive messages, and `resolveWebviewView` re-fires
 * on re-show) land with that message flow.
 */

import * as vscode from 'vscode';
import { renderContextualPanelHtml } from './panel-template.js';

export class ContextualPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codev.contextualPanel';

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);
  }

  private buildHtml(webview: vscode.Webview): string {
    const asset = (file: string): string =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', file)).toString();
    return renderContextualPanelHtml({
      cspSource: webview.cspSource,
      scriptUri: asset('contextual-panel.js'),
      styleUri: asset('contextual-panel.css'),
    });
  }
}
