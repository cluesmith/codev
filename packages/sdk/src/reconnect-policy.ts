/**
 * ReconnectPolicy — transport-agnostic exponential-backoff reconnect logic.
 *
 * Extracted from four hand-rolled copies of the `Math.min(1000 * 2^attempt, cap)`
 * curve (#961): the VSCode SSE health-check, the VSCode terminal WebSocket, the
 * web terminal WebSocket, and the tunnel control channel. Pure logic — no
 * `vscode`, DOM, or socket dependency, so it is usable from any host that wraps
 * a flaky connection. Same cross-host discipline as `EscapeBuffer`.
 *
 * Three exports, layered by need:
 *
 * - `backoffDelayMs(attempt, opts)` — the one shared curve. Takes the attempt
 *   index explicitly, so each call site keeps its own counter and increment
 *   ordering (the tunnel increments *before* computing its delay; the terminals
 *   compute *then* increment). This is the single primitive that replaces every
 *   inline `Math.min(...)`.
 * - `BackoffController` — a thin counter+status+give-up wrapper over the curve,
 *   for the two terminal surfaces that need a give-up threshold and a status
 *   machine. SSE and the tunnel keep bespoke counters and call the curve fn
 *   directly (they never give up — SSE retries forever, the tunnel floors).
 * - `classifyUpgradeError(reason)` — encapsulates the Tower close-code rule so
 *   every site agrees on what's worth retrying (session-unknown → permanent).
 */

export interface BackoffOptions {
  /** Base delay in milliseconds (the attempt-0 delay before jitter). Default 1000. */
  baseMs?: number;
  /** Maximum delay in milliseconds (the curve is clamped to this). Default 30_000. */
  capMs?: number;
  /**
   * Number of consecutive failures after which {@link BackoffController}
   * gives up. Default 6. Use `Infinity` for surfaces that retry forever
   * (SSE health-check, tunnel control channel). Ignored by the bare
   * {@link backoffDelayMs} function — it only governs the controller.
   */
  maxAttempts?: number;
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
const DEFAULT_MAX_ATTEMPTS = 6;

/**
 * Compute the backoff delay for a given attempt index.
 *
 * `min(base * 2^attempt + jitter, cap)`, with an optional floor short-circuit
 * applied first. Pure: the only impurity is `opts.random` (defaults to
 * `Math.random`), which callers inject for deterministic tests.
 *
 * The `attempt` index is explicit so each call site owns its own counter and
 * increment ordering.
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
  const jitter = jitterMs > 0 ? Math.floor(random() * jitterMs) : 0;
  return Math.min(base * 2 ** safeAttempt + jitter, cap);
}

export type BackoffStatus = 'idle' | 'connecting' | 'connected' | 'giving-up';
export type FailureAction = 'retry' | 'give-up';

/**
 * Stateful reconnect controller: tracks the consecutive-failure count and a
 * status machine, and decides retry-vs-give-up against `maxAttempts`.
 *
 * Usage (terminal surfaces):
 *
 * ```
 * const ctrl = new BackoffController({ maxAttempts: 6 });
 * onOpen  = () => ctrl.recordSuccess();
 * onClose = () => {
 *   if (ctrl.recordFailure() === 'give-up') { surfaceGiveUp(); return; }
 *   scheduleRetry(ctrl.nextDelayMs(), ctrl.attempt);   // attempt is 1..maxAttempts
 * };
 * onUserReconnect = () => { ctrl.reset(); connect(); };
 * ```
 *
 * The give-up sequencing reproduces the pre-extraction terminal-adapter
 * behavior exactly: with `maxAttempts: 6` the delays are
 * `[1000, 2000, 4000, 8000, 16000, 30000]` and the 7th `recordFailure()`
 * returns `'give-up'`.
 */
export class BackoffController {
  private readonly opts: BackoffOptions;
  private readonly maxAttempts: number;
  private _attempt = 0;
  private _status: BackoffStatus = 'idle';

