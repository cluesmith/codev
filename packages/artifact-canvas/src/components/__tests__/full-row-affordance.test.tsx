import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import * as React from 'react';
import { ArtifactCanvas } from '../ArtifactCanvas.js';

afterEach(cleanup);

/**
 * Full-row "+" affordance tests (#1343, GitHub-diff pattern). The whole row is the hover target
 * and the "+" renders inside the hovered row's own DOM, so there is no pointer journey between
 * trigger and target. The #1236 grace/pin machinery is deleted with the model that needed it —
 * nothing here uses fake timers, and every transition below is asserted to be INSTANT (a timer
 * before any of these behaviors would be a regression to the travel-gap era).
 *
 * jsdom has no layout, so these tests pin the structural contract (which row hosts the "+",
 * when it appears/moves/disappears); pixel placement is verified in the running flow at the
 * dev-approval gate.
 */
function makeHost(initial: string) {
  const watchers: Array<(c: string) => void> = [];
  return {
    watchers,
    fileAdapter: {
      read: vi.fn(async () => initial),
      watch: vi.fn((_uri: string, cb: (c: string) => void) => {
        watchers.push(cb);
        return { dispose: vi.fn() };
      }),
    },
    markerAdapter: { list: vi.fn(async () => []), add: vi.fn(async () => {}) },
    themeAdapter: { resolve: vi.fn(() => ''), onChange: vi.fn(() => ({ dispose: vi.fn() })) },
  };
}

// h1 at line 0, paragraphs at lines 2 and 4 (labels "line 3" / "line 5"), a list whose ul + first
// item share line 6 and whose second item is line 7 (labels "line 7" / "line 8").
const DOC = '# Alpha\n\nFirst paragraph.\n\nSecond paragraph.\n\n- item one\n- item two';

async function mount() {
  const host = makeHost(DOC);
  const onAddComment = vi.fn();
  render(<ArtifactCanvas uri="x" {...host} onAddComment={onAddComment} />);
  const paras = await waitFor(() => {
    const els = document.querySelectorAll<HTMLElement>('p[data-line]');
    if (els.length < 2) throw new Error('not rendered yet');
    return Array.from(els);
  });
  const canvas = document.querySelector('.codev-artifact-canvas') as HTMLElement;
  const body = document.querySelector('.codev-artifact-canvas-body') as HTMLElement;
  return { paras, canvas, body, onAddComment };
}

const plusButton = (line1Based: number): HTMLElement | null =>
  screen.queryByRole('button', { name: `Add comment on line ${line1Based}` });

/** Native mouseout with a relatedTarget OUTSIDE the canvas — React synthesizes onMouseLeave. */
const leaveCanvas = (canvas: HTMLElement): void => {
  fireEvent.mouseOut(canvas, { relatedTarget: document.body });
};

