/**
 * WebSocket binary protocol types for terminal communication.
 *
 * Protocol:
 * - 0x00 prefix: Control frame (remainder is UTF-8 JSON)
 * - 0x01 prefix: Data frame (remainder is raw PTY bytes)
 */

export const FRAME_CONTROL = 0x00;
export const FRAME_DATA = 0x01;

export interface ControlMessage {
  type: 'resize' | 'ping' | 'pong' | 'pause' | 'resume' | 'error' | 'seq';
  payload: Record<string, unknown>;
}

export type DecodedFrame =
  | { type: 'control'; message: ControlMessage }
  | { type: 'data'; data: Uint8Array };
