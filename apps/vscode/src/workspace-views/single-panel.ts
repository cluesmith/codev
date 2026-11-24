/**
 * What the Work and Decisions panels have in common (Spec 1963): each is one editor-area webview
 * panel per window, for this window's workspace.
 *
 * - **One per window.** Opening it again reveals it where it is, and never creates a second one or
 *   reloads the first. Where it is not offered (`availability.ts`) its command says why instead.
 * - **Restored after a reload** through its serializer. A second restored panel, or one restored
 *   where the panel is not offered, is closed. VS Code revives a restored panel only when its tab is
 *   shown, so until then the tab has no panel behind it: opening the panel then puts the live one in
 *   that tab's group and closes the restored tab, rather than leaving two.
 * - **Retained.** `retainContextWhenHidden` keeps the webview's state (a Decisions draft) while the
 *   panel is hidden or moved between groups.
 * - **Its visibility is observable** (`visible`, `onDidChangeVisibility`), so a panel can count
 *   toward the periodic overview refresh as the sidebar's views do.
 *
 * A `PanelSession` is one panel's webview from creation until it is closed: it answers the
 * webview's messages and drops any reply that lands after the panel closed.
 */

import * as vscode from 'vscode';
import { renderWorkspaceViewHtml } from './panel-template.js';
import { isAllowedExternalUrl } from './security.js';

/** What every panel is given. */
export interface SinglePanelOptions {
  extensionUri: vscode.Uri;
  /** Why the panel is not offered in this window (`availability.ts`), or null when it is. */
  unavailableReason: () => string | null;
  log: (line: string) => void;
}

/** Where *Arrange Cockpit* puts a panel: its editor group, and whether focus stays where it is. */
export interface PanelPlacement {
  viewColumn: vscode.ViewColumn;
  preserveFocus: boolean;
}

/** Which panel: its restore type, its title, and its bundle `dist/webview/<bundle>.{js,css}`. */
export interface PanelKind {
  viewType: string;
  title: string;
  bundle: string;
}

/**
 * Whether an editor tab is a panel of this view type. VS Code's tab model reports an extension's
 * webview panel type with its internal `mainThreadWebview-` prefix (1.147.0), so both forms match.
 */
export function isPanelTab(tab: vscode.Tab, viewType: string): boolean {
  return tab.input instanceof vscode.TabInputWebview
    && (tab.input.viewType === viewType || tab.input.viewType === `mainThreadWebview-${viewType}`);
}

/** What the webview may load: the bundle under `dist`, and nothing else from the extension. */
function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')] };
}

/** The window's one panel of a kind, and its serializer. */
export abstract class SingleWebviewPanel implements vscode.WebviewPanelSerializer, vscode.Disposable {
  private current: vscode.WebviewPanel | undefined;
  /** The open panel's listeners, kept until the panel closes or this is disposed. */
  private panelSubscriptions: vscode.Disposable[] = [];
  /** Whether the tab-model canary ({@link checkTabModel}) has warned in this window session. */
  private warnedNoTab = false;
  private readonly visibilityEmitter = new vscode.EventEmitter<void>();
  /** Fires when the panel opens, closes, or is shown or hidden. */
  readonly onDidChangeVisibility = this.visibilityEmitter.event;

  protected constructor(private readonly kind: PanelKind, private readonly base: SinglePanelOptions) {}

  /**
   * Reveal the panel where it is, or open it in the active editor group. Where it is not offered, say
   * why. With a `placement` (*Arrange Cockpit*) it is moved to, or opened in, that group instead; the
   * same panel is moved, never closed and reopened, so its webview keeps its state.
   *
   * A tab restored by a reload and not yet revived has no state to keep: the new panel opens in its
   * group (or at the placement), and the restored tab is closed after it, so the window never shows
   * two. It is closed after the new panel opens, so its group is never left empty and closed.
   */
  show(placement?: PanelPlacement): void {
    const reason = this.base.unavailableReason();
    if (reason) {
      void vscode.window.showInformationMessage(reason);
      return;
    }
    if (this.current) {
      if (placement) {
        this.current.reveal(placement.viewColumn, placement.preserveFocus);
      } else {
        this.current.reveal();
      }
      return;
    }
    const restored = this.tabs;
    const panel = vscode.window.createWebviewPanel(
      this.kind.viewType,
      this.kind.title,
      placement ?? restored[0]?.group.viewColumn ?? vscode.ViewColumn.Active,
      { ...webviewOptions(this.base.extensionUri), retainContextWhenHidden: true },
    );
    this.adopt(panel);
    for (const tab of restored) { void vscode.window.tabGroups.close(tab); }
  }

  /** The panel, if one is open. */
  get panel(): vscode.WebviewPanel | undefined {
    return this.current;
  }

  /** The open panel's editor tab: whether it is a preview tab, and whether it is active. */
  get tab(): vscode.Tab | undefined {
    const column = this.current?.viewColumn;
    return column === undefined ? undefined : this.tabs.find(tab => tab.group.viewColumn === column);
  }

