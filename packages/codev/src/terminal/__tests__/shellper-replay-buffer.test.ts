import { describe, it, expect } from 'vitest';
import { ShellperReplayBuffer } from '../shellper-replay-buffer.js';

describe('ShellperReplayBuffer', () => {
  it('evicts by line count (existing behavior preserved)', () => {
    const buf = new ShellperReplayBuffer(3);
    buf.append('a\nb\nc\nd\ne\n');
    // Keeps the last ~3 lines worth of data.
    const replay = buf.getReplayData().toString('utf-8');
    expect(replay.endsWith('e\n')).toBe(true);
    expect(replay).not.toContain('a\n');
    expect(buf.lines).toBeLessThanOrEqual(3);
  });

  it('bounds a no-newline stream by bytes (Issue #1047)', () => {
    const maxBytes = 4096;
    const buf = new ShellperReplayBuffer(10_000, maxBytes);
    // 100 KB of redraw output with no newline — lineCount stays 0, so the
    // line cap never fires; the byte cap must bound it.
    const frame = Buffer.alloc(1024, 0x78); // 'x'
    for (let i = 0; i < 100; i++) {
      buf.append(frame);
    }
    expect(buf.lines).toBe(0);
    expect(buf.size).toBeLessThanOrEqual(maxBytes);
    expect(buf.getReplayData().length).toBeLessThanOrEqual(maxBytes);
  });

  it('byte cap retains the most recent bytes', () => {
    const maxBytes = 8;
    const buf = new ShellperReplayBuffer(10_000, maxBytes);
    buf.append('ABCDEFGHIJKLMNOP'); // 16 bytes, no newline
    expect(buf.getReplayData().toString('utf-8')).toBe('IJKLMNOP');
  });

  it('respects both caps when a single chunk overflows lines and bytes', () => {
    const buf = new ShellperReplayBuffer(2, 64);
    // Many short lines in one append: over the line cap and (eventually) bytes.
    const data = Array.from({ length: 50 }, (_, i) => `row${i}`).join('\n') + '\n';
    buf.append(data);
    expect(buf.lines).toBeLessThanOrEqual(2);
    expect(buf.size).toBeLessThanOrEqual(64);
    // Most recent rows survive.
    expect(buf.getReplayData().toString('utf-8')).toContain('row49');
  });

  it('does not evict when under both caps', () => {
    const buf = new ShellperReplayBuffer(10_000, 1024 * 1024);
    buf.append('hello\nworld\n');
    expect(buf.getReplayData().toString('utf-8')).toBe('hello\nworld\n');
  });
});
