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

  it('caps the partial to maxPartialBytes for a no-newline stream (Issue #1047)', () => {
    const cap = 1024;
    const buf = new RingBuffer(10, cap);
    // Feed 100 KB with no newline, in 1 KB frames — mimics a full-screen TUI
    // that redraws in place and never emits \n.
    const frame = 'x'.repeat(1024);
    for (let i = 0; i < 100; i++) {
      buf.pushData(frame);
    }
    // No complete lines were ever pushed.
    expect(buf.size).toBe(0);
    // The partial is bounded by the cap, not the 100 KB total.
    const all = buf.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].length).toBe(cap);
    // It retains the most recent bytes (front-trimmed).
    expect(all[0]).toBe('x'.repeat(cap));
  });

  it('byte-cap retains the tail across a mixed boundary', () => {
    const cap = 8;
    const buf = new RingBuffer(10, cap);
    buf.pushData('done\n');           // completes a line, clears partial
    buf.pushData('ABCDEFGHIJ');       // 10 bytes, no newline → trim to last 8
    expect(buf.getAll()).toEqual(['done', 'CDEFGHIJ']);
  });

  it('byte-cap does not clip lines that fit, and still splits correctly', () => {
    const cap = 16;
    const buf = new RingBuffer(10, cap);
    buf.pushData('short\nalsoShort\ntail');
    expect(buf.getAll()).toEqual(['short', 'alsoShort', 'tail']);
  });

  it('a newline after an over-cap run still emits a (trimmed) line', () => {
    const cap = 4;
    const buf = new RingBuffer(10, cap);
    buf.pushData('ABCDEFGH'); // 8 bytes, no newline → partial trimmed to 'EFGH'
    buf.pushData('\n');       // completes the (trimmed) line
    expect(buf.getAll()).toEqual(['EFGH']);
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
});
