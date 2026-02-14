/**
 * Shellper wire protocol: binary frame encoding/decoding for Unix socket
 * communication between Tower and shellper processes.
 *
 * Frame format: [1-byte type] [4-byte big-endian length] [payload]
 *
 * This module is imported by both the shellper process (standalone) and
 * Tower (within the main package). It has NO dependencies beyond Node.js
 * built-ins to keep the shellper process lightweight.
 */

import { Transform, type TransformCallback } from 'node:stream';

// --- Frame Types ---

export const FrameType = {
  DATA: 0x01,
  RESIZE: 0x02,
  SIGNAL: 0x03,
  EXIT: 0x04,
  REPLAY: 0x05,
  PING: 0x06,
  PONG: 0x07,
  HELLO: 0x08,
  WELCOME: 0x09,
  SPAWN: 0x0a,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

// --- Protocol Constants ---

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_SIZE = 16 * 1024 * 1024; // 16MB
export const HEADER_SIZE = 5; // 1 byte type + 4 bytes length

// --- Allowed Signals ---

export const ALLOWED_SIGNALS = new Set([
  1, // SIGHUP
  2, // SIGINT
  9, // SIGKILL
  15, // SIGTERM
  28, // SIGWINCH
]);

// --- Typed Message Interfaces ---

export interface ResizeMessage {
  cols: number;
  rows: number;
}

export interface SignalMessage {
  signal: number;
}

export interface ExitMessage {
  code: number | null;
  signal: string | null;
}

export interface HelloMessage {
  version: number;
}

export interface WelcomeMessage {
  version: number;
  pid: number;
  cols: number;
  rows: number;
  startTime: number;
}

export interface SpawnMessage {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

// --- Frame Encoding ---

/**
 * Encode a frame with the given type and payload.
 */
export function encodeFrame(type: FrameTypeValue, payload: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(HEADER_SIZE + payload.length);
  frame[0] = type;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, HEADER_SIZE);
  return frame;
}

/** Encode a DATA frame (raw PTY bytes). */
export function encodeData(data: Buffer | string): Buffer {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  return encodeFrame(FrameType.DATA, buf);
}

/** Encode a RESIZE frame. */
export function encodeResize(msg: ResizeMessage): Buffer {
  return encodeFrame(FrameType.RESIZE, Buffer.from(JSON.stringify(msg)));
}

/** Encode a SIGNAL frame. */
export function encodeSignal(msg: SignalMessage): Buffer {
  return encodeFrame(FrameType.SIGNAL, Buffer.from(JSON.stringify(msg)));
}

/** Encode an EXIT frame. */
export function encodeExit(msg: ExitMessage): Buffer {
  return encodeFrame(FrameType.EXIT, Buffer.from(JSON.stringify(msg)));
}

/** Encode a REPLAY frame (raw bytes). */
export function encodeReplay(data: Buffer): Buffer {
  return encodeFrame(FrameType.REPLAY, data);
}

/** Encode a PING frame. */
export function encodePing(): Buffer {
  return encodeFrame(FrameType.PING, Buffer.alloc(0));
}

/** Encode a PONG frame. */
export function encodePong(): Buffer {
  return encodeFrame(FrameType.PONG, Buffer.alloc(0));
}

/** Encode a HELLO frame. */
export function encodeHello(msg: HelloMessage): Buffer {
  return encodeFrame(FrameType.HELLO, Buffer.from(JSON.stringify(msg)));
}

/** Encode a WELCOME frame. */
export function encodeWelcome(msg: WelcomeMessage): Buffer {
  return encodeFrame(FrameType.WELCOME, Buffer.from(JSON.stringify(msg)));
}

/** Encode a SPAWN frame. */
export function encodeSpawn(msg: SpawnMessage): Buffer {
  return encodeFrame(FrameType.SPAWN, Buffer.from(JSON.stringify(msg)));
}

// --- Parsed Frame ---

export interface ParsedFrame {
  type: FrameTypeValue | number; // number allows unknown types
  payload: Buffer;
}

// --- Streaming Frame Parser ---

/**
 * A Transform stream that parses the binary frame protocol.
 *
 * Input: raw socket data (may be fragmented across chunks)
 * Output: ParsedFrame objects (in objectMode)
 *
 * Emits 'frame-error' event on protocol violations (oversized frames,
 * malformed headers). The stream is destroyed on error.
 */
export class FrameParser extends Transform {
  private chunks: Buffer[] = [];
  private bufferedLength = 0;

  constructor() {
    super({ readableObjectMode: true });
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.chunks.push(chunk);
    this.bufferedLength += chunk.length;

    try {
      this.drainFrames();
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  _flush(callback: TransformCallback): void {
    if (this.bufferedLength > 0) {
      callback(
        new Error(`Incomplete frame: ${this.bufferedLength} bytes remaining at end of stream`),
      );
    } else {
      callback();
    }
  }

  private drainFrames(): void {
    while (this.bufferedLength >= HEADER_SIZE) {
      // Peek at the header without consuming
      const header = this.peek(HEADER_SIZE);
      const payloadLength = header.readUInt32BE(1);

      if (payloadLength > MAX_FRAME_SIZE) {
        throw new Error(
          `Frame payload size ${payloadLength} exceeds maximum ${MAX_FRAME_SIZE}`,
        );
      }

      const totalLength = HEADER_SIZE + payloadLength;
      if (this.bufferedLength < totalLength) {
        // Need more data
        break;
      }

      // Consume the full frame
      const frameData = this.consume(totalLength);
      const type = frameData[0] as FrameTypeValue | number;
      const payload = frameData.subarray(HEADER_SIZE);

      this.push({ type, payload } satisfies ParsedFrame);
    }
  }

  private peek(n: number): Buffer {
    if (this.chunks.length === 1 && this.chunks[0].length >= n) {
      return this.chunks[0].subarray(0, n);
    }
    // Slow path: concat needed bytes
    const parts: Buffer[] = [];
    let remaining = n;
    for (const chunk of this.chunks) {
      if (remaining <= 0) break;
      const take = Math.min(chunk.length, remaining);
      parts.push(chunk.subarray(0, take));
      remaining -= take;
    }
    return Buffer.concat(parts);
  }

  private consume(n: number): Buffer {
    if (this.chunks.length === 1 && this.chunks[0].length === n) {
      const buf = this.chunks[0];
      this.chunks = [];
      this.bufferedLength = 0;
      return buf;
    }

    if (this.chunks.length === 1 && this.chunks[0].length > n) {
      const buf = this.chunks[0].subarray(0, n);
      this.chunks[0] = this.chunks[0].subarray(n);
      this.bufferedLength -= n;
      return Buffer.from(buf); // Copy so subarray doesn't pin original
    }

    // Slow path: gather from multiple chunks
    const result = Buffer.allocUnsafe(n);
    let offset = 0;
    let remaining = n;

    while (remaining > 0) {
      const chunk = this.chunks[0];
      const take = Math.min(chunk.length, remaining);
      chunk.copy(result, offset, 0, take);
      offset += take;
      remaining -= take;

      if (take === chunk.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = chunk.subarray(take);
      }
    }

    this.bufferedLength -= n;
    return result;
  }
}

/**
 * Create a streaming frame parser.
 * Convenience factory matching the plan's API.
 */
export function createFrameParser(): FrameParser {
  return new FrameParser();
}

// --- JSON Payload Helpers ---

const KNOWN_FRAME_TYPES = new Set(Object.values(FrameType));

/** Check if a frame type is a known type. */
export function isKnownFrameType(type: number): type is FrameTypeValue {
  return KNOWN_FRAME_TYPES.has(type as FrameTypeValue);
}

/**
 * Parse a JSON payload from a control frame.
 * Throws on invalid JSON.
 */
export function parseJsonPayload<T>(payload: Buffer): T {
  return JSON.parse(payload.toString('utf-8')) as T;
}
