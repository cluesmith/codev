/**
 * Local webview UI primitives for the contextual panel (mode pills + header strip).
 *
 * No JSX — elements are built with `React.createElement` (matching the markdown-preview webview, so
 * the extension package needs no JSX build config). These are LOCAL primitives with clean extraction
 * seams for #1549 (a shared webview UI layer); do not promote them to a shared package here. The pure
 * pill model (order, labels, descriptor → state) lives in `../pills.ts` so it can be tested without a DOM.
 */

import * as React from 'react';
import type { ModeKind } from '../types.js';
import { type ModePill } from '../pills.js';

const h = React.createElement;

export { MODE_ORDER, MODE_LABELS, pillsFromDescriptor, type ModePill, type PillState } from '../pills.js';

export function Pill(props: { pill: ModePill; onNavigate?: (mode: ModeKind) => void }): React.ReactElement {
  const { pill, onNavigate } = props;

  const classes = ['cp-pill'];
  if (pill.state === 'active') {
    classes.push('cp-pill--active');
  }
  if (pill.state === 'disabled') {
    classes.push('cp-pill--disabled');
  }

  // A native `disabled` button suppresses its `title` tooltip in Chromium, so the greyed-pill hover
  // hint would never show. Use `aria-disabled` instead (also keeps the pill keyboard-discoverable)
  // and simply withhold the click handler.
  const buttonProps: React.ButtonHTMLAttributes<HTMLButtonElement> = {
    type: 'button',
    className: classes.join(' '),
    'aria-pressed': pill.state === 'active',
  };
  if (pill.state === 'disabled') {
    buttonProps['aria-disabled'] = true;
    buttonProps.title = `Open a spec, plan, or review to activate ${pill.label}`;
  }
  if (pill.state === 'navigable' && onNavigate !== undefined) {
    buttonProps.onClick = () => onNavigate(pill.mode);
  }

  return h('button', buttonProps, pill.label);
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