describe('full-row "+" affordance (#1343)', () => {
  it('first hover lights the "+" instantly, inside the hovered row itself', async () => {
    const { paras } = await mount();
    fireEvent.mouseOver(paras[0]);
    const btn = plusButton(3);
    expect(btn).not.toBeNull();
    // The structural fix: the button lives in the row's own DOM, not a canvas overlay.
    expect(btn!.closest('[data-line]')).toBe(paras[0]);
    expect(document.querySelector('.codev-canvas-overlay')).toBeNull();
  });

  it('crossing to another row re-anchors instantly into the new row (no grace window)', async () => {
    const { paras } = await mount();
    fireEvent.mouseOver(paras[0]);
    expect(plusButton(3)).not.toBeNull();
    fireEvent.mouseOver(paras[1]);
    expect(plusButton(5)).not.toBeNull(); // no timer advance — instant is the contract
    expect(plusButton(3)).toBeNull();
    expect(plusButton(5)!.closest('[data-line]')).toBe(paras[1]);
  });

  it('a nested list item labels its own line but is hosted by its top-level row', async () => {
    await mount();
    const ul = document.querySelector<HTMLElement>('ul[data-line="6"]') as HTMLElement;
    const li = document.querySelector<HTMLElement>('li[data-line="7"]') as HTMLElement;
    fireEvent.mouseOver(li);
    const btn = plusButton(8); // the li's own line — activation targeting stays precise
    expect(btn).not.toBeNull();
    expect(btn!.closest('[data-line]')).toBe(ul); // hosted in the row's gutter
  });

  it('dead strips are sticky: hovering body whitespace keeps the current row lit', async () => {
    const { paras, body } = await mount();
    fireEvent.mouseOver(paras[0]);
    fireEvent.mouseOver(body); // margin/padding strips resolve no block
    fireEvent.mouseMove(body);
    expect(plusButton(3)).not.toBeNull();
  });

  it('canvas mouseleave dismisses immediately', async () => {
    const { paras, canvas } = await mount();
    fireEvent.mouseOver(paras[0]);
    expect(plusButton(3)).not.toBeNull();
    leaveCanvas(canvas);
    expect(plusButton(3)).toBeNull(); // no grace window to wait out
    // Re-entry re-lights instantly in the same row.
    fireEvent.mouseOver(paras[0]);
    expect(plusButton(3)).not.toBeNull();
  });

  it('keyboard focus lights the "+" in the focused row (#1237 parity)', async () => {
    const { paras } = await mount();
    fireEvent.mouseOver(paras[0]);
    expect(plusButton(3)).not.toBeNull();
    act(() => {
      paras[1].focus();
    });
    const btn = plusButton(5);
    expect(btn).not.toBeNull(); // instant — no pointer, no timers
    expect(plusButton(3)).toBeNull();
    expect(btn!.closest('[data-line]')).toBe(paras[1]);
  });

  it('clicking the "+" opens the composer for the labeled line and suppresses the affordance', async () => {
    const { paras, onAddComment } = await mount();
    fireEvent.mouseOver(paras[0]);
    fireEvent.click(plusButton(3) as HTMLElement);
    const textarea = await waitFor(() => {
      const el = document.querySelector<HTMLTextAreaElement>('.codev-canvas-comment-composer-input');
      if (!el) throw new Error('composer not open yet');
      return el;
    });
    expect(plusButton(3)).toBeNull(); // the composer replaces the "+" for its line
    fireEvent.change(textarea, { target: { value: 'needs a citation' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(onAddComment).toHaveBeenCalledWith(2, 'needs a citation'); // 0-based intent seam
  });

  it('does not re-anchor while a primary-button drag (text selection) is in progress', async () => {
    const { paras } = await mount();
    fireEvent.mouseOver(paras[0]);
    expect(plusButton(3)).not.toBeNull();
    fireEvent.mouseOver(paras[1], { buttons: 1 });
    fireEvent.mouseMove(paras[1], { buttons: 1 });
    expect(plusButton(3)).not.toBeNull(); // frozen for the duration of the drag
    expect(plusButton(5)).toBeNull();
  });

  it('pointer events originating on the affordance itself never retarget it', async () => {
    await mount();
    const li = document.querySelector<HTMLElement>('li[data-line="7"]') as HTMLElement;
    fireEvent.mouseOver(li);
    const btn = plusButton(8) as HTMLElement;
    // The button sits inside the ul row; re-resolving from it would retarget line 8 → line 7.
    fireEvent.mouseOver(btn);
    fireEvent.mouseMove(btn);
    expect(plusButton(8)).not.toBeNull();
    expect(plusButton(7)).toBeNull();
  });

  it('focus and keydown on the affordance never retarget it either (iter-1 Codex)', async () => {
    // Same trap as the pointer path, via keyboard: the button lives inside the HOST row (the ul),
    // so an unguarded focus/keydown re-resolves an li's line 8 to the ul's line 7 — and Enter
    // would open the composer on the wrong line.
    const { onAddComment } = await mount();
    const li = document.querySelector<HTMLElement>('li[data-line="7"]') as HTMLElement;
    fireEvent.mouseOver(li);
    const btn = plusButton(8) as HTMLElement;
    act(() => {
      btn.focus(); // Tab reaches the button — must not re-anchor to the host row's line
    });
    expect(plusButton(8)).not.toBeNull();
    expect(plusButton(7)).toBeNull();
    // Enter on the button belongs to the button (native activation → onClick). The body handler
    // must not intercept it and open the composer for the ul's line.
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(document.querySelector('.codev-canvas-comment-composer')).toBeNull();
    // Clicking (what native activation fires) opens the composer for the li's own line.
    fireEvent.click(btn);
    const textarea = await waitFor(() => {
      const el = document.querySelector<HTMLTextAreaElement>('.codev-canvas-comment-composer-input');
      if (!el) throw new Error('composer not open yet');
      return el;
    });
    expect(textarea.getAttribute('aria-label')).toBe('Add comment on line 8');
    fireEvent.change(textarea, { target: { value: 'scoped to the item' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(onAddComment).toHaveBeenCalledWith(7, 'scoped to the item'); // the li's 0-based line
  });
});
