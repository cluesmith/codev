/**
 * Render-empty gate (Spec 1313, Phase 2) — the sole authority that answers
 * "is this screen a clean, empty prompt?".
 *
 * A message body is only ever written to a prompt this gate proves empty, so
 * corruption is eliminated by construction: a message can never fuse with a
 * draft because it is never delivered while one exists. The gate replays the
 * session's output ring — the exact reconnect-replay data path
 * (`ringBuffer.getAll().join('\n')`, tower-websocket.ts) — through a transient
 * headless terminal and inspects the rendered composer region. This is a direct
 * port of the G-lite classifier validated against the real claude/codex TUIs in
 * spike 1265 (`codev/spikes/1265-poc/exp-g2-glite-prod-path.mjs`).
 *
 * Classifier (fail-toward-not-clean): CLEAN requires
 *   (a) a recognized composer marker on the reconstructed screen, AND
 *   (b) a positively-bounded composer region (a rule/status line BELOW the
 *       marker — never a scan to the screen bottom), AND
 *   (c) zero normal-intensity (non-dim), non-whitespace, non-chrome cells in that
 *       region — with one measured exemption: claude's suggested-command *ghost* cursor
 *       cell (an inverse, non-dim char at the cursor followed by a non-empty dim run), which
 *       is composer chrome, not typed text (see `isGhostCursorCell`).
 * The placeholder-vs-user-text distinction is an SGR attribute — both TUIs
 * render rotating placeholder/hint text DIM while typed text is normal-intensity
 * (measured, spike g2) — so no placeholder allowlist is needed. Anything
 * unrecognized (no marker, no region boundary, a menu, a picker, a draft, a
 * wrapper/boot screen) → NOT clean → the message stays held. There is no force path.
 *
 * Replay fidelity (Spec 1313 render-gate hardening): the gate renders the WHOLE
 * coherent ring at any size, not a fixed tail slice. A claude/codex TUI on the
 * alternate screen (`\x1b[?1049h`) encodes its state in the cumulative byte stream
 * from the alt-screen-enter onward (why `ring-buffer.ts` keeps the `partial` whole),
 * so a mid-stream tail slice corrupts the reconstruction — dropping the composer
 * marker (→ false `no-composer-marker`) or the composer's lower rule (→ the region
 * spills into status chrome → false `user-text`). Both were real field bugs traced to
 * the old 1 MB `capReplay` slice (architect cap-sweep: every whole render classifies
 * CLEAN; the verdict flipped purely with slice size). There is no "most-recent
 * full-repaint boundary" to slice at for an alt-screen app, so the whole ring is the
 * only faithful input — every time, regardless of size.
 *
 * No size cap on delivery (Spec 1313 over-ceiling removal): the gate never holds a
 * ring for being large. A long-lived session accretes its whole alt-screen frame into
 * the unbounded `partial` (#1047), so a busy terminal grows past any fixed size in
 * normal use — an earlier `over-ceiling` hold therefore meant a permanent delivery
 * outage for exactly the busiest agents (a live ~14 M-unit empty-composer architect
 * terminal was stuck, its mail undeliverable until relaunch). Whole-ring render is
 * correct at any size, so the fix is simply to render it. Two mechanisms in
 * `mailbox-delivery.ts` bound the recurring cost: the verdict memo skips re-rendering a
 * STATIC large ring, and a cost-aware backstop backoff throttles re-classifying a BUSY big
 * ring that repaints every tick — the case the memo can NOT help, because a busy ring's token
 * changes every tick and the memo always misses exactly when the render is most expensive.
 * Residual risk (accepted, deferred to #1047): because `partial` is unbounded, a pathological
 * runaway (a huge no-newline dump) can make ONE whole-ring render allocate and parse a
 * multi-hundred-MB string — a real risk of exhausting the Tower heap (an OOM CRASH, not merely
 * a stall: @xterm/headless chunks its parse and yields, so the event loop is not monolithically
 * blocked, but the allocation is unbounded). Neither the memo nor the backoff bounds that first
 * giant render; a hold cap is NOT the answer (it just reintroduces the outage under a bigger
 * number). The robust fix — classify off-thread with a memory bound, or retire the unbounded
 * `partial` for a persistent headless screen — is #1047, out of scope here. An unclassifiable
 * huge ring still HOLDS and escalates via the classifier-stuck liveness surface
 * (`no-region-end`/`no-composer-marker`), so it is never a silent loss.
 *
 * Cost (spike g2, @xterm/headless 6.0.0): 2 ms @ 13 KB, 67 ms @ 4 MB — cheap enough
 * to gate every delivery for realistic rings.
 */

