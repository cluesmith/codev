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
 *   (b) zero normal-intensity (non-dim), non-whitespace, non-chrome cells in the
 *       composer region.
 * The placeholder-vs-user-text distinction is an SGR attribute — both TUIs
 * render rotating placeholder/hint text DIM while typed text is normal-intensity
 * (measured, spike g2) — so no placeholder allowlist is needed. Anything
 * unrecognized (no marker, a menu, a picker, a draft, a wrapper/boot screen) →
 * NOT clean → the message stays held. There is no force path.
 *
 * Cost (spike g2, @xterm/headless 6.0.0): 2 ms @ 13 KB, 22 ms @ 1 MB (the seed
 * cap), 67 ms @ 4 MB — cheap enough to gate every delivery.
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
 * The seed-capped ring snapshot the gate classifies — the production
 * reconnect-replay shape. `replay` is `ringBuffer.getAll().join('\n')` capped to
 * {@link RING_SEED_MAX_BYTES}; `cols`/`rows` size the headless terminal to match
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
}

/** The gate's verdict. `reason` is the mailbox why-held reason when not clean. */
export interface GateVerdict {
  clean: boolean;
  /** Present only when not clean — the busy-line hold reason. */
  reason?: 'busy';
  /**
   * Internal classification detail (telemetry/debugging only — NOT a delivery
   * reason). `no-composer-marker` = wrapper/boot/picker/unknown screen;
   * `user-text` = a draft or menu occupies the composer; `empty` = clean.
   */
  detail: 'no-composer-marker' | 'user-text' | 'empty';
}

/**
 * Rendering size cap for a gate check — the production reconnect-replay seed cap
 * (`RING_SEED_MAX_BYTES`, tower-terminals.ts). A live ring's unbounded partial
 * (#1047 full-screen-TUI basin) can exceed it, so the gate caps the replay to
 * the most-recent bytes before rendering, bounding the classify cost to ~22 ms.
 */
export const RING_SEED_MAX_BYTES = 1024 * 1024; // 1 MB

/**
 * Box-drawing / prompt chrome that is never "user text". The composer marker
 * glyphs (❯ ›) live here too; the marker cell is additionally skipped by
 * position so a profile whose marker is not listed still never self-trips.
 */
const IGNORE_CHARS = new Set(['❯', '›', '│', '▌', '─', '━', '╌', '┄', '╭', '╰', '┌', '└', '']);

/** All-whitespace (incl. NBSP and other Unicode spaces) → ignorable. */
const WHITESPACE = /^\s+$/u;

/** Cap the replay to the seed max, keeping the most-recent bytes (the live screen). */
function capReplay(replay: string): string {
  if (replay.length <= RING_SEED_MAX_BYTES) return replay;
  return replay.slice(replay.length - RING_SEED_MAX_BYTES);
}

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

/** First region-ending row after the marker (rule/status line), else lines.length. */
function findRegionEnd(lines: string[], markerRow: number, endPatterns: RegExp[]): number {
  for (let i = markerRow + 1; i < lines.length; i++) {
    if (endPatterns.some((p) => p.test(lines[i]))) return i;
  }
  return lines.length;
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
  const replay = capReplay(snapshot.replay);

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
        if (cell.isDim()) continue; // placeholder / hint chrome renders dim
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
