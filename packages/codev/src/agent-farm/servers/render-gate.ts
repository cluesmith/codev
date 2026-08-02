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
 *       region.
 * The placeholder-vs-user-text distinction is an SGR attribute — both TUIs
 * render rotating placeholder/hint text DIM while typed text is normal-intensity
 * (measured, spike g2) — so no placeholder allowlist is needed. Anything
 * unrecognized (no marker, no region boundary, a menu, a picker, a draft, a
 * wrapper/boot screen) → NOT clean → the message stays held. There is no force path.
 *
 * Replay fidelity (Spec 1313 render-gate hardening): the gate renders the WHOLE
 * coherent ring, not a fixed tail slice. A claude/codex TUI on the alternate
 * screen (`\x1b[?1049h`) encodes its state in the cumulative byte stream from the
 * alt-screen-enter onward (why `ring-buffer.ts` keeps the `partial` whole), so a
 * mid-stream tail slice corrupts the reconstruction — dropping the composer marker
 * (→ false `no-composer-marker`) or the composer's lower rule (→ the region spills
 * into status chrome → false `user-text`). Both were real fields bugs traced to the
 * old 1 MB `capReplay` slice (architect cap-sweep: every whole render classifies
 * CLEAN; the verdict flipped purely with slice size). There is no "most-recent
 * full-repaint boundary" to slice at for an alt-screen app, so the correctness path
 * is: render the whole ring; a ring that exceeds {@link RENDER_CEILING_UNITS} (a
 * pathological #1047 unbounded-partial basin) is NOT rendered from an arbitrary tail
 * — an arbitrary slice can reconstruct a clean-looking composer while the whole ring
 * holds a draft (a false CLEAN), so an over-ceiling ring is held unconditionally.
 *
 * Cost (spike g2, @xterm/headless 6.0.0): 2 ms @ 13 KB, 67 ms @ 4 MB — cheap enough
 * to gate every delivery for realistic rings; the ceiling bounds the worst case.
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

/**
 * The ring snapshot the gate classifies — the production reconnect-replay shape.
 * `replay` is the WHOLE `ringBuffer.getAll().join('\n')` (rendered in full; only a
 * pathological over-{@link RENDER_CEILING_UNITS} basin is capped); `cols`/`rows`
 * size the headless terminal to match the live session so wrapping reconstructs
 * identically.
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
   * rather than scanning into status chrome; `over-ceiling` = the ring exceeds
   * {@link RENDER_CEILING_UNITS} and is held unrendered (an arbitrary tail could
   * false-clean); `user-text` = a draft or menu occupies the composer; `empty` = clean.
   */
  detail: 'no-composer-marker' | 'no-region-end' | 'over-ceiling' | 'user-text' | 'empty';
}

/**
 * Absolute render ceiling for a gate check, in JS string length units (UTF-16 code
 * units — NOT bytes; a multibyte glyph is 1–2 units). The gate renders the WHOLE
 * ring for correctness (an alt-screen frame only reconstructs from its full stream —
 * see the module header). A ring larger than this — a pathological #1047
 * unbounded-partial basin — is NOT rendered from an arbitrary tail: no reliable
 * repaint boundary exists to slice at, and an arbitrary slice can reconstruct a
 * clean-looking composer while the whole ring holds a draft (a false CLEAN). So an
 * over-ceiling ring is held UNRENDERED (`detail: 'over-ceiling'`, the fail-safe
 * direction), bounding worst-case classify cost to a whole render just under the
 * ceiling (~130 ms @ 8 M units). Set generously above realistic rings (largest
 * observed ≈ 3 M units) so real sessions always render whole. Caveat: an #1047 basin
 * never shrinks, so a genuinely-empty over-ceiling prompt would stay held
 * indefinitely — that agent needs the held-mail escalation/liveness surface (see
 * mailbox-delivery.ts), which flags a sustained hold for a human.
 */
// NB: distinct from tower-terminals.ts's own `RING_SEED_MAX_BYTES` (1 MB), which caps
// the WEBSOCKET RECONNECT SEED (bandwidth to a reconnecting browser). The two were once
// the same value; they now intentionally diverge — the gate renders the whole ring for
// correctness, the reconnect seed stays small — so keep them SEPARATE, not a shared const.
export const RENDER_CEILING_UNITS = 8 * 1024 * 1024; // 8 M UTF-16 units (~8 MB ASCII)

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

  // An over-ceiling ring is held UNRENDERED (never sliced): no reliable repaint
  // boundary exists to slice an alt-screen stream at, and an arbitrary tail can
  // reconstruct a clean-looking composer while the whole ring holds a draft — a
  // false CLEAN. Hold in the safe direction. This also bounds the render cost below.
  if (replay.length > RENDER_CEILING_UNITS) {
    return { clean: false, reason: 'busy', detail: 'over-ceiling' };
  }

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
