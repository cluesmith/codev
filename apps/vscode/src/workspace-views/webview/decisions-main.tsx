/**
 * Webview entry of the Decisions panel (Spec 1963): mounts the shared Decisions view with a
 * postMessage-backed host, so every Tower call is the extension host's. Bundled by esbuild as a
 * browser IIFE (`dist/webview/decisions.{js,css}`) and type-checked by `tsconfig.webview.json`.
 *
 * Styles: the shared views' stylesheet, the markdown theme the dashboard also loads, and
 * `vscode-theme.css`, which maps the views' `--codev-wv-*` tokens to VS Code's theme.
 */

import { createRoot } from 'react-dom/client';
import '@cluesmith/codev-artifact-canvas/default-theme.css';
import '@cluesmith/codev-workspace-views/styles.css';
import './vscode-theme.css';
import type { DecisionsWebviewMessage } from '../messages.js';
import { visibilityOf, WebviewDecisionsHost } from './decisions-host.js';
import { DecisionsApp, PanelStore } from './DecisionsApp.js';

declare function acquireVsCodeApi(): { postMessage(message: DecisionsWebviewMessage): void };

const vscodeApi = acquireVsCodeApi();
const store = new PanelStore();
const host = new WebviewDecisionsHost(message => vscodeApi.postMessage(message), image => store.showImage(image));

window.addEventListener('message', (event: MessageEvent) => {
  const visible = visibilityOf(event.data);
  if (visible !== null) {
    store.setVisible(visible);
    return;
  }
  host.receive(event.data);
});

const container = document.getElementById('root');
if (!container) { throw new Error('Decisions panel: the webview document has no #root element'); }
createRoot(container).render(<DecisionsApp host={host} store={store} />);
vscodeApi.postMessage({ type: 'ready' });
