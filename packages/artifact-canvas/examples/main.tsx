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

function Example(): React.ReactElement {
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
    initialReadingMode: params.get('mode') ?? undefined,
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

  return React.createElement(
    'div',
    { style: { maxWidth: 760, margin: '2rem auto', padding: '0 1rem' } },
    React.createElement('h2', null, 'artifact-canvas dev example'),
    React.createElement(
      'p',
      { style: { color: '#6e7781' } },
      'Hover a block for the + affordance (or focus it and press Enter). Comments round-trip through text.',
    ),
    canvas,
  );
}

createRoot(document.getElementById('root')!).render(React.createElement(Example));
