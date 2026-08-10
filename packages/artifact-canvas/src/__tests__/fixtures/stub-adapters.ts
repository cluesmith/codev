/**
 * Stub host adapters for the end-to-end test and the `examples/` dev page (Phase 4).
 *
 * These are NOT shipped (they live under `src/__tests__/` and are excluded from `files`/`exports`).
 * They implement the three package interfaces against a single shared **text store** so the
 * round-trip is proven *through text* (spec D3 / text-as-source-of-truth, #857), not via an
 * in-memory side store:
 *
 *   - `stubMarkerAdapter.add` serializes a positional `<!-- REVIEW(@author): text -->` INTO the
 *     text (on the line *after* the annotated block, #857 convention) and notifies watchers.
 *   - `stubFileAdapter.read` returns the current text; `.watch` replays text changes.
 *   - `stubMarkerAdapter.list` DERIVES markers by parsing the current text.
 *
 * The store is created per call (`createStore`) so each test/page instance is isolated — the
 * stubs are factories over a store rather than module-level singletons.
 */
import type { FileAdapter } from '../../adapters/FileAdapter.js';
import type { MarkerAdapter } from '../../adapters/MarkerAdapter.js';
import type { ThemeAdapter } from '../../adapters/ThemeAdapter.js';
import type { Disposable, ReviewMarker } from '../../types.js';

/** Mutable text store shared by a host's three adapters — text is the single source of truth. */
export interface StubStore {
  getText(): string;
  setText(next: string): void;
  /** Active watch callbacks (exposed so tests/pages can assert teardown if needed). */
  watchers: Array<(content: string) => void>;
}

export function createStore(initial: string): StubStore {
  let text = initial;
  const watchers: Array<(content: string) => void> = [];
  return {
    getText: () => text,
    setText: (next: string) => {
      text = next;
      watchers.forEach((cb) => cb(text));
    },
    watchers,
  };
}

const REVIEW_RE = /<!--\s*REVIEW\(@([^)]+)\):\s*(.*?)\s*-->/;

/** Parse positional REVIEW comments out of the text into ReviewMarkers (text → markers). */
function parseMarkers(text: string): ReviewMarker[] {
  const out: ReviewMarker[] = [];
  const lines = text.split('\n');
  lines.forEach((ln, i) => {
    const m = ln.match(REVIEW_RE);
    // #857: a REVIEW comment sits on the line BELOW the block it annotates, so its logical
    // (0-based) line is i-1 — walking back past any preceding comment lines, so a run of
    // consecutive comments STACKS on the same block (comment lines are stripped from the
    // render and have no `data-line` of their own). A comment with no content above is skipped.
    if (m && i > 0) {
      let line = i - 1;
      while (line > 0 && REVIEW_RE.test(lines[line])) line--;
      if (!REVIEW_RE.test(lines[line])) {
        // `markerLine` = the marker's own physical line (#1055): with it populated, hosts that
        // supply edit/delete callbacks get addressable cards — the dev page needs the full
        // review pass (add → edit → delete), same as the VS Code host.
        out.push({ author: m[1], line, text: m[2], raw: ln.trim(), markerLine: i });
      }
    }
  });
  return out;
}

export function stubFileAdapter(store: StubStore): FileAdapter {
  return {
    read: async (_uri: string) => store.getText(),
    watch: (_uri: string, onChange: (content: string) => void): Disposable => {
      store.watchers.push(onChange);
      return {
        dispose: () => {
          const i = store.watchers.indexOf(onChange);
          if (i >= 0) store.watchers.splice(i, 1); // idempotent: a second call is a no-op
        },
      };
    },
  };
}

export function stubMarkerAdapter(store: StubStore): MarkerAdapter {
  return {
    list: async (_uri: string) => parseMarkers(store.getText()),
    add: async (_uri: string, line: number, text: string, author: string) => {
      const lines = store.getText().split('\n');
      // Serialize INTO the text on the line after the annotated block (#857), then notify.
      lines.splice(line + 1, 0, `<!-- REVIEW(@${author}): ${text} -->`);
      store.setText(lines.join('\n'));
    },
  };
}

export function stubThemeAdapter(): ThemeAdapter {
  // Off the v1 render path (spec D4 Model A) — provided only to satisfy the prop + the
  // scenario-4 contract. resolve() returns a token's value; onChange registers a no-op handler.
  return {
    resolve: (token: string) => (token === '--codev-canvas-foreground' ? '#1f2328' : ''),
    onChange: (_handler: () => void): Disposable => ({ dispose: () => {} }),
  };
}

/**
 * Host-side edit intent (#1055 contract, stub form): verify the marker at `markerLine` still
 * matches (author + body prefix — the optimistic-concurrency check real hosts perform), then
 * rewrite its body in the text and notify watchers. A mismatch is a silent no-op (the real
 * VS Code host refreshes + notifies; the stub just refuses to write the wrong marker).
 */
export function stubEditMarker(
  store: StubStore,
  markerLine: number,
  expectedAuthor: string,
  expectedBodyPrefix: string,
  newBody: string,
): void {
  const lines = store.getText().split('\n');
  const m = (lines[markerLine] ?? '').match(REVIEW_RE);
  if (!m || m[1] !== expectedAuthor || !m[2].startsWith(expectedBodyPrefix)) return;
  const indent = lines[markerLine].match(/^\s*/)?.[0] ?? '';
  lines[markerLine] = `${indent}<!-- REVIEW(@${expectedAuthor}): ${newBody} -->`;
  store.setText(lines.join('\n'));
}

/** Host-side delete intent (#1055 contract, stub form): same verification, then remove the line. */
export function stubDeleteMarker(
  store: StubStore,
  markerLine: number,
  expectedAuthor: string,
  expectedBodyPrefix: string,
): void {
  const lines = store.getText().split('\n');
  const m = (lines[markerLine] ?? '').match(REVIEW_RE);
  if (!m || m[1] !== expectedAuthor || !m[2].startsWith(expectedBodyPrefix)) return;
  lines.splice(markerLine, 1);
  store.setText(lines.join('\n'));
}

/** Convenience: one shared store wired to all three stub adapters (used by the e2e test + page). */
export function createStubHost(initial: string) {
  const store = createStore(initial);
  return {
    store,
    fileAdapter: stubFileAdapter(store),
    markerAdapter: stubMarkerAdapter(store),
    themeAdapter: stubThemeAdapter(),
  };
}
