/**
 * Webview entry for the contextual bottom panel.
 *
 * Message-driven: the host posts `{ type: 'render', descriptor }` after resolving the active
 * surface; this renders the header (context label + pills from the descriptor's applicability) and
 * a per-mode placeholder body. All descriptor-derived text (file paths, builder ids) is rendered
 * through React as children — never `innerHTML` — so it is auto-escaped; the host never interpolates
 * it into the HTML string. Mode navigation (clickable pills / drill-in) arrives in Phase 4.
 *
 * Bundled by esbuild as a browser IIFE (dist/webview/contextual-panel.js); type-checked by
 * tsconfig.webview.json (DOM lib), excluded from the host tsconfig. No JSX (createElement).
 */

import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import './styles.css';
import { HeaderStrip, MODE_LABELS, pillsFromDescriptor } from './components.js';
import type { ModeDescriptor, ModeKind } from '../types.js';
import type { HostToWebviewMessage } from '../messages.js';

const h = React.createElement;

declare function acquireVsCodeApi(): { postMessage(message: { type: 'ready' }): void };
const vscodeApi = acquireVsCodeApi();

const BODY_PLACEHOLDER: Record<ModeKind, string> = {
  'document-review': 'Review markers for this file will appear here (rendering owned by #859 / #945).',
  'code-review': "This builder's pending comments and files-to-review will appear here (#1037).",
  'builder-inspector': "This builder's phase, gate, activity, and message input will appear here.",
  'attention': 'Pending gates, blocked builders, and queued comments across builders will appear here.',
};

function labelFor(descriptor: ModeDescriptor): React.ReactNode {
  if (descriptor.kind === 'document-review') {
    const path = descriptor.context.resourcePath ?? '';
    const name = path.split('/').pop();
    if (name !== undefined && name.length > 0) {
      return name;
    }
    return 'Document';
  }
  if (descriptor.kind === 'code-review' || descriptor.kind === 'builder-inspector') {
    const modeLabel = MODE_LABELS[descriptor.kind];
    if (descriptor.context.builderId !== undefined) {
      return h(
        React.Fragment,
        null,
        `${modeLabel} · `,
        h('span', { className: 'cp-builder' }, descriptor.context.builderId),
      );
    }
    return modeLabel;
  }
  return MODE_LABELS[descriptor.kind];
}

function Panel(props: { descriptor: ModeDescriptor | undefined }): React.ReactElement {
  const { descriptor } = props;
  if (descriptor === undefined) {
    return h('div', { className: 'cp-body' }, h('div', { className: 'cp-body-empty' }, 'Loading…'));
  }
  return h(
    React.Fragment,
    null,
    h(HeaderStrip, { contextLabel: labelFor(descriptor), pills: pillsFromDescriptor(descriptor) }),
    h('div', { className: 'cp-body' }, h('div', { className: 'cp-body-empty' }, BODY_PLACEHOLDER[descriptor.kind])),
  );
}

let root: Root | undefined;
function render(descriptor: ModeDescriptor | undefined): void {
  const rootElement = document.getElementById('root');
  if (rootElement === null) {
    return;
  }
  if (root === undefined) {
    root = createRoot(rootElement);
  }
  root.render(h(Panel, { descriptor }));
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as HostToWebviewMessage | undefined;
  if (message !== undefined && message.type === 'render') {
    render(message.descriptor);
  }
});

render(undefined);
vscodeApi.postMessage({ type: 'ready' });