  /** Whether the panel is open and on screen. */
  get visible(): boolean {
    return this.current?.visible ?? false;
  }

  /**
   * A window reload restores an open panel in its group. Webview state is not restored (a Decisions
   * draft, as a dashboard page reload loses it too). A second panel, or one in a window where the
   * panel is not offered, is closed.
   */
  async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
    if (this.current || this.base.unavailableReason()) {
      panel.dispose();
      return;
    }
    panel.webview.options = webviewOptions(this.base.extensionUri);
    this.adopt(panel);
  }

  dispose(): void {
    for (const subscription of this.panelSubscriptions) { subscription.dispose(); }
    this.panelSubscriptions = [];
    this.visibilityEmitter.dispose();
  }

  /** Every editor tab of this kind: the open panel's, and any restored one not yet revived. */
  get tabs(): vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => isPanelTab(tab, this.kind.viewType));
  }

  /**
   * A canary for {@link isPanelTab}. A panel on screen has an editor tab, so if no tab matches,
   * VS Code has changed how its tab model spells a webview panel's type. Restored tabs are then
   * invisible to `show()`, and a reload can leave two panels with no error. Logged once per window
   * session, from a view-state change, which VS Code sends after the tab change that opened it.
   */
  private checkTabModel(panel: vscode.WebviewPanel): void {
    if (this.warnedNoTab || !panel.visible || this.tabs.length > 0) { return; }
    this.warnedNoTab = true;
    this.base.log(`Warning: the ${this.kind.title} panel is on screen, but no editor tab matches its type "${this.kind.viewType}" (isPanelTab). VS Code may have changed how it reports webview tabs; a ${this.kind.title} tab restored by a reload could then open a second panel.`);
  }

  /** Start the session that answers a new or restored panel's webview. */
  protected abstract attach(panel: vscode.WebviewPanel): void;

  private adopt(panel: vscode.WebviewPanel): void {
    const { webview } = panel;
    const bundle = vscode.Uri.joinPath(this.base.extensionUri, 'dist', 'webview');
    webview.html = renderWorkspaceViewHtml({
      cspSource: webview.cspSource,
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(bundle, `${this.kind.bundle}.js`)).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(bundle, `${this.kind.bundle}.css`)).toString(),
      title: this.kind.title,
    });
    this.current = panel;
    const subscriptions = [
      panel.onDidChangeViewState(() => {
        this.checkTabModel(panel);
        this.visibilityEmitter.fire();
      }),
      panel.onDidDispose(() => {
        if (this.current === panel) { this.current = undefined; }
        for (const subscription of subscriptions) { subscription.dispose(); }
        if (this.panelSubscriptions === subscriptions) { this.panelSubscriptions = []; }
        this.visibilityEmitter.fire();
      }),
    ];
    this.panelSubscriptions = subscriptions;
    this.attach(panel);
    this.visibilityEmitter.fire();
  }
}

/** One panel's webview, from creation until the panel is closed. */
export abstract class PanelSession<HostMessage> {
  private disposed = false;
  private readonly subscriptions: vscode.Disposable[] = [];

  /** `label` names the panel in the log. */
  protected constructor(
    protected readonly panel: vscode.WebviewPanel,
    private readonly label: string,
    private readonly logLine: (line: string) => void,
  ) {
    this.track(
      // A handler that throws (an editor that would not open) is logged, never an unhandled rejection.
      panel.webview.onDidReceiveMessage((message: unknown) => {
        this.onMessage(message).catch((err: unknown) => {
          this.log(`a message from its webview failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }),
      panel.onDidDispose(() => {
        this.disposed = true;
        for (const subscription of this.subscriptions) { subscription.dispose(); }
      }),
    );
  }

  /** Answer one message from the webview. Messages are untrusted: act only on what a guard accepts. */
  protected abstract onMessage(message: unknown): Promise<void>;

  /** Whether the panel has closed: work that finishes after that drops its result. */
  protected get closed(): boolean {
    return this.disposed;
  }

  /** Keep `subscriptions` until the panel closes. */
  protected track(...subscriptions: vscode.Disposable[]): void {
    this.subscriptions.push(...subscriptions);
  }

  /** Post to the webview. A reply that lands after the panel closed has nowhere to go, and is dropped. */
  protected post(message: HostMessage): void {
    if (this.disposed) { return; }
    void this.panel.webview.postMessage(message);
  }

  protected log(line: string): void {
    this.logLine(`${this.label} panel: ${line}`);
  }

  /** Open a link from the webview in the user's browser: http(s) only. */
  protected openExternal(url: string): void {
    if (isAllowedExternalUrl(url)) {
      void vscode.env.openExternal(vscode.Uri.parse(url));
    } else {
      this.log(`did not open ${url}; only http(s) links open from a panel.`);
    }
  }
}