// `@xterm/headless` resolves to its CommonJS entry (no `exports` map, no
// `type: module`), and its named exports are not statically analyzable, so a
// native-node ESM `import { Terminal }` throws "Named export 'Terminal' not
// found" when the compiled dist runs under node (production; masked under vitest
// by vite's CJS interop). Default-import the module object — the codebase's
// convention for CJS deps (cf. `import Database from 'better-sqlite3'`).
import xtermHeadless from '@xterm/headless';
// Type-only: erased at compile time, so it adds no runtime import (the named
// runtime binding is unavailable — see above); the .d.ts still provides the type.
import type { Terminal as HeadlessTerminal } from '@xterm/headless';

const { Terminal } = xtermHeadless;

// Buffer cell/line types derived from the public Terminal type rather than imported by
// name: `@xterm/headless`'s `IBufferCell`/`IBufferLine` are declared without `export`
// inside its ambient module, so a named `import type` is not guaranteed to resolve —
// deriving via the exported `Terminal` surface is import-stable.
type BufferCell = ReturnType<HeadlessTerminal['buffer']['active']['getNullCell']>;
type BufferLine = NonNullable<ReturnType<HeadlessTerminal['buffer']['active']['getLine']>>;

/**
 * The ring snapshot the gate classifies — the production reconnect-replay shape.
 * `replay` is the WHOLE `ringBuffer.getAll().join('\n')`, rendered in full at any size
 * (no cap — see the module header); `cols`/`rows` size the headless terminal to match
 * the live session so wrapping reconstructs identically.
 */
export interface RingSnapshot {
  replay: string;
  cols: number;
  rows: number;
}

/**
 * A per-app classifier profile (instances + `resolveProfile` live in
 * `gate-profiles.ts`). Marker + region bounds are per-app data by design
 * (spike constraint 9): a TUI layout change is a profile drift, never a silent
 * misdelivery — an unmatched marker defaults to NOT clean.
 */
export interface GateProfile {
  /** App identity this profile classifies (e.g. 'claude', 'codex'). */
  app: string;
  /** Matches the composer prompt marker at the START of the input row. */
  markerPattern: RegExp;
  /**
   * A line matching any of these ENDS the composer region (the rule/status lines
   * rendered directly below the input). Scanning stops there so status chrome
   * below the composer is never counted as user text.
   */
  regionEndPatterns: RegExp[];
  /**
   * Optional per-app placeholder signal: a 16-color palette index whose cells are
   * treated as placeholder/hint chrome (ignored), NOT user text. This is the
   * color-attribute analogue of the universal dim-placeholder skip. claude/codex
   * de-emphasize their placeholder with SGR-dim (handled universally); agy instead
   * renders its idle mode-hint in palette-8 (gray) while user-typed text is
   * default-fg — measured, Spec 1313 Phase 3 — so agy sets this to 8. Left unset,
   * only the dim rule applies (claude/codex behavior is unchanged).
   */
  placeholderFgPalette?: number;
}

/** The gate's verdict. `reason` is the mailbox why-held reason when not clean. */
export interface GateVerdict {
  clean: boolean;
  /** Present only when not clean — the busy-line hold reason. */
  reason?: 'busy';
  /**
   * Internal classification detail (telemetry/debugging only — NOT a delivery
   * reason). `no-composer-marker` = wrapper/boot/picker/unknown screen (or a torn
   * replay that dropped the marker); `no-region-end` = a marker with no rule/status
   * line beneath it to bound the composer (a partial/mid-repaint frame) — held
   * rather than scanning into status chrome; `user-text` = a draft or menu occupies
   * the composer; `empty` = clean.
   */
  detail: 'no-composer-marker' | 'no-region-end' | 'user-text' | 'empty';
}

/**
 * Box-drawing / prompt chrome that is never "user text". The composer marker
 * glyphs (❯ ›) live here too; the marker cell is additionally skipped by
 * position so a profile whose marker is not listed still never self-trips.
 */
