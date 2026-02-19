/**
 * WebSocket frame encoding/decoding for terminal communication.
 *
 * Hybrid protocol:
 * - 0x00 prefix: Control frame (remainder is UTF-8 JSON)
 * - 0x01 prefix: Data frame (remainder is raw PTY bytes)
 */

export const FRAME_CONTROL = 0x00;
export const FRAME_DATA = 0x01;

export interface ControlMessage {
  type: 'resize' | 'ping' | 'pong' | 'pause' | 'resume' | 'error' | 'seq';
  payload: Record<string, unknown>;
}

/** Encode a control message into a binary frame. */
export function encodeControl(msg: ControlMessage): Buffer {
  const json = JSON.stringify(msg);
  const jsonBuf = Buffer.from(json, 'utf-8');
  const frame = Buffer.allocUnsafe(1 + jsonBuf.length);
  frame[0] = FRAME_CONTROL;
  jsonBuf.copy(frame, 1);
  return frame;
}

/** Encode raw PTY data into a binary frame. */
export function encodeData(data: Buffer | string): Buffer {
  const dataBuf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  const frame = Buffer.allocUnsafe(1 + dataBuf.length);
  frame[0] = FRAME_DATA;
  dataBuf.copy(frame, 1);
  return frame;
}

export type DecodedFrame =
  | { type: 'control'; message: ControlMessage }
  | { type: 'data'; data: Buffer };

/** Decode a received WebSocket frame. */
export function decodeFrame(frame: Buffer): DecodedFrame {
  if (frame.length === 0) {
    throw new Error('Empty frame');
  }

  const prefix = frame[0];
  const payload = frame.subarray(1);

  if (prefix === FRAME_CONTROL) {
    const json = payload.toString('utf-8');
    const message = JSON.parse(json) as ControlMessage;
    return { type: 'control', message };
  }

  if (prefix === FRAME_DATA) {
    return { type: 'data', data: payload };
  }

  throw new Error(`Unknown frame prefix: 0x${prefix.toString(16)}`);
}
