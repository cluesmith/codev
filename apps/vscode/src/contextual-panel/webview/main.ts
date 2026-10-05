/**
 * Webview entry for the contextual bottom panel.
 *
 * Message-driven and purely contextual: the host posts `{ type: 'render', descriptor, attention?,
 * codeReview? }` after resolving the active surface; this renders a one-line context label and a
 * per-mode body. For the Attention fallback the body is the live roll-up projected from the overview
 * cache (`attention`); for Code Review it is the shown builder's pending review queue plus its
 * files-to-review (`codeReview`, read-only); the remaining modes still show their placeholder (owned
 * by its own participating feature). There is no navigation — no pills, no selection. All
 * host-supplied text (file paths, builder ids, issue titles, gate labels, comment bodies) is rendered
 * through React children (auto-escaped), never `innerHTML`.
 *
 * Bundled by esbuild as a browser IIFE (dist/webview/contextual-panel.js); type-checked by
 * tsconfig.webview.json (DOM lib). No JSX (createElement).
 */

import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import './styles.css';
import type { ModeDescriptor, ModeKind } from '../types.js';
import { formatAge } from '@cluesmith/codev-sdk/builder-helpers';
import type { AttentionBuilderRef, AttentionSummary, GateItem, WaitingItem, CountItem } from '@cluesmith/codev-sdk/builder-helpers';
import type { HostToWebviewMessage } from '../messages.js';
import type { CodeReviewComment, CodeReviewFile, CodeReviewSummary } from '../code-review.js';

const h = React.createElement;

declare function acquireVsCodeApi(): { postMessage(message: { type: 'ready' }): void };
const vscodeApi = acquireVsCodeApi();

const MODE_LABELS: Record<ModeKind, string> = {
  'document-review': 'Document Review',
  'code-review': 'Code Review',
  'builder-inspector': 'Builder Inspector',
  'attention': 'Attention',
};

// Placeholder bodies for the modes whose content is owned by other participating features. Attention
// (#1553) and Code Review (#1559) render live data below.
const BODY_PLACEHOLDER: Record<Exclude<ModeKind, 'attention' | 'code-review'>, string> = {
  'document-review': 'Review markers for this file will appear here (rendering owned by #859 / #945).',
  'builder-inspector': "This builder's phase, gate, activity, and message input will appear here.",
};

