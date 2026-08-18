/**
 * Render-empty gate (Spec 1313, Phase 2) — the sole authority that answers
 * "is this screen a clean, empty prompt?".
 *
 * A message body is only ever written to a prompt this gate proves empty, so
 * corruption is eliminated by construction: a message can never fuse with a
 * draft because it is never delivered while one exists. The classifier is a direct
 * port of the G-lite classifier validated against the real claude/codex TUIs in
 * spike 1265 (`codev/spikes/1265-poc/exp-g2-glite-prod-path.mjs`).
 *
 * WHAT it reads (Spec 1313 render-gate round 2 — capped-ring reconciliation): the gate
 * classifies a rendered terminal SCREEN via the sync core {@link classifyBuffer}. In
 * PRODUCTION that screen is the session's persistent bounded mirror (`SessionScreen`,
 * terminal layer): one long-lived `@xterm/headless` Terminal fed the session's output
 * incrementally — from birth on the live path — whose current viewport IS the live screen. The gate originally
 * REBUILT the screen every check by replaying the whole output ring
 * (`ringBuffer.getAll().join('\n')`) through a throwaway Terminal — but #1205 capped the ring's
 * newline-free `partial` at 2 MiB (`trimPartial` halves to ~1 MiB), and a claude/codex
 * alt-screen frame (`\x1b[?1049h`) is exactly one giant newline-free partial. So once a busy
 * long-lived agent's frame crossed the cap, the gate was handed a TORN front — dropping the
 * composer marker (→ false `no-composer-marker`) or the composer's lower rule (→ the region
 * spills into status chrome → false `user-text`) — and held its mail PERMANENTLY. That is the
 * over-ceiling delivery outage the whole-ring render was meant to eliminate, resurrected one
 * layer down for exactly the busiest agents. A bounded terminal mirror needs only the live byte
 * stream, not the whole ring, so the cap is irrelevant, the live-ring tear is gone, each classify is
 * O(viewport) rather than O(ring size), and the whole-render era's unbounded-`partial` OOM risk
 * (#1047: one classify allocating a multi-hundred-MB string) is closed. The whole-ring
 * {@link classifyScreen} entry survives for the fixture suite and any transient one-shot
 * classify; it shares the SAME classifier core, so the two paths can never diverge.
 *
 * Caveat — adopt/reconnect seed: after a Tower restart the mirror is seeded from a bounded replay
 * tail (`capRingSeed`, 1 MiB), not the live-from-birth stream, so a long-lived alt-screen frame can
 * be born torn on adopt. That classifies not-clean → the gate HOLDS (fail-safe, never a misdelivery)
 * and self-heals on the next repaint/viewer nudge. Pre-existing (the pre-round-2 whole-ring gate saw
 * the same capped seed), not a round-2 regression; tracked as #1361.
 *
 * Classifier (fail-toward-not-clean): CLEAN requires
 *   (a) a recognized composer marker on the screen — a text match, plus whatever further
 *       positive evidence the profile demands that the row is the LIVE composer and not
 *       just a row the app prefixes alike (agy anchors on the cursor row and the marker's
 *       own palette color; see `markerRequiresCursorRow` / `markerFgPalette`), AND
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
 * wrapper/boot screen, or a mirror that has not yet repainted a coherent frame) → NOT clean →
 * the message stays held. There is no force path.
 *
 * Cost (spike g2, @xterm/headless 6.0.0): classifying a rendered viewport is sub-millisecond
 * (bounded rows × cols, independent of history); the mirror pays a normal terminal-emulator
 * parse per output chunk — the cost any emulator pays for the byte stream — amortised across
 * the session instead of spent in a per-check whole-history burst.
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
 * A one-shot replay-string snapshot for the TRANSIENT {@link classifyScreen} path.
 * `replay` is a rendered byte stream (e.g. a `ringBuffer.getAll().join('\n')` or a test
 * fixture); `cols`/`rows` size the throwaway headless terminal to match the captured
 * session so wrapping reconstructs identically. Production no longer builds this from the
 * (capped) ring — it reads the session's persistent {@link SessionScreen} mirror instead
 * (see the module header); this shape survives for the fixture suite and any transient
 * one-shot classify.
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
   * Optional per-app marker anchor: when true, the marker row must ALSO be the row
   * holding the buffer cursor. `markerPattern` alone is a text test, and a text test
   * cannot tell a composer from any other row an app happens to prefix the same way —
   * agy's `> ` matches its slash-menu selection cursor and its per-turn transcript echo
   * as readily as its composer (measured, #1474). The cursor is the one signal only the
   * live input row carries, so this converts "a row that looks like a prompt" into "the
   * row the user would actually type into". Fail-safe: an app whose cursor is parked
   * elsewhere yields NO marker ⇒ `no-composer-marker` ⇒ hold. Left unset, the marker is
   * the text match alone (claude/codex behavior is unchanged).
   */
  markerRequiresCursorRow?: boolean;
  /**
   * Optional per-app marker anchor: the 16-color palette index the marker GLYPH cell must
   * render in. The color-attribute analogue of {@link markerRequiresCursorRow}, and the
   * signal that separates agy's composer marker (palette 12, bright blue) from its
   * transcript echo of a submitted turn (palette 4 — measured, #1474). Left unset, the
   * marker cell's color is not examined.
   */
  markerFgPalette?: number;
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

