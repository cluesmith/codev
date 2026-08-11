/**
 * SessionScreen.serialize() round-trip suite (PIR #1354).
 *
 * The viewer-attach snapshot must be a faithful, O(screen) stand-in for the raw byte
 * history it replaces: replaying a serialization into a fresh terminal must reproduce
 * the source screen cell-for-cell (chars, colors, attributes), cursor position, and
 * active-buffer type — for real captured Claude streams (the gzipped gate fixtures are
 * alternate-buffer TUI captures) and for synthesized worst-case workloads. House
 * pattern from #1353: captured streams as fixtures, exhaustive structural assertions.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { SessionScreen } from '../session-screen.js';

const FIXTURE_DIR = fileURLToPath(new URL('../../agent-farm/__tests__/fixtures/gate', import.meta.url));

const COLS = 200;
const ROWS = 50;

/** Ceiling asserting the payload is O(screen): generous vs the ~2-10 KB measured, far under the MB-scale raw tails. */
const SNAPSHOT_MAX_BYTES = 256 * 1024;

function feed(scr: SessionScreen, data: string): void {
  scr.feed(data);
}

/**
 * Cell-level dump of the current viewport: chars plus fg/bg color and the attribute
 * flags a viewer would see. Comparing dumps proves visual equivalence, not just text.
 */
async function viewportCells(scr: SessionScreen): Promise<string> {
  const { term, rows, cols } = await scr.read();
  const buf = term.buffer.active;
  const cell = buf.getNullCell();
  const out: string[] = [];
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    if (!line) {
      out.push('<null>');
      continue;
    }
    const row: string[] = [];
    for (let x = 0; x < cols; x++) {
      line.getCell(x, cell);
      row.push(
        `${cell.getChars() || ' '}|${cell.getFgColor()},${cell.getBgColor()},${cell.isBold()}${cell.isUnderline()}${cell.isInverse()}`,
      );
    }
    out.push(row.join(''));
  }
  return out.join('\n');
}

async function cursor(scr: SessionScreen): Promise<string> {
  const { term } = await scr.read();
  return `${term.buffer.active.cursorX},${term.buffer.active.cursorY}`;
}

/** Feed `stream` into a source screen, serialize, replay into a fresh screen, assert equivalence. */
async function assertRoundTrip(stream: string): Promise<{ source: SessionScreen; replica: SessionScreen; snapshot: string }> {
  const source = new SessionScreen(COLS, ROWS);
  feed(source, stream);
  await source.read();
  const snapshot = source.serialize();

  expect(snapshot.length).toBeGreaterThan(0);
  expect(snapshot.length).toBeLessThan(SNAPSHOT_MAX_BYTES);

  const replica = new SessionScreen(COLS, ROWS);
  feed(replica, snapshot);

  expect(await viewportCells(replica)).toBe(await viewportCells(source));
  expect(await cursor(replica)).toBe(await cursor(source));
  expect(replica.bufferType).toBe(source.bufferType);
  return { source, replica, snapshot };
}

function loadFixture(name: string): string {
  return gunzipSync(fs.readFileSync(path.join(FIXTURE_DIR, name))).toString('utf-8');
}

describe('SessionScreen.serialize round trip (PIR #1354)', () => {
  const replayFixtures = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.replay.bin.gz'));

  it('has captured replay fixtures to exercise', () => {
    expect(replayFixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of replayFixtures) {
    it(`round-trips captured stream ${fixture} cell-exactly at O(screen) size`, async () => {
      const stream = loadFixture(fixture);
      const { source, replica, snapshot } = await assertRoundTrip(stream);
      // The payload claim: snapshot size is a property of the screen, not the history.
      expect(snapshot.length).toBeLessThan(Math.max(stream.length, SNAPSHOT_MAX_BYTES + 1));
      source.dispose();
      replica.dispose();
    });
  }

  it('round-trips a synthesized zero-newline alt-screen TUI (the shape that defeats the line ring)', async () => {
    let stream = '\x1b[?1049h\x1b[?25l\x1b[2J';
    for (let frame = 0; frame < 300; frame++) {
      for (let y = 1; y <= ROWS - 1; y++) {
        stream += `\x1b[${y};1H\x1b[38;5;${(frame + y) % 200}m` + `row ${y} frame ${frame} `.repeat(6).slice(0, COLS - 20);
      }
      stream += `\x1b[${ROWS};1H\x1b[7m STATUS frame=${frame} \x1b[0m\x1b[K`;
    }
    expect(stream).not.toContain('\n');
    const { source, replica } = await assertRoundTrip(stream);
    expect(source.bufferType).toBe('alternate');
    source.dispose();
    replica.dispose();
  });

  it('serialized size is O(screen): 10x more frames of history do not grow the snapshot', async () => {
    const paint = (frames: number): string => {
      let s = '\x1b[?1049h\x1b[2J';
      for (let f = 0; f < frames; f++) s += `\x1b[1;1Hframe ${String(f).padStart(8, '0')}\x1b[2;1Hstable content`;
      return s;
    };
    const short = new SessionScreen(COLS, ROWS);
    feed(short, paint(50));
    await short.read();
    const long = new SessionScreen(COLS, ROWS);
    feed(long, paint(500));
    await long.read();
    // Same final screen → same snapshot, regardless of how much history produced it.
    expect(long.serialize().length).toBe(short.serialize().length);
    short.dispose();
    long.dispose();
  });

  it('preserves the normal buffer behind the alt screen: quitting the TUI after replay restores shell history', async () => {
    const source = new SessionScreen(COLS, ROWS);
    feed(source, 'shell line one\r\nshell line two\r\n$ ');
    feed(source, '\x1b[?1049h\x1b[2J\x1b[HALT SCREEN APP');
    await source.read();
    const snapshot = source.serialize();

    const replica = new SessionScreen(COLS, ROWS);
    feed(replica, snapshot);
    // The app exits the alt screen on both terminals after the reconnect.
    feed(source, '\x1b[?1049l');
    feed(replica, '\x1b[?1049l');
    expect(await viewportCells(replica)).toBe(await viewportCells(source));
    expect(replica.bufferType).toBe('normal');
    source.dispose();
    replica.dispose();
  });

  it('retains bounded scrollback history in the snapshot (viewer history parity with the ring)', async () => {
    const source = new SessionScreen(COLS, ROWS);
    let stream = '';
    for (let i = 0; i < 200; i++) stream += `history line ${i}\r\n`;
    feed(source, stream);
    await source.read();
    const snapshot = source.serialize();
    // Lines scrolled off the viewport are still in the payload.
    expect(snapshot).toContain('history line 0');
    expect(snapshot).toContain('history line 199');
    source.dispose();
  });

  it('bufferType reports normal/alternate transitions', async () => {
    const scr = new SessionScreen(COLS, ROWS);
    expect(scr.bufferType).toBe('normal');
    feed(scr, '\x1b[?1049h');
    await scr.read();
    expect(scr.bufferType).toBe('alternate');
    feed(scr, '\x1b[?1049l');
    await scr.read();
    expect(scr.bufferType).toBe('normal');
    scr.dispose();
  });

  it('serialize after dispose returns empty rather than touching the freed term', () => {
    const scr = new SessionScreen(COLS, ROWS);
    scr.feed('content');
    scr.dispose();
    expect(scr.serialize()).toBe('');
  });
});
