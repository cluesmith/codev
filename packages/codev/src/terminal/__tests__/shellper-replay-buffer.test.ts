import { describe, it, expect } from 'vitest';
import { ShellperReplayBuffer } from '../shellper-replay-buffer.js';

/** A buffer with ceilings high enough that no eviction interferes. */
function unbounded(): ShellperReplayBuffer {
  return new ShellperReplayBuffer(1_000_000, 1024 * 1024 * 1024);
}

describe('ShellperReplayBuffer', () => {
  describe('getReplayData() without a cap', () => {
    it('returns empty for an empty buffer', () => {
      expect(unbounded().getReplayData().length).toBe(0);
    });

    it('returns the concatenation of all chunks', () => {
      const buf = unbounded();
      buf.append('one ');
      buf.append('two ');
      buf.append('three');
      expect(buf.getReplayData().toString()).toBe('one two three');
    });

    it('accepts strings and Buffers interchangeably', () => {
      const buf = unbounded();
      buf.append('a');
      buf.append(Buffer.from('b'));
      expect(buf.getReplayData().toString()).toBe('ab');
    });
  });

  describe('getReplayData(maxBytes) — cap before concat (#1205)', () => {
    it('returns exactly the last maxBytes across many chunks', () => {
      const buf = unbounded();
      for (let i = 0; i < 100; i++) buf.append(Buffer.alloc(100, 0x61));
      const out = buf.getReplayData(250);
      expect(out.length).toBe(250);
      expect(out.every((b) => b === 0x61)).toBe(true);
    });

    it('returns the true tail content, not merely the right length', () => {
      const buf = unbounded();
      buf.append('AAAA');
      buf.append('BBBB');
      buf.append('CCCC');
      expect(buf.getReplayData(6).toString()).toBe('BBCCCC');
    });

    it('slices the boundary chunk rather than dropping it whole', () => {
      const buf = unbounded();
      buf.append('0123456789');
      buf.append('abcde');
      // Cap lands inside the first chunk: 3 of its bytes plus all of the second.
      expect(buf.getReplayData(8).toString()).toBe('789abcde');
    });

    it('returns everything when the cap exceeds the buffer', () => {
      const buf = unbounded();
      buf.append('short');
      expect(buf.getReplayData(1000).toString()).toBe('short');
    });

    it('is byte-identical to the uncapped result when the cap is not reached', () => {
      const buf = unbounded();
      buf.append('alpha');
      buf.append('beta');
      expect(buf.getReplayData(100)).toEqual(buf.getReplayData());
    });

    it('handles a zero or negative cap without throwing', () => {
      const buf = unbounded();
      buf.append('data');
      expect(buf.getReplayData(0).length).toBe(0);
      expect(buf.getReplayData(-1).length).toBe(0);
    });

    it('returns empty for an empty buffer regardless of cap', () => {
      expect(unbounded().getReplayData(100).length).toBe(0);
    });

    /**
     * The #1253 shape: a long-lived full-screen TUI emits no newlines, so the
     * line ceiling never fires and history accumulates. Asking for a capped
     * replay must not first materialise that history.
     */
    it('caps a large newline-free history down to the requested tail', () => {
      const buf = unbounded();
      for (let i = 0; i < 500; i++) buf.append(Buffer.alloc(4096, 0x78));
      expect(buf.size).toBe(500 * 4096);
      expect(buf.getReplayData(64 * 1024).length).toBe(64 * 1024);
    });

    it('moves a mid-sequence cut forward to the next escape boundary', () => {
      const buf = unbounded();
      // Layout: AAAA(0-3) ESC[31m(4-8) BBBB(9-12) ESC[0m(13-16) CCCC(17-20).
      // A cap of 15 cuts at offset 6, i.e. inside the first escape sequence —
      // emitting from there would send "31mBBBB..." as literal text. Alignment
      // must advance to the ESC at 13, yielding strictly fewer bytes than asked
      // for rather than a corrupt prefix.
      buf.append('AAAA\x1b[31mBBBB\x1b[0mCCCC');
      const out = buf.getReplayData(15);
      expect(out.toString()).toBe('\x1b[0mCCCC');
      expect(out.length).toBeLessThan(15);
    });

    /**
     * Regression (#1205, caught by PR consultation): the tail-walk sliced the
     * boundary chunk but did not stop there. Because ESC alignment moves the
     * cut forward, the piece is shorter than the remaining budget, so the loop
     * kept consuming *older* chunks and stitched fragments across a gap —
     * emitting a non-contiguous stream that also began mid-escape-sequence.
     * Only reachable with ESC-dense data spanning several chunks, which is why
     * the original ESC-free fixtures missed it.
     */
    it('returns a contiguous suffix, never fragments stitched across chunks', () => {
      const buf = unbounded();
      for (let i = 0; i < 6; i++) buf.append(`BODY-${i}-abcdefg\x1b[m`);

      const whole = buf.getReplayData().toString();
      const capped = buf.getReplayData(25).toString();

      expect(whole.endsWith(capped)).toBe(true);
      expect(capped.length).toBeLessThanOrEqual(25);
    });

    it('keeps the suffix contiguous across a range of caps', () => {
      const buf = unbounded();
      for (let i = 0; i < 10; i++) buf.append(`\x1b[3${i % 8}mframe-${i}\x1b[0m`);
      const whole = buf.getReplayData().toString();

      for (let cap = 1; cap <= whole.length; cap++) {
        const capped = buf.getReplayData(cap).toString();
        expect(whole.endsWith(capped)).toBe(true);
        expect(capped.length).toBeLessThanOrEqual(cap);
      }
    });

    it('falls back to a raw cut when no escape sequence follows the cut point', () => {
      const buf = unbounded();
      buf.append('x'.repeat(10_000));
      expect(buf.getReplayData(100).length).toBe(100);
    });

    it('does not scan unboundedly for an escape boundary', () => {
      const buf = unbounded();
      // The only ESC sits far beyond the scan window, so the cut stays raw
      // and the caller gets the full requested tail.
      buf.append('\x1b[0m' + 'y'.repeat(100_000));
      expect(buf.getReplayData(1000).length).toBe(1000);
    });
  });

  describe('byte-ceiling eviction (#1205)', () => {
    /**
     * The defect this ceiling exists for: a full-screen TUI redraws in place
     * and emits no newlines at all, so the line ceiling never fires and the
     * buffer grew for the whole life of the session.
     */
    it('bounds a newline-free stream that the line ceiling never touches', () => {
      const buf = new ShellperReplayBuffer(10_000, 4096);
      for (let i = 0; i < 200; i++) buf.append(Buffer.alloc(512, 0x7a));
      expect(buf.lines).toBe(0);
      expect(buf.size).toBeLessThanOrEqual(4096);
    });

    it('retains the tail, not the head, when evicting for bytes', () => {
      const buf = new ShellperReplayBuffer(10_000, 10);
      buf.append('AAAAA');
      buf.append('BBBBB');
      buf.append('CCCCC');
      expect(buf.getReplayData().toString()).toBe('BBBBBCCCCC');
    });

    it('stays bounded across many appends rather than growing monotonically', () => {
      const buf = new ShellperReplayBuffer(10_000, 1000);
      const sizes: number[] = [];
      for (let i = 0; i < 100; i++) {
        buf.append(Buffer.alloc(100, 0x71));
        sizes.push(buf.size);
      }
      expect(Math.max(...sizes)).toBeLessThanOrEqual(1000);
    });

    it('front-trims a single chunk that alone exceeds the ceiling', () => {
      const buf = new ShellperReplayBuffer(10_000, 50);
      buf.append('x'.repeat(500));
      expect(buf.size).toBe(50);
      expect(buf.getReplayData().toString()).toBe('x'.repeat(50));
    });

    it('keeps the line count consistent when evicting for bytes', () => {
      const buf = new ShellperReplayBuffer(10_000, 20);
      for (let i = 0; i < 20; i++) buf.append(`line${i}\n`);
      // Whatever survived, `lines` must equal the newlines actually retained.
      const retained = buf.getReplayData().toString();
      expect(buf.lines).toBe((retained.match(/\n/g) ?? []).length);
      expect(buf.size).toBeLessThanOrEqual(20);
    });

    it('still enforces the line ceiling independently of the byte ceiling', () => {
      const buf = new ShellperReplayBuffer(3, 1024 * 1024);
      for (let i = 0; i < 10; i++) buf.append(`row${i}\n`);
      expect(buf.lines).toBeLessThanOrEqual(3);
      expect(buf.getReplayData().toString()).toBe('row7\nrow8\nrow9\n');
    });

    it('applies both ceilings when both are exceeded', () => {
      const buf = new ShellperReplayBuffer(5, 12);
      for (let i = 0; i < 20; i++) buf.append(`aa${i}\n`);
      expect(buf.size).toBeLessThanOrEqual(12);
      expect(buf.lines).toBeLessThanOrEqual(5);
    });

    it('clear() resets both counters', () => {
      const buf = new ShellperReplayBuffer(10_000, 1000);
      buf.append('some data\n');
      buf.clear();
      expect(buf.size).toBe(0);
      expect(buf.lines).toBe(0);
      expect(buf.getReplayData().length).toBe(0);
    });

    it('defaults the byte ceiling to 8MB', () => {
      const buf = new ShellperReplayBuffer();
      for (let i = 0; i < 12; i++) buf.append(Buffer.alloc(1024 * 1024, 0x62));
      expect(buf.size).toBeLessThanOrEqual(8 * 1024 * 1024);
    });
  });
});
