import * as React from 'react';
import { createPortal } from 'react-dom';
import type { ArtifactCanvasProps, ReviewMarker } from '../types.js';
import { renderMarkdown } from '../renderer/renderer.js';
import { CommentAffordance } from '../overlays/CommentAffordance.js';
import { CommentComposer } from '../overlays/CommentComposer.js';
import { MarkerMinimap } from '../overlays/MarkerMinimap.js';

/**
 * ArtifactCanvas — the composed review surface (Phase 3).
 *
 * Data flow (spec D2/D6): reads content via `FileAdapter.read`, lists markers via
 * `MarkerAdapter.list`, and subscribes to `FileAdapter.watch` (the only subscription). When the
 * file changes it re-renders and auto re-lists markers. It emits comment *intent* via
 * `onAddComment(line)` and never calls `MarkerAdapter.add` itself (the host does the input +
 * write-back). `themeAdapter` is accepted but NOT used for rendering (spec D4, Model A — theming
 * is CSS-variable driven; `resolve()`/`onChange` are for #863's canvas).
 *
 * Errors from the adapter calls the component makes are caught, logged, and surfaced via the
 * optional `onError` prop; the component never throws out of an event handler, and a failed
 * `list()` leaves the prior markers in place (spec D2).
 */
/**
 * Build an inline-below comment-card stack for one annotated block (#863). Returns a `<ul>` to be
 * inserted as the block's next sibling. Markers render in `markers` order — i.e. the order
 * `parseReviewMarkers` produces (creation order). Author and body are set via `textContent`, so
 * document-supplied text can never inject markup into the canvas.
 */
