import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../ring-buffer.js';

describe('RingBuffer', () => {
  it('stores and retrieves lines in order', () => {
    const buf = new RingBuffer(5);
    buf.push('a');
    buf.push('b');
    buf.push('c');
    expect(buf.getAll()).toEqual(['a', 'b', 'c']);
  });

  it('overwrites oldest when full', () => {
    const buf = new RingBuffer(3);
    buf.push('a');
    buf.push('b');
    buf.push('c');
    buf.push('d');
    expect(buf.getAll()).toEqual(['b', 'c', 'd']);
    expect(buf.size).toBe(3);
  });

  it('tracks sequence numbers monotonically', () => {
    const buf = new RingBuffer(3);
    expect(buf.push('a')).toBe(1);
    expect(buf.push('b')).toBe(2);
    expect(buf.push('c')).toBe(3);
    expect(buf.push('d')).toBe(4);
    expect(buf.currentSeq).toBe(4);
  });

  it('getSince returns lines after a sequence number', () => {
    const buf = new RingBuffer(5);
    buf.push('a'); // seq 1
    buf.push('b'); // seq 2
    buf.push('c'); // seq 3
    buf.push('d'); // seq 4

    expect(buf.getSince(2)).toEqual(['c', 'd']);
    expect(buf.getSince(0)).toEqual(['a', 'b', 'c', 'd']);
    expect(buf.getSince(4)).toEqual([]);
  });

  it('getSince handles overwritten lines', () => {
    const buf = new RingBuffer(3);
    buf.push('a'); // seq 1
    buf.push('b'); // seq 2
    buf.push('c'); // seq 3
    buf.push('d'); // seq 4 (overwrites a)
    buf.push('e'); // seq 5 (overwrites b)

    // Requesting from seq 1 should only get what's available
    expect(buf.getSince(1)).toEqual(['c', 'd', 'e']);
    expect(buf.getSince(3)).toEqual(['d', 'e']);
  });

  it('pushData splits on newlines', () => {
    const buf = new RingBuffer(10);
    buf.pushData('line1\nline2\nline3');
    // "line3" has no trailing \n, so it's held as a partial
    expect(buf.getAll()).toEqual(['line1', 'line2', 'line3']);
  });

  it('pushData does not create blank lines from trailing newlines', () => {
    const buf = new RingBuffer(10);
    buf.pushData('hello\n');
    buf.pushData('world\n');
    // Before fix: ["hello", "", "world", ""] → join → "hello\n\nworld\n" (extra blanks)
    // After fix: ["hello", "world"] → join → "hello\nworld" (correct)
    expect(buf.getAll()).toEqual(['hello', 'world']);
  });

  it('pushData handles partial lines across chunk boundaries', () => {
    const buf = new RingBuffer(10);
    buf.pushData('hel');
    buf.pushData('lo\nworld\n');
    // "hel" is incomplete — held as partial, prepended to next chunk
    expect(buf.getAll()).toEqual(['hello', 'world']);
  });

  it('pushData handles multiple chunks ending with newlines', () => {
    const buf = new RingBuffer(10);
    buf.pushData('prompt % \n');
    buf.pushData('ls\n');
    buf.pushData('file1\nfile2\n');
    const lines = buf.getAll();
    expect(lines).toEqual(['prompt % ', 'ls', 'file1', 'file2']);
    // Replay round-trip should not have extra blank lines
    expect(lines.join('\n')).toBe('prompt % \nls\nfile1\nfile2');
  });

  it('pushData preserves trailing partial for getAll and getSince', () => {
    const buf = new RingBuffer(10);
    buf.pushData('complete\npartial');
    expect(buf.getAll()).toEqual(['complete', 'partial']);
    // "partial" hasn't been assigned a seq, but is included in results
    expect(buf.getSince(0)).toEqual(['complete', 'partial']);
  });

  it('pushData empty string is a no-op', () => {
    const buf = new RingBuffer(10);
    buf.pushData('hello\n');
    buf.pushData('');
    buf.pushData('world\n');
    expect(buf.getAll()).toEqual(['hello', 'world']);
  });

  it('pushData bare newline creates empty line', () => {
    const buf = new RingBuffer(10);
    buf.pushData('hello\n');
    buf.pushData('\n');
    buf.pushData('world\n');
    expect(buf.getAll()).toEqual(['hello', '', 'world']);
  });

  it('keeps a no-newline stream whole below the partial ceiling (Issue #1047)', () => {
    const buf = new RingBuffer(10);
    // 100 KB with no newline, in 1 KB frames — mimics a full-screen TUI that
    // redraws in place and never emits \n.
    //
    // NOTE (#1205): "whole" is no longer an unconditional guarantee — the
    // partial is now capped (2MB by default). This fixture stays whole only
    // because 100 KB is well under that ceiling. See the "partial ceiling"
    // suite below for the capped behaviour; don't read this test as promising
    // unbounded retention.
    const frame = 'x'.repeat(1024);
    for (let i = 0; i < 100; i++) {
      buf.pushData(frame);
    }
    expect(buf.size).toBe(0); // no complete lines
    const all = buf.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].length).toBe(100 * 1024); // full content retained, not capped
    expect(buf.partialBytes).toBe(100 * 1024);
  });

  it('partialBytes reports the held incomplete-line size', () => {
    const buf = new RingBuffer(10);
    expect(buf.partialBytes).toBe(0);
    buf.pushData('abc');
    expect(buf.partialBytes).toBe(3);
    buf.pushData('def\n'); // completes the line, clears partial
    expect(buf.partialBytes).toBe(0);
  });

  it('clear resets content but keeps seq', () => {
    const buf = new RingBuffer(5);
    buf.push('a');
    buf.push('b');
    const seqBefore = buf.currentSeq;
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.getAll()).toEqual([]);
    expect(buf.currentSeq).toBe(seqBefore);
  });

  it('handles capacity of 1', () => {
    const buf = new RingBuffer(1);
    buf.push('a');
    buf.push('b');
    expect(buf.getAll()).toEqual(['b']);
    expect(buf.size).toBe(1);
  });

  it('handles large number of pushes', () => {
    const buf = new RingBuffer(100);
    for (let i = 0; i < 1000; i++) {
      buf.push(`line-${i}`);
    }
    expect(buf.size).toBe(100);
    expect(buf.getAll()[0]).toBe('line-900');
    expect(buf.getAll()[99]).toBe('line-999');
    expect(buf.currentSeq).toBe(1000);
  });

  describe('partial ceiling (#1205)', () => {
    /**
     * The defect: a full-screen TUI emits no newlines, so every byte lands in
     * the partial and it grew for the life of the session.
     */
    it('bounds a newline-free stream', () => {
      const buf = new RingBuffer(1000, 1000);
      for (let i = 0; i < 200; i++) {
        buf.pushData('z'.repeat(100));
      }
      expect(buf.partialBytes).toBeLessThanOrEqual(1000);
      expect(buf.size).toBe(0);
    });

    it('retains the newest characters, not the oldest', () => {
      const buf = new RingBuffer(1000, 100);
      buf.pushData('A'.repeat(100));
      buf.pushData('B'.repeat(60));
      // Trimming targets half the ceiling, so the 50 most recent characters
      // survive — all of them from the newest write, none from the oldest.
      const partial = buf.getAll()[0];
      expect(partial).toBe('B'.repeat(50));
    });

    it('never exceeds the ceiling across many appends', () => {
      const buf = new RingBuffer(1000, 512);
      let peak = 0;
      for (let i = 0; i < 500; i++) {
        buf.pushData('q'.repeat(37));
        peak = Math.max(peak, buf.partialBytes);
      }
      expect(peak).toBeLessThanOrEqual(512);
    });

    /**
     * Trimming back to exactly the ceiling would re-trim on every subsequent
     * append, making each call copy the whole partial — the O(|partial|)
     * per-call cost #1047 removed. Trimming to half the ceiling amortises it,
     * so the number of trims must stay proportional to growth, not to calls.
     */
    it('amortises trimming rather than copying on every append', () => {
      const ceiling = 1000;
      const buf = new RingBuffer(1000, ceiling);
      buf.pushData('x'.repeat(ceiling));

      let trims = 0;
      let previous = buf.partialBytes;
      for (let i = 0; i < 200; i++) {
        buf.pushData('y');
        if (buf.partialBytes < previous) trims++;
        previous = buf.partialBytes;
      }
      // 200 single-char appends past the ceiling: one trim per ~half-ceiling of
      // growth, so a small handful — emphatically not one per call.
      expect(trims).toBeLessThan(5);
    });

    it('leaves newline-terminated streams untouched', () => {
      const buf = new RingBuffer(1000, 10);
      buf.pushData('one\ntwo\nthree\n');
      expect(buf.partialBytes).toBe(0);
      expect(buf.getAll()).toEqual(['one', 'two', 'three']);
    });

    it('keeps getAll terminating with the capped partial', () => {
      const buf = new RingBuffer(1000, 100);
      buf.pushData('done\n');
      buf.pushData('W'.repeat(500));
      expect(buf.getAll()[0]).toBe('done');
      expect(buf.getAll()[1].length).toBeLessThanOrEqual(100);
    });

    it('does not change the documented getSince gap for caught-up clients', () => {
      const buf = new RingBuffer(1000, 100);
      buf.pushData('done\n');
      buf.pushData('W'.repeat(500));
      // Pre-existing #1047 behaviour, unchanged by the cap: seq only advances
      // on completed lines, so a client caught up to the last line gets nothing
      // and relies on the post-connect repaint nudge. Asserted here so capping
      // the partial can't be mistaken for having introduced the gap.
      expect(buf.getSince(1)).toEqual([]);
      // A client behind the last line still receives the capped partial.
      expect(buf.getSince(0)[1].length).toBeLessThanOrEqual(100);
    });

    it('defaults the ceiling to 2MB', () => {
      const buf = new RingBuffer(1000);
      for (let i = 0; i < 10; i++) {
        buf.pushData('m'.repeat(512 * 1024));
      }
      expect(buf.partialBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    });
  });
});
