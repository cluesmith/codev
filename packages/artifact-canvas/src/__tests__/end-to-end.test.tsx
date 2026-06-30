/**
 * End-to-end contract proof (Phase 4 — the PRIMARY deliverable).
 *
 * Mounts the real <ArtifactCanvas> against the stub host adapters + the sample artifact and
 * proves the full review round-trip *through text* (spec D3 / text-as-source-of-truth, #857),
 * via BOTH mouse and keyboard:
 *
 *   render → existing marker shows → hover/focus a block → click/Enter the `+` →
 *   the inline composer opens (#1107) → type a body → Cmd/Ctrl+Enter →
 *   onAddComment(line, text) fires (0-based, spec D5) → host glue calls MarkerAdapter.add →
 *   the marker is serialized INTO the text → FileAdapter.watch replays the new text →
 *   MarkerAdapter.list re-derives from that text → the new marker renders.
 *
 * It asserts the new marker text lands in the shared text store (not an in-memory side store),
 * which is what distinguishes a real round-trip from a mere UI refresh (iter-2 Codex).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import * as React from 'react';
import { ArtifactCanvas } from '../components/ArtifactCanvas.js';
import { SAMPLE_ARTIFACT } from './fixtures/sample-artifact.js';
import { createStubHost } from './fixtures/stub-adapters.js';

afterEach(cleanup);

/** Host glue (spec D6): the canvas's composer collects the body; the host writes it back. */
function mountWithHost(initial: string, author = 'reviewer') {
  const host = createStubHost(initial);
  const onAddComment = vi.fn((line: number, text: string) => {
    void host.markerAdapter.add('artifact://sample.md', line, text, author);
  });
  render(
    <ArtifactCanvas
      uri="artifact://sample.md"
      fileAdapter={host.fileAdapter}
      markerAdapter={host.markerAdapter}
      themeAdapter={host.themeAdapter}
      onAddComment={onAddComment}
    />,
  );
  return { host, onAddComment };
}

async function firstParagraph(): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.querySelector('p[data-line]');
    if (!el) throw new Error('no paragraph rendered yet');
    return el as HTMLElement;
  });
}

/** Type `body` into the inline composer (#1107) and submit it with Cmd/Ctrl+Enter. */
async function composeAndSubmit(body: string): Promise<void> {
  const input = await screen.findByRole('textbox', { name: /add comment on line/i });
  fireEvent.change(input, { target: { value: body } });
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
}

describe('ArtifactCanvas end-to-end (Phase 4 contract proof)', () => {
  it('renders the sample artifact and its pre-existing marker', async () => {
    mountWithHost(SAMPLE_ARTIFACT);
    await waitFor(() => expect(document.querySelector('h1')).not.toBeNull());
    expect(document.body.textContent).toContain('Example Feature');
    // The fixture's seeded REVIEW marker derives from text and renders.
    await waitFor(() => expect(document.querySelector('.codev-canvas-has-marker')).not.toBeNull());
  });

  it('MOUSE: hover → click "+" → compose → submit → round-trips a new marker THROUGH TEXT', async () => {
    const { host, onAddComment } = mountWithHost(SAMPLE_ARTIFACT, 'alice');
    const p = await firstParagraph();
    const line = Number(p.getAttribute('data-line'));

    fireEvent.mouseOver(p);
    fireEvent.click(await screen.findByRole('button', { name: /add comment on line/i }));
    await composeAndSubmit('tighten this');

    // Intent fired with the 0-based line + composed text; the package never wrote the marker (D6).
    expect(onAddComment).toHaveBeenCalledWith(line, 'tighten this');

    // The host's add serialized the marker INTO the text store (proves round-trip through text).
    await waitFor(() =>
      expect(host.store.getText()).toContain('<!-- REVIEW(@alice): tighten this -->'),
    );
    // …and after watch → re-list, the new marker renders on the annotated line.
    await waitFor(() => {
      const marked = document.querySelectorAll('.codev-canvas-has-marker');
      const onLine = Array.from(marked).some(
        (el) => Number(el.getAttribute('data-line')) === line,
      );
      expect(onLine).toBe(true);
    });
  });

  it('KEYBOARD: focus → Enter → compose → submit → round-trips a new marker THROUGH TEXT', async () => {
    const { host, onAddComment } = mountWithHost(SAMPLE_ARTIFACT, 'bob');
    const p = await firstParagraph();
    const line = Number(p.getAttribute('data-line'));

    expect(p.tabIndex).toBe(0); // keyboard-reachable (accessibility AC)
    fireEvent.keyDown(p, { key: 'Enter' });
    await composeAndSubmit('needs a test');

    expect(onAddComment).toHaveBeenCalledWith(line, 'needs a test');
    await waitFor(() =>
      expect(host.store.getText()).toContain('<!-- REVIEW(@bob): needs a test -->'),
    );
    await waitFor(() => {
      const onLine = Array.from(document.querySelectorAll('.codev-canvas-has-marker')).some(
        (el) => Number(el.getAttribute('data-line')) === line,
      );
      expect(onLine).toBe(true);
    });
  });
});