function buildMarkerCards(
  line: number,
  markers: ReviewMarker[],
  canEdit: boolean,
  canDelete: boolean,
): HTMLUListElement {
  const stack = document.createElement('ul');
  stack.className = 'codev-canvas-marker-cards';
  // Human-facing line numbers are 1-based; the data model stays 0-based (spec D5).
  stack.setAttribute('aria-label', `Comments on line ${line + 1}`);
  for (const m of markers) {
    const card = document.createElement('li');
    card.className = 'codev-canvas-marker-card';

    const icon = document.createElement('span');
    icon.className = 'codev-canvas-marker-card-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '💬';

    const author = document.createElement('span');
    author.className = 'codev-canvas-marker-card-author';
    author.textContent = m.author;

    const body = document.createElement('span');
    body.className = 'codev-canvas-marker-card-body';
    body.textContent = m.text;

    card.append(icon, author, body);

    // Edit/delete affordances (#1055). Only rendered when the host provided the matching intent
    // callback AND the marker carries its own physical file line (the identity the host writes
    // against). The buttons are tagged with `data-action` + `data-marker-line`; a delegated click
    // handler on the body routes them (matching the imperative-DOM pattern the cards use). A
    // read-only host (no callbacks) or a marker without `markerLine` renders a plain card, unchanged.
    if (m.markerLine !== undefined && (canEdit || canDelete)) {
      const actions = document.createElement('span');
      actions.className = 'codev-canvas-marker-card-actions';
      if (canEdit) {
        actions.append(makeCardAction('edit', m.markerLine, `Edit comment by ${m.author}`));
      }
      if (canDelete) {
        actions.append(makeCardAction('delete', m.markerLine, `Delete comment by ${m.author}`));
      }
      card.append(actions);
    }

    stack.append(card);
  }
  return stack;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * A 16-grid stroke icon built from static path data (no user input, so no injection surface). We
 * draw our own SVGs rather than reuse a font glyph or the host's icon set: the package is
 * host-agnostic (it can't assume VS Code's codicon font is present in the webview), and emoji
 * render inconsistently across platforms. `currentColor` lets the button's CSS drive the tint.
 */
function svgIcon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

// Pencil (edit) and trash-can (delete) — plain line icons matching a codicon-ish weight.
const CARD_ICONS: Record<'edit' | 'delete', () => SVGSVGElement> = {
  edit: () => svgIcon(['M10.8 2.9l2.3 2.3', 'M11.5 2.2a1 1 0 0 1 1.4 0l.9.9a1 1 0 0 1 0 1.4l-7.6 7.6-2.7.6.6-2.7 7.4-7.4z']),
  delete: () =>
    svgIcon([
      'M3 4.5h10',
      'M6.4 4.5V3.1a.6.6 0 0 1 .6-.6h2a.6.6 0 0 1 .6.6v1.4',
      'M4.6 4.5l.5 8.4a1 1 0 0 0 1 .95h3.8a1 1 0 0 0 1-.95l.5-8.4',
      'M6.8 6.8v4.4',
      'M9.2 6.8v4.4',
    ]),
};

/** One card action button (edit/delete). Identity travels on `data-marker-line`; the delegated
 * handler resolves author + body from the marker list, so the button carries no user text. */
function makeCardAction(
  action: 'edit' | 'delete',
  markerLine: number,
  label: string,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `codev-canvas-marker-card-action codev-canvas-marker-card-${action}`;
  btn.dataset.action = action;
  btn.dataset.markerLine = String(markerLine);
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.append(CARD_ICONS[action]());
  return btn;
}

export function ArtifactCanvas(props: ArtifactCanvasProps): React.ReactElement {
  const { uri, fileAdapter, markerAdapter, onAddComment, onEditComment, onDeleteComment, onError, refreshKey } = props;
  const canEdit = onEditComment !== undefined;
  const canDelete = onDeleteComment !== undefined;

  const [content, setContent] = React.useState<string>('');
  const [markers, setMarkers] = React.useState<ReviewMarker[]>([]);
  const [activeLine, setActiveLine] = React.useState<number | null>(null);
  // Vertical offset (px, relative to the canvas) of the active block, so the overlay anchors to it.
  const [overlayTop, setOverlayTop] = React.useState(0);
  // The line currently being commented on (the inline composer is open for it), and the in-flow
  // placeholder node the composer portals into — injected directly below that block (#1107).
  const [composingLine, setComposingLine] = React.useState<number | null>(null);
  const [composerHost, setComposerHost] = React.useState<HTMLElement | null>(null);
  // The marker currently being edited (#1055): the composer opens prefilled with its body and
  // submit routes to `onEditComment` instead of `onAddComment`. null → the empty add composer.
  const [editingMarker, setEditingMarker] = React.useState<ReviewMarker | null>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  // Latest markers, readable synchronously from the delegated click handler without re-binding it.
  const markersRef = React.useRef<ReviewMarker[]>(markers);
  markersRef.current = markers;

  const report = React.useCallback(
    (err: unknown) => {
      console.error('[artifact-canvas]', err);
      onError?.(err);
    },
    [onError],
  );

  // Request-versioning: out-of-order async resolutions must never apply stale state — a slow
  // initial read() or an older list() must not overwrite a newer watch update (iter-2 Codex).
  // Each load (initial read or a watch change) takes a monotonically increasing seq; results are
  // applied only while their seq is still the latest.
  const seqRef = React.useRef(0);
  // Warn-once dedup for out-of-range stale markers, so a noisy watch doesn't spam warnings
  // across reloads (deferred #4 AC: "dropped … and warned once"). iter-3 Codex.
  const warnedRef = React.useRef(new Set<string>());

  // Apply content + markers for one load, guarded by `seq`. Out-of-range markers are dropped +
  // warned (deferred #4: ignore, not clamp/hard-error); a failed list() keeps the prior markers.
  const applyLoad = React.useCallback(
    async (text: string, seq: number) => {
      if (seq !== seqRef.current) return; // superseded by a newer load
      setContent(text);
      try {
        const list = await markerAdapter.list(uri);
        if (seq !== seqRef.current) return; // a newer load won the race — discard these markers
        const lineCount = text.length === 0 ? 0 : text.split('\n').length;
        setMarkers(
          list.filter((m) => {
            const ok = m.line >= 0 && m.line < lineCount;
            if (!ok) {
              const key = `${m.line}|${m.author}|${m.text}`;
              if (!warnedRef.current.has(key)) {
                warnedRef.current.add(key);
                console.warn(
                  `[artifact-canvas] dropping out-of-range marker @line ${m.line} (document has ${lineCount} lines)`,
                );
              }
            }
            return ok;
          }),
        );
      } catch (err) {
        if (seq !== seqRef.current) return;
        report(err); // keep prior markers on failure
      }
    },
    [markerAdapter, uri, report],
  );

  // Initial read + the single watch subscription (spec D2/D6).
  React.useEffect(() => {
    let disposed = false;
    const initialSeq = (seqRef.current += 1);
    void (async () => {
      try {
        const text = await fileAdapter.read(uri);
        if (disposed) return;
        await applyLoad(text, initialSeq);
      } catch (err) {
        if (!disposed) report(err);
      }
    })();

    let sub: { dispose(): void } = { dispose: () => {} };
    try {
      sub = fileAdapter.watch(uri, (newContent) => {
        if (disposed) return;
        const watchSeq = (seqRef.current += 1); // each change is a newer load
        void applyLoad(newContent, watchSeq); // auto re-list on change (D6)
      });
    } catch (err) {
      // A synchronous failure setting up the subscription must not throw out of the effect (D2).
      report(err);
    }

    return () => {
      disposed = true;
      sub.dispose(); // idempotent per the Disposable contract (spec D2)
    };
    // `refreshKey` in the deps: a host without a watcher bumps it to force a fresh read+list (D6).
  }, [fileAdapter, uri, applyLoad, report, refreshKey]);

  const html = React.useMemo(() => renderMarkdown(content), [content]);

  // Own the markdown body imperatively rather than via React's `dangerouslySetInnerHTML`. React
  // must NOT manage these children: when it did, a re-render would re-commit `innerHTML` and wipe
  // the comment cards we inject below (the "cards flash then vanish" bug — the React-rendered
  // minimap survived precisely because React owned it, while the injected cards did not). With the
  // body left out of React's child reconciliation, the cards + decoration we add are stable. This
  // is the standard React escape hatch for integrating non-React DOM: render an empty container and
  // fill it in an effect. Runs only when `html` changes, so a markers-only update (below) does not
  // rebuild the body and lose scroll/focus. Synthetic events still fire — the handlers live on this
  // div and native events from the (non-fiber) children bubble to it exactly as before.
  React.useEffect(() => {
    const root = bodyRef.current;
    if (root) root.innerHTML = html;
  }, [html]);

  // Decorate the body after it (re)renders: mark lines that carry a ReviewMarker and inject an
  // inline-below comment-card stack for each annotated block (#863). The stack is a real DOM sibling
  // inserted *after* the block, so it sits in normal flow and pushes subsequent content down — it
  // never overlaps the block (the layout fix that replaced the absolutely-positioned hover overlay
  // marker-list). Card author/body use textContent, never innerHTML, so document-supplied marker
  // text can't inject markup. Declared AFTER the innerHTML effect so on an `html` change the body is
  // rebuilt first, then decorated.
  React.useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    // Remove previously-injected stacks first so a markers-only update (the body is NOT rebuilt
    // then) doesn't accumulate duplicates. Idempotent on an html change too (body just rebuilt).
    root.querySelectorAll('.codev-canvas-marker-cards').forEach((n) => n.remove());

    const byLine = new Map<number, ReviewMarker[]>();
    for (const m of markers) {
      const arr = byLine.get(m.line) ?? [];
      arr.push(m);
      byLine.set(m.line, arr);
    }
    // (tabindex is stamped at render time by the renderer, not here — keeps focusability free of
    // this effect's timing.) This effect only applies marker decoration, which depends on the
    // asynchronously-loaded markers.
    // The renderer stamps the same `data-line` on multiple nested blocks for one source line
    // (e.g. both a `ul` and its `li`; see renderer/__tests__/data-line.test.ts). Anchor the card
    // stack + decoration to the FIRST match per line only — querySelectorAll yields tree order, so
    // the first match is the outermost block for that line. Without this guard a list/blockquote
    // marker injects a duplicate stack and, worse, invalid DOM: the stack is itself a `<ul>`, so
    // `el.after(...)` on the inner `<li>` nests `ul > ul`. (Codex review iter-1.)
    const decoratedLines = new Set<number>();
    root.querySelectorAll<HTMLElement>('[data-line]').forEach((el) => {
      const line = Number(el.getAttribute('data-line'));
      const ms = byLine.get(line);
      el.removeAttribute('title'); // the inline cards show author+text now — no tooltip needed
      if (ms && ms.length > 0 && !decoratedLines.has(line)) {
        decoratedLines.add(line);
        el.classList.add('codev-canvas-has-marker');
        el.after(buildMarkerCards(line, ms, canEdit, canDelete)); // inline-below, in flow (#863)
      } else {
        // Inner siblings that share the line (and genuinely unmarked blocks) get no card and no
        // decoration; any stale class from a prior markers-only re-render is cleared here too.
        el.classList.remove('codev-canvas-has-marker');
      }
    });
    // Reconcile the overlay anchor against the *reloaded* DOM (iter-5 Codex): if a watch/refreshKey
    // reload removed or shortened the previously active block, clear `activeLine` so the overlay
    // can't render `+` for — or emit `onAddComment` for — a line the new content no longer has.
    // VALIDATE rather than blindly reset: a still-present active line survives, so this never races
    // a fresh hover (which changes only `activeLine`, not `html`, so this effect doesn't run then).
    setActiveLine((cur) =>
      cur !== null && !root.querySelector(`[data-line="${cur}"]`) ? null : cur,
    );
  }, [html, markers, canEdit, canDelete]);

  // Manage the in-flow composer placeholder (#1107). When `composingLine` is set, inject a
  // placeholder `<div>` directly below that block — AFTER its marker-card stack if present, so the
  // composer reads as the in-progress sibling of the existing comments — and hand the node to the
  // portal below. Declared AFTER the marker-card decoration effect so the card stack already exists
  // when we pick the insertion anchor. Idempotent: if a correctly-placed host already exists for
  // this line we leave it (prevents a setState→re-run loop); an `html` change wipes the body, so the
  // node disconnects and we re-create it. If the target block vanished on reload, close the composer.
  React.useEffect(() => {
    const root = bodyRef.current;
    if (!root) { return; }

    if (composingLine === null) {
      if (composerHost) { composerHost.remove(); setComposerHost(null); }
      return;
    }
    const block = root.querySelector(`[data-line="${composingLine}"]`);
    if (!block) {
      if (composerHost) { composerHost.remove(); }
      setComposerHost(null);
      setComposingLine(null);
      return;
    }
    // Anchor below the block's marker-card stack when it has one, else directly below the block.
    let anchor: Element = block;
    const sib = block.nextElementSibling;
    if (sib?.classList.contains('codev-canvas-marker-cards')) { anchor = sib; }

    if (composerHost?.isConnected && composerHost.previousElementSibling === anchor) {
      return; // already placed correctly — nothing to do (avoids an infinite re-run)
    }
    composerHost?.remove();
    const host = document.createElement('div');
    host.className = 'codev-canvas-comment-composer-host';
    anchor.after(host);
    setComposerHost(host);
  }, [composingLine, html, markers, composerHost]);

  // Comment-intent seam (#1107): clicking "+" / pressing Enter opens the inline composer for the
  // line; submitting emits `onAddComment(line, text)` (the host writes the marker); cancel/Esc just
  // closes it and restores focus to the block so keyboard users aren't stranded.
  const openComposer = (line: number): void => { setEditingMarker(null); setComposingLine(line); };
  const submitComposer = (text: string): void => {
    if (composingLine === null) { return; }
    // Edit vs add (#1055): when a marker is being edited, route to `onEditComment` with the marker's
    // identity (physical line) + the expected author/body for the host's optimistic-concurrency
    // check; otherwise emit the add intent. The host verifies then writes either way.
    if (editingMarker && editingMarker.markerLine !== undefined) {
      onEditComment?.(editingMarker.markerLine, editingMarker.author, editingMarker.text, text);
    } else {
      onAddComment(composingLine, text);
    }
    setEditingMarker(null);
    setComposingLine(null);
  };
  const cancelComposer = (): void => {
    const line = composingLine;
    setEditingMarker(null);
    setComposingLine(null);
    if (line !== null) {
      // The block element persists across this state change (the body is not rebuilt), so focus it
      // synchronously to return the reviewer to where they were.
      bodyRef.current?.querySelector<HTMLElement>(`[data-line="${line}"]`)?.focus();
    }
  };

  // Card-action seam (#1055): a delegated click handler on the body routes the edit/delete buttons
  // injected into each comment card (`data-action` + `data-marker-line`). Edit opens the composer
  // prefilled with the marker's body; delete emits the delete intent immediately. Author + body are
  // resolved from the current marker list (not read off the DOM), so the payload matches the model.
  const onBodyClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const btn = (e.target as HTMLElement | null)?.closest?.('[data-action]') as HTMLElement | null;
    if (!btn) { return; }
    const action = btn.dataset.action;
    const markerLine = Number(btn.dataset.markerLine);
    if (Number.isNaN(markerLine)) { return; }
    const marker = markersRef.current.find((m) => m.markerLine === markerLine);
    if (!marker) { return; }
    if (action === 'delete') {
      onDeleteComment?.(marker.markerLine as number, marker.author, marker.text);
    } else if (action === 'edit') {
      setEditingMarker(marker);
      setComposingLine(marker.line); // portal the composer below this marker's block
    }
  };

  const lineFromEvent = (target: EventTarget | null): number | null => {
    const el = (target as HTMLElement | null)?.closest?.('[data-line]') as HTMLElement | null;
    if (!el) return null;
    const n = Number(el.getAttribute('data-line'));
    return Number.isNaN(n) ? null : n;
  };

  // Activate the hovered/focused block AND anchor the overlay to it: record the block's vertical
  // offset so the `+` affordance renders beside that block. We anchor to the *first line's vertical
  // center* (offsetTop + half the line height) rather than the block's top edge, and the overlay
  // CSS applies `translateY(-50%)` so the `+` lands centered on the first line, not floating above
  // it (#863 bundled polish from the issue comment). (`offsetTop` is relative to
  // `.codev-artifact-canvas`, the positioned ancestor.)
  const activateFromTarget = (target: EventTarget | null): void => {
    const el = (target as HTMLElement | null)?.closest?.('[data-line]') as HTMLElement | null;
    if (!el) return;
    const n = Number(el.getAttribute('data-line'));
    if (Number.isNaN(n)) return;
    setActiveLine(n);
    const cs = getComputedStyle(el);
    let lineHeight = parseFloat(cs.lineHeight);
    if (!Number.isFinite(lineHeight)) {
      const fontSize = parseFloat(cs.fontSize);
      lineHeight = Number.isFinite(fontSize) ? fontSize * 1.2 : 0;
    }
    setOverlayTop(el.offsetTop + lineHeight / 2);
  };

  return (
    <div className="codev-artifact-canvas" onMouseLeave={() => setActiveLine(null)}>
      {/* No `dangerouslySetInnerHTML`: the body's content is set imperatively in the effect above so
          React never re-commits it (which would wipe the injected cards). Rendered with no children. */}
      <div
        ref={bodyRef}
        className="codev-artifact-canvas-body"
        onMouseOver={(e) => activateFromTarget(e.target)}
        onFocus={(e) => activateFromTarget(e.target)}
        onClick={onBodyClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            const l = lineFromEvent(e.target);
            if (l !== null) {
              e.preventDefault();
              openComposer(l); // open the inline composer for this block (#1107)
            }
          }
        }}
      />
      {/* The overlay carries ONLY the "+" add-comment affordance. Existing markers render as
          always-visible inline cards below their block (injected above), not in this hover overlay —
          that's the layout fix that stopped the cards overlapping the block content (#863). The "+"
          is suppressed for the line whose composer is open (the composer is shown there instead). */}
      {activeLine !== null && activeLine !== composingLine ? (
        <div className="codev-canvas-overlay" style={{ top: overlayTop }}>
          <CommentAffordance line={activeLine} onActivate={openComposer} />
        </div>
      ) : null}
      {/* Inline composer (#1107): portalled into the in-flow placeholder injected directly below the
          block, so the reviewer types where the comment will live. Keeping it React-owned (rather than
          hand-built DOM in the imperatively-managed body) gives clean state / focus / Esc handling. */}
      {composingLine !== null && composerHost
        ? createPortal(
            <CommentComposer
              // Key on the edit target so switching cards remounts the composer and re-seeds its
              // textarea from `initialText`. Two comments stacked on ONE block share `composingLine`,
              // so without this a click on a second card leaves the first card's text in the box and a
              // save would write it to the wrong marker (#1055 codex finding). `useState(initialText)`
              // only reads its arg on mount, so a fresh mount is what refreshes the seed.
              key={`composer-${editingMarker?.markerLine ?? 'add'}-${composingLine}`}
              line={composingLine}
              onSubmit={submitComposer}
              onCancel={cancelComposer}
              initialText={editingMarker ? editingMarker.text : undefined}
            />,
            composerHost,
          )
        : null}
      <MarkerMinimap markers={markers} bodyRef={bodyRef} />
    </div>
  );
}
