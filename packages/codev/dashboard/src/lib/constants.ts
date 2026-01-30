export const MOBILE_BREAKPOINT = 768;
export const MOBILE_TERMINAL_COLS = 40;
export const POLL_INTERVAL_MS = 1000;
export const DEFAULT_TERMINAL_COLS = 80;
export const DEFAULT_TERMINAL_ROWS = 24;

/** Get API base path, handling tower proxy context */
export function getApiBase(): string {
  const path = window.location.pathname;
  const match = path.match(/^(\/project\/[^/]+\/)/);
  return match ? match[1] : '/';
}