const IGNORE_CHARS = new Set(['❯', '›', '│', '▌', '─', '━', '╌', '┄', '╭', '╰', '┌', '└', '']);

/** All-whitespace (incl. NBSP and other Unicode spaces) → ignorable. */
const WHITESPACE = /^\s+$/u;

/** Rendered viewport lines, right-trimmed — the same extraction the spike asserts on. */
function screenLines(term: HeadlessTerminal, rows: number): string[] {
  const buf = term.buffer.active;
  const top = buf.viewportY;
  const lines: string[] = [];
  for (let i = 0; i < rows; i++) {
    const line = buf.getLine(top + i);
    lines.push(line ? line.translateToString(true).trimEnd() : '');
  }
  return lines;
}

/** Last row index whose text starts with the profile's composer marker, or -1. */
function findMarkerRow(lines: string[], markerPattern: RegExp): number {
  let markerRow = -1;
  for (let i = 0; i < lines.length; i++) {
    if (markerPattern.test(lines[i])) markerRow = i;
  }
  return markerRow;
}

/**
 * First region-ending row after the marker (the rule/status line beneath the
 * composer), or -1 when none is found. -1 means the composer has no proven lower
 * bound (a partial/mid-repaint frame, or a torn replay) — the caller MUST hold, not
 * scan to the screen bottom: scanning further counts status chrome below the
 * composer as user text (the old bug) OR, if that chrome renders empty/dim, returns
 * a false CLEAN. A missing boundary is indeterminate, and indeterminate is not-clean.
 */
function findRegionEnd(lines: string[], markerRow: number, endPatterns: RegExp[]): number {
  for (let i = markerRow + 1; i < lines.length; i++) {
    if (endPatterns.some((p) => p.test(lines[i]))) return i;
  }
  return -1;
}

/**
 * Ghost-suggestion cursor cell (Spec 1313 render-gate hardening — false-`busy` on an idle
 * claude composer). When claude's own last reply mentioned a runnable command it paints
 * that command into the otherwise-empty composer as a *suggested-command ghost*, and the
 * ghost's first character doubles as the software block cursor: it is rendered SGR-7
 * INVERSE at normal intensity while the rest of the ghost is SGR-2 dim
 * (`❯ ␛[7m a ␛[27m␛[2mfx cleanup …␛[22m`, measured live — captured as
 * `claude-ghost-suggestion-empty.replay.bin`). The universal dim rule already skips the
 * ghost body, but the lone inverse cursor cell was counted as user text → the composer
 * classified `user-text`/`busy` FOREVER while genuinely empty, so mail to an idle
 * (unattended) agent was never delivered (fail-safe becomes fail-forever for an idle
 * recipient — the exact agent `afx send` exists to wake).
 *
 * This exempts exactly that cell: the cell at the headless buffer's cursor position,
 * rendered inverse at normal intensity, whose following run on the same row is dim or
 * empty (the measured ghost tail). It is deliberately NARROW — NOT the blanket inverse
 * skip the finding warns against — and does not false-clean a real draft:
 *   - measured, claude renders the block cursor inverse only on the trailing WHITESPACE
 *     past a real draft (already skipped as whitespace) and never inverse-renders typed
 *     characters, so a real draft's typed cells are non-inverse and still counted;
 *   - an inverse *selection* over real multi-char text fails the dim-tail test (its
 *     following cells are non-dim) and, even if it passed, only this one cell is skipped
 *     while every other selected cell keeps the verdict `busy`.
 * A lone inverse cursor cell with NO dim tail (a 1-char draft with the cursor sitting on its
 * only char, empty composer otherwise) is NOT exempted — it stays `busy` — because the
 * exemption requires positive ghost evidence (≥1 dim suggestion-body cell). That closes the
 * false-clean an empty-tail exemption would have opened, honoring the no-new-corruption-vector
 * / fail-toward-hold invariant (Codex CMAP, 2026-08-06). Real ghosts always carry a multi-char
 * dim command body (the captured fixture's tail is 23 dim cells), so nothing real is lost.
 */
