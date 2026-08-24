/**
 * WebviewViewProvider for the contextual `Codev` bottom-panel tab — the extension's first webview
 * *view*.
 *
 * It resolves the active surface (via `SurfaceContextReader` + the pure `resolveMode`) on each
 * trigger event and posts the resulting `ModeDescriptor` to the webview, which renders it. To keep
 * the switch path O(1)-cheap and avoid churn, it re-posts only when the *transition id* changes — a
 * raw surface key (which distinguishes two ordinary files that both resolve to Attention) combined
 * with the resolved descriptor (which catches the diff-registry populating on the same tab). A cursor
 * move within one surface changes neither, so it posts nothing.
 *
 * Focus: the last-focused surface (editor vs terminal) drives the terminal-exit. It flips to
 * `terminal` on `onDidChangeActiveTerminal` and to `editor` on an editor selection or a genuine tab
 * *activation* (not background tab churn like dirty/pin/label changes, which must not demote a
 * focused terminal out of Builder Inspector).
 *
 * Visibility: registered with `retainContextWhenHidden: true`, so its context persists while hidden
 * and `resolveWebviewView` is NOT called again on re-show. The provider caches the last descriptor
 * and re-posts it on `onDidChangeVisibility`, so a surface change made while collapsed reaches the
 * reopened panel.
 *
 * Transient pill navigation (a `ManualSelection` fed into `resolveMode`) arrives in Phase 4.
 */

import * as vscode from 'vscode';
import type { TerminalManager } from '../terminal-manager.js';
import { onDidChangeDiffInjectRegistry } from '../diff-inject-codelens.js';
import { resolveMode } from './resolver.js';
import { SurfaceContextReader } from './surface-reader.js';
import { renderContextualPanelHtml } from './panel-template.js';
import { isReadyMessage, type HostToWebviewMessage } from './messages.js';
import type { ModeDescriptor } from './types.js';

export class ContextualPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codev.contextualPanel';

  private view: vscode.WebviewView | undefined;
  private lastDescriptor: ModeDescriptor | undefined;
  private lastTransitionId: string | undefined;
  private lastTabResource: string | undefined;
  private readonly reader: SurfaceContextReader;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly viewDisposables: vscode.Disposable[] = [];

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
      // The terminal-exit proxy: interacting with an editor (cursor move / click into it) means the
      // editor is focused. Gate on the ACTIVE editor so a programmatic selection change in a
      // background visible editor does not demote a focused builder terminal. Residual limitation
      // (accepted per the spec, not engineered around): some focus returns — e.g. clicking into the
      // already-active editor without moving the cursor, or focus paths VS Code emits no event for —
      // fire nothing, so the panel can stay in Builder Inspector until the next real surface change.
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          this.reader.noteEditorFocused();
        }
        this.refresh();
      }),
      // The active text editor changes without a tab change when navigating between files inside a
      // multi-file diff (`vscode.changes`) — whose container tab stays active while its focused
      // sub-file (the active editor) changes. This is the canonical signal for that navigation.
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor !== undefined) {
          this.reader.noteEditorFocused();
        }
        this.refresh();
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => this.onTabEvent()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.onTabEvent()),
      // The diff-inject registry populates AFTER the diff editor activates, so a diff's builder id
      // is only knowable once this fires.
      onDidChangeDiffInjectRegistry(() => this.refresh()),
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    // Guard re-resolve (a non-retained view can resolve more than once): drop the previous view's
    // listeners before re-wiring, so they do not accumulate.
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
    );

    // Seed the active-tab resource so the first tab event that is mere background churn (same active
    // tab) is not mistaken for an activation. The webview is fresh, so force the current descriptor.
    this.lastTabResource = this.reader.activeTabResource();
    this.lastTransitionId = undefined;
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
    // Only a genuine active-tab activation counts as editor focus. Background tab churn (dirty /
    // pinned / label) fires the same event but leaves the active tab unchanged — it must not demote
    // a focused terminal out of Builder Inspector.
    const tabResource = this.reader.activeTabResource();
    if (tabResource !== this.lastTabResource) {
      this.lastTabResource = tabResource;
      this.reader.noteEditorFocused();
    }
    this.refresh();
  }

  private onMessage(message: unknown): void {
    // The webview mounts and asks for the current descriptor. (Phase 4 adds navigation messages.)
    if (isReadyMessage(message)) {
      this.repost();
    }
  }

  /** Re-resolve the active surface and post only if the transition id changed. */
  private refresh(): void {
    const { context, key } = this.reader.read();
    const descriptor = resolveMode(context, null);
    const transitionId = transitionIdOf(key, descriptor);
    this.lastDescriptor = descriptor;
    if (transitionId !== this.lastTransitionId) {
      this.lastTransitionId = transitionId;
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

/** Raw surface key + resolved descriptor. Distinguishes ordinary-file-A vs B (same Attention) AND a
 *  diff whose builder becomes known on the same tab (Attention -> Code Review). */
function transitionIdOf(surfaceKey: string, descriptor: ModeDescriptor): string {
  return [
    surfaceKey,
    descriptor.kind,
    descriptor.context.builderId ?? '',
    descriptor.context.resourcePath ?? '',
  ].join('|');
}