/**
 * Last row index that is the profile's composer marker, or -1 when no row qualifies.
 *
 * The text match (`markerPattern`) is the necessary condition; a profile may demand
 * further POSITIVE evidence that the row is the live composer and not merely a row the
 * app prefixes the same way (`markerRequiresCursorRow`, `markerFgPalette` — both measured
 * per app, see their docs on {@link GateProfile}). Last-match-wins is retained: with the
 * anchors applied, the qualifying rows are the composer, and the lowest one is it.
 *
 * Why the anchors exist (#1474): agy's marker is `> `, which its slash-menu selection
 * cursor and its per-turn transcript echo also render — and the menu's item rows sit BELOW
 * the composer, so text-only last-match-wins bounded the wrong region on real screens.
 * Requiring the cursor row (and the marker's own color) makes the composer the only row
 * that can qualify. A row that fails the anchors is simply not a marker, so an app that
 * drifts fails toward `no-composer-marker` ⇒ hold, never toward a false clean.
 *
 * `cursorRow` is viewport-relative, matching `lines`' indexing from `viewportY` (the same
 * convention {@link isGhostCursorCell} uses).
 */
function findMarkerRow(
  lines: string[],
  profile: GateProfile,
  buf: HeadlessTerminal['buffer']['active'],
  top: number,
  cursorRow: number,
  cell: BufferCell,
): number {
  let markerRow = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!profile.markerPattern.test(lines[i])) continue;
    if (profile.markerRequiresCursorRow && i !== cursorRow) continue;
    if (profile.markerFgPalette !== undefined) {
      const line = buf.getLine(top + i);
      if (!line) continue;
      line.getCell(0, cell);
      if (!cell.isFgPalette() || cell.getFgColor() !== profile.markerFgPalette) continue;
    }
    markerRow = i;
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
 * The classifier CORE (Spec 1313 render-gate round 2): classify an already-rendered
 * headless buffer against a profile. Synchronous — it only READS the live buffer, it never
 * parses — so it is shared, unchanged, by BOTH gate paths: the production persistent-mirror
 * gate (`SessionScreen.read()` → this) and the transient {@link classifyScreen} (write a
 * replay into a throwaway term → this). One classifier core means the two paths can never
 * disagree about what "empty" means.
 *
 * Precondition: the caller has already parsed all input into `term` (the mirror flushes in
 * `read()`; `classifyScreen` awaits its `write`). Having no `await`, a single call is atomic
 * against concurrent feeds — nothing can mutate the buffer mid-scan.
 *
 * Returns `{ clean: true, detail: 'empty' }` only when a composer marker is present and the
 * composer region carries zero normal-intensity user cells; otherwise
 * `{ clean: false, reason: 'busy', … }`.
 */
export function classifyBuffer(
  term: HeadlessTerminal,
  cols: number,
  rows: number,
  profile: GateProfile
): GateVerdict {
  const buf = term.buffer.active;
  const lines = screenLines(term, rows);
  const top = buf.viewportY;
  const cell = buf.getNullCell();
  const probe = buf.getNullCell(); // scratch cell for the ghost-tail look-ahead (never clobbers `cell`)
  // Cursor position is viewport-relative (matching `row`, which indexes from `viewportY`).
  const cursorRow = buf.cursorY;
  const cursorCol = buf.cursorX;

  const markerRow = findMarkerRow(lines, profile, buf, top, cursorRow, cell);
  if (markerRow === -1) {
    // No composer marker: a wrapper/boot screen, a full-screen picker with no marker, a
    // mirror that has not yet repainted a coherent frame, or an unrenderable snapshot.
    // Never clean — the safe direction.
    return { clean: false, reason: 'busy', detail: 'no-composer-marker' };
  }

  const endRow = findRegionEnd(lines, markerRow, profile.regionEndPatterns);
  if (endRow === -1) {
    // A marker with no rule/status line beneath it: a partial/mid-repaint frame. The
    // composer has no proven lower bound, so hold rather than scan into the status chrome
    // below it (which would either miscount chrome as user text or, if it renders
    // empty/dim, return a false CLEAN).
    return { clean: false, reason: 'busy', detail: 'no-region-end' };
  }
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
}

/**
 * Classify a one-shot replay snapshot by rendering it into a THROWAWAY headless terminal
 * (Spec 1313). The transient path — the fixture suite and any caller holding a replay string
 * rather than a live mirror. Production instead classifies the session's persistent
 * {@link SessionScreen} directly via {@link classifyBuffer} (see the module header). Async
 * because the headless terminal parses its input on a write callback; the shared
 * {@link classifyBuffer} then does the actual classification.
 */
export async function classifyScreen(snapshot: RingSnapshot, profile: GateProfile): Promise<GateVerdict> {
  const { cols, rows } = snapshot;
  // A throwaway terminal for this single classify. scrollback 2000 is ample for a
  // whole-replay render; the gate reads only the viewport, so the value never changes the
  // verdict (the persistent mirror uses a much smaller one for the same reason).
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
  try {
    await new Promise<void>((resolve) => term.write(snapshot.replay, resolve));
    return classifyBuffer(term, cols, rows, profile);
  } finally {
    term.dispose();
  }
}
