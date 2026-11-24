/**
 * What the Work and Decisions panels have in common (Spec 1963): each is one editor-area webview
 * panel per window, for this window's workspace.
 *
 * - **One per window.** Opening it again reveals it where it is, and never creates a second one or
 *   reloads the first. Where it is not offered (`availability.ts`) its command says why instead.
 * - **Restored after a reload** through its serializer. A second restored panel, or one restored
 *   where the panel is not offered, is closed.
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

/** Which panel: its restore type, its title, and its bundle `dist/webview/<bundle>.{js,css}`. */
export interface PanelKind {
  viewType: string;
  title: string;
  bundle: string;
}

/** What the webview may load: the bundle under `dist`, and nothing else from the extension. */
function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')] };
}

/** The window's one panel of a kind, and its serializer. */
export abstract class SingleWebviewPanel implements vscode.WebviewPanelSerializer, vscode.Disposable {
  private current: vscode.WebviewPanel | undefined;
  private readonly visibilityEmitter = new vscode.EventEmitter<void>();
  /** Fires when the panel opens, closes, or is shown or hidden. */
  readonly onDidChangeVisibility = this.visibilityEmitter.event;

  protected constructor(private readonly kind: PanelKind, private readonly base: SinglePanelOptions) {}

  /** Reveal the panel where it is, or open it in the active editor group. Where it is not offered, say why. */
  show(): void {
    const reason = this.base.unavailableReason();
    if (reason) {
      void vscode.window.showInformationMessage(reason);
      return;
    }
    if (this.current) {
      this.current.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      this.kind.viewType,
      this.kind.title,
      vscode.ViewColumn.Active,
      { ...webviewOptions(this.base.extensionUri), retainContextWhenHidden: true },
    );
    this.adopt(panel);
  }

  /** The panel, if one is open. */
  get panel(): vscode.WebviewPanel | undefined {
    return this.current;
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
    this.visibilityEmitter.dispose();
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
      panel.onDidChangeViewState(() => this.visibilityEmitter.fire()),
      panel.onDidDispose(() => {
        if (this.current === panel) { this.current = undefined; }
        for (const subscription of subscriptions) { subscription.dispose(); }
        this.visibilityEmitter.fire();
      }),
    ];
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
      panel.webview.onDidReceiveMessage((message: unknown) => { void this.onMessage(message); }),
      panel.onDidDispose(() => {
        this.disposed = true;
        for (const subscription of this.subscriptions) { subscription.dispose(); }
      }),
    );
  }

  /** Answer one message from the webview. Messages are untrusted: act only on what a guard accepts. */
  protected abstract onMessage(message: unknown): Promise<void>;

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
