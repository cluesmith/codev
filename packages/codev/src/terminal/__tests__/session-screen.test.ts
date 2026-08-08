/**
 * SessionScreen (Spec 1313 render-gate round 2) — the persistent bounded gate mirror.
 *
 * Pure mechanics here (feed / flush-on-read / resize / dispose); the gate classification of a
 * mirror is covered end-to-end in render-gate.test.ts's production-path suite, which feeds the
 * real large captures through this class in chunks and asserts CLEAN where the capped ring tears.
 */

import { describe, it, expect } from 'vitest';
import { SessionScreen } from '../session-screen.js';

const COLS = 80;
const ROWS = 24;

/** Read the current viewport as plain text lines (right-trimmed) — flushing the parser first. */
async function lines(scr: SessionScreen): Promise<string[]> {
  const { term, rows } = await scr.read();
  const buf = term.buffer.active;
  const top = buf.viewportY;
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const line = buf.getLine(top + i);
    out.push(line ? line.translateToString(true).trimEnd() : '');
  }
  return out;
}

describe('SessionScreen (Spec 1313 render-gate round 2)', () => {
  it('feed → read renders the fed output into the viewport', async () => {
    const scr = new SessionScreen(COLS, ROWS);
    scr.feed('hello\r\nworld');
    const l = await lines(scr);
    expect(l[0]).toBe('hello');
    expect(l[1]).toBe('world');
    scr.dispose();
  });

  it('renders identically whether fed one-shot or one byte at a time (the torn-PTY-delivery case)', async () => {
    // A mirror fed a byte at a time (incl. splits mid-CRLF and mid-word) must reconstruct the
    // same screen as one fed the whole chunk — the property that lets it mirror a live PTY whose
    // output arrives in arbitrary fragments.
    const raw = 'The quick brown fox\r\njumps over\r\nthe lazy dog';
    const whole = new SessionScreen(COLS, ROWS);
    whole.feed(raw);
    const chunked = new SessionScreen(COLS, ROWS);
    for (const ch of raw) chunked.feed(ch);
    expect(await lines(chunked)).toEqual(await lines(whole));
    whole.dispose();
    chunked.dispose();
  });

  it('read() flushes the parser: output fed immediately before read (not awaited between feeds) is present', async () => {
    const scr = new SessionScreen(COLS, ROWS);
    scr.feed('line-a\r\n');
    scr.feed('line-b'); // second feed not awaited before read — read() must still flush it
    const l = await lines(scr);
    expect(l[0]).toBe('line-a');
    expect(l[1]).toBe('line-b');
    scr.dispose();
  });

  it('an unfed screen reads as blank (no marker) — the "no output yet is not a verified prompt" case', async () => {
    const scr = new SessionScreen(COLS, ROWS);
    const l = await lines(scr);
    expect(l.every((line) => line === '')).toBe(true);
    scr.dispose();
  });

  it('resize updates the reported geometry', async () => {
    const scr = new SessionScreen(COLS, ROWS);
    scr.feed('x');
    let v = await scr.read();
    expect([v.cols, v.rows]).toEqual([COLS, ROWS]);
    scr.resize(120, 40);
    v = await scr.read();
    expect([v.cols, v.rows]).toEqual([120, 40]);
    scr.dispose();
  });

  it('dispose is idempotent and feed/resize after dispose are silent no-ops (a late PTY frame can’t touch a freed term)', async () => {
    const scr = new SessionScreen(COLS, ROWS);
    scr.feed('x');
    scr.dispose();
    expect(() => scr.dispose()).not.toThrow();
    expect(() => scr.feed('late frame')).not.toThrow();
    expect(() => scr.resize(10, 10)).not.toThrow();
  });
});
