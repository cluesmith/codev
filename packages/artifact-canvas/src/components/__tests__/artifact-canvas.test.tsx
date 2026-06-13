import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import * as React from 'react';
import { ArtifactCanvas } from '../ArtifactCanvas.js';
import type { ReviewMarker } from '../../types.js';

afterEach(cleanup);

/**
 * Stub host (spec D3/D6 + text-as-source-of-truth): file + marker adapters share one text store.
 * `markerAdapter.add` serializes a positional `<!-- REVIEW(@author): text -->` INTO the text and
 * notifies the watcher; `list` derives markers from the current text. This exercises the round-trip
 * *through text*, not an in-memory side store.
 */
function makeHost(initial: string) {
  let text = initial;
  const watchers: Array<(c: string) => void> = [];
  const parse = (t: string): ReviewMarker[] => {
    const out: ReviewMarker[] = [];
    t.split('\n').forEach((ln, i) => {
      const m = ln.match(/<!--\s*REVIEW\(@([^)]+)\):\s*(.*?)\s*-->/);
      // #857 convention: a REVIEW comment annotates the line ABOVE it (it's written on the next
      // line). So the marker's logical line is i-1 — the content block the reviewer commented on.
      if (m && i > 0) out.push({ author: m[1], line: i - 1, text: m[2], raw: ln.trim() });
    });
    return out;
  };
  const fileAdapter = {
    read: vi.fn(async () => text),
    watch: vi.fn((_uri: string, cb: (c: string) => void) => {
      watchers.push(cb);
      return { dispose: vi.fn(() => { const i = watchers.indexOf(cb); if (i >= 0) watchers.splice(i, 1); }) };
    }),
  };
  const markerAdapter = {
    list: vi.fn(async () => parse(text)),
    add: vi.fn(async (_uri: string, line: number, body: string, author: string) => {
      const lines = text.split('\n');
      lines.splice(line + 1, 0, `<!-- REVIEW(@${author}): ${body} -->`);
      text = lines.join('\n');
      watchers.forEach((cb) => cb(text));
    }),
  };
  const themeAdapter = {
    resolve: vi.fn((tok: string) => (tok === '--codev-canvas-foreground' ? '#111111' : '')),
    onChange: vi.fn(() => ({ dispose: vi.fn() })),
  };
  return { text: () => text, watchers, fileAdapter, markerAdapter, themeAdapter };
}

