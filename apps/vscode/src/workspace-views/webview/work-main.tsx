/**
 * Webview entry of the Work panel (Spec 1963): mounts the shared Work view on the overview the
 * extension host pushes, with every action a message to the host. Bundled by esbuild as a browser
 * IIFE (`dist/webview/work.{js,css}`) and type-checked by `tsconfig.webview.json`.
 *
 * Styles: the shared views' stylesheet and `vscode-theme.css`, which maps the views' `--codev-wv-*`
 * tokens to VS Code's theme.
 */

import { createRoot } from 'react-dom/client';
import '@cluesmith/codev-workspace-views/styles.css';
import './vscode-theme.css';
import type { WorkWebviewMessage } from '../messages.js';
import { WorkApp, WorkStore, workOverviewOf } from './WorkApp.js';

declare function acquireVsCodeApi(): { postMessage(message: WorkWebviewMessage): void };

const vscodeApi = acquireVsCodeApi();
const store = new WorkStore();
const post = (message: WorkWebviewMessage) => vscodeApi.postMessage(message);

window.addEventListener('message', (event: MessageEvent) => {
  const overview = workOverviewOf(event.data);
  if (overview !== undefined) { store.setOverview(overview); }
});

const container = document.getElementById('root');
if (!container) { throw new Error('Work panel: the webview document has no #root element'); }
createRoot(container).render(<WorkApp store={store} post={post} />);
vscodeApi.postMessage({ type: 'ready' });
