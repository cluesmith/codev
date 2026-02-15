/** Standard VT100 default terminal dimensions. */
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

export { RingBuffer } from './ring-buffer.js';
export { TerminalManager } from './pty-manager.js';
export type { TerminalManagerConfig, CreateTerminalRequest } from './pty-manager.js';
export { PtySession } from './pty-session.js';
export type { PtySessionConfig, PtySessionInfo } from './pty-session.js';
export {
  encodeControl,
  encodeData,
  decodeFrame,
  FRAME_CONTROL,
  FRAME_DATA,
} from './ws-protocol.js';
export type { ControlMessage, DecodedFrame } from './ws-protocol.js';
