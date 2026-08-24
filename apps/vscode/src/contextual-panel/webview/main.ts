/**
 * Webview entry for the contextual bottom panel.
 *
 * Phase 2 ships a STATIC shell: the header strip (context label + four mode pills) and an empty
 * body. Contextual resolution and host<->webview messaging arrive in Phase 3 — this file only
 * establishes the React (createElement, no JSX) substrate and the local primitives, so Document
 * Review can later host `<ArtifactCanvas>` and the other modes their own bodies.
 *
 * Bundled by esbuild as a browser IIFE (dist/webview/contextual-panel.js); type-checked by
 * tsconfig.webview.json (DOM lib), excluded from the host tsconfig.
 */

import * as React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { HeaderStrip, MODE_LABELS, MODE_ORDER, type ModePill } from './components.js';

const h = React.createElement;

/**
 * The shell's pill states. With no active context the contextual fallback is Attention, so it
 * shows active; Document Review is file-scoped and inapplicable with nothing open, so it is
 * disabled. The other two are navigable. Phase 3 replaces this with host-driven descriptors.
 */
function buildShellPills(): ModePill[] {
  return MODE_ORDER.map((mode) => {
    let state: ModePill['state'] = 'navigable';
    if (mode === 'attention') {
      state = 'active';
    }
    if (mode === 'document-review') {
      state = 'disabled';
    }
    return { mode, label: MODE_LABELS[mode], state };
  });
}

function Panel(): React.ReactElement {
  return h(
    React.Fragment,
    null,
    h(HeaderStrip, { contextLabel: 'Codev', pills: buildShellPills() }),
    h(
      'div',
      { className: 'cp-body' },
      h('div', { className: 'cp-body-empty' }, 'Nothing needs your attention right now.'),
    ),
  );
}

const rootElement = document.getElementById('root');
if (rootElement !== null) {
  createRoot(rootElement).render(h(Panel));
}
