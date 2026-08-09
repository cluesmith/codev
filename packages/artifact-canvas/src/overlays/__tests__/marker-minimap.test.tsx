import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import * as React from 'react';
import { MarkerMinimap } from '../MarkerMinimap.js';
import type { ReviewMarker } from '../../types.js';

afterEach(cleanup);

/**
 * Mount the minimap against a real body element carrying `[data-line]` blocks, so the component's
 * `querySelector(...)` and click→scroll paths run against actual DOM. jsdom has no layout, so dot
 * pixel-positions collapse to 0 — these tests assert structure/behavior (count, hidden-when-empty,
 * click→scrollIntoView, tooltip), and placement is verified on the running worktree at dev-approval.
 */
function Harness({ markers, lines }: { markers: ReviewMarker[]; lines: number[] }) {
  const ref = React.useRef<HTMLDivElement>(null);
  return React.createElement(
    'div',
    null,
    React.createElement(
      'div',
      { ref, className: 'codev-artifact-canvas-body' },
      lines.map((l) =>
        // tabIndex mirrors the real renderer, which stamps tabindex="0" on every mapped block —
        // required for the focus-handoff assertion (jsdom ignores focus() on non-focusables).
        React.createElement('p', { key: l, 'data-line': String(l), tabIndex: 0 }, `block ${l}`),
      ),
    ),
    React.createElement(MarkerMinimap, { markers, bodyRef: ref }),
  );
}

const marker = (line: number, author: string, text: string): ReviewMarker => ({
  line,
  author,
  text,
  raw: `<!-- REVIEW(@${author}): ${text} -->`,
});

describe('MarkerMinimap (#863)', () => {
  it('renders nothing when there are zero markers (hidden on a marker-free doc)', () => {
    const { container } = render(<Harness markers={[]} lines={[0, 1, 2]} />);
    expect(container.querySelector('.codev-canvas-minimap')).toBeNull();
  });

  it('renders one dot per marker', () => {
    const markers = [marker(0, 'bob', 'one'), marker(2, 'amy', 'two')];
    render(<Harness markers={markers} lines={[0, 1, 2]} />);
    expect(document.querySelectorAll('.codev-canvas-minimap-dot').length).toBe(2);
  });

  it('a dot tooltip shows author + truncated body (~80 chars)', () => {
    const long = 'x'.repeat(200);
    render(<Harness markers={[marker(0, 'bob', long)]} lines={[0]} />);
    const dot = document.querySelector('.codev-canvas-minimap-dot') as HTMLElement;
    expect(dot.title.startsWith('bob: ')).toBe(true);
    expect(dot.title).toContain('…'); // truncated
    expect(dot.title.length).toBeLessThan(long.length); // not the full 200 chars
  });

  it('clicking a dot smooth-scrolls the canvas to the marker block', () => {
    // jsdom doesn't implement scrollIntoView, so install a mock (and restore after) rather than spy.
    const original = Element.prototype.scrollIntoView;
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    render(<Harness markers={[marker(2, 'bob', 'fix')]} lines={[0, 1, 2]} />);
    fireEvent.click(screen.getByRole('button', { name: /jump to comment by bob/i }));
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    Element.prototype.scrollIntoView = original;
  });

  it('activating a dot moves focus to the target block, not just the viewport (#1237)', () => {
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn();
    render(<Harness markers={[marker(2, 'bob', 'fix')]} lines={[0, 1, 2]} />);
    fireEvent.click(screen.getByRole('button', { name: /jump to comment by bob/i }));
    // A keyboard user's next Tab / jump key must resume from the block the dot targeted.
    expect(document.activeElement).toBe(document.querySelector('[data-line="2"]'));
    Element.prototype.scrollIntoView = original;
  });
});
