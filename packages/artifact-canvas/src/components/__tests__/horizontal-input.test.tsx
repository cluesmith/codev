import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, waitFor, cleanup, act, fireEvent } from '@testing-library/react';
import * as React from 'react';
import { ArtifactCanvas } from '../ArtifactCanvas.js';
import { innerScrollerCanConsume, wheelDeltaPx, blockScrollOptions } from '../column-geometry.js';
import { createStore, stubFileAdapter, stubMarkerAdapter, stubThemeAdapter } from '../../__tests__/fixtures/stub-adapters.js';

afterEach(cleanup);

const DOC = [
  '# Title',
  '',
  'First paragraph.',
  '<!-- REVIEW(@amr): a comment -->',
  '',
  'Second paragraph.',
  '',
  'Third paragraph.',
].join('\n');

async function mountCanvas(extra: Partial<React.ComponentProps<typeof ArtifactCanvas>> = {}) {
  const store = createStore(DOC);
  render(
    <ArtifactCanvas
      uri="artifact://doc.md"
      fileAdapter={stubFileAdapter(store)}
      markerAdapter={stubMarkerAdapter(store)}
      themeAdapter={stubThemeAdapter()}
      onAddComment={vi.fn()}
      {...extra}
    />,
  );
  const body = document.querySelector('.codev-artifact-canvas-body') as HTMLElement;
  await waitFor(() => expect(body.querySelector('h1')).not.toBeNull());
  return { store, body };
}

