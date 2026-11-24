/**
 * The Decisions panel (Spec 1963): the shared Decisions view in an editor-area webview, for this
 * window's workspace. One panel per window: opening it again reveals it, and never creates a
 * second one or reloads the first. A window reload restores it through the panel serializer.
 *
 * The webview never contacts Tower. It asks the host, which calls Tower through `DecisionsBridge`:
 * - **Polling has one owner:** the shared `useDecisions` hook, at its 2 s cadence. Each tick is one
 *   `decisions/read` message, and the host makes one Tower request per message. The host runs no
 *   timer. It relays the panel's own visibility (`onDidChangeViewState`), which the webview passes
 *   to the hook as `isActive`, so polling stops while the panel is hidden: a retained, hidden
 *   webview still reports its page as visible.
 * - **A reply for a closed panel is dropped** silently: no post, no toast, no new panel.
 * - **Links** open in the user's browser, http(s) only. **Images** a decision item names by
 *   workspace path come back as bytes, which the webview shows as object URLs.
 */

import * as vscode from 'vscode';
import { renderWorkspaceViewHtml } from './panel-template.js';
import { isAllowedExternalUrl } from './security.js';
import type { DecisionsBridge } from './decisions-bridge.js';
import {
  DECISIONS_VIEW_TYPE,
  isDecisionsImageMessage,
  isDecisionsReadMessage,
  isDecisionsRuleMessage,
  isOpenExternalMessage,
  isReadyMessage,
  ruleRequestOf,
  type DecisionsHostMessage,
} from './messages.js';

export interface DecisionsPanelsOptions {
  extensionUri: vscode.Uri;
  bridge: Pick<DecisionsBridge, 'read' | 'rule' | 'image'>;
  /** Why the panel is not offered in this window (`availability.ts`), or null when it is. */
  unavailableReason: () => string | null;
  log: (line: string) => void;
}

const PANEL_TITLE = 'Decisions';

/** What the webview may load: the bundle under `dist`, and nothing else from the extension. */
function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')] };
}

/** The window's one Decisions panel, and its serializer. */
export class DecisionsPanels implements vscode.WebviewPanelSerializer {
  private current: DecisionsPanelSession | undefined;

  constructor(private readonly options: DecisionsPanelsOptions) {}

  /**
   * *Codev: Open Decisions* and the Cockpit's Decisions entry: reveal the panel where it is, or open
   * it in the active editor group. Where the panel is not offered, say why instead.
   */
  show(): void {
    const reason = this.options.unavailableReason();
    if (reason) {
      void vscode.window.showInformationMessage(reason);
      return;
    }
    if (this.current) {
      this.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      DECISIONS_VIEW_TYPE,
      PANEL_TITLE,
      vscode.ViewColumn.Active,
      { ...webviewOptions(this.options.extensionUri), retainContextWhenHidden: true },
    );
    this.adopt(panel);
  }

  /** The panel, if one is open. */
  get panel(): vscode.WebviewPanel | undefined {
    return this.current?.panel;
  }

  /**
   * A window reload restores an open panel in its group. Drafts are not restored, as a dashboard page
   * reload loses them too. A second panel, or one in a window where Decisions is not offered, is closed.
   */
  async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
    if (this.current || this.options.unavailableReason()) {
      panel.dispose();
      return;
    }
    panel.webview.options = webviewOptions(this.options.extensionUri);
    this.adopt(panel);
  }

  private adopt(panel: vscode.WebviewPanel): void {
    const session = new DecisionsPanelSession(panel, this.options, () => {
      if (this.current === session) { this.current = undefined; }
    });
    this.current = session;
  }
}

/** One panel's webview, from creation until it is closed. */
class DecisionsPanelSession {
  private disposed = false;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly options: DecisionsPanelsOptions,
    onDisposed: () => void,
  ) {
    const { webview } = panel;
    const bundle = vscode.Uri.joinPath(options.extensionUri, 'dist', 'webview');
    webview.html = renderWorkspaceViewHtml({
      cspSource: webview.cspSource,
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(bundle, 'decisions.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(bundle, 'decisions.css')).toString(),
      title: PANEL_TITLE,
    });
    this.subscriptions.push(
      webview.onDidReceiveMessage((message: unknown) => { void this.onMessage(message); }),
      panel.onDidChangeViewState(() => this.postVisibility()),
      panel.onDidDispose(() => {
        this.disposed = true;
        for (const subscription of this.subscriptions) { subscription.dispose(); }
        onDisposed();
      }),
    );
  }

  private post(message: DecisionsHostMessage): void {
    // A reply that lands after the panel closed has nowhere to go.
    if (this.disposed) { return; }
    void this.panel.webview.postMessage(message);
  }

  private postVisibility(): void {
    this.post({ type: 'visibility', visible: this.panel.visible });
  }

  private async onMessage(message: unknown): Promise<void> {
    const { bridge } = this.options;
    if (isReadyMessage(message)) {
      this.postVisibility();
    } else if (isDecisionsReadMessage(message)) {
      const result = await bridge.read();
      this.post({ type: 'decisions/read-result', requestId: message.requestId, result });
    } else if (isDecisionsRuleMessage(message)) {
      const result = await bridge.rule(ruleRequestOf(message));
      this.post({ type: 'decisions/rule-result', requestId: message.requestId, result });
    } else if (isDecisionsImageMessage(message)) {
      const result = await bridge.image(message.path);
      this.post({ type: 'decisions/image-result', requestId: message.requestId, result });
    } else if (isOpenExternalMessage(message)) {
      if (isAllowedExternalUrl(message.url)) {
        void vscode.env.openExternal(vscode.Uri.parse(message.url));
      } else {
        this.options.log(`Decisions panel: did not open ${message.url}; only http(s) links open from a panel.`);
      }
    } else {
      this.options.log('Decisions panel: ignored a malformed message from its webview.');
    }
  }
}
