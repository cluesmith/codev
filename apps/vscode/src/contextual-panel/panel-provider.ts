/**
 * WebviewViewProvider for the contextual `Codev` bottom-panel tab — the extension's first webview
 * *view*.
 *
 * It resolves the active surface (via `SurfaceContextReader` + the pure `resolveMode`, plus an
 * optional transient `ManualSelection` from pill navigation) on each trigger event and posts the
 * resulting `ModeDescriptor` to the webview. To keep the switch path O(1)-cheap it posts only when
 * the render would change (surface key + selection + descriptor + summary ids); a cursor move within
 * one surface posts nothing.
 *
 * Transient navigation: clicking a pill / drilling into a summary row sets an in-memory
 * `ManualSelection` (NEVER persisted). Any real active-surface change — a change in the raw surface
 * key — clears it, so the panel returns to following context.
 *
 * Focus: the last-focused surface (editor vs terminal) drives the terminal-exit. It flips to
 * `terminal` on `onDidChangeActiveTerminal` and to `editor` on an editor selection, an active-editor
 * change, or a genuine tab *activation* (not background tab churn).
 *
 * Visibility: registered with `retainContextWhenHidden: true`; the provider caches the last
 * descriptor and re-posts it on `onDidChangeVisibility` so a change made while hidden reaches the
 * reopened panel.
 */

import * as vscode from 'vscode';
import type { TerminalManager } from '../terminal-manager.js';
import type { ReviewQueueStore } from '../review-queue/store.js';
import type { OverviewCache } from '../views/overview-data.js';
import { onDidChangeDiffInjectRegistry } from '../diff-inject-codelens.js';
import { resolveMode } from './resolver.js';
import { SurfaceContextReader } from './surface-reader.js';
import { renderContextualPanelHtml } from './panel-template.js';
import { isReadyMessage, parseNavigation, type HostToWebviewMessage } from './messages.js';
import type { ManualSelection, ModeDescriptor, ModeKind } from './types.js';

interface Summary {
  builderIds: string[];
}

export class ContextualPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codev.contextualPanel';

  private view: vscode.WebviewView | undefined;
  private lastDescriptor: ModeDescriptor | undefined;
  private lastPostId: string | undefined;
  private lastSurfaceKey: string | undefined;
  private lastTabResource: string | undefined;
  private selection: ManualSelection | null = null;
  private readonly reader: SurfaceContextReader;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly viewDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    terminalManager: TerminalManager,
    private readonly reviewQueueStore: ReviewQueueStore,
    private readonly overviewCache: OverviewCache,
  ) {
    this.reader = new SurfaceContextReader(() => terminalManager.getActiveBuilderId());
    this.disposables.push(
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        if (terminal !== undefined) {
          this.reader.noteTerminalFocused();
        }
        this.evaluate('surface');
      }),
      // The terminal-exit proxy, gated to the active editor so a background editor's programmatic
      // selection does not demote a focused terminal. Residual (accepted per spec): some focus
      // returns fire nothing.
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          this.reader.noteEditorFocused();
        }
        this.evaluate('surface');
      }),
      // The active editor can change without a tab change when navigating between files inside a
      // multi-file diff (`vscode.changes`).
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor !== undefined) {
          this.reader.noteEditorFocused();
        }
        this.evaluate('surface');
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => this.onTabEvent()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.onTabEvent()),
      onDidChangeDiffInjectRegistry(() => this.evaluate('surface')),
      // A summary's builder-id list can change under the panel; re-post if it does.
      this.reviewQueueStore.onDidChangeQueue(() => this.evaluate('surface')),
      this.overviewCache.onDidChange(() => this.evaluate('surface')),
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
    );

    // Seed focus/transition state, then force the current descriptor to the fresh webview.
    this.lastTabResource = this.reader.activeTabResource();
    this.lastPostId = undefined;
    this.lastSurfaceKey = undefined;
    this.evaluate('surface');
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
      this.reader.noteEditorFocused();
    }
    this.evaluate('surface');
  }

  private onMessage(message: unknown): void {
    if (isReadyMessage(message)) {
      this.repost();
      return;
    }
    const navigation = parseNavigation(message, (id) => this.isKnownBuilder(id));
    if (navigation === null) {
      return;
    }
    if (navigation.type === 'mode-navigate') {
      this.selection = this.selectionForNavigate(navigation.mode);
    } else {
      this.selection = { mode: navigation.mode, builderId: navigation.builderId };
    }
    this.evaluate('manual');
  }

  /**
   * The transient selection for a pill click. Clicking the mode you are already in at DETAIL zooms
   * out to its summary. Otherwise, first-navigating to a builder-scoped mode while viewing a worktree
   * artifact scopes to that artifact's builder (architect note A2 — richer context for free); with no
   * such builder in scope it lands on the summary.
   */
  private selectionForNavigate(mode: ModeKind): ManualSelection {
    const current = this.lastDescriptor;
    const zoomingOut = current !== undefined && current.kind === mode && current.level === 'detail';
    if (!zoomingOut && (mode === 'code-review' || mode === 'builder-inspector')) {
      const builderId = this.reader.read().context.artifact?.builderId;
      if (builderId !== undefined) {
        return { mode, builderId };
      }
    }
    return { mode };
  }

  /**
   * Resolve and post. `surface` events clear the transient selection when the raw surface key
   * changes; `manual` events (pill navigation) keep the selection they just set.
   */
  private evaluate(source: 'surface' | 'manual'): void {
    const { context, key } = this.reader.read();
    if (source === 'surface' && key !== this.lastSurfaceKey) {
      this.selection = null;
    }
    this.lastSurfaceKey = key;

    const descriptor = resolveMode(context, this.selection);
    const summary = this.summaryFor(descriptor);
    this.lastDescriptor = descriptor;

    const postId = [
      key,
      this.selection === null ? 'ctx' : 'sel',
      descriptor.kind,
      descriptor.level,
      descriptor.context.builderId ?? '',
      descriptor.context.resourcePath ?? '',
      summary === undefined ? '' : summary.builderIds.join(','),
    ].join('|');
    if (postId !== this.lastPostId) {
      this.lastPostId = postId;
      this.post(descriptor, summary);
    }
  }

  private repost(): void {
    if (this.lastDescriptor === undefined) {
      this.evaluate('surface');
      return;
    }
    this.post(this.lastDescriptor, this.summaryFor(this.lastDescriptor));
  }

  /** Minimal summary stub: the builder ids the two builder-scoped summaries list (umbrella scope —
   *  rich per-row content is owned by the participating features). */
  private summaryFor(descriptor: ModeDescriptor): Summary | undefined {
    if (descriptor.level !== 'summary') {
      return undefined;
    }
    if (descriptor.kind === 'code-review') {
      return { builderIds: this.reviewQueueStore.buildersWithPending() };
    }
    if (descriptor.kind === 'builder-inspector') {
      return { builderIds: this.overviewBuilderIds() };
    }
    return undefined;
  }

  private overviewBuilderIds(): string[] {
    return this.overviewCache.getData()?.builders.map((builder) => builder.id) ?? [];
  }

  private isKnownBuilder(id: string): boolean {
    return this.overviewBuilderIds().includes(id) || this.reviewQueueStore.buildersWithPending().includes(id);
  }

  private post(descriptor: ModeDescriptor, summary: Summary | undefined): void {
    const message: HostToWebviewMessage = { type: 'render', descriptor, summary };
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
