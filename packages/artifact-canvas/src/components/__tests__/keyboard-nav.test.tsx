import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import * as React from 'react';
import { ArtifactCanvas } from '../ArtifactCanvas.js';
import type { ReviewMarker } from '../../types.js';

afterEach(cleanup);

// focusBlock() scroll-follows every jump; jsdom has no scrollIntoView, so install one for the file.
const scrollSpy = vi.fn();
beforeAll(() => { Element.prototype.scrollIntoView = scrollSpy; });
afterAll(() => { delete (Element.prototype as Partial<Element>).scrollIntoView; });

/**
 * Stub host matching the component-test convention: file + marker adapters share one text store,
 * REVIEW comments annotate the line ABOVE them (#857), and `markerLine` carries the comment's own
 * physical line (the delete/edit identity).
 */
function makeHost(initial: string) {
  let text = initial;
  const watchers: Array<(c: string) => void> = [];
  const parse = (t: string): ReviewMarker[] => {
    const out: ReviewMarker[] = [];
    t.split('\n').forEach((ln, i) => {
      const m = ln.match(/<!--\s*REVIEW\(@([^)]+)\):\s*(.*?)\s*-->/);
      if (m && i > 0) out.push({ author: m[1], line: i - 1, markerLine: i, text: m[2], raw: ln.trim() });
    });
    return out;
  };
  return {
    text: () => text,
    setText: (next: string) => {
      text = next;
      watchers.forEach((cb) => cb(text));
    },
    watchers,
    fileAdapter: {
      read: vi.fn(async () => text),
      watch: vi.fn((_uri: string, cb: (c: string) => void) => {
        watchers.push(cb);
        return { dispose: vi.fn() };
      }),
    },
    markerAdapter: {
      list: vi.fn(async () => parse(text)),
      add: vi.fn(async (_uri: string, line: number, body: string, author: string) => {
        const lines = text.split('\n');
        lines.splice(line + 1, 0, `<!-- REVIEW(@${author}): ${body} -->`);
        text = lines.join('\n');
        watchers.forEach((cb) => cb(text));
      }),
    },
    themeAdapter: { resolve: vi.fn(() => ''), onChange: vi.fn(() => ({ dispose: vi.fn() })) },
  };
}

// Blocks land at: h1@0, p@2, h2@4, p@6 (bob's marker), p@9 (amy's marker).
const DOC = [
  '# Alpha',
  '',
  'First paragraph.',
  '',
  '## Beta',
  '',
  'Second paragraph.',
  '<!-- REVIEW(@bob): fix this -->',
  '',
  'Third paragraph.',
  '<!-- REVIEW(@amy): also this -->',
].join('\n');

const block = (line: number): HTMLElement =>
  document.querySelector(`.codev-artifact-canvas-body [data-line="${line}"]`) as HTMLElement;

async function mount(doc = DOC, extraProps: Record<string, unknown> = {}) {
  const host = makeHost(doc);
  render(<ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} {...extraProps} />);
  await waitFor(() => {
    if (!document.querySelector('.codev-artifact-canvas-body [data-line]')) {
      throw new Error('not rendered yet');
    }
  });
  return host;
}

/** Focus a block, then press a key on whatever currently holds focus. */
const press = (key: string): void => {
  fireEvent.keyDown(document.activeElement as HTMLElement, { key });
};

describe('jump navigation (#1237)', () => {
  it('n / p move focus between commented blocks, without wrap-around at the edges', async () => {
    await mount();
    await waitFor(() => expect(block(6).classList.contains('codev-canvas-has-marker')).toBe(true));
    act(() => block(0).focus());
    press('n');
    expect(document.activeElement).toBe(block(6));
    press('n');
    expect(document.activeElement).toBe(block(9));
    press('n'); // no later commented block: deliberate no-op
    expect(document.activeElement).toBe(block(9));
    press('p');
    expect(document.activeElement).toBe(block(6));
    press('p'); // no earlier commented block
    expect(document.activeElement).toBe(block(6));
  });

  it('] and [ move focus between headings', async () => {
    await mount();
    act(() => block(2).focus());
    press(']');
    expect(document.activeElement).toBe(block(4)); // ## Beta
    press('[');
    expect(document.activeElement).toBe(block(0)); // # Alpha
  });

  it('Home / End jump to the first / last block', async () => {
    await mount();
    act(() => block(6).focus());
    press('Home');
    expect(document.activeElement).toBe(block(0));
    press('End');
    expect(document.activeElement).toBe(block(9));
  });

  it('jumps scroll the target into view', async () => {
    await mount();
    scrollSpy.mockClear();
    act(() => block(0).focus());
    press('n');
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });

  it('n lands on the OUTERMOST element when nested blocks share the line (list dedupe)', async () => {
    await mount('# Title\n\n- item one\n<!-- REVIEW(@bob): fix the list -->');
    await waitFor(() =>
      expect(document.querySelector('.codev-canvas-has-marker')).not.toBeNull(),
    );
    act(() => block(0).focus());
    press('n');
    expect((document.activeElement as HTMLElement).tagName).toBe('UL');
    expect((document.activeElement as HTMLElement).classList.contains('codev-canvas-has-marker')).toBe(true);
  });

  it('keys inside the composer are never intercepted (typing "n" stays in the textarea)', async () => {
    await mount();
    fireEvent.keyDown(block(2), { key: 'Enter' });
    const textarea = await screen.findByRole('textbox', { name: /add comment on line/i });
    expect(document.activeElement).toBe(textarea); // composer autofocused
    fireEvent.keyDown(textarea, { key: 'n' });
    expect(document.activeElement).toBe(textarea); // focus did not jump
  });
});

