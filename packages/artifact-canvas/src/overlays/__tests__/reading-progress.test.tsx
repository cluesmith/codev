import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, waitFor, cleanup, act, fireEvent } from '@testing-library/react';
import * as React from 'react';
import { ReadingProgress } from '../ReadingProgress.js';
import { ArtifactCanvas } from '../../components/ArtifactCanvas.js';
import { createStore, stubFileAdapter, stubMarkerAdapter, stubThemeAdapter } from '../../__tests__/fixtures/stub-adapters.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A fake scrollable body with fabricated column geometry (jsdom has no layout). */
function makeBody(opts: { scrollWidth: number; clientWidth: number; columnWidth: number; gap: number }): HTMLDivElement {
  const body = document.createElement('div');
  document.body.appendChild(body);
  const child = document.createElement('p');
  body.appendChild(child);
  child.getClientRects = (() =>
    [{ width: opts.columnWidth, left: 0, top: 0, right: opts.columnWidth, bottom: 100, height: 100 }] as unknown as DOMRectList) as HTMLElement['getClientRects'];
  Object.defineProperty(body, 'scrollWidth', { value: opts.scrollWidth, configurable: true });
  Object.defineProperty(body, 'clientWidth', { value: opts.clientWidth, configurable: true });
  const original = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
    const style = original(el);
    if (el === body) {
      return new Proxy(style, {
        get(target, prop) {
          if (prop === 'columnGap') return `${opts.gap}px`;
          const v = Reflect.get(target, prop);
          if (typeof v === 'function') return v.bind(target);
          return v;
        },
      }) as CSSStyleDeclaration;
    }
    return style;
  });
  return body;
}

describe('ReadingProgress (spec 1380 D8)', () => {
  it('renders "Column k of n" from measured geometry and tracks scroll', async () => {
    // 12 columns of 400 + 11 gaps of 48 → scrollWidth 5328; +48 = 12 steps of 448.
    const body = makeBody({ scrollWidth: 5328, clientWidth: 1600, columnWidth: 400, gap: 48 });
    render(<ReadingProgress bodyRef={{ current: body }} />);
    await waitFor(() =>
      expect(document.querySelector('.codev-canvas-reading-progress')).not.toBeNull(),
    );
    const visible = document.querySelector('.codev-canvas-reading-progress [aria-hidden]');
    expect(visible?.textContent).toBe('Column 1 of 12');

    body.scrollLeft = 448 * 3;
    act(() => { fireEvent.scroll(body); });
    expect(
      document.querySelector('.codev-canvas-reading-progress [aria-hidden]')?.textContent,
    ).toBe('Column 4 of 12');
    body.remove();
  });

  it('hidden when the document fits the viewport', async () => {
    const body = makeBody({ scrollWidth: 1200, clientWidth: 1600, columnWidth: 400, gap: 48 });
    render(<ReadingProgress bodyRef={{ current: body }} />);
    await act(async () => {}); // flush the effect
    expect(document.querySelector('.codev-canvas-reading-progress')).toBeNull();
    body.remove();
  });

  it('announces on a debounce, not per scroll tick (aria-live)', async () => {
    vi.useFakeTimers();
    const body = makeBody({ scrollWidth: 5328, clientWidth: 1600, columnWidth: 400, gap: 48 });
    render(<ReadingProgress bodyRef={{ current: body }} />);
    act(() => { vi.advanceTimersByTime(0); });
    const live = () => document.querySelector('.codev-canvas-visually-hidden');
    expect(live()).not.toBeNull();
    expect(live()?.textContent).toBe(''); // nothing announced yet

    // A burst of scroll ticks produces exactly one trailing announcement.
    for (const col of [1, 2, 3]) {
      body.scrollLeft = 448 * col;
      act(() => { fireEvent.scroll(body); });
      act(() => { vi.advanceTimersByTime(100); });
      expect(live()?.textContent).toBe('');
    }
    act(() => { vi.advanceTimersByTime(400); });
    expect(live()?.textContent).toBe('Column 4 of 12');
    body.remove();
  });
});

describe('phase-5 canvas chrome wiring', () => {
  const DOC = '# Title\n\nA paragraph.\n<!-- REVIEW(@amr): note -->\n\nAnother.';

  async function mountCanvas(mode?: string) {
    const store = createStore(DOC);
    render(
      <ArtifactCanvas
        uri="artifact://doc.md"
        fileAdapter={stubFileAdapter(store)}
        markerAdapter={stubMarkerAdapter(store)}
        themeAdapter={stubThemeAdapter()}
        onAddComment={vi.fn()}
        initialReadingMode={mode}
      />,
    );
    const body = document.querySelector('.codev-artifact-canvas-body') as HTMLElement;
    await waitFor(() => expect(body.querySelector('h1')).not.toBeNull());
    return body;
  }

  it('minimap renders in vertical, suppressed in horizontal (D3)', async () => {
    const body = await mountCanvas();
    await waitFor(() =>
      expect(document.querySelector('.codev-canvas-minimap')).not.toBeNull(),
    );
    const toggle = document.querySelector('.codev-canvas-reading-mode-toggle') as HTMLButtonElement;
    act(() => { toggle.click(); });
    expect(document.querySelector('.codev-canvas-minimap')).toBeNull();
    act(() => { toggle.click(); });
    await waitFor(() =>
      expect(document.querySelector('.codev-canvas-minimap')).not.toBeNull(),
    );
  });

  it('body is a labeled, focusable region ONLY in horizontal (Constraint 7 / vertical untouched)', async () => {
    const body = await mountCanvas();
    expect(body.getAttribute('tabindex')).toBeNull();
    expect(body.getAttribute('role')).toBeNull();
    expect(body.getAttribute('aria-roledescription')).toBeNull();

    const toggle = document.querySelector('.codev-canvas-reading-mode-toggle') as HTMLButtonElement;
    act(() => { toggle.click(); });
    expect(body.getAttribute('tabindex')).toBe('0');
    expect(body.getAttribute('role')).toBe('region');
    expect(body.getAttribute('aria-roledescription')).toBe('multi-column reading view');
  });

  it('paging works with focus on the container itself (phase-5 reachability decision)', async () => {
    const body = await mountCanvas('horizontal');
    const first = body.firstElementChild as HTMLElement;
    first.getClientRects = (() =>
      [{ width: 400, left: 0, top: 0, right: 400, bottom: 100, height: 100 }] as unknown as DOMRectList) as HTMLElement['getClientRects'];
    const original = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
      const style = original(el);
      if (el === body) {
        return new Proxy(style, {
          get(target, prop) {
            if (prop === 'columnGap') return '48px';
            const v = Reflect.get(target, prop);
            if (typeof v === 'function') return v.bind(target);
            return v;
          },
        }) as CSSStyleDeclaration;
      }
      return style;
    });
    Object.defineProperty(body, 'scrollWidth', { value: 5328, configurable: true });
    Object.defineProperty(body, 'clientWidth', { value: 1600, configurable: true });

    body.focus();
    fireEvent.keyDown(body, { key: 'PageDown' });
    expect(body.scrollLeft).toBe(448);
  });
});