function isGhostCursorCell(
  line: BufferLine,
  row: number,
  col: number,
  cols: number,
  cursorRow: number,
  cursorCol: number,
  cell: BufferCell,
  probe: BufferCell,
): boolean {
  if (row !== cursorRow || col !== cursorCol) return false;
  if (!cell.isInverse()) return false; // typed text is never inverse-rendered; only the software cursor is
  // Require POSITIVE ghost evidence: at least one dim, non-whitespace, non-chrome cell must
  // follow on this row (the SGR-2 suggestion body), and EVERY following such cell must be dim.
  // An empty / whitespace-only tail is NOT a ghost — it is a 1-char draft with the cursor on
  // its only char, which must stay `busy` (fail-toward-hold; a lone inverse cell is not proof
  // of a ghost). Any non-dim text to the right ⇒ real content, also not a ghost.
  let sawDimTail = false;
  for (let c = col + 1; c < cols; c++) {
    line.getCell(c, probe);
    const ch = probe.getChars();
    if (!ch || WHITESPACE.test(ch) || IGNORE_CHARS.has(ch)) continue;
    if (!probe.isDim()) return false;
    sawDimTail = true;
  }
  return sawDimTail;
}

/**
 * Classify a rendered ring snapshot against a profile.
 *
 * Returns `{ clean: true, detail: 'empty' }` only when a composer marker is
 * present and the composer region carries zero normal-intensity user cells;
 * otherwise `{ clean: false, reason: 'busy', … }`. Async because the headless
 * terminal parses its input on a write callback.
 */
export async function classifyScreen(snapshot: RingSnapshot, profile: GateProfile): Promise<GateVerdict> {
  const { cols, rows } = snapshot;
  const replay = snapshot.replay;

  // Render the WHOLE ring at any size — never a slice, never a size-based hold. An
  // alt-screen frame only reconstructs from its full cumulative stream, so a tail
  // slice would false-clean and a size cap would strand the busiest agents' mail
  // (see the module header): there is no size at which holding beats rendering.
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
  try {
    await new Promise<void>((resolve) => term.write(replay, resolve));

    const buf = term.buffer.active;
    const lines = screenLines(term, rows);

    const markerRow = findMarkerRow(lines, profile.markerPattern);
    if (markerRow === -1) {
      // No composer marker: a wrapper/boot screen, a full-screen picker with no
      // marker, or an unrenderable snapshot. Never clean — the safe direction.
      return { clean: false, reason: 'busy', detail: 'no-composer-marker' };
    }

    const endRow = findRegionEnd(lines, markerRow, profile.regionEndPatterns);
    if (endRow === -1) {
      // A marker with no rule/status line beneath it: a partial/mid-repaint frame or
      // a torn replay. The composer has no proven lower bound, so hold rather than
      // scan into the status chrome below it (which would either miscount chrome as
      // user text or, if it renders empty/dim, return a false CLEAN).
      return { clean: false, reason: 'busy', detail: 'no-region-end' };
    }
    const top = buf.viewportY;
    const cell = buf.getNullCell();
    const probe = buf.getNullCell(); // scratch cell for the ghost-tail look-ahead (never clobbers `cell`)
    // Cursor position is viewport-relative (matching `row`, which indexes from `viewportY`).
    const cursorRow = buf.cursorY;
    const cursorCol = buf.cursorX;
    let userCells = 0;

    for (let row = markerRow; row < endRow; row++) {
      const line = buf.getLine(top + row);
      if (!line) continue;
      for (let col = 0; col < cols; col++) {
        line.getCell(col, cell);
        const ch = cell.getChars();
        if (!ch || WHITESPACE.test(ch) || IGNORE_CHARS.has(ch)) continue;
        if (row === markerRow && col === 0) continue; // the marker glyph itself
        if (cell.isDim()) continue; // placeholder / hint chrome renders dim (claude/codex)
        if (
          profile.placeholderFgPalette !== undefined &&
          cell.isFgPalette() &&
          cell.getFgColor() === profile.placeholderFgPalette
        ) {
          continue; // per-app placeholder color: agy renders its idle hint in palette-8 (gray)
        }
        if (isGhostCursorCell(line, row, col, cols, cursorRow, cursorCol, cell, probe)) {
          continue; // claude's suggested-command ghost cursor cell (see isGhostCursorCell)
        }
        userCells++;
      }
    }

    return userCells === 0
      ? { clean: true, detail: 'empty' }
      : { clean: false, reason: 'busy', detail: 'user-text' };
  } finally {
    term.dispose();
  }
}
