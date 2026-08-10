import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, waitFor, cleanup, act } from '@testing-library/react';
import * as React from 'react';
import { ArtifactCanvas } from '../ArtifactCanvas.js';
import { createStore, stubFileAdapter, stubMarkerAdapter, stubThemeAdapter } from '../../__tests__/fixtures/stub-adapters.js';

afterEach(cleanup);

const DOC = '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.';

function mountCanvas(extra: Partial<React.ComponentProps<typeof ArtifactCanvas>> = {}) {
  const store = createStore(DOC);
  const utils = render(
    <ArtifactCanvas
      uri="artifact://doc.md"
      fileAdapter={stubFileAdapter(store)}
      markerAdapter={stubMarkerAdapter(store)}
      themeAdapter={stubThemeAdapter()}
      onAddComment={vi.fn()}
      {...extra}
    />,
  );
  const root = document.querySelector('.codev-artifact-canvas') as HTMLElement;
  const body = document.querySelector('.codev-artifact-canvas-body') as HTMLElement;
  return { store, root, body, ...utils };
}

const toggleButton = (): HTMLButtonElement =>
  document.querySelector('.codev-canvas-reading-mode-toggle') as HTMLButtonElement;

describe('reading mode (spec 1380, phase 1)', () => {
  it('defaults to vertical: no mode class, and the toggle is the sole new chrome', async () => {
    const { root, body } = mountCanvas();
    await waitFor(() => expect(body.querySelector('h1')).not.toBeNull());

    expect(root.classList.contains('codev-canvas-mode-horizontal')).toBe(false);
    // Vertical-mode parity (spec: "vertical untouched"): the body and every [data-line] block
    // carry no mode-related classes or attributes; the only phase-added node is the toggle.
    expect(body.className).toBe('codev-artifact-canvas-body');
    body.querySelectorAll('[data-line]').forEach((el) => {
      expect(el.className).not.toMatch(/mode|column|horizontal/);
    });
    const btn = toggleButton();
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('seeds from initialReadingMode="horizontal"', async () => {
    const { root } = mountCanvas({ initialReadingMode: 'horizontal' });
    expect(root.classList.contains('codev-canvas-mode-horizontal')).toBe(true);
    expect(toggleButton().getAttribute('aria-pressed')).toBe('true');
  });

  it('coerces an unrecognized persisted value to vertical (D4)', async () => {
    const { root } = mountCanvas({ initialReadingMode: 'sideways-nonsense' });
    expect(root.classList.contains('codev-canvas-mode-horizontal')).toBe(false);
    expect(toggleButton().getAttribute('aria-pressed')).toBe('false');
  });

  it('toggle flips the mode class both ways and emits onReadingModeChange', async () => {
    const onReadingModeChange = vi.fn();
    const { root, body } = mountCanvas({ onReadingModeChange });
    await waitFor(() => expect(body.querySelector('h1')).not.toBeNull());

    act(() => { toggleButton().click(); });
    expect(root.classList.contains('codev-canvas-mode-horizontal')).toBe(true);
    expect(onReadingModeChange).toHaveBeenLastCalledWith('horizontal');
    expect(toggleButton().getAttribute('aria-pressed')).toBe('true');

    act(() => { toggleButton().click(); });
    expect(root.classList.contains('codev-canvas-mode-horizontal')).toBe(false);
    expect(onReadingModeChange).toHaveBeenLastCalledWith('vertical');
    expect(onReadingModeChange).toHaveBeenCalledTimes(2);
  });

  it('works without onReadingModeChange (persistence-less host)', async () => {
    const { root, body } = mountCanvas();
    await waitFor(() => expect(body.querySelector('h1')).not.toBeNull());
    act(() => { toggleButton().click(); });
    expect(root.classList.contains('codev-canvas-mode-horizontal')).toBe(true);
  });

  it('mode survives a content rebuild (watch reload — spec Test Scenario 9, state half)', async () => {
    const { root, body, store } = mountCanvas({ initialReadingMode: 'horizontal' });
    await waitFor(() => expect(body.querySelector('h1')).not.toBeNull());

    act(() => { store.setText('# Replaced\n\nNew content entirely.'); });
    await waitFor(() => expect(body.querySelector('h1')?.textContent).toBe('Replaced'));
    expect(root.classList.contains('codev-canvas-mode-horizontal')).toBe(true);
  });

  it('restores the viewport-start block after a switch, axis-aware (D7)', async () => {
    const { body } = mountCanvas();
    await waitFor(() => expect(body.querySelector('h1')).not.toBeNull());

    // jsdom has no layout: give the blocks distinct client rects so the viewport-start scan
    // (vertical: first block whose bottom > 0) lands on the SECOND block, not the first.
    const blocks = Array.from(body.querySelectorAll<HTMLElement>('[data-line]'));
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    blocks.forEach((el, i) => {
      const top = i * 100 - 150; // block 0 fully above the viewport (bottom = -50)
      el.getBoundingClientRect = () =>
        ({ top, bottom: top + 100, left: 0, right: 500, width: 500, height: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    });
    const scrolled: Array<{ el: HTMLElement; opts: ScrollIntoViewOptions | undefined }> = [];
    blocks.forEach((el) => {
      el.scrollIntoView = ((opts?: ScrollIntoViewOptions) => { scrolled.push({ el, opts }); }) as HTMLElement['scrollIntoView'];
    });

    act(() => { toggleButton().click(); }); // vertical → horizontal
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0].el).toBe(blocks[1]);
    // Axis-aware restore: horizontal brings the block to the reading start on the inline axis.
    expect(scrolled[0].opts).toEqual({ inline: 'start', block: 'nearest' });
  });

  // NOTE: the nearest-preceding-block fallback for a vanished anchor line shares the exact
  // query shape already exercised by the #1237 focus-restoration tests (pendingFocusLineRef in
  // artifact-canvas.test.tsx); it triggers only when a watch reload races the switch, which
  // jsdom cannot express honestly (scan and restore run in one commit). The browser fixture
  // (plan phase 2/4) covers the raced path.

  it('publishes --codev-canvas-column-height on the root only in horizontal mode', async () => {
    const { root, body } = mountCanvas();
    await waitFor(() => expect(body.querySelector('h1')).not.toBeNull());
    expect(root.style.getPropertyValue('--codev-canvas-column-height')).toBe('');

    act(() => { toggleButton().click(); });
    // jsdom clientHeight is 0; the contract under test is presence + px form + cleanup.
    expect(root.style.getPropertyValue('--codev-canvas-column-height')).toMatch(/^\d+px$/);

    act(() => { toggleButton().click(); });
    expect(root.style.getPropertyValue('--codev-canvas-column-height')).toBe('');
  });

  it('toggle is a labeled button (keyboard-operable, a11y)', async () => {
    mountCanvas();
    const btn = toggleButton();
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.getAttribute('aria-label')).toBeTruthy();
  });
});
