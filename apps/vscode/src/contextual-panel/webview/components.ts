/**
 * Local webview UI primitives for the contextual panel (mode pills + header strip).
 *
 * No JSX — elements are built with `React.createElement` (matching the markdown-preview webview,
 * so the extension package needs no JSX build config). These are LOCAL primitives with clean
 * extraction seams for #1549 (a shared webview UI layer); do not promote them to a shared
 * package here — #1549 extracts from proven code.
 */

import * as React from 'react';
import type { ModeKind } from '../types.js';

const h = React.createElement;

export const MODE_ORDER: readonly ModeKind[] = [
  'document-review',
  'code-review',
  'builder-inspector',
  'attention',
];

export const MODE_LABELS: Record<ModeKind, string> = {
  'document-review': 'Document Review',
  'code-review': 'Code Review',
  'builder-inspector': 'Builder Inspector',
  'attention': 'Attention',
};

/** A single mode pill's display state, derived host-side from the resolved descriptor. */
export type PillState = 'active' | 'navigable' | 'disabled';

export interface ModePill {
  mode: ModeKind;
  label: string;
  state: PillState;
}

export function Pill(props: { pill: ModePill; onNavigate?: (mode: ModeKind) => void }): React.ReactElement {
  const { pill, onNavigate } = props;

  const classes = ['cp-pill'];
  if (pill.state === 'active') {
    classes.push('cp-pill--active');
  }
  if (pill.state === 'disabled') {
    classes.push('cp-pill--disabled');
  }

  let title: string | undefined;
  if (pill.state === 'disabled') {
    title = `Open a spec, plan, or review to activate ${pill.label}`;
  }

  let onClick: (() => void) | undefined;
  if (pill.state === 'navigable' && onNavigate !== undefined) {
    onClick = () => onNavigate(pill.mode);
  }

  return h(
    'button',
    {
      type: 'button',
      className: classes.join(' '),
      disabled: pill.state === 'disabled',
      'aria-pressed': pill.state === 'active',
      title,
      onClick,
    },
    pill.label,
  );
}

export function HeaderStrip(props: {
  contextLabel: React.ReactNode;
  pills: ModePill[];
  onNavigate?: (mode: ModeKind) => void;
}): React.ReactElement {
  return h(
    'div',
    { className: 'cp-header' },
    h('span', { className: 'cp-context' }, props.contextLabel),
    h(
      'div',
      { className: 'cp-pills' },
      props.pills.map((pill) => h(Pill, { key: pill.mode, pill, onNavigate: props.onNavigate })),
    ),
  );
}
