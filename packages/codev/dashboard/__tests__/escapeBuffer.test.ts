/**
 * Unit tests for EscapeBuffer — ensures escape sequences split across
 * WebSocket frames are reassembled before writing to xterm (Issue #630).
 */
import { describe, it, expect } from 'vitest';
import { EscapeBuffer } from '../src/lib/escapeBuffer.js';

describe('EscapeBuffer', () => {
  describe('plain text (no escape sequences)', () => {
    it('passes through plain text unchanged', () => {
      const buf = new EscapeBuffer();
      expect(buf.write('Hello, world!')).toBe('Hello, world!');
    });

    it('passes through empty string', () => {
      const buf = new EscapeBuffer();
      expect(buf.write('')).toBe('');
    });
  });

  describe('complete escape sequences', () => {
    it('passes through complete CSI sequence', () => {
      const buf = new EscapeBuffer();
      expect(buf.write('\x1b[31mHello')).toBe('\x1b[31mHello');
    });

    it('passes through multiple complete CSI sequences', () => {
      const buf = new EscapeBuffer();
      expect(buf.write('\x1b[31mHello\x1b[0m')).toBe('\x1b[31mHello\x1b[0m');
    });

    it('passes through complete OSC sequence with BEL', () => {
      const buf = new EscapeBuffer();
      expect(buf.write('\x1b]0;title\x07')).toBe('\x1b]0;title\x07');
    });

    it('passes through complete OSC sequence with ST', () => {
      const buf = new EscapeBuffer();
      expect(buf.write('\x1b]0;title\x1b\\')).toBe('\x1b]0;title\x1b\\');
    });

    it('passes through two-byte escape sequences (ESC =, ESC >)', () => {
      const buf = new EscapeBuffer();
      expect(buf.write('\x1b=Hello')).toBe('\x1b=Hello');
      expect(buf.write('\x1b>World')).toBe('\x1b>World');
    });
  });

  describe('split CSI sequences', () => {
    it('buffers trailing ESC at end of chunk', () => {
      const buf = new EscapeBuffer();
      // Frame 1: text ending with bare ESC
      const out1 = buf.write('Hello\x1b');
      expect(out1).toBe('Hello');
      expect(buf.hasPending).toBe(true);

      // Frame 2: continuation completes the sequence
      const out2 = buf.write('[31mWorld');
      expect(out2).toBe('\x1b[31mWorld');
      expect(buf.hasPending).toBe(false);
    });

    it('buffers incomplete CSI (ESC [) at end of chunk', () => {
      const buf = new EscapeBuffer();
      const out1 = buf.write('Hello\x1b[');
      expect(out1).toBe('Hello');

      const out2 = buf.write('31m');
      expect(out2).toBe('\x1b[31m');
    });

    it('buffers incomplete CSI with partial parameters', () => {
      const buf = new EscapeBuffer();
      // Split mid-sequence: ESC [ 3 (missing final byte)
      const out1 = buf.write('Hello\x1b[3');
      expect(out1).toBe('Hello');

      const out2 = buf.write('1mWorld');
      expect(out2).toBe('\x1b[31mWorld');
    });

    it('handles DA response split across frames', () => {
      const buf = new EscapeBuffer();
      // DA response: ESC [ ? 6 c — split after ESC [ ? 6
      const out1 = buf.write('Hello\x1b[?6');
      expect(out1).toBe('Hello');

      const out2 = buf.write('cWorld');
      expect(out2).toBe('\x1b[?6cWorld');
    });

    it('handles multiple splits in sequence', () => {
      const buf = new EscapeBuffer();
      // First split
      const out1 = buf.write('A\x1b');
      expect(out1).toBe('A');

      // Second chunk also has split
      const out2 = buf.write('[31mB\x1b[3');
      expect(out2).toBe('\x1b[31mB');

      // Third chunk completes
      const out3 = buf.write('2mC');
      expect(out3).toBe('\x1b[32mC');
    });
  });

  describe('split OSC sequences', () => {
    it('buffers incomplete OSC', () => {
      const buf = new EscapeBuffer();
      const out1 = buf.write('Hello\x1b]0;tit');
      expect(out1).toBe('Hello');

      const out2 = buf.write('le\x07World');
      expect(out2).toBe('\x1b]0;title\x07World');
    });
  });

  describe('split DCS sequences', () => {
    it('buffers incomplete DCS', () => {
      const buf = new EscapeBuffer();
      const out1 = buf.write('Hello\x1bPdata');
      expect(out1).toBe('Hello');

      const out2 = buf.write('more\x1b\\World');
      expect(out2).toBe('\x1bPdatamore\x1b\\World');
    });
  });

  describe('flush', () => {
    it('returns empty string when no pending data', () => {
      const buf = new EscapeBuffer();
      expect(buf.flush()).toBe('');
    });

    it('returns and clears pending data', () => {
      const buf = new EscapeBuffer();
      buf.write('Hello\x1b');
      expect(buf.flush()).toBe('\x1b');
      expect(buf.hasPending).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles chunk that is just ESC', () => {
      const buf = new EscapeBuffer();
      const out = buf.write('\x1b');
      expect(out).toBe('');
      expect(buf.hasPending).toBe(true);
    });

    it('handles chunk that is just ESC [', () => {
      const buf = new EscapeBuffer();
      const out = buf.write('\x1b[');
      expect(out).toBe('');
      expect(buf.hasPending).toBe(true);
    });

    it('does not buffer complete sequence followed by text', () => {
      const buf = new EscapeBuffer();
      const out = buf.write('\x1b[31mHello');
      expect(out).toBe('\x1b[31mHello');
      expect(buf.hasPending).toBe(false);
    });

    it('only buffers the LAST incomplete sequence', () => {
      const buf = new EscapeBuffer();
      // Complete CSI + incomplete CSI at end
      const out = buf.write('\x1b[31mHello\x1b[');
      expect(out).toBe('\x1b[31mHello');
      expect(buf.hasPending).toBe(true);
    });

    it('handles box-drawing characters (code 0x2500) that trigger issue #630', () => {
      // Box-drawing ─ (U+2500) is what the bug report mentioned:
      // "Code 9472 = 0x2500 (box-drawing ─), currentState: 4 = escape state"
      // This happens when ─ appears after a split ESC sequence
      const buf = new EscapeBuffer();
      const boxChar = String.fromCharCode(0x2500); // ─

      // ESC split before box-drawing char — without buffering, xterm would
      // receive ESC then ─ in escape state, causing parsing error
      const out1 = buf.write('test\x1b');
      expect(out1).toBe('test');

      const out2 = buf.write(`[1m${boxChar}${boxChar}${boxChar}`);
      expect(out2).toBe(`\x1b[1m${boxChar}${boxChar}${boxChar}`);
    });
  });
});
