/**
 * WebSocket binary protocol types for terminal communication.
 *
 * Protocol:
 * - 0x00 prefix: Control frame (remainder is UTF-8 JSON)
 * - 0x01 prefix: Data frame (remainder is raw PTY bytes)
 */

export const FRAME_CONTROL = 0x00;
export const FRAME_DATA = 0x01;

/**
 * Request-authentication wire contracts (advisory GHSA-xvjp-7748-v88v). The
 * Tower server enforces these; clients only transport the shared local key.
 *
 * - `WEB_KEY_HEADER`: the HTTP header carrying the key on authenticated requests.
 * - WebSocket key transport: browsers cannot set headers on a WebSocket, so the
 *   key travels as a `Sec-WebSocket-Protocol` subprotocol. A client offers
 *   `WS_MARKER_PROTOCOL` (a non-secret marker the server echoes back so strict
 *   `ws` clients accept the handshake) plus a `${WS_KEY_PROTOCOL_PREFIX}<key>`
 *   token the server validates at the upgrade and never echoes.
 */
export const WEB_KEY_HEADER = 'codev-web-key';
export const WS_MARKER_PROTOCOL = 'codev.tower.v1';
export const WS_KEY_PROTOCOL_PREFIX = 'codev-key.';

export interface ControlMessage {
  type: 'resize' | 'ping' | 'pong' | 'pause' | 'resume' | 'error' | 'seq';
  payload: Record<string, unknown>;
}

export type DecodedFrame =
  | { type: 'control'; message: ControlMessage }
  | { type: 'data'; data: Uint8Array };
