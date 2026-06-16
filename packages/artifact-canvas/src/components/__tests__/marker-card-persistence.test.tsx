import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, act, waitFor, cleanup } from '@testing-library/react';
import * as React from 'react';
import { ArtifactCanvas } from '../ArtifactCanvas.js';
import type { ReviewMarker } from '../../types.js';

afterEach(cleanup);

/**
 * Faithful replica of core's parseReviewMarkers: a marker annotates the nearest non-marker line
 * ABOVE it (walking past stacked markers). This matches production semantics, unlike the simpler
 * stub in artifact-canvas.test.tsx.
 */
const RE = /^(\s*)<!--\s*REVIEW\s*\(@([^)]+)\)\s*:\s*([\s\S]*?)\s*-->\s*$/;
function parse(text: string): ReviewMarker[] {
  const lines = text.split('\n');
  const out: ReviewMarker[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = RE.exec(lines[i]);
    if (!m) continue;
    let anchor = i - 1;
    while (anchor >= 0 && RE.test(lines[anchor])) anchor--;
    if (anchor < 0) continue;
    out.push({ author: m[2], line: anchor, text: m[3], raw: lines[i].trim() });
  }
  return out;
}

/**
 * Harness mimicking webview/main.ts EXACTLY: no watcher; the host pushes updates by mutating
 * content + bumping refreshKey. read() returns latest content, list() returns parse(content).
 */
function Webview({ initial }: { initial: string }) {
  const [content, setContent] = React.useState(initial);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const contentRef = React.useRef(content);
  contentRef.current = content;

  const fileAdapter = React.useMemo(
    () => ({ read: async () => contentRef.current, watch: () => ({ dispose: () => {} }) }),
    [],
  );
  const markerAdapter = React.useMemo(
    () => ({ list: async () => parse(contentRef.current), add: async () => {} }),
    [],
  );
  const themeAdapter = React.useMemo(
    () => ({ resolve: () => '', onChange: () => ({ dispose: () => {} }) }),
    [],
  );

  // Host-side addComment: insert marker on the line after `line`, then push an update (refreshKey).
  (Webview as unknown as { add: (l: number, body: string, twice?: boolean) => void }).add = (
    l,
    body,
    twice,
  ) => {
    const lines = contentRef.current.split('\n');
    lines.splice(l + 1, 0, `<!-- REVIEW(@me): ${body} -->`);
    setContent(lines.join('\n'));
    setRefreshKey((k) => k + 1);
    // Simulate document.save() firing a SECOND onDidChangeTextDocument with identical content.
    if (twice) setRefreshKey((k) => k + 1);
  };

  return React.createElement(ArtifactCanvas, {
    uri: 'codev:markdown-preview',
    fileAdapter,
    markerAdapter,
    themeAdapter,
    onAddComment: () => {},
    refreshKey,
  });
}

/**
 * Regression for "comment card flashes then disappears" (#863 dev-approval finding). The card is
 * injected into the markdown body; once React stopped owning that body's innerHTML (now set
 * imperatively in an effect), a re-render can no longer re-commit innerHTML and wipe the card.
 * NOTE: the original defect only surfaced in the real browser's React commit timing and does not
 * reproduce under jsdom, so these assert the behavioral contract (the card survives the realistic
 * update cycle) rather than the browser-only wipe; the running-app check at dev-approval covers that.
 */
describe('comment card persists after add (webview refreshKey path)', () => {
  it('keeps the inline card after a comment is added', async () => {
    render(<Webview initial={'## Understanding\n\nWaleed flagged a slow load.'} />);
    await waitFor(() => expect(document.querySelector('p[data-line]')).not.toBeNull());

    const para = document.querySelector('p[data-line]') as HTMLElement;
    const line = Number(para.getAttribute('data-line'));

    await act(async () => {
      (Webview as unknown as { add: (l: number, body: string) => void }).add(line, 'please clarify');
    });

    // The card must be present AND STAY present (the reported bug: it flashes then vanishes).
    const cards = await screen.findByLabelText(/comments on line/i);
    expect(cards.textContent).toContain('please clarify');

    // Let any trailing renders/effects settle, then assert it's still there.
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByLabelText(/comments on line/i)).not.toBeNull();
  });

  it('VARIANT: comment inserted MID multi-line paragraph (the #1036 split case)', async () => {
    // A hard-wrapped paragraph: three source lines forming ONE block (data-line = first line).
    render(
      <Webview
        initial={'Para line one here.\npara line two here.\npara line three here.'}
      />,
    );
    await waitFor(() => expect(document.querySelector('p[data-line]')).not.toBeNull());
    const para = document.querySelector('p[data-line]') as HTMLElement;
    const line = Number(para.getAttribute('data-line')); // first line of the block

    await act(async () => {
      (Webview as unknown as { add: (l: number, b: string) => void }).add(line, 'mid-para comment');
    });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByLabelText(/comments on line/i)).not.toBeNull();
  });

  it('VARIANT: double update (save fires a second change event)', async () => {
    render(<Webview initial={'## Understanding\n\nWaleed flagged a slow load.'} />);
    await waitFor(() => expect(document.querySelector('p[data-line]')).not.toBeNull());
    const para = document.querySelector('p[data-line]') as HTMLElement;
    const line = Number(para.getAttribute('data-line'));

    await act(async () => {
      (Webview as unknown as { add: (l: number, b: string, t?: boolean) => void }).add(
        line,
        'please clarify',
        true, // twice
      );
    });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByLabelText(/comments on line/i)).not.toBeNull();
  });
});
