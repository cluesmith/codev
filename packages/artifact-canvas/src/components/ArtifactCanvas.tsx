import * as React from 'react';
import { createPortal } from 'react-dom';
import type { ArtifactCanvasProps, ReadingMode, ReviewMarker } from '../types.js';
import { renderMarkdown } from '../renderer/renderer.js';
import { CommentAffordance } from '../overlays/CommentAffordance.js';
import { CommentComposer } from '../overlays/CommentComposer.js';
import { MarkerMinimap } from '../overlays/MarkerMinimap.js';
import { KeyboardHelp } from '../overlays/KeyboardHelp.js';
import { ReadingModeToggle } from '../overlays/ReadingModeToggle.js';
import { ReadingProgress } from '../overlays/ReadingProgress.js';
import {
  blockScrollOptions,
  flowHeight,
  flowOffsetAt,
  fragmentAtPoint,
  innerScrollerCanConsume,
  measureColumnGeometry,
  wheelDeltaPx,
} from './column-geometry.js';

/** Coerce an untrusted (host-persisted) mode value to the closed vocabulary (spec 1380 D4). */
function coerceReadingMode(value: string | undefined): ReadingMode {
  if (value === 'horizontal') return 'horizontal';
  return 'vertical';
}

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
  focusableBodies: boolean,
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
    // Horizontal mode caps the card body with an inner scroller (spec D1); a scroller must be
    // keyboard-reachable to be keyboard-scrollable (phase-2 iter-2 consult). Vertical mode adds
    // no tabindex — its tab order stays exactly as it was.
    if (focusableBodies) {
      body.setAttribute('tabindex', '0');
    }

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
  const {
    uri,
    fileAdapter,
    markerAdapter,
    onAddComment,
    onEditComment,
    onDeleteComment,
    onError,
    refreshKey,
    initialReadingMode,
    onReadingModeChange,
  } = props;
  const canEdit = onEditComment !== undefined;
  const canDelete = onDeleteComment !== undefined;

  // Reading mode (spec 1380 D4): uncontrolled after mount, seeded from the host's persisted
  // value coerced to the closed vocabulary. Mode is React state on the root, so it survives
  // content rebuilds (the innerHTML effect touches only the body's children).
  const [readingMode, setReadingMode] = React.useState<ReadingMode>(() =>
    coerceReadingMode(initialReadingMode),
  );

  const [content, setContent] = React.useState<string>('');
  const [markers, setMarkers] = React.useState<ReviewMarker[]>([]);
  const [activeLine, setActiveLine] = React.useState<number | null>(null);
  // The line currently being commented on (the inline composer is open for it), and the in-flow
  // placeholder node the composer portals into — injected directly below that block (#1107).
  const [composingLine, setComposingLine] = React.useState<number | null>(null);
  const [composerHost, setComposerHost] = React.useState<HTMLElement | null>(null);
  // The marker currently being edited (#1055): the composer opens prefilled with its body and
  // submit routes to `onEditComment` instead of `onAddComment`. null → the empty add composer.
  const [editingMarker, setEditingMarker] = React.useState<ReviewMarker | null>(null);
  // Keys legend visibility (#1237): toggled with `?` while a block has focus.
  const [helpOpen, setHelpOpen] = React.useState(false);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  // Latest markers, readable synchronously from the delegated click handler without re-binding it.
  const markersRef = React.useRef<ReviewMarker[]>(markers);
  markersRef.current = markers;
  // Latest active line, readable synchronously from the decoration effect (which must not depend
  // on `activeLine` — re-running it per hover would churn the injected card stacks).
  const activeLineRef = React.useRef<number | null>(activeLine);
  activeLineRef.current = activeLine;
  // Block line to focus after the next body rebuild (#1237): submit/delete trigger a host write,
  // the watch reload rebuilds the body, and the previously-focused element is destroyed. The
  // decoration effect consumes this to put the reviewer back on the block they were working on.
  const pendingFocusLineRef = React.useRef<number | null>(null);

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
        // inline-below, in flow (#863); card bodies become focusable scrollers in horizontal
        el.after(buildMarkerCards(line, ms, canEdit, canDelete, readingMode === 'horizontal'));
      } else {
        // Inner siblings that share the line (and genuinely unmarked blocks) get no card and no
        // decoration; any stale class from a prior markers-only re-render is cleared here too.
        el.classList.remove('codev-canvas-has-marker');
      }
    });
    // Reconcile the affordance anchor against the *reloaded* DOM (iter-5 Codex): if a watch/
    // refreshKey reload removed or shortened the previously active block, clear `activeLine` so
    // the "+" can't render for — or emit `onAddComment` for — a line the new content no longer
    // has. VALIDATE rather than blindly reset: a still-present active line survives, so this never
    // races a fresh hover (which changes only `activeLine`, not `html`, so this effect doesn't run
    // then).
    setActiveLine((cur) =>
      cur !== null && !root.querySelector(`[data-line="${cur}"]`) ? null : cur,
    );
    // Re-host the in-row "+" after a body rebuild (#1343): the innerHTML reset detached the
    // wrapper node (the ref keeps it alive and the portal keeps rendering into it), so re-append
    // it into the still-active line's row. A line the reload removed skips this (the lookup fails,
    // and the validation above has already queued the clear); a markers-only update leaves the
    // wrapper connected, so this is a no-op then.
    const wrap = affordanceWrapRef.current;
    if (wrap && !wrap.isConnected && activeLineRef.current !== null) {
      const el = root.querySelector<HTMLElement>(`[data-line="${activeLineRef.current}"]`);
      if (el) placeAffordance(el, null);
    }
    // Focus restoration (#1237): submit/delete recorded the block being worked on before emitting
    // the intent; the host's write led back here via the watch reload, which rebuilt the body and
    // dropped focus to the document root. Exact line first; if the write shifted lines, the nearest
    // preceding block keeps the reviewer in place rather than stranding them at the top.
    const pendingLine = pendingFocusLineRef.current;
    if (pendingLine !== null) {
      pendingFocusLineRef.current = null;
      let target = root.querySelector<HTMLElement>(`[data-line="${pendingLine}"]`);
      if (target === null) {
        let bestLine = -1;
        for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-line]'))) {
          const l = Number(el.getAttribute('data-line'));
          if (!Number.isNaN(l) && l < pendingLine && l > bestLine) {
            bestLine = l;
            target = el;
          }
        }
      }
      if (target) target.focus({ preventScroll: true });
    }
    // `readingMode` in the deps: toggling re-injects the card stacks so card-body focusability
    // tracks the mode (the injected DOM is not React-managed, so a re-run is the update path).
  }, [html, markers, canEdit, canDelete, readingMode]);

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
  const openComposer = (line: number): void => {
    setEditingMarker(null);
    setComposingLine(line);
  };
  const submitComposer = (text: string): void => {
    if (composingLine === null) { return; }
    // Edit vs add (#1055): when a marker is being edited, route to `onEditComment` with the marker's
    // identity (physical line) + the expected author/body for the host's optimistic-concurrency
    // check; otherwise emit the add intent. The host verifies then writes either way.
    // The host's write triggers a watch reload that rebuilds the body and destroys the focused
    // element; record where the reviewer was so the decoration effect can put them back (#1237).
    if (editingMarker && editingMarker.markerLine !== undefined) {
      pendingFocusLineRef.current = editingMarker.line;
      onEditComment?.(editingMarker.markerLine, editingMarker.author, editingMarker.text, text);
    } else {
      pendingFocusLineRef.current = composingLine;
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
      // Focus was on the delete button, which the post-write reload destroys with the card; land
      // the reviewer back on the annotated block, the stable anchor jump keys resume from (#1237).
      pendingFocusLineRef.current = marker.line;
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

  // Navigable blocks in tree order, deduped to the FIRST element per line: the renderer stamps the
  // same `data-line` on nested blocks (a `ul` and its `li`), and the first match is the outermost —
  // the same outermost-wins rule the marker decoration uses, so `n`/`p` land where the class is.
  const collectBlocks = (root: HTMLElement): HTMLElement[] => {
    const blocks: HTMLElement[] = [];
    const seen = new Set<string>();
    root.querySelectorAll<HTMLElement>('[data-line]').forEach((el) => {
      const line = el.getAttribute('data-line') ?? '';
      if (seen.has(line)) return;
      seen.add(line);
      blocks.push(el);
    });
    return blocks;
  };

  const focusBlock = (el: HTMLElement): void => {
    el.focus({ preventScroll: true });
    // Axis-aware (spec req. 3): horizontal centers on the inline axis — the axis that scrolls.
    el.scrollIntoView(blockScrollOptions(readingMode));
    // Focusing fires the body's onFocus → activateFromFocus, so the "+" follows the jump for free.
  };

  // ---- Reading-mode switch (spec 1380 D4/D7) ----
  const rootRef = React.useRef<HTMLDivElement>(null);
  // data-line of the block at the viewport start, recorded just before a mode switch; the
  // layout effect below restores it once the new mode has laid out (D7 coarse preservation).
  const pendingAnchorLineRef = React.useRef<number | null>(null);

  // First block (tree order) not entirely before the viewport start — the block the reviewer
  // is reading. Vertical: the viewport start is the window top (the page/host scrolls the
  // canvas). Horizontal: the body's left edge (the body is the horizontal scroll container).
  const viewportStartLine = (mode: ReadingMode): number | null => {
    const root = bodyRef.current;
    if (!root) return null;
    const rootRect = root.getBoundingClientRect();
    for (const el of collectBlocks(root)) {
      const r = el.getBoundingClientRect();
      const visible = mode === 'horizontal' ? r.right > rootRect.left : r.bottom > 0;
      if (visible) {
        const n = Number(el.getAttribute('data-line'));
        return Number.isNaN(n) ? null : n;
      }
    }
    return null;
  };

  const toggleReadingMode = (): void => {
    const next: ReadingMode = readingMode === 'horizontal' ? 'vertical' : 'horizontal';
    pendingAnchorLineRef.current = viewportStartLine(readingMode);
    setReadingMode(next);
    onReadingModeChange?.(next);
  };

  // Bring a recorded anchor line back to the reading start (D7 + the resize criterion): exact
  // line first, nearest preceding block if the line vanished (the #1237 focus-restoration
  // fallback, applied to scroll position). Instant, not smooth — the layout just changed, and
  // animating would imply a continuity that doesn't exist.
  const restoreAnchorLine = (line: number, mode: ReadingMode): void => {
    const root = bodyRef.current;
    if (!root) return;
    let target = root.querySelector<HTMLElement>(`[data-line="${line}"]`);
    if (target === null) {
      let bestLine = -1;
      for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-line]'))) {
        const l = Number(el.getAttribute('data-line'));
        if (!Number.isNaN(l) && l < line && l > bestLine) {
          bestLine = l;
          target = el;
        }
      }
    }
    if (target) {
      let options: ScrollIntoViewOptions = { block: 'start', inline: 'nearest' };
      if (mode === 'horizontal') {
        options = { inline: 'start', block: 'nearest' };
      }
      target.scrollIntoView(options);
    }
  };

  // Restore the recorded anchor after a mode switch has re-laid-out (D7).
  React.useLayoutEffect(() => {
    const line = pendingAnchorLineRef.current;
    if (line === null) return;
    pendingAnchorLineRef.current = null;
    restoreAnchorLine(line, readingMode);
  }, [readingMode]);

  // Track the block at the viewport start while the reviewer scrolls horizontally
  // (rAF-throttled), so a container resize can put them back on it (spec resize criterion,
  // phase 5). Vertical mode attaches nothing.
  const lastViewportLineRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    const body = bodyRef.current;
    if (!body || readingMode !== 'horizontal') {
      lastViewportLineRef.current = null;
      return;
    }
    let raf = 0;
    const onScroll = (): void => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const line = viewportStartLine('horizontal');
        if (line !== null) lastViewportLineRef.current = line;
      });
    };
    body.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      body.removeEventListener('scroll', onScroll);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [readingMode]);

  // Column-height variable (spec 1380, D1 groundwork): in horizontal mode, publish the body's
  // resolved height as `--codev-canvas-column-height` so cap rules can derive from it. The CSS
  // layer self-bounds the body (100% of the host bound, capped to the viewport), so this is
  // measurement, not sizing — no circularity. Hosts without ResizeObserver (jsdom) keep the
  // one-shot measurement.
  React.useEffect(() => {
    const root = rootRef.current;
    const body = bodyRef.current;
    if (!root || !body) return;
    if (readingMode !== 'horizontal') {
      root.style.removeProperty('--codev-canvas-column-height');
      return;
    }
    const publish = (): void => {
      root.style.setProperty('--codev-canvas-column-height', `${body.clientHeight}px`);
    };
    publish();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      publish();
      // Re-anchor after a resize/zoom reflow (spec resize criterion): the scroll-tracked
      // viewport-start block stays in view instead of the reflow teleporting the reader.
      // Null on the observer's initial fire (nothing tracked yet) — no spurious scroll.
      const line = lastViewportLineRef.current;
      if (line !== null) restoreAnchorLine(line, 'horizontal');
    });
    ro.observe(body);
    return () => ro.disconnect();
  }, [readingMode]);

  // Wheel remap (spec Constraint 5): active ONLY in horizontal mode, attached as a NATIVE
  // non-passive listener — React's delegated wheel path is passive-by-default, so its
  // preventDefault cannot be relied on (plan phase 3). Pass-through rules, in order: modified
  // wheels (pinch-zoom), horizontal-dominant deltas (native trackpad gesture), and events an
  // inner vertical scroller (capped code/table/card/composer) can still consume. Everything
  // else becomes horizontal canvas travel. Vertical mode attaches nothing.
  React.useEffect(() => {
    const body = bodyRef.current;
    if (!body || readingMode !== 'horizontal') return;
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey) return;
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      if (innerScrollerCanConsume(e.target, e.deltaY, body)) return;
      e.preventDefault();
      body.scrollLeft += wheelDeltaPx(e, body.clientHeight);
    };
    body.addEventListener('wheel', onWheel, { passive: false });
    return () => body.removeEventListener('wheel', onWheel);
  }, [readingMode]);

  // Keyboard handling on the body (#1107 activation + #1237 jump navigation). Every branch below
  // requires the event to originate on a `[data-line]` block, so keystrokes inside the composer
  // textarea, the card action buttons, or the minimap are never intercepted — typing "n" in a
  // comment types "n".
  const onBodyKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // Keys pressed ON the "+" button belong to the button: its native Enter/Space activation
    // fires onClick → openComposer with the button's own (possibly nested) line. Intercepting
    // here would re-resolve through the host row and open the composer on the wrong line.
    if (fromAffordance(e.target)) return;
    if (e.key === 'Enter' || e.key === ' ') {
      const l = lineFromEvent(e.target);
      if (l !== null) {
        e.preventDefault();
        openComposer(l); // open the inline composer for this block (#1107)
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const root = bodyRef.current;
    if (!root) return;

    // Column paging (spec 1380, phase 3 + the phase-5 container decision): CONTAINER-level —
    // it works with focus on the body itself (focusable in horizontal, Constraint 7) or on any
    // block, closing the phase-3 gap where paging was unreachable right after clicking the
    // toggle. The composer is exempt: its textarea keeps native PageUp/PageDown. Steps land on
    // column starts: quantize to the measured step grid, then move one column.
    if (readingMode === 'horizontal' && (e.key === 'PageDown' || e.key === 'PageUp')) {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('.codev-canvas-comment-composer')) return;
      // Yield to a focused inner vertical scroller (a capped code block or card body) that
      // can still consume the page in that direction — same rule as the wheel remap.
      let pageDelta = 1;
      if (e.key === 'PageUp') pageDelta = -1;
      if (innerScrollerCanConsume(t, pageDelta, root)) return;
      const { step } = measureColumnGeometry(root);
      // Unmeasurable geometry: leave the key to the browser rather than swallowing it.
      if (step <= 0) return;
      e.preventDefault();
      let dir = 1;
      if (e.key === 'PageUp') dir = -1;
      const max = Math.max(root.scrollWidth - root.clientWidth, 0);
      let target = (Math.round(root.scrollLeft / step) + dir) * step;
      if (target < 0) target = 0;
      if (target > max) target = max;
      root.scrollLeft = target;
      return;
    }

    const current = (e.target as HTMLElement | null)?.closest?.('[data-line]') as HTMLElement | null;
    if (!current) return;

    if (e.key === '?') {
      e.preventDefault();
      setHelpOpen((open) => !open);
      return;
    }
    if (e.key === 'Escape') {
      // Esc during composition is handled by the composer itself (its target is not a block).
      if (helpOpen) {
        e.preventDefault();
        setHelpOpen(false);
      }
      return;
    }

    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const blocks = collectBlocks(root);
      let target: HTMLElement | undefined;
      if (e.key === 'Home') {
        target = blocks[0];
      } else {
        target = blocks[blocks.length - 1];
      }
      if (target) focusBlock(target);
      return;
    }

    const isMarked = (el: HTMLElement): boolean => el.classList.contains('codev-canvas-has-marker');
    const isHeading = (el: HTMLElement): boolean => /^H[1-6]$/.test(el.tagName);
    let match: (el: HTMLElement) => boolean;
    let step: number;
    switch (e.key) {
      case 'n': match = isMarked; step = 1; break;
      case 'p': match = isMarked; step = -1; break;
      case ']': match = isHeading; step = 1; break;
      case '[': match = isHeading; step = -1; break;
      default: return;
    }
    e.preventDefault();
    const blocks = collectBlocks(root);
    const curLine = current.getAttribute('data-line');
    // Match by line value, not element identity: the focused element may be an inner nested block
    // that the dedupe dropped in favor of its outermost sibling for the same line.
    const start = blocks.findIndex((b) => b.getAttribute('data-line') === curLine);
    if (start === -1) return;
    for (let i = start + step; i >= 0 && i < blocks.length; i += step) {
      if (match(blocks[i])) {
        focusBlock(blocks[i]);
        return;
      }
    }
    // No match in that direction: deliberate no-op, no wrap-around — predictable at the edges.
  };

  const resolveBlock = (target: EventTarget | null): { el: HTMLElement; line: number } | null => {
    const el = (target as HTMLElement | null)?.closest?.('[data-line]') as HTMLElement | null;
    if (!el) return null;
    const n = Number(el.getAttribute('data-line'));
    if (Number.isNaN(n)) return null;
    return { el, line: n };
  };

  // ---- In-row "+" affordance (#1343, GitHub-diff pattern) ----
  // The whole row is the hover target and the "+" renders inside the hovered row's own DOM,
  // positioned only against that row — never against the canvas. Trigger and target coincide, so
  // there is no pointer journey to protect: the #1236 grace/pin machinery is gone, instant
  // re-anchor and immediate dismiss are correct, and #1380's column mode places the row (and its
  // affordance) for free.

  // Single wrapper node for the "+", created once and MOVED between row hosts (appendChild
  // relocates it). The portal below targets this stable node, so React's ownership of the button
  // survives both moves and body rebuilds (the ref outlives an innerHTML wipe; the decoration
  // effect re-appends the node).
  const affordanceWrapRef = React.useRef<HTMLElement | null>(null);
  const affordanceWrap = (): HTMLElement => {
    if (affordanceWrapRef.current === null) {
      const wrap = document.createElement('div');
      wrap.className = 'codev-canvas-row-affordance';
      affordanceWrapRef.current = wrap;
    }
    return affordanceWrapRef.current;
  };

  // The top-level row that hosts the affordance for a block: its ancestor that is a direct child
  // of the body. Nested blocks (an `li`, a `p` inside a blockquote) are hosted by their outermost
  // row, which carries the block-local gutter the "+" renders in; `activeLine` still targets the
  // inner block, so the label and the composer stay precise.
  const rowHostOf = (el: HTMLElement): HTMLElement => {
    let host = el;
    while (host.parentElement && host.parentElement !== bodyRef.current) {
      host = host.parentElement;
    }
    return host;
  };

  const lineHeightOf = (el: HTMLElement): number => {
    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight);
    if (Number.isFinite(lineHeight)) return lineHeight;
    const fontSize = parseFloat(cs.fontSize);
    if (Number.isFinite(fontSize)) return fontSize * 1.2;
    return 0;
  };

  // Attach the wrapper inside `el`'s row and set its row-relative `top` — in FLOW coordinates
  // (spec-1380 D2): the fragment math sums preceding fragment heights, and the browser resolves
  // an abspos flow `top` into the correct column fragment (spike finding 6). The mouse path
  // anchors to the fragment under the pointer — hovering a prose block's continuation in column
  // N lights the "+" in column N, never back at the block's start (the addendum requirement) —
  // quantized to `el`'s line-height so the "+" snaps line-to-line (GitHub-style). The keyboard
  // path anchors to the block's first fragment, where reading of the block starts. Both paths
  // clamp on flow height (fragment-height sum), never the union bounding box, which spans
  // columns under fragmentation. In vertical mode every rect list has length 1 and the math
  // degenerates to the classic #1343 single-rect placement. jsdom (no layout: empty rect lists)
  // falls back to `offsetTop`, preserving the pre-1380 unit-test surface.
  const placeAffordance = (el: HTMLElement, clientY: number | null, clientX: number | null = null): void => {
    const host = rowHostOf(el);
    const wrap = affordanceWrap();
    if (wrap.parentElement !== host) host.appendChild(wrap);
    const lineHeight = lineHeightOf(el);
    const elRects = Array.from(el.getClientRects());
    const hostRects = Array.from(host.getClientRects());
    let top: number;
    if (elRects.length === 0 || hostRects.length === 0) {
      // No layout (jsdom / display:none): the keyboard math from offset geometry.
      let base = 0;
      if (el !== host) base = el.offsetTop;
      let within = lineHeight / 2;
      if (clientY !== null && lineHeight > 0) {
        within = Math.floor(Math.max(clientY, 0) / lineHeight) * lineHeight + lineHeight / 2;
      }
      top = base + within;
    } else if (clientY === null) {
      // Keyboard path: first line of the block's FIRST fragment, in host flow coordinates.
      const first = elRects[0];
      top = flowOffsetAt(hostRects, first.left + 1, first.top) + lineHeight / 2;
    } else {
      let x = elRects[0].left + 1;
      if (clientX !== null) x = clientX;
      const frag = elRects[fragmentAtPoint(elRects, x, clientY)];
      let within = clientY - frag.top;
      if (lineHeight > 0) {
        within = Math.floor(within / lineHeight) * lineHeight + lineHeight / 2;
      }
      top = flowOffsetAt(hostRects, frag.left + 1, frag.top) + within;
    }
    const max = flowHeight(hostRects);
    if (top < 0) top = 0;
    if (max > 0 && top > max) top = max;
    wrap.style.top = `${top}px`;
  };

  // True when an event originated inside the "+" wrapper. Every activation path no-ops for
  // these: the wrapper sits inside the HOST row's DOM, so re-resolving through
  // `closest('[data-line]')` would retarget a nested block's line (an `li`) to its host's line
  // (the `ul`) — wrong label, wrong composer target (iter-1 Codex). NOTE the primary isolation
  // is actually the portal itself: React propagates the button's events through the REACT tree
  // (the portal's parent is the canvas div), so the body div's handlers never see them. These
  // guards are deliberate defense-in-depth — they keep nested-line targeting correct even if the
  // affordance is ever re-hosted non-portally (e.g. rendered imperatively like the marker cards),
  // where DOM-tree bubbling WOULD reach the body handlers (iter-1 Claude).
  const fromAffordance = (target: EventTarget | null): boolean =>
    Boolean((target as HTMLElement | null)?.closest?.('.codev-canvas-row-affordance'));

  // Keyboard path (#1237 parity): focusing a block lights the "+" in its row, instantly.
  // Tab-focusing the button itself must not re-anchor (see fromAffordance).
  const activateFromFocus = (target: EventTarget | null): void => {
    if (fromAffordance(target)) return;
    const b = resolveBlock(target);
    if (!b) return;
    setActiveLine(b.line);
    placeAffordance(b.el, null);
  };

  // Mouse path: hover and move share one handler (a repeat with an unchanged line is a state-set
  // React bails out of, plus one style write). Three deliberate no-ops: events originating inside
  // the affordance itself (re-resolving would retarget a nested block's line to its host row and
  // jitter the "+" under the pointer), moves during a primary-button drag (the "+" must never
  // jump around mid text-selection), and targets outside any block (margins and other dead strips
  // keep the current row lit — sticky — rather than flickering; the "+" sits inside the row it
  // targets, so a lingering affordance can never be attributed to the wrong row).
  const activateFromPointer = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (fromAffordance(target)) return;
    if ((e.buttons & 1) !== 0) return;
    const b = resolveBlock(target);
    if (!b) return;
    setActiveLine(b.line);
    placeAffordance(b.el, e.clientY, e.clientX);
  };

  // Canvas mouseleave: dismiss immediately. Structurally safe without a grace window — the "+"
  // sits on the pointer's own path at the row's leading edge, so it cannot be approached without
  // being crossed, and re-entry re-lights it instantly in the same place.
  const dismissAffordance = (): void => {
    setActiveLine(null);
    affordanceWrapRef.current?.remove();
  };

  // Progress recomputation key (iter-1 Codex): scrollWidth moves not only on content changes
  // but when marker CARDS are (re)injected or the composer opens/closes — neither changes
  // `html` nor the body's border box (fixed height), so neither the ResizeObserver nor a
  // plain html key would catch them. A memo over all three layout-affecting inputs gives the
  // readout one stable identity per layout-relevant state.
  const progressKey = React.useMemo(() => ({}), [html, markers, composingLine]);

  let rootClassName = 'codev-artifact-canvas';
  if (readingMode === 'horizontal') {
    rootClassName += ' codev-canvas-mode-horizontal';
  }

  return (
    <div ref={rootRef} className={rootClassName} onMouseLeave={dismissAffordance}>
      {/* Reading-mode toggle (spec 1380 D4): canvas-owned chrome so every host gets the control.
          Rendered in both modes — it is the way back. Placed BEFORE the body so it is the FIRST
          tab stop, not the last one behind every tabindex="0" block (iter-1 Claude); it is
          position: fixed, so document order has no visual effect. */}
      <ReadingModeToggle mode={readingMode} onToggle={toggleReadingMode} />
      {/* No `dangerouslySetInnerHTML`: the body's content is set imperatively in the effect above so
          React never re-commits it (which would wipe the injected cards). Rendered with no children. */}
      {/* Horizontal-mode container semantics (Constraint 7): the body is itself focusable —
          the landmark a screen reader announces via the roledescription, and the target that
          makes column paging reachable without first focusing a block. Vertical mode carries
          none of these attributes (undefined → absent). */}
      <div
        ref={bodyRef}
        className="codev-artifact-canvas-body"
        tabIndex={readingMode === 'horizontal' ? 0 : undefined}
        role={readingMode === 'horizontal' ? 'region' : undefined}
        aria-label={readingMode === 'horizontal' ? 'Document content' : undefined}
        aria-roledescription={readingMode === 'horizontal' ? 'multi-column reading view' : undefined}
        onMouseOver={activateFromPointer}
        onMouseMove={activateFromPointer}
        onFocus={(e) => activateFromFocus(e.target)}
        onClick={onBodyClick}
        onKeyDown={onBodyKeyDown}
      />
      {/* The "+" add-comment affordance (#1343): portalled into the wrapper that lives INSIDE the
          active row's own DOM, so the affordance is wherever its row is. Existing markers render as
          always-visible inline cards below their block (injected above), never here (#863). The "+"
          is suppressed for the line whose composer is open (the composer is shown there instead). */}
      {activeLine !== null && activeLine !== composingLine && affordanceWrapRef.current
        ? createPortal(
            <CommentAffordance line={activeLine} onActivate={openComposer} />,
            affordanceWrapRef.current,
          )
        : null}
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
      {helpOpen ? <KeyboardHelp readingMode={readingMode} /> : null}
      {/* Progress readout replaces the vertical scrollbar's positional feedback (D8);
          minimap is suppressed in horizontal (D3 — its offsetTop fractions collapse to
          within-column positions there; `n`/`p` + the readout cover its jobs in v1). */}
      {readingMode === 'horizontal' ? <ReadingProgress bodyRef={bodyRef} contentKey={progressKey} /> : null}
      {readingMode === 'vertical' ? (
        <MarkerMinimap markers={markers} bodyRef={bodyRef} readingMode={readingMode} />
      ) : null}
    </div>
  );
}
