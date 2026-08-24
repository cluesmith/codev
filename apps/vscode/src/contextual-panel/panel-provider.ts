/**
 * WebviewViewProvider for the contextual `Codev` bottom-panel tab — the extension's first webview
 * *view*.
 *
 * It resolves the active surface (via `SurfaceContextReader` + the pure `resolveMode`) on each
 * trigger event and posts the resulting `ModeDescriptor` to the webview, which renders it. To keep
 * the switch path O(1)-cheap and avoid churn, it re-posts only when the resolved surface *identity*
 * changes (a cursor move that leaves the surface unchanged posts nothing).
 *
 * Visibility: the view is registered with `retainContextWhenHidden: true`, so its context persists
 * while hidden and `resolveWebviewView` is NOT called again on re-show. The provider therefore caches
 * the last descriptor and re-posts it on `onDidChangeVisibility` when the view becomes visible, so a
 * surface change made while the panel was collapsed reaches the reopened panel.
 *
 * Transient pill navigation (a `ManualSelection` fed into `resolveMode`) arrives in Phase 4.
 */

import * as vscode from 'vscode';
import type { TerminalManager } from '../terminal-manager.js';
import { onDidChangeDiffInjectRegistry } from '../diff-inject-codelens.js';
import { resolveMode } from './resolver.js';
import { surfaceIdentity } from './surface-context.js';
import { SurfaceContextReader } from './surface-reader.js';
import { renderContextualPanelHtml } from './panel-template.js';
import { isReadyMessage, type HostToWebviewMessage } from './messages.js';
import type { ModeDescriptor } from './types.js';

export class ContextualPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codev.contextualPanel';

  private view: vscode.WebviewView | undefined;
  private lastDescriptor: ModeDescriptor | undefined;
  private readonly reader: SurfaceContextReader;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    terminalManager: TerminalManager,
  ) {
    this.reader = new SurfaceContextReader(() => terminalManager.getActiveBuilderId());
    this.disposables.push(
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        if (terminal !== undefined) {
          this.reader.noteTerminalFocused();
        }
        this.refresh();
      }),
      // Cursor moves fire this frequently, but `refresh` only posts on an identity change, so a
      // move within the same surface is cheap and does not re-render.
      vscode.window.onDidChangeTextEditorSelection(() => {
        this.reader.noteEditorFocused();
        this.refresh();
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => {
        this.reader.noteEditorFocused();
        this.refresh();
      }),
      vscode.window.tabGroups.onDidChangeTabGroups(() => {
        this.reader.noteEditorFocused();
        this.refresh();
      }),
      // The diff-inject registry populates AFTER the diff editor activates, so a diff's builder id
      // is only knowable once this fires.
      onDidChangeDiffInjectRegistry(() => this.refresh()),
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((message) => this.onMessage(message)),
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.repost();
        }
      }),
    );

    this.resolveAndPost();
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private onMessage(message: unknown): void {
    // The webview mounts and asks for the current descriptor. (Phase 4 adds navigation messages.)
    if (isReadyMessage(message)) {
      this.repost();
    }
  }

  /** Re-resolve the active surface and post only if the resolved identity changed. */
  private refresh(): void {
    const descriptor = resolveMode(this.reader.read(), null);
    const previousId = this.lastDescriptor === undefined ? undefined : surfaceIdentity(this.lastDescriptor);
    this.lastDescriptor = descriptor;
    if (surfaceIdentity(descriptor) !== previousId) {
      this.post(descriptor);
    }
  }

  private resolveAndPost(): void {
    const descriptor = resolveMode(this.reader.read(), null);
    this.lastDescriptor = descriptor;
    this.post(descriptor);
  }

  private repost(): void {
    if (this.lastDescriptor === undefined) {
      this.resolveAndPost();
      return;
    }
    this.post(this.lastDescriptor);
  }

  private post(descriptor: ModeDescriptor): void {
    const message: HostToWebviewMessage = { type: 'render', descriptor };
    void this.view?.webview.postMessage(message);
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