describe('focus management across the post-write rebuild (#1237)', () => {
  it('Esc-cancel returns focus to the originating block (regression)', async () => {
    await mount();
    fireEvent.keyDown(block(2), { key: 'Enter' });
    const textarea = await screen.findByRole('textbox', { name: /add comment on line/i });
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(document.activeElement).toBe(block(2));
  });

  it('submit returns focus to the commented block after the watch reload', async () => {
    const host = makeHost(DOC);
    const onAddComment = vi.fn((line: number, body: string) => {
      void host.markerAdapter.add('x', line, body, 'reviewer');
    });
    render(<ArtifactCanvas uri="x" {...host} onAddComment={onAddComment} />);
    await waitFor(() => expect(block(2)).not.toBeNull());
    fireEvent.keyDown(block(2), { key: 'Enter' });
    const textarea = await screen.findByRole('textbox', { name: /add comment on line/i });
    fireEvent.change(textarea, { target: { value: 'a new comment' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    // The write → watch → reload path rebuilds the body (destroying the old nodes); the reviewer
    // must land back on the block they commented on, which now carries the new marker.
    await waitFor(() => {
      expect(block(2).classList.contains('codev-canvas-has-marker')).toBe(true);
      expect(document.activeElement).toBe(block(2));
    });
  });

  it('delete returns focus to the annotated block after the watch reload', async () => {
    const host = makeHost('A paragraph.\n<!-- REVIEW(@bob): fix -->');
    const onDeleteComment = vi.fn((markerLine: number) => {
      const lines = host.text().split('\n');
      lines.splice(markerLine, 1);
      host.setText(lines.join('\n'));
    });
    render(<ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} onDeleteComment={onDeleteComment} />);
    const del = await screen.findByRole('button', { name: /delete comment by bob/i });
    fireEvent.click(del);
    await waitFor(() => {
      expect(document.querySelector('.codev-canvas-marker-card')).toBeNull();
      expect(document.activeElement).toBe(block(0));
    });
  });

  it('falls back to the nearest preceding block when the reload removed the target line', async () => {
    const host = makeHost('# Alpha\n\nFirst paragraph.\n\nLast paragraph.');
    // A host whose "write" shrinks the document past the commented block entirely.
    const onAddComment = vi.fn(() => {
      host.setText('# Alpha\n\nFirst paragraph.');
    });
    render(<ArtifactCanvas uri="x" {...host} onAddComment={onAddComment} />);
    await waitFor(() => expect(block(4)).not.toBeNull());
    fireEvent.keyDown(block(4), { key: 'Enter' });
    const textarea = await screen.findByRole('textbox', { name: /add comment on line/i });
    fireEvent.change(textarea, { target: { value: 'never lands' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(block(4)).toBeNull(); // the commented block is gone
      expect(document.activeElement).toBe(block(2)); // nearest preceding block, not document.body
    });
  });
});

describe('keys legend (#1237)', () => {
  it('? toggles the legend, Esc closes it, and focus never leaves the block', async () => {
    await mount();
    act(() => block(2).focus());
    press('?');
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog.textContent).toContain('Next / previous commented block');
    expect(document.activeElement).toBe(block(2)); // non-modal: focus stays put
    press('Escape');
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    expect(document.activeElement).toBe(block(2));
    press('?'); // reopen…
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeNull();
    press('?'); // …and ? closes it too
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
  });
});
