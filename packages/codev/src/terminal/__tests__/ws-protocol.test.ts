import { describe, it, expect } from 'vitest';
import {
  encodeControl,
  encodeData,
  decodeFrame,
  FRAME_CONTROL,
  FRAME_DATA,
} from '../ws-protocol.js';

describe('ws-protocol', () => {
  describe('encodeControl / decodeFrame', () => {
    it('round-trips a control message', () => {
      const msg = { type: 'resize' as const, payload: { cols: 120, rows: 40 } };
      const frame = encodeControl(msg);

      expect(frame[0]).toBe(FRAME_CONTROL);

      const decoded = decodeFrame(frame);
      expect(decoded.type).toBe('control');
      if (decoded.type === 'control') {
        expect(decoded.message.type).toBe('resize');
        expect(decoded.message.payload.cols).toBe(120);
        expect(decoded.message.payload.rows).toBe(40);
      }
    });

    it('round-trips a ping control message', () => {
      const msg = { type: 'ping' as const, payload: {} };
      const frame = encodeControl(msg);
      const decoded = decodeFrame(frame);
      expect(decoded.type).toBe('control');
      if (decoded.type === 'control') {
        expect(decoded.message.type).toBe('ping');
      }
    });
  });

  describe('encodeData / decodeFrame', () => {
    it('round-trips string data', () => {
      const frame = encodeData('hello world');
      expect(frame[0]).toBe(FRAME_DATA);

      const decoded = decodeFrame(frame);
      expect(decoded.type).toBe('data');
      if (decoded.type === 'data') {
        expect(decoded.data.toString('utf-8')).toBe('hello world');
      }
    });

    it('round-trips binary data', () => {
      const original = Buffer.from([0x1b, 0x5b, 0x31, 0x6d]); // ESC[1m
      const frame = encodeData(original);
      const decoded = decodeFrame(frame);
      expect(decoded.type).toBe('data');
      if (decoded.type === 'data') {
        expect(decoded.data).toEqual(original);
      }
    });

    it('handles empty data', () => {
      const frame = encodeData('');
      const decoded = decodeFrame(frame);
      expect(decoded.type).toBe('data');
      if (decoded.type === 'data') {
        expect(decoded.data.length).toBe(0);
      }
    });
  });

  describe('error cases', () => {
    it('throws on empty frame', () => {
      expect(() => decodeFrame(Buffer.alloc(0))).toThrow('Empty frame');
    });

    it('throws on unknown prefix', () => {
      const bad = Buffer.from([0xff, 0x01, 0x02]);
      expect(() => decodeFrame(bad)).toThrow('Unknown frame prefix: 0xff');
    });

    it('throws on invalid JSON in control frame', () => {
      const bad = Buffer.from([FRAME_CONTROL, ...Buffer.from('not json')]);
      expect(() => decodeFrame(bad)).toThrow();
    });
  });
});
