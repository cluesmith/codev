import * as React from 'react';
import { measureColumnGeometry } from '../components/column-geometry.js';

export interface ReadingProgressProps {
  /** The horizontally-scrolling multicol body the readout tracks. */
  bodyRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Changes whenever the body's CONTENT changes (the canvas passes its rendered html). The
   * body is fixed-height in horizontal mode, so a content swap moves `scrollWidth` without
   * firing the ResizeObserver (it watches the border box) or the scroll listener — without
   * this dependency the readout computed against an empty body at mount and never woke up.
   */
  contentKey?: unknown;
}

interface Progress {
  current: number;
  total: number;
}

/** Milliseconds between screen-reader announcements — visible text updates live, but a
 * per-scroll-tick aria-live stream would be spam (spec Constraint 7 / D8). */
const ANNOUNCE_DEBOUNCE_MS = 400;

/**
 * Horizontal-mode progress readout (spec 1380 D8): "Column k of n", derived from scroll
 * position and MEASURED column geometry (phase 3's helper — the width token is a preferred
 * minimum, not the rendered width). Mounted by the canvas only in horizontal mode. Hidden when
 * the whole document fits (nothing to indicate). Two output surfaces: a visible token-styled
 * chip (aria-hidden — it duplicates the announcement) and a visually-hidden `aria-live` region
 * updated on a debounce.
 *
 * Layout reads (`scrollWidth`, client rects) are only meaningful in a real browser; under
 * jsdom the readout computes total=0 and renders nothing — the unit tests therefore fabricate
 * geometry, and live behavior is asserted in the Playwright suite (the minimap precedent).
 */
export function ReadingProgress({ bodyRef, contentKey }: ReadingProgressProps): React.ReactElement | null {
  const [progress, setProgress] = React.useState<Progress | null>(null);
  const [announced, setAnnounced] = React.useState<string>('');
  const announceTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    const body = bodyRef.current;
    if (!body) {
      setProgress(null);
      return;
    }
    const compute = (): void => {
      if (body.scrollWidth <= body.clientWidth) {
        setProgress(null); // everything fits — no positional feedback needed
        return;
      }
      const { gap, step } = measureColumnGeometry(body);
      if (step <= 0) {
        setProgress(null);
        return;
      }
      // scrollWidth counts n columns + (n-1) gaps; adding one gap makes it n whole steps.
      const total = Math.max(1, Math.round((body.scrollWidth + gap) / step));
      const current = Math.min(total, Math.round(body.scrollLeft / step) + 1);
      // Bail on unchanged values: `compute` runs per scroll tick, and a fresh object every
      // tick would re-render the chip continuously for nothing (phase-5 consult).
      setProgress((prev) => {
        if (prev && prev.current === current && prev.total === total) return prev;
        return { current, total };
      });
    };
    compute();
    // Child effects run BEFORE the canvas's imperative innerHTML effect, so on a content
    // change this effect fires while the body still holds the old children — recompute once
    // more after layout settles.
    const raf = requestAnimationFrame(compute);
    body.addEventListener('scroll', compute, { passive: true });
    // Async media (an image finishing its load) grows scrollWidth with no scroll, no
    // border-box resize, and no content change — catch it via the capture phase, since
    // `load` doesn't bubble.
    body.addEventListener('load', compute, true);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(compute);
      ro.observe(body);
    }
    return () => {
      cancelAnimationFrame(raf);
      body.removeEventListener('scroll', compute);
      body.removeEventListener('load', compute, true);
      ro?.disconnect();
    };
  }, [bodyRef, contentKey]);

  // Debounced announcement: trail the visible readout so a continuous scroll produces one
  // announcement, not one per tick.
  React.useEffect(() => {
    if (progress === null) {
      setAnnounced('');
      return;
    }
    if (announceTimer.current !== null) {
      clearTimeout(announceTimer.current);
    }
    announceTimer.current = setTimeout(() => {
      announceTimer.current = null;
      setAnnounced(`Column ${progress.current} of ${progress.total}`);
    }, ANNOUNCE_DEBOUNCE_MS);
    return () => {
      if (announceTimer.current !== null) {
        clearTimeout(announceTimer.current);
        announceTimer.current = null;
      }
    };
  }, [progress]);

  if (progress === null) return null;

  return (
    <div className="codev-canvas-reading-progress">
      <span aria-hidden="true">{`Column ${progress.current} of ${progress.total}`}</span>
      <span className="codev-canvas-visually-hidden" aria-live="polite">
        {announced}
      </span>
    </div>
  );
}