/** Dispatch a native wheel event (the handler is a native listener, not a React one). */
function wheel(el: HTMLElement, init: WheelEventInit): WheelEvent {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

describe('horizontal wheel remap (spec Constraint 5)', () => {
  it('vertical mode attaches no handler: wheel events are never consumed', async () => {
    const { body } = await mountCanvas();
    const e = wheel(body, { deltaY: 120 });
    expect(e.defaultPrevented).toBe(false);
    expect(body.scrollLeft).toBe(0);
  });

  it('vertical-dominant unmodified wheel becomes horizontal scroll (prevented + scrollLeft)', async () => {
    const { body } = await mountCanvas({ initialReadingMode: 'horizontal' });
    const e = wheel(body, { deltaY: 120, deltaX: 10 });
    expect(e.defaultPrevented).toBe(true);
    expect(body.scrollLeft).toBe(120);
  });

  it('horizontal-dominant deltas pass through (native trackpad gesture)', async () => {
    const { body } = await mountCanvas({ initialReadingMode: 'horizontal' });
    const e = wheel(body, { deltaY: 10, deltaX: 120 });
    expect(e.defaultPrevented).toBe(false);
    expect(body.scrollLeft).toBe(0);
  });

  it('ctrl/meta-modified wheel (pinch-zoom) passes through', async () => {
    const { body } = await mountCanvas({ initialReadingMode: 'horizontal' });
    expect(wheel(body, { deltaY: 120, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(wheel(body, { deltaY: 120, metaKey: true }).defaultPrevented).toBe(false);
    expect(body.scrollLeft).toBe(0);
  });

  it('yields to an inner vertical scroller that can still consume the delta', async () => {
    const { body } = await mountCanvas({ initialReadingMode: 'horizontal' });
    const p = body.querySelector('p') as HTMLElement;
    p.style.overflowY = 'auto';
    Object.defineProperty(p, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(p, 'clientHeight', { value: 100, configurable: true });
    p.scrollTop = 0;

    // Downward delta, scroller not at its end → the scroller owns the event.
    const down = wheel(p, { deltaY: 120 });
    expect(down.defaultPrevented).toBe(false);

    // Scroller exhausted downward → falls through to canvas travel.
    p.scrollTop = 400; // 400 + 100 === 500 (at end)
    const exhausted = wheel(p, { deltaY: 120 });
    expect(exhausted.defaultPrevented).toBe(true);

    // Upward delta with scrollTop > 0 → the scroller owns it again.
    const up = wheel(p, { deltaY: -120 });
    expect(up.defaultPrevented).toBe(false);
  });

  it('toggling back to vertical detaches the handler', async () => {
    const { body } = await mountCanvas({ initialReadingMode: 'horizontal' });
    const btn = document.querySelector('.codev-canvas-reading-mode-toggle') as HTMLButtonElement;
    act(() => { btn.click(); });
    const e = wheel(body, { deltaY: 120 });
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('column paging (PageUp/PageDown)', () => {
  async function mountHorizontalWithGeometry() {
    const utils = await mountCanvas({ initialReadingMode: 'horizontal' });
    const { body } = utils;
    // jsdom has no layout: fabricate the measured geometry — first child measures one
    // 400px-wide fragment, 48px gap, 1600px viewport, 5333px of columns.
    const first = body.firstElementChild as HTMLElement;
    first.getClientRects = (() =>
      [{ width: 400, left: 0, top: 0, right: 400, bottom: 100, height: 100 }] as unknown as DOMRectList) as HTMLElement['getClientRects'];
    const style = getComputedStyle(body);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
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
      return getComputedStyleOriginal(el);
    });
    Object.defineProperty(body, 'scrollWidth', { value: 5333, configurable: true });
    Object.defineProperty(body, 'clientWidth', { value: 1600, configurable: true });
    return utils;
  }
  const getComputedStyleOriginal = window.getComputedStyle.bind(window);
  afterEach(() => { vi.restoreAllMocks(); });

  it('PageDown advances one column step, landing on a column start', async () => {
    const { body } = await mountHorizontalWithGeometry();
    const block = body.querySelector('[data-line]') as HTMLElement;
    block.focus();
    fireEvent.keyDown(block, { key: 'PageDown' });
    expect(body.scrollLeft).toBe(448); // 400 + 48

    body.scrollLeft = 500; // mid-column drift
    fireEvent.keyDown(block, { key: 'PageDown' });
    expect(body.scrollLeft).toBe(2 * 448); // quantized to the grid, then +1
  });

  it('PageUp steps back and clamps at 0', async () => {
    const { body } = await mountHorizontalWithGeometry();
    const block = body.querySelector('[data-line]') as HTMLElement;
    body.scrollLeft = 448;
    fireEvent.keyDown(block, { key: 'PageUp' });
    expect(body.scrollLeft).toBe(0);
    fireEvent.keyDown(block, { key: 'PageUp' });
    expect(body.scrollLeft).toBe(0);
  });

  it('paging yields to a focused inner vertical scroller (same rule as the wheel remap)', async () => {
    const { body } = await mountHorizontalWithGeometry();
    const block = body.querySelector('[data-line]') as HTMLElement;
    block.style.overflowY = 'auto';
    Object.defineProperty(block, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(block, 'clientHeight', { value: 100, configurable: true });
    block.scrollTop = 0;
    block.focus();
    // Scroller can consume a downward page → the key stays native (no canvas paging).
    const notPrevented = fireEvent.keyDown(block, { key: 'PageDown' });
    expect(notPrevented).toBe(true);
    expect(body.scrollLeft).toBe(0);
    // Exhausted downward → the canvas pages.
    block.scrollTop = 400;
    fireEvent.keyDown(block, { key: 'PageDown' });
    expect(body.scrollLeft).toBe(448);
  });

  it('paging keys are inert in vertical mode', async () => {
    const { body } = await mountCanvas();
    const block = body.querySelector('[data-line]') as HTMLElement;
    const e = fireEvent.keyDown(block, { key: 'PageDown' });
    expect(e).toBe(true); // not prevented — native behavior retained
    expect(body.scrollLeft).toBe(0);
  });

  it('keystrokes inside the composer are never intercepted', async () => {
    const { body } = await mountCanvas({ initialReadingMode: 'horizontal' });
    const block = body.querySelector('[data-line]') as HTMLElement;
    fireEvent.keyDown(block, { key: 'Enter' }); // open composer
    const textarea = await waitFor(() => {
      const t = document.querySelector('.codev-canvas-comment-composer-input');
      expect(t).not.toBeNull();
      return t as HTMLTextAreaElement;
    });
    const notPrevented = fireEvent.keyDown(textarea, { key: 'PageDown' });
    expect(notPrevented).toBe(true); // composer keeps its native key behavior
    expect(body.scrollLeft).toBe(0);
  });
});

describe('axis-aware navigation', () => {
  it('n/p jumps use inline centering in horizontal, block centering in vertical', async () => {
    for (const mode of ['vertical', 'horizontal'] as const) {
      cleanup();
      const { body } = await mountCanvas({ initialReadingMode: mode });
      await waitFor(() =>
        expect(body.querySelector('.codev-canvas-has-marker')).not.toBeNull(),
      );
      const calls: ScrollIntoViewOptions[] = [];
      body.querySelectorAll<HTMLElement>('[data-line]').forEach((el) => {
        el.scrollIntoView = ((opts?: ScrollIntoViewOptions) => {
          calls.push(opts as ScrollIntoViewOptions);
        }) as HTMLElement['scrollIntoView'];
      });
      const first = body.querySelector('[data-line]') as HTMLElement;
      first.focus();
      fireEvent.keyDown(first, { key: 'n' });
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]).toEqual(blockScrollOptions(mode));
    }
  });

  it('card bodies are focusable scrollers in horizontal mode only', async () => {
    const { body } = await mountCanvas({ initialReadingMode: 'horizontal' });
    await waitFor(() =>
      expect(body.querySelector('.codev-canvas-marker-card-body')).not.toBeNull(),
    );
    expect(
      body.querySelector('.codev-canvas-marker-card-body')?.getAttribute('tabindex'),
    ).toBe('0');

    const btn = document.querySelector('.codev-canvas-reading-mode-toggle') as HTMLButtonElement;
    act(() => { btn.click(); }); // → vertical: re-injected cards drop the tabindex
    await waitFor(() =>
      expect(
        body.querySelector('.codev-canvas-marker-card-body')?.getAttribute('tabindex'),
      ).toBeNull(),
    );
  });
});

describe('legend and minimap (phase-3 deliverables)', () => {
  it('keys legend lists the paging row only in horizontal mode', async () => {
    for (const mode of ['vertical', 'horizontal'] as const) {
      cleanup();
      const { body } = await mountCanvas({ initialReadingMode: mode });
      const block = body.querySelector('[data-line]') as HTMLElement;
      block.focus();
      fireEvent.keyDown(block, { key: '?' });
      const help = await waitFor(() => {
        const h = document.querySelector('.codev-canvas-keyboard-help');
        expect(h).not.toBeNull();
        return h as HTMLElement;
      });
      if (mode === 'horizontal') {
        expect(help.textContent).toContain('PgUp / PgDn');
      } else {
        expect(help.textContent).not.toContain('PgUp / PgDn');
      }
    }
  });

  it('minimap dot click scrolls axis-aware (overlay-level: the canvas suppresses it in horizontal)', async () => {
    // Phase 5 suppresses the minimap in horizontal mode (D3), so the axis-aware prop is
    // exercised by rendering the overlay directly — it stays correct for re-enablement.
    const { MarkerMinimap } = await import('../../overlays/MarkerMinimap.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const block = document.createElement('p');
    block.setAttribute('data-line', '2');
    host.appendChild(block);
    const calls: ScrollIntoViewOptions[] = [];
    block.scrollIntoView = ((opts?: ScrollIntoViewOptions) => {
      calls.push(opts as ScrollIntoViewOptions);
    }) as HTMLElement['scrollIntoView'];
    const bodyRef = { current: host as HTMLDivElement };
    render(
      <MarkerMinimap
        markers={[{ author: 'amr', line: 2, text: 'x', raw: '<!-- REVIEW(@amr): x -->' }]}
        bodyRef={bodyRef}
        readingMode="horizontal"
      />,
    );
    const dot = document.querySelector('.codev-canvas-minimap-dot') as HTMLButtonElement;
    act(() => { dot.click(); });
    expect(calls[0]).toEqual(blockScrollOptions('horizontal'));
    host.remove();
  });

  it('paging with unmeasurable geometry leaves the key to the browser', async () => {
    const { body } = await mountCanvas({ initialReadingMode: 'horizontal' });
    // jsdom: no rects and clientWidth 0 → step 0 → no preventDefault, no movement.
    const block = body.querySelector('[data-line]') as HTMLElement;
    block.focus();
    const notPrevented = fireEvent.keyDown(block, { key: 'PageDown' });
    expect(notPrevented).toBe(true);
    expect(body.scrollLeft).toBe(0);
  });
});

describe('column-geometry helpers (pure)', () => {
  it('wheelDeltaPx normalizes line and page delta modes', () => {
    const px = { deltaY: 3, deltaMode: 0 } as WheelEvent;
    const lines = { deltaY: 3, deltaMode: 1 } as WheelEvent;
    const pages = { deltaY: 2, deltaMode: 2 } as WheelEvent;
    expect(wheelDeltaPx(px, 900)).toBe(3);
    expect(wheelDeltaPx(lines, 900)).toBe(48);
    expect(wheelDeltaPx(pages, 900)).toBe(1800);
  });

  it('innerScrollerCanConsume is false for non-scrollable chains', () => {
    const div = document.createElement('div');
    const child = document.createElement('span');
    div.appendChild(child);
    document.body.appendChild(div);
    expect(innerScrollerCanConsume(child, 100, div)).toBe(false);
    div.remove();
  });
});