describe('ArtifactCanvas (Phase 3)', () => {
  it('renders content from FileAdapter and lists markers', async () => {
    const host = makeHost('# Title\n\nA paragraph.');
    render(<ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} />);
    await waitFor(() => expect(document.querySelector('h1')).not.toBeNull());
    expect(host.fileAdapter.read).toHaveBeenCalledWith('x');
    expect(host.markerAdapter.list).toHaveBeenCalled();
  });

  it('hover shows the "+" affordance; clicking emits onAddComment with the 0-based line (scenario 2)', async () => {
    const host = makeHost('# Title\n\nA paragraph.');
    const onAddComment = vi.fn();
    render(<ArtifactCanvas uri="x" {...host} onAddComment={onAddComment} />);
    const p = await waitFor(() => {
      const el = document.querySelector('p[data-line]');
      if (!el) throw new Error('no paragraph yet');
      return el as HTMLElement;
    });
    fireEvent.mouseOver(p);
    const plus = await screen.findByRole('button', { name: /add comment on line/i });
    fireEvent.click(plus);
    expect(onAddComment).toHaveBeenCalledWith(Number(p.getAttribute('data-line')));
    // The package must NOT write the marker itself (D6 intent-only / invariant scenario 6).
    expect(host.markerAdapter.add).not.toHaveBeenCalled();
  });

  it('is keyboard-activatable: Enter on a focused block emits onAddComment (accessibility AC)', async () => {
    const host = makeHost('A paragraph.');
    const onAddComment = vi.fn();
    render(<ArtifactCanvas uri="x" {...host} onAddComment={onAddComment} />);
    const p = await waitFor(() => {
      const el = document.querySelector('p[data-line]');
      if (!el) throw new Error('no paragraph yet');
      return el as HTMLElement;
    });
    expect(p.tabIndex).toBe(0); // focusable
    fireEvent.keyDown(p, { key: 'Enter' });
    expect(onAddComment).toHaveBeenCalledWith(0);
  });

  it('round-trips a marker through text: host add → watch → re-list → marker renders (scenario 3)', async () => {
    const host = makeHost('A paragraph.'); // line 0, no markers
    const onAddComment = vi.fn((line: number) => {
      // Host glue: collect text + write back via MarkerAdapter.add (which serializes into the file text).
      void host.markerAdapter.add('x', line, 'please clarify', 'reviewer');
    });
    render(<ArtifactCanvas uri="x" {...host} onAddComment={onAddComment} />);
    const p = await waitFor(() => {
      const el = document.querySelector('p[data-line]');
      if (!el) throw new Error('no paragraph yet');
      return el as HTMLElement;
    });
    fireEvent.mouseOver(p);
    fireEvent.click(await screen.findByRole('button', { name: /add comment on line/i }));
    expect(host.markerAdapter.add).toHaveBeenCalled();
    // After the host writes + the watcher fires, the component re-lists and renders the marker.
    await waitFor(() => expect(document.querySelector('.codev-canvas-has-marker')).not.toBeNull());
    expect(host.text()).toContain('<!-- REVIEW(@reviewer): please clarify -->'); // proves text round-trip
  });

  it('drops an out-of-range marker and warns ONCE even across reloads (deferred #4)', async () => {
    const host = makeHost('one line only');
    host.markerAdapter.list = vi.fn(async () => [
      { author: 'a', line: 99, text: 'stale', raw: 'r' } as ReviewMarker,
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} />);
    await waitFor(() => expect(document.querySelector('[data-line]')).not.toBeNull());
    expect(document.querySelector('.codev-canvas-has-marker')).toBeNull(); // not rendered
    // A watch refresh re-lists the SAME stale marker — it must not re-warn (warn-once).
    await act(async () => { host.watchers.forEach((cb) => cb('one line only')); });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('surfaces adapter errors via onError and does not throw; failed list keeps prior markers (D2)', async () => {
    const host = makeHost('A paragraph.');
    host.markerAdapter.list = vi.fn(async () => { throw new Error('list boom'); });
    const onError = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(document.querySelector('p[data-line]')).not.toBeNull(); // still rendered, no throw
    err.mockRestore();
  });

  it('disposes the watch subscription on unmount; later emits do not throw (scenario 9)', async () => {
    const host = makeHost('A paragraph.');
    const { unmount } = render(<ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} />);
    await waitFor(() => expect(document.querySelector('p[data-line]')).not.toBeNull());
    const disposable = host.fileAdapter.watch.mock.results[0].value as { dispose: ReturnType<typeof vi.fn> };
    unmount();
    expect(disposable.dispose).toHaveBeenCalled();
    expect(() => host.watchers.forEach((cb) => cb('changed'))).not.toThrow();
  });

  it('surfaces a FileAdapter.read rejection via onError without throwing (D2)', async () => {
    const host = makeHost('A paragraph.');
    host.fileAdapter.read = vi.fn(async () => { throw new Error('read boom'); });
    const onError = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} onError={onError} />)).not.toThrow();
    await waitFor(() => expect(onError).toHaveBeenCalled());
    err.mockRestore();
  });

  it('surfaces a synchronous FileAdapter.watch() failure via onError without throwing (D2)', async () => {
    const host = makeHost('A paragraph.');
    host.fileAdapter.watch = vi.fn(() => { throw new Error('watch boom'); });
    const onError = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} onError={onError} />)).not.toThrow();
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(document.querySelector('p[data-line]')).not.toBeNull(); // read succeeded → content still renders
    err.mockRestore();
  });

  it('Disposable.dispose is safe to call more than once (idempotent contract, D2)', async () => {
    const host = makeHost('A paragraph.');
    const { unmount } = render(<ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} />);
    await waitFor(() => expect(document.querySelector('p[data-line]')).not.toBeNull());
    const disposable = host.fileAdapter.watch.mock.results[0].value as { dispose: () => void };
    unmount(); // dispose() #1
    expect(() => disposable.dispose()).not.toThrow(); // dispose() #2 — safe no-op
  });

  it('surfaces an existing marker author + text via the overlay when its line is active (deferred #4)', async () => {
    const host = makeHost('A paragraph.\n<!-- REVIEW(@bob): please fix -->'); // marker annotates line 0
    render(<ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} />);
    const p = await waitFor(() => {
      const el = document.querySelector('p[data-line]');
      if (!el) throw new Error('no paragraph yet');
      return el as HTMLElement;
    });
    await waitFor(() => expect(document.querySelector('.codev-canvas-has-marker')).not.toBeNull());
    fireEvent.mouseOver(p);
    const list = await screen.findByLabelText(/comments on line/i);
    expect(list.textContent).toContain('bob');
    expect(list.textContent).toContain('please fix');
  });

  it('activates on Space (not just Enter) on a focused block', async () => {
    const host = makeHost('A paragraph.');
    const onAddComment = vi.fn();
    render(<ArtifactCanvas uri="x" {...host} onAddComment={onAddComment} />);
    const p = await waitFor(() => {
      const el = document.querySelector('p[data-line]');
      if (!el) throw new Error('no paragraph yet');
      return el as HTMLElement;
    });
    fireEvent.keyDown(p, { key: ' ' });
    expect(onAddComment).toHaveBeenCalledWith(0);
  });

  it('keeps previously-rendered markers when a LATER list() rejects (D2 — prior markers preserved)', async () => {
    const host = makeHost('A paragraph.\n<!-- REVIEW(@bob): fix -->'); // marker annotates line 0
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} onError={vi.fn()} />);
    await waitFor(() => expect(document.querySelector('.codev-canvas-has-marker')).not.toBeNull());
    // Now a later list() fails; trigger a watch update (same content).
    host.markerAdapter.list = vi.fn(async () => { throw new Error('list boom'); });
    await act(async () => { host.watchers.forEach((cb) => cb('A paragraph.\n<!-- REVIEW(@bob): fix -->')); });
    expect(document.querySelector('.codev-canvas-has-marker')).not.toBeNull(); // prior marker remains
    err.mockRestore();
  });

  it('a slow initial read() does not overwrite newer watch content (request-versioning, iter-2 Codex)', async () => {
    const host = makeHost('OLD content.');
    let resolveRead!: (v: string) => void;
    host.fileAdapter.read = vi.fn(() => new Promise<string>((res) => { resolveRead = res; }));
    render(<ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} />);
    // Newer watch content arrives before the slow read resolves.
    await act(async () => { host.watchers.forEach((cb) => cb('NEW content.')); });
    await waitFor(() => expect(document.body.textContent).toContain('NEW content'));
    // The stale initial read resolves last — it must NOT overwrite the newer content.
    await act(async () => { resolveRead('OLD content.'); });
    expect(document.body.textContent).toContain('NEW content');
    expect(document.body.textContent).not.toContain('OLD content');
  });

  it('re-fetches when refreshKey changes — the no-watcher refresh contract (D6)', async () => {
    const host = makeHost('first.');
    host.fileAdapter.read = vi
      .fn()
      .mockResolvedValueOnce('first content.')
      .mockResolvedValueOnce('second content.');
    const { rerender } = render(
      <ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} refreshKey={1} />,
    );
    await waitFor(() => expect(document.body.textContent).toContain('first content'));
    expect(host.fileAdapter.read).toHaveBeenCalledTimes(1);
    // Host data changed (no watcher) → it bumps refreshKey to force a refresh.
    rerender(<ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} refreshKey={2} />);
    await waitFor(() => expect(document.body.textContent).toContain('second content'));
    expect(host.fileAdapter.read).toHaveBeenCalledTimes(2);
  });

  it('clears a stale activeLine after a reload removes the hovered block (no "+" / no onAddComment on an invalid line, iter-5 Codex)', async () => {
    const host = makeHost('# Title\n\nFirst paragraph.\n\nSecond paragraph.');
    const onAddComment = vi.fn();
    render(<ArtifactCanvas uri="x" {...host} onAddComment={onAddComment} />);
    // Hover the LAST block (highest data-line) so the overlay anchors to a line the reload removes.
    const blocks = await waitFor(() => {
      const els = document.querySelectorAll<HTMLElement>('p[data-line]');
      if (els.length < 2) throw new Error('paragraphs not rendered yet');
      return els;
    });
    const last = blocks[blocks.length - 1];
    fireEvent.mouseOver(last);
    expect(await screen.findByRole('button', { name: /add comment on line/i })).not.toBeNull();
    // A watch reload shrinks the document so the previously-hovered block no longer exists.
    await act(async () => { host.watchers.forEach((cb) => cb('# Title')); });
    await waitFor(() => expect(document.querySelectorAll('p[data-line]').length).toBe(0));
    // The stale overlay is gone — no "+" on the now-invalid line, and clicking is impossible.
    expect(screen.queryByRole('button', { name: /add comment on line/i })).toBeNull();
    expect(onAddComment).not.toHaveBeenCalled();
  });

  it('KEEPS the active overlay across a reload that still contains the hovered block (no over-clear; guards the CI clobber)', async () => {
    // Root cause of the CI-only e2e failure: the iter-5 reset was UNCONDITIONAL on content change,
    // so it could wipe a valid `activeLine` (e.g. one set by a hover that raced the initial async
    // load). The fix VALIDATES instead: a still-present line survives a reload. This test fails
    // against the blind-reset implementation and passes against the validating one.
    const host = makeHost('# Title\n\nA paragraph.'); // paragraph at data-line 2
    render(<ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} />);
    const p = await waitFor(() => {
      const el = document.querySelector('p[data-line]');
      if (!el) throw new Error('no paragraph yet');
      return el as HTMLElement;
    });
    fireEvent.mouseOver(p);
    expect(await screen.findByRole('button', { name: /add comment on line/i })).not.toBeNull();
    // A reload to DIFFERENT content where the hovered block (line 2) still exists.
    await act(async () => { host.watchers.forEach((cb) => cb('# Title\n\nA paragraph.\n\nMore text.')); });
    await waitFor(() => expect(document.querySelectorAll('p[data-line]').length).toBe(2));
    // The overlay must NOT have been clobbered — the hovered line is still present.
    expect(screen.queryByRole('button', { name: /add comment on line/i })).not.toBeNull();
  });
});

describe('ThemeAdapter contract (D4 Model A, scenario 4 — not on the v1 render path)', () => {
  it('resolve() returns the host value and onChange returns a disposable that fires', () => {
    let fired = false;
    const theme = {
      resolve: (tok: string) => (tok === '--codev-canvas-accent' ? '#0969da' : ''),
      onChange: (h: () => void) => { h(); return { dispose: () => {} }; }, // simulate a theme switch
    };
    expect(theme.resolve('--codev-canvas-accent')).toBe('#0969da');
    const sub = theme.onChange(() => { fired = true; });
    expect(fired).toBe(true);
    expect(typeof sub.dispose).toBe('function');
    sub.dispose(); // idempotent no-op
  });
});
