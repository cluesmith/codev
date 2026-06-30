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

  it('hover shows the "+" affordance; clicking opens the inline composer below the block (#1107)', async () => {
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
    // Clicking "+" no longer emits intent directly (#1107) — it opens the composer in-flow below
    // the block, where the comment will live.
    const composer = await screen.findByRole('textbox', { name: /add comment on line/i });
    const host_el = composer.closest('.codev-canvas-comment-composer-host');
    expect(host_el).not.toBeNull();
    expect(p.nextElementSibling).toBe(host_el); // placed directly below the block
    expect(onAddComment).not.toHaveBeenCalled();
    // The package must NOT write the marker itself (D6 intent-only / invariant scenario 6).
    expect(host.markerAdapter.add).not.toHaveBeenCalled();
  });

  it('composer submit (Cmd/Ctrl+Enter) emits onAddComment(line, text) (#1107)', async () => {
    const host = makeHost('# Title\n\nA paragraph.');
    const onAddComment = vi.fn();
    render(<ArtifactCanvas uri="x" {...host} onAddComment={onAddComment} />);
    const p = await waitFor(() => {
      const el = document.querySelector('p[data-line]');
      if (!el) throw new Error('no paragraph yet');
      return el as HTMLElement;
    });
    const line = Number(p.getAttribute('data-line'));
    fireEvent.mouseOver(p);
    fireEvent.click(await screen.findByRole('button', { name: /add comment on line/i }));
    const composer = await screen.findByRole('textbox', { name: /add comment on line/i });
    fireEvent.change(composer, { target: { value: 'please clarify' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    expect(onAddComment).toHaveBeenCalledWith(line, 'please clarify');
    expect(host.markerAdapter.add).not.toHaveBeenCalled(); // host writes; package never does (D6)
  });

  it('is keyboard-activatable: Enter on a focused block opens the composer (accessibility AC)', async () => {
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
    const composer = await screen.findByRole('textbox', { name: /add comment on line/i });
    expect(composer).not.toBeNull();
    expect(onAddComment).not.toHaveBeenCalled(); // opens composer, doesn't emit yet
  });

  it('round-trips a marker through text: composer submit → host add → watch → re-list → renders (scenario 3)', async () => {
    const host = makeHost('A paragraph.'); // line 0, no markers
    const onAddComment = vi.fn((line: number, text: string) => {
      // Host glue: write back via MarkerAdapter.add (which serializes into the file text).
      void host.markerAdapter.add('x', line, text, 'reviewer');
    });
    render(<ArtifactCanvas uri="x" {...host} onAddComment={onAddComment} />);
    const p = await waitFor(() => {
      const el = document.querySelector('p[data-line]');
      if (!el) throw new Error('no paragraph yet');
      return el as HTMLElement;
    });
    fireEvent.mouseOver(p);
    fireEvent.click(await screen.findByRole('button', { name: /add comment on line/i }));
    const composer = await screen.findByRole('textbox', { name: /add comment on line/i });
    fireEvent.change(composer, { target: { value: 'please clarify' } });
    fireEvent.keyDown(composer, { key: 'Enter', ctrlKey: true });
    expect(host.markerAdapter.add).toHaveBeenCalled();
    // After the host writes + the watcher fires, the component re-lists and renders the marker.
    await waitFor(() => expect(document.querySelector('.codev-canvas-has-marker')).not.toBeNull());
    expect(host.text()).toContain('<!-- REVIEW(@reviewer): please clarify -->'); // proves text round-trip
    // The composer closes after submit.
    expect(document.querySelector('.codev-canvas-comment-composer')).toBeNull();
  });

  it('Esc / Cancel closes the composer without emitting (#1107)', async () => {
    const host = makeHost('A paragraph.');
    const onAddComment = vi.fn();
    render(<ArtifactCanvas uri="x" {...host} onAddComment={onAddComment} />);
    const p = await waitFor(() => {
      const el = document.querySelector('p[data-line]');
      if (!el) throw new Error('no paragraph yet');
      return el as HTMLElement;
    });
    fireEvent.mouseOver(p);
    fireEvent.click(await screen.findByRole('button', { name: /add comment on line/i }));
    const composer = await screen.findByRole('textbox', { name: /add comment on line/i });
    fireEvent.keyDown(composer, { key: 'Escape' });
    await waitFor(() =>
      expect(document.querySelector('.codev-canvas-comment-composer')).toBeNull(),
    );
    expect(onAddComment).not.toHaveBeenCalled();
    // The placeholder host is cleaned up too (no orphan node left in the body).
    expect(document.querySelector('.codev-canvas-comment-composer-host')).toBeNull();
  });

  it('a reload that removes the active block closes the composer (#1107)', async () => {
    const host = makeHost('first para\n\nsecond para');
    const onAddComment = vi.fn();
    render(<ArtifactCanvas uri="x" {...host} onAddComment={onAddComment} />);
    // Open the composer on the LAST paragraph, then shrink the document so that line is gone.
    const paras = await waitFor(() => {
      const els = document.querySelectorAll('p[data-line]');
      if (els.length < 2) throw new Error('paragraphs not rendered yet');
      return els;
    });
    const last = paras[paras.length - 1] as HTMLElement;
    fireEvent.mouseOver(last);
    fireEvent.click(await screen.findByRole('button', { name: /add comment on line/i }));
    expect(await screen.findByRole('textbox', { name: /add comment on line/i })).not.toBeNull();
    // A watch reload to a shorter document removes the block the composer was anchored to.
    await act(async () => { host.watchers.forEach((cb) => cb('only one para now')); });
    await waitFor(() =>
      expect(document.querySelector('.codev-canvas-comment-composer')).toBeNull(),
    );
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
    await waitFor(() => expect(document.querySelector('p[data-line]')).not.toBeNull()); // still rendered, no throw
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
    await waitFor(() => expect(document.querySelector('p[data-line]')).not.toBeNull()); // read succeeded → content still renders
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

  it('renders an existing marker as an always-visible inline card below its block (#863)', async () => {
    const host = makeHost('A paragraph.\n<!-- REVIEW(@bob): please fix -->'); // marker annotates line 0
    render(<ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} />);
    const p = await waitFor(() => {
      const el = document.querySelector('p[data-line]');
      if (!el) throw new Error('no paragraph yet');
      return el as HTMLElement;
    });
    // No hover needed — the card is in flow. It shows author + body.
    const cards = await screen.findByLabelText(/comments on line/i);
    expect(cards.textContent).toContain('bob');
    expect(cards.textContent).toContain('please fix');
    // Injected inline-BELOW the block (the layout fix): the stack is the block's next sibling,
    // so it pushes following content down rather than overlaying the block.
    expect(p.nextElementSibling).toBe(cards);
    expect(cards.classList.contains('codev-canvas-marker-cards')).toBe(true);
  });

  it('injects NO card stack for a block with zero markers (no wasted vertical space, #863)', async () => {
    const host = makeHost('# Title\n\nUncommented paragraph.'); // no markers anywhere
    render(<ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} />);
    await waitFor(() => expect(document.querySelector('p[data-line]')).not.toBeNull());
    expect(document.querySelector('.codev-canvas-marker-cards')).toBeNull();
  });

  it('stacks multiple markers on one line as cards in creation (list) order (#863)', async () => {
    // Two markers on the SAME line (line 0) — the shape parseReviewMarkers yields for a block with
    // two stacked REVIEW comments. They must render as two cards in the order list() returns them.
    const host = makeHost('A paragraph.');
    host.markerAdapter.list = vi.fn(async () => [
      { author: 'bob', line: 0, text: 'first', raw: 'r1' } as ReviewMarker,
      { author: 'amy', line: 0, text: 'second', raw: 'r2' } as ReviewMarker,
    ]);
    render(<ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} />);
    const cards = await screen.findByLabelText(/comments on line/i);
    const items = cards.querySelectorAll('.codev-canvas-marker-card');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain('first');
    expect(items[1].textContent).toContain('second');
  });

  it('does not re-inject (duplicate) card stacks across a markers-only reload (#863)', async () => {
    const host = makeHost('A paragraph.\n<!-- REVIEW(@bob): fix -->');
    render(<ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} />);
    await waitFor(() => expect(document.querySelector('.codev-canvas-marker-cards')).not.toBeNull());
    // Re-list the same content via a watch tick — the prior stack must be cleaned up, not stacked.
    await act(async () => { host.watchers.forEach((cb) => cb('A paragraph.\n<!-- REVIEW(@bob): fix -->')); });
    await waitFor(() =>
      expect(document.querySelectorAll('.codev-canvas-marker-cards').length).toBe(1),
    );
  });

  it('anchors a single card stack to the OUTERMOST block when one line stamps multiple data-line nodes (list/blockquote, Codex iter-1)', async () => {
    // The renderer stamps the SAME data-line on a `ul` and its `li` (renderer/data-line.test.ts).
    // A marker on that line must inject exactly ONE stack, after the outermost `ul` — never a
    // duplicate, and never the invalid `ul > ul` that `el.after()` on the inner `li` would create.
    const host = makeHost('- item one\n<!-- REVIEW(@bob): fix the list -->'); // marker annotates line 0
    render(<ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} />);
    const ul = await waitFor(() => {
      const el = document.querySelector('ul[data-line]');
      if (!el) throw new Error('no list yet');
      return el as HTMLElement;
    });
    const stacks = document.querySelectorAll('.codev-canvas-marker-cards');
    expect(stacks.length).toBe(1); // exactly one — not one-per-data-line-node
    const stack = stacks[0];
    expect(ul.nextElementSibling).toBe(stack); // inline-below the outermost block, in flow
    expect(stack.parentElement).not.toBe(ul); // NOT nested inside the list (no invalid ul > ul)
    // Decoration is anchored to the outermost block only; the inner `li` carries no marker class.
    expect(ul.classList.contains('codev-canvas-has-marker')).toBe(true);
    expect(document.querySelector('li.codev-canvas-has-marker')).toBeNull();
  });

  it('renders marker body as text, never as markup (no innerHTML injection, #863)', async () => {
    const host = makeHost('A paragraph.\n<!-- REVIEW(@bob): <img src=x onerror=alert(1)> -->');
    render(<ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} />);
    const cards = await screen.findByLabelText(/comments on line/i);
    // The payload appears as literal text; no <img> element is created from the marker body.
    expect(cards.textContent).toContain('<img');
    expect(cards.querySelector('img')).toBeNull();
  });

  it('activates on Space (not just Enter) on a focused block — opens the composer (#1107)', async () => {
    const host = makeHost('A paragraph.');
    const onAddComment = vi.fn();
    render(<ArtifactCanvas uri="x" {...host} onAddComment={onAddComment} />);
    const p = await waitFor(() => {
      const el = document.querySelector('p[data-line]');
      if (!el) throw new Error('no paragraph yet');
      return el as HTMLElement;
    });
    fireEvent.keyDown(p, { key: ' ' });
    expect(await screen.findByRole('textbox', { name: /add comment on line/i })).not.toBeNull();
    expect(onAddComment).not.toHaveBeenCalled(); // opens composer; emit happens on submit
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