function label(descriptor: ModeDescriptor): React.ReactNode {
  if (descriptor.kind === 'document-review') {
    const name = (descriptor.context.resourcePath ?? '').split('/').pop();
    if (name !== undefined && name.length > 0) {
      return h(React.Fragment, null, 'Document Review · ', h('span', { className: 'cp-file' }, name));
    }
    return 'Document Review';
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

/** The builder id + its issue reference, shared by every Attention row. */
function rowMain(item: AttentionBuilderRef): React.ReactNode {
  const issue = item.issueId !== null
    ? h('span', { className: 'cp-issue' }, `${item.issueId} · `)
    : null;
  const title = item.issueTitle ?? 'no linked issue';
  return h(
    'span',
    { className: 'cp-row-main' },
    h('span', { className: 'cp-row-id' }, item.builderId),
    h('span', { className: 'cp-row-sub' }, issue, title),
  );
}

// Relative age uses the SDK's canonical `formatAge` (shared with the Tower view) so both surfaces
// read the same — "just now" under a minute, then "6m"/"2h"/"3d", and nothing for an absent age.

function section(title: string, count: number, rows: React.ReactNode): React.ReactNode {
  return h(
    'div',
    { className: 'cp-section' },
    h(
      'div',
      { className: 'cp-section-head' },
      h('span', { className: 'cp-section-title' }, title),
      h('span', { className: 'cp-count-pill' }, String(count)),
    ),
    h('div', { className: 'cp-rows' }, rows),
  );
}

function gateRow(item: GateItem, index: number): React.ReactElement {
  const age = formatAge(item.since);
  const badge = h(
    'span',
    { className: 'cp-badge cp-badge-gate' },
    item.gate,
    age !== null ? h('span', { className: 'cp-badge-since' }, ` · ${age}`) : null,
  );
  return h(
    'div',
    { className: 'cp-row cp-row-gate', key: `${item.builderId}:${item.gate}:${index}` },
    h('span', { className: 'cp-stripe' }),
    rowMain(item),
    badge,
  );
}

function waitingRow(item: WaitingItem, index: number): React.ReactElement {
  const age = formatAge(item.since);
  return h(
    'div',
    { className: 'cp-row cp-row-waiting', key: `${item.builderId}:${index}` },
    h('span', { className: 'cp-stripe' }),
    rowMain(item),
    h('span', { className: 'cp-badge cp-badge-waiting' }, age !== null ? `idle · ${age}` : 'idle'),
  );
}

function countRow(item: CountItem, index: number, variant: 'mail' | 'queued', unit: string): React.ReactElement {
  const plural = item.count === 1 ? unit : `${unit}s`;
  return h(
    'div',
    { className: `cp-row cp-row-${variant}`, key: `${item.builderId}:${index}` },
    h('span', { className: 'cp-stripe' }),
    rowMain(item),
    h(
      'span',
      { className: `cp-badge cp-badge-${variant}` },
      h('span', { className: 'cp-count-num' }, String(item.count)),
      ` ${plural}`,
    ),
  );
}

function attentionBody(summary: AttentionSummary): React.ReactNode {
  if (summary.isEmpty) {
    return h(
      'div',
      { className: 'cp-empty' },
      h('div', { className: 'cp-empty-msg' }, 'Nothing needs attention right now'),
      h('div', { className: 'cp-empty-sub' }, 'No builders at a gate, none waiting on input, no held mail, no queued feedback.'),
    );
  }

  const sections: React.ReactNode[] = [];
  if (summary.pendingGates.length > 0) {
    sections.push(
      h(
        React.Fragment,
        { key: 'gates' },
        section('Pending gates', summary.pendingGates.length, summary.pendingGates.map((item, i) => gateRow(item, i))),
      ),
    );
  }
  if (summary.waiting.length > 0) {
    sections.push(
      h(
        React.Fragment,
        { key: 'waiting' },
        section('Waiting on input', summary.waiting.length, summary.waiting.map((item, i) => waitingRow(item, i))),
      ),
    );
  }
  if (summary.heldTotal > 0) {
    const title = summary.heldEscalated ? 'Held mail · escalated' : 'Held mail';
    const rows = summary.heldMail.length > 0
      ? summary.heldMail.map((item, i) => countRow(item, i, 'mail', 'message'))
      : h('div', { className: 'cp-row-note' }, `${summary.heldTotal} held, awaiting an empty prompt`);
    sections.push(h(React.Fragment, { key: 'mail' }, section(title, summary.heldTotal, rows)));
  }
  if (summary.queuedFeedback.length > 0) {
    sections.push(
      h(
        React.Fragment,
        { key: 'queued' },
        section('Queued feedback', summary.queuedFeedback.length, summary.queuedFeedback.map((item, i) => countRow(item, i, 'queued', 'comment'))),
      ),
    );
  }
  return sections;
}

function commentRow(item: CodeReviewComment): React.ReactElement {
  return h(
    'div',
    { className: 'cp-row cp-row-queued', key: item.id },
    h('span', { className: 'cp-stripe' }),
    h(
      'span',
      { className: 'cp-row-main' },
      h('span', { className: 'cp-row-id' }, item.ref),
      h('span', { className: 'cp-comment-body' }, item.body),
    ),
  );
}

function fileRow(item: CodeReviewFile): React.ReactElement {
  const plural = item.commentCount === 1 ? 'comment' : 'comments';
  const badge = item.commentCount > 0
    ? h('span', { className: 'cp-badge cp-badge-queued' }, h('span', { className: 'cp-count-num' }, String(item.commentCount)), ` ${plural}`)
    : null;
  return h(
    'div',
    { className: 'cp-row', key: item.relPath },
    h('span', { className: 'cp-stripe' }),
    h('span', { className: 'cp-row-main' }, h('span', { className: 'cp-row-id' }, item.relPath)),
    badge,
  );
}

function codeReviewBody(summary: CodeReviewSummary): React.ReactNode {
  if (summary.isEmpty) {
    return h(
      'div',
      { className: 'cp-empty' },
      h('div', { className: 'cp-empty-msg' }, 'No pending review comments'),
      h('div', { className: 'cp-empty-sub' }, "Comments you queue on this builder's diff appear here until you submit the review."),
    );
  }
  const comments = summary.comments.length > 0
    ? summary.comments.map((item) => commentRow(item))
    : h('div', { className: 'cp-row-note' }, 'No pending comments yet; queue one from the diff.');
  const sections: React.ReactNode[] = [
    h(React.Fragment, { key: 'comments' }, section('Pending comments', summary.comments.length, comments)),
  ];
  if (summary.files.length > 0) {
    sections.push(
      h(React.Fragment, { key: 'files' }, section('Files to review', summary.files.length, summary.files.map((item) => fileRow(item)))),
    );
  }
  return sections;
}

function body(descriptor: ModeDescriptor, attention: AttentionSummary | undefined, codeReview: CodeReviewSummary | undefined): React.ReactNode {
  if (descriptor.kind === 'attention') {
    if (attention === undefined) {
      // No payload attached yet — the provider always sends one in Attention mode, so this is only
      // a transient pre-first-post frame. Render a neutral placeholder, not an empty-state claim
      // (asserting "nothing needs attention" before the roll-up has arrived would be a lie).
      return h('div', { className: 'cp-body-empty' }, 'Loading…');
    }
    return attentionBody(attention);
  }
  if (descriptor.kind === 'code-review') {
    if (codeReview === undefined) {
      // Same transient pre-first-post frame as Attention: never claim "no comments" before data arrives.
      return h('div', { className: 'cp-body-empty' }, 'Loading…');
    }
    return codeReviewBody(codeReview);
  }
  return h('div', { className: 'cp-body-empty' }, BODY_PLACEHOLDER[descriptor.kind]);
}

interface PanelProps {
  descriptor: ModeDescriptor | undefined;
  attention: AttentionSummary | undefined;
  codeReview: CodeReviewSummary | undefined;
}

function Panel(props: PanelProps): React.ReactElement {
  const { descriptor, attention, codeReview } = props;
  if (descriptor === undefined) {
    return h('div', { className: 'cp-body' }, h('div', { className: 'cp-body-empty' }, 'Loading…'));
  }
  // The one-line context header names the file/builder the panel is about — informative for the
  // per-surface modes. Attention is the fallback (no single subject), so its header would be a static
  // "Attention" duplicating the "Codev" panel tab; skip it and let the body reclaim the row.
  const header = descriptor.kind === 'attention'
    ? null
    : h('div', { className: 'cp-header' }, h('span', { className: 'cp-context' }, label(descriptor)));
  return h(
    React.Fragment,
    null,
    header,
    h('div', { className: 'cp-body' }, body(descriptor, attention, codeReview)),
  );
}

let root: Root | undefined;
function render(props: PanelProps): void {
  const rootElement = document.getElementById('root');
  if (rootElement === null) {
    return;
  }
  if (root === undefined) {
    root = createRoot(rootElement);
  }
  root.render(h(Panel, props));
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as HostToWebviewMessage | undefined;
  if (message !== undefined && message.type === 'render') {
    render({ descriptor: message.descriptor, attention: message.attention, codeReview: message.codeReview });
  }
});

render({ descriptor: undefined, attention: undefined, codeReview: undefined });
vscodeApi.postMessage({ type: 'ready' });
