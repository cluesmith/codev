/**
 * Webview entry for the contextual bottom panel.
 *
 * Message-driven: the host posts `{ type: 'render', descriptor, summary? }` after resolving the
 * active surface. This renders the header (context label + pills from the descriptor's applicability)
 * and the body — a per-mode detail placeholder, or (for a builder-scoped summary) a clickable
 * builder-id list. Clicking a navigable pill or a summary row posts a transient navigation message
 * back to the host; nothing is persisted. All descriptor-derived text is rendered through React
 * children (auto-escaped) — never `innerHTML`.
 *
 * Bundled by esbuild as a browser IIFE (dist/webview/contextual-panel.js); type-checked by
 * tsconfig.webview.json (DOM lib). No JSX (createElement).
 */

import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import './styles.css';
import { EmptyState, HeaderStrip, SummaryList } from './components.js';
import { MODE_LABELS, pillsFromDescriptor } from '../pills.js';
import type { ModeDescriptor, ModeKind } from '../types.js';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../messages.js';

const h = React.createElement;

declare function acquireVsCodeApi(): { postMessage(message: WebviewToHostMessage): void };
const vscodeApi = acquireVsCodeApi();

function navigate(mode: ModeKind): void {
  vscodeApi.postMessage({ type: 'mode-navigate', mode });
}

function drillIn(mode: ModeKind, builderId: string): void {
  vscodeApi.postMessage({ type: 'drill-in', mode, builderId });
}

const DETAIL_PLACEHOLDER: Record<ModeKind, string> = {
  'document-review': 'Review markers for this file will appear here (rendering owned by #859 / #945).',
  'code-review': "This builder's pending comments and files-to-review will appear here (#1037).",
  'builder-inspector': "This builder's phase, gate, activity, and message input will appear here.",
  'attention': 'Pending gates, blocked builders, and queued comments across builders will appear here.',
};

const SUMMARY_EMPTY: Partial<Record<ModeKind, string>> = {
  'code-review': 'No builders have pending comments.',
  'builder-inspector': 'No builders are running.',
};

function labelFor(descriptor: ModeDescriptor): React.ReactNode {
  if (descriptor.kind === 'document-review') {
    const name = (descriptor.context.resourcePath ?? '').split('/').pop();
    if (name !== undefined && name.length > 0) {
      return name;
    }
    return 'Document';
  }
  if (descriptor.kind === 'code-review' || descriptor.kind === 'builder-inspector') {
    const modeLabel = MODE_LABELS[descriptor.kind];
    if (descriptor.context.builderId !== undefined) {
      return h(React.Fragment, null, `${modeLabel} · `, h('span', { className: 'cp-builder' }, descriptor.context.builderId));
    }
    return modeLabel;
  }
  return MODE_LABELS[descriptor.kind];
}

function body(descriptor: ModeDescriptor, summary: { builderIds: string[] } | undefined): React.ReactElement {
  if (descriptor.level === 'summary' && summary !== undefined) {
    return h(SummaryList, {
      builderIds: summary.builderIds,
      emptyText: SUMMARY_EMPTY[descriptor.kind] ?? 'Nothing to show.',
      onDrillIn: (builderId) => drillIn(descriptor.kind, builderId),
    });
  }
  return h(EmptyState, { text: DETAIL_PLACEHOLDER[descriptor.kind] });
}

function Panel(props: { descriptor: ModeDescriptor | undefined; summary: { builderIds: string[] } | undefined }): React.ReactElement {
  const { descriptor } = props;
  if (descriptor === undefined) {
    return h('div', { className: 'cp-body' }, h(EmptyState, { text: 'Loading…' }));
  }
  return h(
    React.Fragment,
    null,
    h(HeaderStrip, { contextLabel: labelFor(descriptor), pills: pillsFromDescriptor(descriptor), onNavigate: navigate }),
    h('div', { className: 'cp-body' }, body(descriptor, props.summary)),
  );
}

let root: Root | undefined;
function render(descriptor: ModeDescriptor | undefined, summary: { builderIds: string[] } | undefined): void {
  const rootElement = document.getElementById('root');
  if (rootElement === null) {
    return;
  }
  if (root === undefined) {
    root = createRoot(rootElement);
  }
  root.render(h(Panel, { descriptor, summary }));
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as HostToWebviewMessage | undefined;
  if (message !== undefined && message.type === 'render') {
    render(message.descriptor, message.summary);
  }
});

render(undefined, undefined);
vscodeApi.postMessage({ type: 'ready' });
