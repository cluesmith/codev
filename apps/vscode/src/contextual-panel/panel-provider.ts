/**
 * WebviewViewProvider for the contextual `Codev` bottom-panel tab — the extension's first webview
 * *view*, and the sole view in the `codevPanel` container.
 *
 * The panel is purely contextual: it resolves one mode from the active surface (via
 * `SurfaceContextReader` + the pure `resolveMode`) and posts it to the webview, which renders a
 * context label + a per-mode body. There is no manual navigation — no pills, no selection. To keep
 * the switch path O(1)-cheap it posts only when the render would change (surface key + descriptor);
 * a cursor move within one surface posts nothing.
 *
 * Focus: the last-focused surface (editor vs terminal) drives the terminal-exit. It flips to
 * `terminal` on `onDidChangeActiveTerminal` and to `editor` on an editor selection, an active-editor
 * change, or a genuine editor-tab *activation* (not background tab churn, and not activating a
 * terminal that lives in the editor area — that is terminal focus).
 *
 * Visibility: registered with `retainContextWhenHidden: true`; the provider caches the last
 * descriptor and re-posts it on `onDidChangeVisibility` so a change made while hidden reaches the
 * reopened panel.
 */

import * as vscode from 'vscode';
import type { TerminalManager } from '../terminal-manager.js';
import type { OverviewCache } from '../views/overview-data.js';
import { onDidChangeDiffInjectRegistry } from '../diff-inject-codelens.js';
import { resolveMode } from './resolver.js';
import { SurfaceContextReader } from './surface-reader.js';
import { renderContextualPanelHtml } from './panel-template.js';
import { deriveAttention } from './attention.js';
import { isReadyMessage, type HostToWebviewMessage } from './messages.js';
import type { ModeDescriptor } from './types.js';

export class ContextualPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codev.contextualPanel';

  private view: vscode.WebviewView | undefined;
  private lastDescriptor: ModeDescriptor | undefined;
  private lastPostId: string | undefined;
  private lastTabResource: string | undefined;
  private readonly reader: SurfaceContextReader;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly viewDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    terminalManager: TerminalManager,
    private readonly overviewCache: OverviewCache,
  ) {
    this.reader = new SurfaceContextReader(() => terminalManager.getActiveBuilderId());
    this.disposables.push(
      // Attention is fed by the overview cache; when it refreshes (SSE tick) re-post so the body
      // tracks live state. Only while the panel is actually showing Attention — other modes ignore
      // the cache, so this posts nothing extra for them.
      this.overviewCache.onDidChange(() => {
        if (this.lastDescriptor?.kind === 'attention') {
          this.repost();
        }
      }),
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        if (terminal !== undefined) {
          this.reader.noteTerminalFocused();
        }
        this.refresh();
      }),
      // The terminal-exit proxy: interacting with an editor (cursor move / click into it) means the
      // editor is focused. Gate on the ACTIVE editor so a programmatic selection in a background
      // visible editor does not demote a focused builder terminal. Residual (accepted): some focus
      // returns fire nothing.
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          this.reader.noteEditorFocused();
        }
        this.refresh();
      }),
      // The active editor changes without a tab change when navigating between files inside a
      // multi-file diff (`vscode.changes`). It also fires with `undefined` as focus leaves the editor —
      // the only signal for re-entering an already-active builder terminal (which fires no
      // onDidChangeActiveTerminal), so that path re-activates Builder Inspector.
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor !== undefined) {
          this.reader.noteEditorFocused();
        } else if (this.reader.terminalFocusLikely()) {
          this.reader.noteTerminalFocused();
        }
        this.refresh();
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => this.onTabEvent()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.onTabEvent()),
      onDidChangeDiffInjectRegistry(() => this.refresh()),
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.disposeViewListeners();
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    this.viewDisposables.push(
      webviewView.webview.onDidReceiveMessage((message) => this.onMessage(message)),
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.repost();
        }
      }),
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = undefined;
        }
      }),
    );

    // Seed the active-tab resource so the first tab event that is mere background churn is not
    // mistaken for an activation. The webview is fresh, so force the current descriptor to it.
    this.lastTabResource = this.reader.activeTabResource();
    this.lastPostId = undefined;
    this.refresh();
  }

  dispose(): void {
    this.disposeViewListeners();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private disposeViewListeners(): void {
    for (const disposable of this.viewDisposables) {
      disposable.dispose();
    }
    this.viewDisposables.length = 0;
  }

  private onTabEvent(): void {
    // Only a genuine active-tab activation counts as editor focus; background tab churn (dirty /
    // pinned / label) leaves the active tab unchanged and must not demote a focused terminal.
    const tabResource = this.reader.activeTabResource();
    if (tabResource !== this.lastTabResource) {
      this.lastTabResource = tabResource;
      // A terminal that lives in the editor area is a terminal surface, not an editor one — activating
      // it is terminal focus (already tracked by onDidChangeActiveTerminal), so it must not demote a
      // focused builder terminal to Attention.
      if (!this.reader.activeTabIsTerminal()) {
        this.reader.noteEditorFocused();
      }
    }
    this.refresh();
  }

  private onMessage(message: unknown): void {
    // The webview mounts and asks for the current descriptor. (There are no other inbound messages —
    // the panel has no navigation.)
    if (isReadyMessage(message)) {
      this.repost();
    }
  }

  /** Re-resolve the active surface and post only if the render (surface key + descriptor) changed. */
  private refresh(): void {
    const { context, key } = this.reader.read();
    const descriptor = resolveMode(context);
    this.lastDescriptor = descriptor;
    const postId = [key, descriptor.kind, descriptor.context.builderId ?? '', descriptor.context.resourcePath ?? ''].join('|');
    if (postId !== this.lastPostId) {
      this.lastPostId = postId;
      this.post(descriptor);
    }
  }

  private repost(): void {
    if (this.lastDescriptor === undefined) {
      this.refresh();
      return;
    }
    this.post(this.lastDescriptor);
  }

  private post(descriptor: ModeDescriptor): void {
    // Attach the Attention roll-up only in Attention mode, projected fresh from the live cache so a
    // re-post (visibility restore, or an SSE-driven refresh) always reflects current state.
    const attention =
      descriptor.kind === 'attention' ? deriveAttention(this.overviewCache.getData()) : undefined;
    const message: HostToWebviewMessage = { type: 'render', descriptor, attention };
    this.view?.webview.postMessage(message);
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
