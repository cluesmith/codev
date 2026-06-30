import * as React from 'react';
import type { ReviewMarker } from '../types.js';

export interface MarkerMinimapProps {
  /** The markers to plot — one dot per marker (#863). */
  markers: ReviewMarker[];
  /** The rendered-body element the dots are positioned against (the canvas scroll content). */
  bodyRef: React.RefObject<HTMLDivElement | null>;
}

/** First ~80 chars of a marker body, for the hover tooltip (AC: "author + truncated body"). */
function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

interface Dot {
  marker: ReviewMarker;
  /** 0..1 fraction of the body height where the marker's block sits. */
  frac: number;
}

/**
 * Right-edge marker minimap (#863): a fixed vertical column with one dot per REVIEW marker,
 * positioned proportional to the marker's block within the rendered body. Hovering a dot shows
 * `author: truncated body`; clicking smooth-scrolls the canvas to that block. The column is
 * hidden entirely when the document has zero markers, and recomputes dot positions on body
 * resize (which also covers a content rebuild) — both AC requirements.
 *
 * Positioning reads layout (`offsetTop` / `scrollHeight`), so it is only meaningful in a real
 * browser/webview; under jsdom the values are 0 and every dot collapses to the top — the unit
 * tests therefore assert structure/behavior (dot count, hidden-when-empty, click→scroll, tooltip),
 * and pixel placement is verified on the running worktree at the `dev-approval` gate.
 */
export function MarkerMinimap({ markers, bodyRef }: MarkerMinimapProps): React.ReactElement | null {
  const [dots, setDots] = React.useState<Dot[]>([]);

  React.useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) {
      setDots([]);
      return;
    }
    const compute = (): void => {
      const total = body.scrollHeight || 1;
      setDots(
        markers.map((marker) => {
          const el = body.querySelector<HTMLElement>(`[data-line="${marker.line}"]`);
          const top = el ? el.offsetTop : 0;
          const frac = Math.min(1, Math.max(0, top / total));
          return { marker, frac };
        }),
      );
    };
    compute();
    // A ResizeObserver on the body fires on content rebuild AND window resize (both change the
    // body's height), covering the "updates on resize and rebuild" AC with one observer. Guarded
    // for non-browser hosts (e.g. jsdom under test) that don't provide ResizeObserver — the
    // one-shot compute() above still positions the dots from current layout.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(compute);
    ro.observe(body);
    return () => ro.disconnect();
  }, [markers, bodyRef]);

  if (markers.length === 0) return null; // hidden when the doc has zero markers (AC)

  return (
    <div className="codev-canvas-minimap" aria-label="Review marker minimap">
      {dots.map((dot, i) => (
        <button
          key={String(i)}
          type="button"
          className="codev-canvas-minimap-dot"
          style={{ top: `${dot.frac * 100}%` }}
          title={`${dot.marker.author}: ${truncate(dot.marker.text)}`}
          aria-label={`Jump to comment by ${dot.marker.author} on line ${dot.marker.line + 1}`}
          onClick={() => {
            const el = bodyRef.current?.querySelector<HTMLElement>(
              `[data-line="${dot.marker.line}"]`,
            );
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }}
        />
      ))}
    </div>
  );
}
