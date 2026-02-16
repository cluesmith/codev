/** Standard VT100 default terminal dimensions. */
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

/** Default max size for per-session disk logs (50 MB). */
export const DEFAULT_DISK_LOG_MAX_BYTES = 50 * 1024 * 1024;

/** Common defaults for shellper/PTY session creation. */
export interface SessionDefaults {
  cols: number;
  rows: number;
  restartOnExit: boolean;
  restartDelay?: number;
  maxRestarts?: number;
  restartResetAfter?: number;
}

/** Returns default session options, with optional overrides for call-site-specific values. */
export function defaultSessionOptions(overrides?: Partial<SessionDefaults>): SessionDefaults {
  return {
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    restartOnExit: false,
    ...overrides,
  };
}

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
