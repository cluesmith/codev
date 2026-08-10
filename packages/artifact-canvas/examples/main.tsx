/**
 * Vite dev page for hands-on/visual exercise of <ArtifactCanvas> (Phase 4 — a developer aid,
 * NOT the contract proof; the automated proof is `src/__tests__/end-to-end.test.tsx`).
 *
 * Launch with `pnpm dev:example` (= `vite examples`). It reuses the SAME stub adapters + sample
 * artifact as the e2e test, so what you click here is exactly what the test asserts: hover a
 * block, click the `+` (or focus + Enter), type a comment, and watch it round-trip through text
 * back into the rendered markers. Excluded from the published package (`files`/`exports`).
 *
 * Fixture mode (spec 1380, plan phase 2 — the Playwright fragmentation suite drives it):
 *   ?fixture=columns          load the columns fixture document instead of the sample
 *   ?mode=horizontal          seed `initialReadingMode` (any other value exercises coercion)
 *   ?height=unbounded         omit the bounded-height container (self-bounding assertion)
 * Default (no params) is the classic hands-on page, unchanged.
 */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { ArtifactCanvas } from '../src/components/ArtifactCanvas.js';
import { createStubHost } from '../src/__tests__/fixtures/stub-adapters.js';
import { SAMPLE_ARTIFACT } from '../src/__tests__/fixtures/sample-artifact.js';
import { COLUMNS_FIXTURE } from '../src/__tests__/fixtures/columns-fixture.js';
import '../src/styles/default-theme.css';

const params = new URLSearchParams(window.location.search);
const fixtureMode = params.get('fixture') === 'columns';

let doc = SAMPLE_ARTIFACT;
if (fixtureMode) {
  doc = COLUMNS_FIXTURE;
}
const host = createStubHost(doc);

// Per-user persistence in the dev host (spec 1380 D4): localStorage, mirroring what the VS
// Code host does with globalState. An explicit ?mode= always wins (the Playwright fixtures
// drive modes via the URL and must not depend on prior runs' storage).
const STORAGE_KEY = 'codev-canvas-reading-mode';
function initialReadingMode(): string | undefined {
  const fromUrl = params.get('mode');
  if (fromUrl !== null) return fromUrl;
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined; // storage unavailable → vertical default, toggle still works
  }
}

function Example(): React.ReactElement {
  // Track the mode so the page can swap its own layout: the classic centered dev column for
  // vertical, full viewport for horizontal (a 760px well would leave room for ~1 column).
  const [mode, setMode] = React.useState<string>(initialReadingMode() ?? 'vertical');
  const onAddComment = (line: number, text: string) => {
    // Host glue (spec D6): the canvas's inline composer (#1107) collects the body and passes it
    // here; the host just writes it back. (Pre-#1107 this used window.prompt for the input.)
    void host.markerAdapter.add('artifact://sample.md', line, text, 'you');
  };
  const canvas = React.createElement(ArtifactCanvas, {
    uri: 'artifact://sample.md',
    fileAdapter: host.fileAdapter,
    markerAdapter: host.markerAdapter,
    themeAdapter: host.themeAdapter,
    onAddComment,
    initialReadingMode: mode,
    onReadingModeChange: (next: string) => {
      setMode(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Persistence failure is non-fatal by spec: session-only mode.
      }
    },
  });

  if (fixtureMode) {
    // Bounded-height harness for the fragmentation suite: the host-provided height context the
    // spec's Constraint 3 describes. `?height=unbounded` omits it to assert the canvas
    // self-bounds (max-height: 100vh) instead of producing one infinite column.
    let style: React.CSSProperties = { height: '100vh' };
    if (params.get('height') === 'unbounded') {
      style = {};
    }
    return React.createElement('div', { style }, canvas);
  }

  // One stable tree for both modes (the canvas must not remount on toggle — a remount would
  // discard the D7 position preservation this page exists to demonstrate): the wrapper swaps
  // styles and the header hides, but the canvas keeps its position.
  let wrapperStyle: React.CSSProperties = { maxWidth: 760, margin: '2rem auto', padding: '0 1rem' };
  let headerStyle: React.CSSProperties = {};
  if (mode === 'horizontal') {
    wrapperStyle = { height: '100%' };
    headerStyle = { display: 'none' };
  }
  return React.createElement(
    'div',
    { style: wrapperStyle },
    React.createElement(
      'div',
      { style: headerStyle },
      React.createElement('h2', null, 'artifact-canvas dev example'),
      React.createElement(
        'p',
        { style: { color: '#6e7781' } },
        'Hover a block for the + affordance (or focus it and press Enter). Comments round-trip through text.',
      ),
    ),
    canvas,
  );
}

createRoot(document.getElementById('root')!).render(React.createElement(Example));