  constructor(opts: BackoffOptions = {}) {
    this.opts = opts;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  /** Current status of the connection lifecycle. */
  get status(): BackoffStatus {
    return this._status;
  }

  /**
   * Consecutive failures recorded since the last success or reset. After a
   * `recordFailure()` that returns `'retry'`, this is the 1-based attempt
   * number (suitable for an `attempt/max` notice).
   */
  get attempt(): number {
    return this._attempt;
  }

  /** Begin a connection attempt. */
  start(): void {
    this._status = 'connecting';
  }

  /** A connection succeeded: reset the failure count and mark connected. */
  recordSuccess(): void {
    this._attempt = 0;
    this._status = 'connected';
  }

  /**
   * A connection failed. Advances the failure count and decides the next
   * action. Returns `'give-up'` (and sets status to `'giving-up'`) once the
   * attempt budget is exhausted; otherwise returns `'retry'` and the delay for
   * that retry is available via {@link nextDelayMs}.
   */
  recordFailure(): FailureAction {
    if (this._attempt >= this.maxAttempts) {
      this._status = 'giving-up';
      return 'give-up';
    }
    this._attempt++;
    this._status = 'connecting';
    return 'retry';
  }

  /**
   * Delay (ms) before the retry just authorized by `recordFailure()`. Uses the
   * pre-increment attempt index, so the first retry is the base delay.
   */
  nextDelayMs(): number {
    return backoffDelayMs(this._attempt - 1, this.opts);
  }

  /**
   * Manual reconnect: clear the failure count and any give-up state, and mark
   * connecting. Used for the user's "reconnect now" affordance.
   */
  reset(): void {
    this._attempt = 0;
    this._status = 'connecting';
  }

  /** Tear down: return to the idle state. */
  stop(): void {
    this._status = 'idle';
  }
}

/** A connection-error reason, as a transport surfaces it. */
export type UpgradeErrorReason = string | { code?: number; message?: string };

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
 * Classify a connection/upgrade error as worth retrying or not.
 *
 * The Tower convention: a "this session/resource is gone" signal means retrying
 * is hopeless, so `'permanent'`. Everything else is a transport blip →
 * `'transient'`.
 *
 * Accepts both forms a host can produce:
 * - Node `ws` surfaces a rejected upgrade as `Error.message`
 *   `"Unexpected server response: 404"` — the string form (Tower 404s an unknown
 *   session ID at the HTTP upgrade stage).
 * - A browser only learns a numeric `code`. This is overloaded: it may be an
 *   HTTP status (`400–499`, kept for any Node code-form caller) *or* a
 *   WebSocket `CloseEvent.code`. The two ranges are disjoint — valid WS close
 *   codes live in `1000–1015` / `3000–3999` / `4000–4999`, never `400–499` —
 *   so one predicate handles both. Tower's browser-visible session-unknown
 *   close code {@link WS_CLOSE_SESSION_UNKNOWN} is `'permanent'`; a transport
 *   blip (`1006`) is `'transient'`.
 */
export function classifyUpgradeError(reason: UpgradeErrorReason): 'permanent' | 'transient' {
  if (typeof reason === 'string') {
    return isPermanentMessage(reason) ? 'permanent' : 'transient';
  }
  if (reason.code === WS_CLOSE_SESSION_UNKNOWN) {
    return 'permanent';
  }
  if (typeof reason.code === 'number' && reason.code >= 400 && reason.code < 500) {
    return 'permanent';
  }
  if (typeof reason.message === 'string' && isPermanentMessage(reason.message)) {
    return 'permanent';
  }
  return 'transient';
}

/** Tower's `ws`-client upgrade-rejection signature: a 4xx HTTP upgrade response. */
const UPGRADE_CLIENT_ERROR = /Unexpected server response: 4\d\d/;

function isPermanentMessage(message: string): boolean {
  return UPGRADE_CLIENT_ERROR.test(message);
}
