/**
 * Private reconnect-backoff copy for Tower internals (issue #1189).
 *
 * `@cluesmith/codev-sdk/reconnect-policy` is the canonical home of this
 * logic, but Tower itself needs two pieces of it server-side: the backoff
 * curve for the tunnel control channel (`tunnel-client.ts`, Tower acting as a
 * WS client of the cloud relay) and the session-unknown close code that
 * `tower-websocket.ts` emits. The server must not import the client sdk
 * (the issue's isolation invariant), and putting algorithm code in
 * `@cluesmith/codev-types` breaks its wire-contracts-only rule, so this
 * deliberate ~50-line duplication is the recorded resolution. If you change
 * the curve or the close code, change both copies.
 */

export interface BackoffOptions {
  /** Base delay in milliseconds (the attempt-0 delay before jitter). Default 1000. */
  baseMs?: number;
  /** Maximum delay in milliseconds (the curve is clamped to this). Default 30_000. */
  capMs?: number;
  /**
   * Upper bound of random jitter (in ms) added to each delay before the cap.
   * Default 0 (no jitter). The tunnel sets 1000 to avoid thundering-herd
   * reconnects against the cloud relay.
   */
  jitterMs?: number;
  /**
   * Escalation floor: once `attempt >= afterAttempts`, the delay is clamped
   * to `delayMs` (bypassing the exponential curve, jitter, and cap). The
   * tunnel uses `{ afterAttempts: 10, delayMs: 300_000 }` — a 5-minute holding
   * pattern after sustained failure instead of giving up.
   */
  floor?: { afterAttempts: number; delayMs: number };
  /** Injectable RNG for deterministic jitter in tests. Default `Math.random`. */
  random?: () => number;
}

const DEFAULT_BASE_MS = 1000;
const DEFAULT_CAP_MS = 30_000;

/**
 * Compute the backoff delay for a given attempt index:
 * `min(base * 2^attempt + jitter, cap)`, with an optional floor short-circuit
 * applied first. The `attempt` index is explicit so each call site owns its
 * own counter and increment ordering.
 */
export function backoffDelayMs(attempt: number, opts: BackoffOptions = {}): number {
  const { floor } = opts;
  if (floor && attempt >= floor.afterAttempts) {
    return floor.delayMs;
  }
  const base = opts.baseMs ?? DEFAULT_BASE_MS;
  const cap = opts.capMs ?? DEFAULT_CAP_MS;
  const jitterMs = opts.jitterMs ?? 0;
  const random = opts.random ?? Math.random;
  const safeAttempt = Math.max(0, attempt);
  let jitter = 0;
  if (jitterMs > 0) {
    jitter = Math.floor(random() * jitterMs);
  }
  return Math.min(base * 2 ** safeAttempt + jitter, cap);
}

/**
 * Application-range WebSocket close code Tower uses to tell a browser client
 * that the terminal session is unknown/gone. Browsers can't read a failed
 * *upgrade*'s HTTP status (they only see close `1006`), so Tower accepts the
 * upgrade for browser clients and immediately closes with this code, which the
 * dashboard reads via `CloseEvent.code` (#971). In the WS-spec private range
 * (`4000–4999`); the mnemonic `4404` echoes HTTP 404.
 */
export const WS_CLOSE_SESSION_UNKNOWN = 4404;

/**
 * Application-range WebSocket close code Tower uses to tell a browser client
 * that the upgrade was rejected for failing request authentication (advisory
 * GHSA-xvjp-7748-v88v). Same browser-can't-read-upgrade-status rationale as
 * {@link WS_CLOSE_SESSION_UNKNOWN}: Tower accepts the upgrade for browser
 * clients and immediately closes with this code so the client gets a clean,
 * distinguishable signal instead of a silent `1006`. The mnemonic `4401`
 * echoes HTTP 401.
 */
export const WS_CLOSE_UNAUTHORIZED = 4401;
