/**
 * Vite dev page for hands-on/visual exercise of <ArtifactCanvas> (Phase 4 — a developer aid,
 * NOT the contract proof; the automated proof is `src/__tests__/end-to-end.test.tsx`).
 *
 * Launch with `pnpm dev:example` (= `vite examples`). It reuses the SAME stub adapters + sample
 * artifact as the e2e test, so what you click here is exactly what the test asserts: hover a
 * block, click the `+` (or focus + Enter), type a comment, and watch it round-trip through text
 * back into the rendered markers. Excluded from the published package (`files`/`exports`).
 */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { ArtifactCanvas } from '../src/components/ArtifactCanvas.js';
import { createStubHost } from '../src/__tests__/fixtures/stub-adapters.js';
import { SAMPLE_ARTIFACT } from '../src/__tests__/fixtures/sample-artifact.js';
import '../src/styles/default-theme.css';

const host = createStubHost(SAMPLE_ARTIFACT);

function Example(): React.ReactElement {
  const onAddComment = (line: number, text: string) => {
    // Host glue (spec D6): the canvas's inline composer (#1107) collects the body and passes it
    // here; the host just writes it back. (Pre-#1107 this used window.prompt for the input.)
    void host.markerAdapter.add('artifact://sample.md', line, text, 'you');
  };
  return React.createElement(
    'div',
    { style: { maxWidth: 760, margin: '2rem auto', padding: '0 1rem' } },
    React.createElement('h2', null, 'artifact-canvas dev example'),
    React.createElement(
      'p',
      { style: { color: '#6e7781' } },
      'Hover a block for the + affordance (or focus it and press Enter). Comments round-trip through text.',
    ),
    React.createElement(ArtifactCanvas, {
      uri: 'artifact://sample.md',
      fileAdapter: host.fileAdapter,
      markerAdapter: host.markerAdapter,
      themeAdapter: host.themeAdapter,
      onAddComment,
    }),
  );
}

createRoot(document.getElementById('root')!).render(React.createElement(Example));
