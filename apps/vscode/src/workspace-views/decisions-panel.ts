/**
 * The Decisions panel (Spec 1963): the shared Decisions view in an editor-area webview, for this
 * window's workspace. One panel per window, restored after a reload (`single-panel.ts`).
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

import type * as vscode from 'vscode';
import { PanelSession, SingleWebviewPanel, type SinglePanelOptions } from './single-panel.js';
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

export interface DecisionsPanelsOptions extends SinglePanelOptions {
  bridge: Pick<DecisionsBridge, 'read' | 'rule' | 'image'>;
}

const PANEL_TITLE = 'Decisions';

/** The window's one Decisions panel, and its serializer. */
export class DecisionsPanels extends SingleWebviewPanel {
  constructor(private readonly options: DecisionsPanelsOptions) {
    super({ viewType: DECISIONS_VIEW_TYPE, title: PANEL_TITLE, bundle: 'decisions' }, options);
  }

  protected attach(panel: vscode.WebviewPanel): void {
    new DecisionsPanelSession(panel, this.options);
  }
}

/** One panel's webview, from creation until it is closed. */
class DecisionsPanelSession extends PanelSession<DecisionsHostMessage> {
  constructor(panel: vscode.WebviewPanel, private readonly options: DecisionsPanelsOptions) {
    super(panel, PANEL_TITLE, options.log);
    this.track(panel.onDidChangeViewState(() => this.postVisibility()));
  }

  private postVisibility(): void {
    this.post({ type: 'visibility', visible: this.panel.visible });
  }

  protected async onMessage(message: unknown): Promise<void> {
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
      this.openExternal(message.url);
    } else {
      this.log('ignored a malformed message from its webview.');
    }
  }
}
