import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import * as React from 'react';
import { ArtifactCanvas } from '../ArtifactCanvas.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * Hover-geometry regression tests (#1236). The "+" affordance used to vanish exactly as the
 * pointer traveled toward it: crossing another block re-anchored it instantly, and overshooting
 * the canvas edge dismissed it instantly. These tests pin the graced state machine: a ~200ms
 * window absorbs both transitions, and entering the overlay pins everything.
 *
 * Timing is driven with fake timers (installed AFTER the async initial load, which needs real
 * ones). The grace constant is 200ms; tests probe just inside and just past it.
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

// h1 at line 0, paragraphs at lines 2 and 4 → human-facing labels "line 3" and "line 5".
const DOC = '# Alpha\n\nFirst paragraph.\n\nSecond paragraph.';

async function mount() {
  const host = makeHost(DOC);
  render(<ArtifactCanvas uri="x" {...host} onAddComment={vi.fn()} />);
  const paras = await waitFor(() => {
    const els = document.querySelectorAll<HTMLElement>('p[data-line]');
    if (els.length < 2) throw new Error('not rendered yet');
    return Array.from(els);
  });
  const canvas = document.querySelector('.codev-artifact-canvas') as HTMLElement;
  return { paras, canvas };
}

const plusButton = (line1Based: number): HTMLElement | null =>
  screen.queryByRole('button', { name: `Add comment on line ${line1Based}` });

/** Native mouseout with a relatedTarget OUTSIDE the canvas — React synthesizes onMouseLeave. */
const leaveCanvas = (canvas: HTMLElement): void => {
  fireEvent.mouseOut(canvas, { relatedTarget: document.body });
};

describe('"+" affordance hover grace (#1236)', () => {
  it('first hover shows the affordance instantly (no grace when nothing is showing)', async () => {
    const { paras } = await mount();
    fireEvent.mouseOver(paras[0]);
    expect(plusButton(3)).not.toBeNull();
  });

  it('survives a canvas mouseleave through the grace window, then dismisses', async () => {
    const { paras, canvas } = await mount();
    fireEvent.mouseOver(paras[0]);
    expect(plusButton(3)).not.toBeNull();
    vi.useFakeTimers();
    leaveCanvas(canvas);
    act(() => { vi.advanceTimersByTime(199); });
    expect(plusButton(3)).not.toBeNull(); // a pixel of overshoot no longer kills the button
    act(() => { vi.advanceTimersByTime(2); });
    expect(plusButton(3)).toBeNull(); // a real departure still dismisses
  });

  it('re-entering a block cancels the pending dismiss', async () => {
    const { paras, canvas } = await mount();
    fireEvent.mouseOver(paras[0]);
    vi.useFakeTimers();
    leaveCanvas(canvas);
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.mouseOver(paras[0]); // came back within the grace
    act(() => { vi.advanceTimersByTime(500); });
    expect(plusButton(3)).not.toBeNull();
  });

  it('crossing another block re-anchors only after the grace elapses', async () => {
    const { paras } = await mount();
    fireEvent.mouseOver(paras[0]);
    vi.useFakeTimers();
    fireEvent.mouseOver(paras[1]); // en route: crosses the second paragraph
    expect(plusButton(3)).not.toBeNull(); // still anchored to the first
    expect(plusButton(5)).toBeNull();
    act(() => { vi.advanceTimersByTime(200); });
    expect(plusButton(5)).not.toBeNull(); // a settled hover does re-anchor
    expect(plusButton(3)).toBeNull();
  });

  it('entering the overlay cancels a pending re-anchor and pins against further crossings', async () => {
    const { paras } = await mount();
    fireEvent.mouseOver(paras[0]);
    vi.useFakeTimers();
    fireEvent.mouseOver(paras[1]); // re-anchor now pending
    const overlay = document.querySelector('.codev-canvas-overlay') as HTMLElement;
    fireEvent.mouseOver(overlay); // pointer reached the overlay → React fires onMouseEnter
    act(() => { vi.advanceTimersByTime(500); });
    expect(plusButton(3)).not.toBeNull(); // pending re-anchor was canceled
    fireEvent.mouseOver(paras[1]); // crossing while pinned is a no-op
    act(() => { vi.advanceTimersByTime(500); });
    expect(plusButton(3)).not.toBeNull();
    expect(plusButton(5)).toBeNull();
  });

  it('keyboard focus re-anchors instantly (the grace is a pointer-only concession)', async () => {
    const { paras } = await mount();
    fireEvent.mouseOver(paras[0]);
    expect(plusButton(3)).not.toBeNull();
    vi.useFakeTimers();
    act(() => { paras[1].focus(); });
    expect(plusButton(5)).not.toBeNull(); // no timer advance needed
    expect(plusButton(3)).toBeNull();
  });
});
