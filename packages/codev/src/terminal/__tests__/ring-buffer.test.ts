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
    expect(buf.getAll()).toEqual(['line1', 'line2', 'line3']);
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
