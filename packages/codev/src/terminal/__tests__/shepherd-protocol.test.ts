import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  FrameType,
  PROTOCOL_VERSION,
  MAX_FRAME_SIZE,
  HEADER_SIZE,
  ALLOWED_SIGNALS,
  encodeFrame,
  encodeData,
  encodeResize,
  encodeSignal,
  encodeExit,
  encodeReplay,
  encodePing,
  encodePong,
  encodeHello,
  encodeWelcome,
  encodeSpawn,
  createFrameParser,
  isKnownFrameType,
  parseJsonPayload,
  type ParsedFrame,
  type FrameTypeValue,
} from '../shepherd-protocol.js';

// Helper: collect all frames emitted by a parser
function collectFrames(parser: ReturnType<typeof createFrameParser>, data: Buffer): Promise<ParsedFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: ParsedFrame[] = [];
    parser.on('data', (frame: ParsedFrame) => frames.push(frame));
    parser.on('end', () => resolve(frames));
    parser.on('error', reject);
    parser.write(data);
    parser.end();
  });
}

describe('shepherd-protocol', () => {
  describe('encodeFrame / basic structure', () => {
    it('produces correct header: [type][4-byte length]', () => {
      const payload = Buffer.from('hello');
      const frame = encodeFrame(FrameType.DATA, payload);

      expect(frame.length).toBe(HEADER_SIZE + payload.length);
      expect(frame[0]).toBe(FrameType.DATA);
      expect(frame.readUInt32BE(1)).toBe(payload.length);
      expect(frame.subarray(HEADER_SIZE).toString()).toBe('hello');
    });

    it('handles empty payload', () => {
      const frame = encodeFrame(FrameType.PING, Buffer.alloc(0));
      expect(frame.length).toBe(HEADER_SIZE);
      expect(frame[0]).toBe(FrameType.PING);
      expect(frame.readUInt32BE(1)).toBe(0);
    });
  });

  describe('encode/decode round-trips', () => {
    it('DATA frame round-trips with string', async () => {
      const frame = encodeData('hello world');
      const parser = createFrameParser();
      const frames = await collectFrames(parser, frame);

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(FrameType.DATA);
      expect(frames[0].payload.toString('utf-8')).toBe('hello world');
    });

    it('DATA frame round-trips with binary data', async () => {
      const binary = Buffer.from([0x1b, 0x5b, 0x31, 0x6d]); // ESC[1m
      const frame = encodeData(binary);
      const parser = createFrameParser();
      const frames = await collectFrames(parser, frame);

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(FrameType.DATA);
      expect(frames[0].payload).toEqual(binary);
    });

    it('RESIZE frame round-trips', async () => {
      const frame = encodeResize({ cols: 120, rows: 40 });
      const parser = createFrameParser();
      const frames = await collectFrames(parser, frame);

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(FrameType.RESIZE);
      const msg = parseJsonPayload<{ cols: number; rows: number }>(frames[0].payload);
      expect(msg.cols).toBe(120);
      expect(msg.rows).toBe(40);
    });

    it('SIGNAL frame round-trips', async () => {
      const frame = encodeSignal({ signal: 2 }); // SIGINT
      const parser = createFrameParser();
      const frames = await collectFrames(parser, frame);

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(FrameType.SIGNAL);
      const msg = parseJsonPayload<{ signal: number }>(frames[0].payload);
      expect(msg.signal).toBe(2);
    });

    it('EXIT frame round-trips', async () => {
      const frame = encodeExit({ code: 0, signal: null });
      const parser = createFrameParser();
      const frames = await collectFrames(parser, frame);

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(FrameType.EXIT);
      const msg = parseJsonPayload<{ code: number | null; signal: string | null }>(frames[0].payload);
      expect(msg.code).toBe(0);
      expect(msg.signal).toBeNull();
    });

    it('EXIT frame with signal', async () => {
      const frame = encodeExit({ code: null, signal: 'SIGKILL' });
      const parser = createFrameParser();
      const frames = await collectFrames(parser, frame);

      const msg = parseJsonPayload<{ code: number | null; signal: string | null }>(frames[0].payload);
      expect(msg.code).toBeNull();
      expect(msg.signal).toBe('SIGKILL');
    });

    it('REPLAY frame round-trips', async () => {
      const replayData = Buffer.from('line1\r\nline2\r\nline3\r\n');
      const frame = encodeReplay(replayData);
      const parser = createFrameParser();
      const frames = await collectFrames(parser, frame);

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(FrameType.REPLAY);
      expect(frames[0].payload).toEqual(replayData);
    });

    it('PING frame round-trips', async () => {
      const frame = encodePing();
      const parser = createFrameParser();
      const frames = await collectFrames(parser, frame);

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(FrameType.PING);
      expect(frames[0].payload.length).toBe(0);
    });

    it('PONG frame round-trips', async () => {
      const frame = encodePong();
      const parser = createFrameParser();
      const frames = await collectFrames(parser, frame);

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(FrameType.PONG);
      expect(frames[0].payload.length).toBe(0);
    });

    it('HELLO frame round-trips', async () => {
      const frame = encodeHello({ version: PROTOCOL_VERSION });
      const parser = createFrameParser();
      const frames = await collectFrames(parser, frame);

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(FrameType.HELLO);
      const msg = parseJsonPayload<{ version: number }>(frames[0].payload);
      expect(msg.version).toBe(PROTOCOL_VERSION);
    });

    it('WELCOME frame round-trips', async () => {
      const frame = encodeWelcome({ pid: 12345, cols: 80, rows: 24, startTime: 1700000000000 });
      const parser = createFrameParser();
      const frames = await collectFrames(parser, frame);

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(FrameType.WELCOME);
      const msg = parseJsonPayload<{ pid: number; cols: number; rows: number; startTime: number }>(
        frames[0].payload,
      );
      expect(msg.pid).toBe(12345);
      expect(msg.cols).toBe(80);
      expect(msg.rows).toBe(24);
      expect(msg.startTime).toBe(1700000000000);
    });

    it('SPAWN frame round-trips', async () => {
      const spawnMsg = {
        command: '/bin/bash',
        args: ['-l'],
        cwd: '/home/user',
        env: { HOME: '/home/user', TERM: 'xterm-256color' },
      };
      const frame = encodeSpawn(spawnMsg);
      const parser = createFrameParser();
      const frames = await collectFrames(parser, frame);

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(FrameType.SPAWN);
      const msg = parseJsonPayload<typeof spawnMsg>(frames[0].payload);
      expect(msg.command).toBe('/bin/bash');
      expect(msg.args).toEqual(['-l']);
      expect(msg.cwd).toBe('/home/user');
      expect(msg.env.HOME).toBe('/home/user');
    });
  });

  describe('FrameParser streaming', () => {
    it('parses multiple frames in a single chunk', async () => {
      const frame1 = encodeData('hello');
      const frame2 = encodePing();
      const frame3 = encodeData('world');
      const combined = Buffer.concat([frame1, frame2, frame3]);

      const parser = createFrameParser();
      const frames = await collectFrames(parser, combined);

      expect(frames).toHaveLength(3);
      expect(frames[0].type).toBe(FrameType.DATA);
      expect(frames[0].payload.toString()).toBe('hello');
      expect(frames[1].type).toBe(FrameType.PING);
      expect(frames[2].type).toBe(FrameType.DATA);
      expect(frames[2].payload.toString()).toBe('world');
    });

    it('handles fragmented data (partial frames across chunks)', async () => {
      const frame = encodeData('hello world, this is a longer message for testing');
      const parser = createFrameParser();
      const frames: ParsedFrame[] = [];

      parser.on('data', (f: ParsedFrame) => frames.push(f));

      await new Promise<void>((resolve) => {
        // Split the frame into 3-byte chunks
        let offset = 0;
        const interval = setInterval(() => {
          if (offset >= frame.length) {
            clearInterval(interval);
            parser.end();
            // Give time for the end event to propagate
            setTimeout(resolve, 10);
            return;
          }
          const end = Math.min(offset + 3, frame.length);
          parser.write(frame.subarray(offset, end));
          offset = end;
        }, 1);
      });

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(FrameType.DATA);
      expect(frames[0].payload.toString()).toBe('hello world, this is a longer message for testing');
    });

    it('handles frame split exactly at header boundary', async () => {
      const frame = encodeData('test');
      const parser = createFrameParser();
      const frames: ParsedFrame[] = [];

      parser.on('data', (f: ParsedFrame) => frames.push(f));

      await new Promise<void>((resolve) => {
        // Send header and payload separately
        parser.write(frame.subarray(0, HEADER_SIZE));
        parser.write(frame.subarray(HEADER_SIZE));
        parser.end();
        setTimeout(resolve, 10);
      });

      expect(frames).toHaveLength(1);
      expect(frames[0].payload.toString()).toBe('test');
    });

    it('rejects oversized frames (>16MB)', async () => {
      // Craft a header claiming a huge payload
      const header = Buffer.allocUnsafe(HEADER_SIZE);
      header[0] = FrameType.DATA;
      header.writeUInt32BE(MAX_FRAME_SIZE + 1, 1);

      const parser = createFrameParser();

      await expect(new Promise((resolve, reject) => {
        parser.on('data', resolve);
        parser.on('error', reject);
        parser.write(header);
      })).rejects.toThrow(/exceeds maximum/);
    });

    it('passes through unknown frame types', async () => {
      const unknownType = 0xff;
      const payload = Buffer.from('unknown');
      const frame = encodeFrame(unknownType as FrameTypeValue, payload);
      const parser = createFrameParser();
      const frames = await collectFrames(parser, frame);

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(0xff);
      expect(frames[0].payload.toString()).toBe('unknown');
    });

    it('rejects incomplete frame at end of stream', async () => {
      const parser = createFrameParser();

      // Write just a partial header (3 bytes of the 5-byte header)
      await expect(new Promise((resolve, reject) => {
        parser.on('data', resolve);
        parser.on('error', reject);
        parser.write(Buffer.from([0x01, 0x00, 0x00]));
        parser.end();
      })).rejects.toThrow(/Incomplete frame/);
    });

    it('rejects incomplete frame payload at end of stream', async () => {
      const parser = createFrameParser();

      // Write a header claiming 10 bytes, but only provide 3
      const header = Buffer.allocUnsafe(HEADER_SIZE);
      header[0] = FrameType.DATA;
      header.writeUInt32BE(10, 1);
      const partialPayload = Buffer.from('abc');

      await expect(new Promise((resolve, reject) => {
        parser.on('data', resolve);
        parser.on('error', reject);
        parser.write(Buffer.concat([header, partialPayload]));
        parser.end();
      })).rejects.toThrow(/Incomplete frame/);
    });
  });

  describe('parseJsonPayload', () => {
    it('parses valid JSON', () => {
      const payload = Buffer.from(JSON.stringify({ cols: 80, rows: 24 }));
      const result = parseJsonPayload<{ cols: number; rows: number }>(payload);
      expect(result.cols).toBe(80);
      expect(result.rows).toBe(24);
    });

    it('throws on invalid JSON', () => {
      const payload = Buffer.from('not json at all');
      expect(() => parseJsonPayload(payload)).toThrow();
    });

    it('throws on empty payload', () => {
      const payload = Buffer.alloc(0);
      expect(() => parseJsonPayload(payload)).toThrow();
    });
  });

  describe('isKnownFrameType', () => {
    it('returns true for all defined frame types', () => {
      expect(isKnownFrameType(FrameType.DATA)).toBe(true);
      expect(isKnownFrameType(FrameType.RESIZE)).toBe(true);
      expect(isKnownFrameType(FrameType.SIGNAL)).toBe(true);
      expect(isKnownFrameType(FrameType.EXIT)).toBe(true);
      expect(isKnownFrameType(FrameType.REPLAY)).toBe(true);
      expect(isKnownFrameType(FrameType.PING)).toBe(true);
      expect(isKnownFrameType(FrameType.PONG)).toBe(true);
      expect(isKnownFrameType(FrameType.HELLO)).toBe(true);
      expect(isKnownFrameType(FrameType.WELCOME)).toBe(true);
      expect(isKnownFrameType(FrameType.SPAWN)).toBe(true);
    });

    it('returns false for unknown types', () => {
      expect(isKnownFrameType(0x00)).toBe(false);
      expect(isKnownFrameType(0x0b)).toBe(false);
      expect(isKnownFrameType(0xff)).toBe(false);
    });
  });

  describe('ALLOWED_SIGNALS', () => {
    it('contains exactly the 5 allowed signals', () => {
      expect(ALLOWED_SIGNALS.size).toBe(5);
      expect(ALLOWED_SIGNALS.has(1)).toBe(true);  // SIGHUP
      expect(ALLOWED_SIGNALS.has(2)).toBe(true);  // SIGINT
      expect(ALLOWED_SIGNALS.has(9)).toBe(true);  // SIGKILL
      expect(ALLOWED_SIGNALS.has(15)).toBe(true); // SIGTERM
      expect(ALLOWED_SIGNALS.has(28)).toBe(true); // SIGWINCH
    });

    it('rejects other signals', () => {
      expect(ALLOWED_SIGNALS.has(3)).toBe(false);  // SIGQUIT
      expect(ALLOWED_SIGNALS.has(6)).toBe(false);  // SIGABRT
      expect(ALLOWED_SIGNALS.has(11)).toBe(false); // SIGSEGV
      expect(ALLOWED_SIGNALS.has(19)).toBe(false); // SIGSTOP
    });
  });

  describe('constants', () => {
    it('PROTOCOL_VERSION is 1', () => {
      expect(PROTOCOL_VERSION).toBe(1);
    });

    it('MAX_FRAME_SIZE is 16MB', () => {
      expect(MAX_FRAME_SIZE).toBe(16 * 1024 * 1024);
    });

    it('HEADER_SIZE is 5', () => {
      expect(HEADER_SIZE).toBe(5);
    });
  });
});
