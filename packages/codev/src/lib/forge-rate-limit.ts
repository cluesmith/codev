/**
 * Forge rate-limit awareness (Issue #1645).
 *
 * Tower's overview cache backs every workspace with GitHub-API-backed forge
 * commands. When the account's GraphQL budget is exhausted every one of those
 * commands fails instantly, and — before this module existed — Tower answered
 * by spawning them again on the next poll, 2.5 s later. Measured on a real
 * machine: 180 `gh` processes in 60 s, which keeps the budget at zero for the
 * rest of the hour and takes down every other `gh` user on the box.
 *
 * So: when a forge command reports a rate limit, suspend *all* forge-backed
 * refreshes process-wide until the limit resets. The state is deliberately
 * global rather than per-workspace — a GitHub rate limit is charged to the
 * account, so a second workspace hitting the same API would only dig deeper.
 *
 * The suspension is time-bounded, never permanent: it lifts at `resetAt`, and
 * the next successful command clears it outright.
 */

import { onForgeFailure, executeForgeCommand, type ForgeFailure } from './forge.js';

// =============================================================================
// Detection
// =============================================================================

/**
 * Substrings GitHub/`gh` use when a limit is hit. Matched case-insensitively
 * against stderr.
 *
 * - "api rate limit already exceeded" — the primary GraphQL/REST limit, and
 *   the exact wording `gh` prints (`GraphQL: API rate limit already exceeded
 *   for user ID N.`).
 * - "api rate limit exceeded" — the REST wording.
 * - "rate_limit" forms — the GraphQL error `type`.
 * - "secondary rate limit" — GitHub's abuse-detection throttle, which wants
 *   backing off just as much.
 */
const RATE_LIMIT_MARKERS = [
  'api rate limit already exceeded',
  'api rate limit exceeded',
  'graphql_rate_limit',
  'rate_limited',
  'secondary rate limit',
  'was submitted too quickly',
];

/** True when `text` (typically a command's stderr) reports a forge rate limit. */
export function isRateLimitError(text: string): boolean {
  const haystack = text.toLowerCase();
  return RATE_LIMIT_MARKERS.some(marker => haystack.includes(marker));
}

// =============================================================================
// Suspension state
// =============================================================================

/** First suspension when the reset instant is unknown. */
export const BACKOFF_BASE_MS = 60_000;
/** Ceiling for both the doubling backoff and any reported reset instant. */
export const BACKOFF_MAX_MS = 900_000;
/**
 * Hard cap on a suspension. GitHub's GraphQL budget is an hourly rolling
 * window, so a reported reset further out than this is a misread, not a fact.
 */
export const SUSPEND_CAP_MS = 3_600_000;

let suspendedUntilMs = 0;
let consecutiveHits = 0;
/** Set while a reset probe is in flight, so a burst of failures probes once. */
let probing = false;

export interface ForgeRateLimitState {
  /** True while forge-backed refreshes are suspended. */
  limited: boolean;
  /** ISO instant the suspension lifts, or null when not suspended. */
  resetAt: string | null;
}

/** Current suspension state. */
export function getForgeRateLimit(now: number = Date.now()): ForgeRateLimitState {
  if (suspendedUntilMs <= now) return { limited: false, resetAt: null };
  return { limited: true, resetAt: new Date(suspendedUntilMs).toISOString() };
}

/** True while forge-backed refreshes should not be attempted at all. */
export function isForgeSuspended(now: number = Date.now()): boolean {
  return suspendedUntilMs > now;
}

/**
 * Record a rate-limit hit and suspend until `resetAtMs`.
 *
 * With no reset instant the suspension follows a doubling backoff
 * (60 s → 15 min), so a forge that is merely flaky recovers quickly while one
 * that is genuinely throttled is left alone.
 */
export function noteRateLimited(resetAtMs: number | null, now: number = Date.now()): void {
  const backoff = Math.min(BACKOFF_BASE_MS * 2 ** consecutiveHits, BACKOFF_MAX_MS);
  consecutiveHits++;
  const until = resetAtMs !== null && resetAtMs > now
    ? Math.min(resetAtMs, now + SUSPEND_CAP_MS)
    : now + backoff;
  // Never shorten a suspension already in force.
  suspendedUntilMs = Math.max(suspendedUntilMs, until);
}

/** Clear the suspension — called when a forge command succeeds. */
export function noteForgeSuccess(): void {
  suspendedUntilMs = 0;
  consecutiveHits = 0;
}

/** Reset all state. Tests only. */
export function resetForgeRateLimit(): void {
  suspendedUntilMs = 0;
  consecutiveHits = 0;
  probing = false;
  probeEnabled = false;
}

// =============================================================================
// Budget probe
// =============================================================================

/** GitHub's per-resource rate-limit budget, as reported by the `rate-limit` concept. */
export interface ForgeBudget {
  limit: number;
  remaining: number;
  used: number;
  /** Unix seconds. */
  reset: number;
}

/** Parse the `rate-limit` concept's output. Returns null on any shape mismatch. */
export function parseBudget(raw: unknown): ForgeBudget | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const nums = ['limit', 'remaining', 'used', 'reset'] as const;
  if (!nums.every(k => typeof r[k] === 'number')) return null;
  return { limit: r.limit as number, remaining: r.remaining as number, used: r.used as number, reset: r.reset as number };
}

/**
 * Read the account's GraphQL budget via the `rate-limit` concept.
 * Returns null when the concept is unavailable or its output is unparseable.
 */
export async function fetchForgeBudget(cwd?: string): Promise<ForgeBudget | null> {
  const raw = await executeForgeCommand('rate-limit', {}, { cwd });
  return parseBudget(raw);
}

let probeEnabled = false;

/**
 * Turn the reset probe on. Off by default so importing this module never
 * shells out: only a long-lived process that actually benefits from a precise
 * reset instant (Tower) opts in, and unit tests stay hermetic.
 */
export function enableResetProbe(enabled = true): void {
  probeEnabled = enabled;
}

/**
 * Learn the reset instant for a suspension already in force — at most one probe
 * per suspension window, and only when enabled.
 *
 * Advisory only. Measured on a genuinely-exhausted account (#1645),
 * `gh api rate_limit` reported `graphql` as `{limit:5000, remaining:5000,
 * used:0}` while the live GraphQL response headers said `Used: 5000,
 * Remaining: 0` — so the probe's reset instant is trusted **only when it agrees
 * that the budget is gone**. Otherwise the doubling backoff stands.
 */
export async function maybeProbeReset(cwd?: string): Promise<void> {
  if (!probeEnabled || probing || !isForgeSuspended()) return;
  probing = true;
  try {
    const budget = await fetchForgeBudget(cwd);
    if (budget && budget.remaining === 0 && budget.reset > 0) {
      noteRateLimited(budget.reset * 1000);
    }
  } catch {
    // Probe failures are non-events — the backoff already covers us.
  } finally {
    probing = false;
  }
}

// =============================================================================
// Wiring
// =============================================================================

let installed = false;

/**
 * Subscribe to forge failures and suspend on a rate limit. Idempotent, so any
 * module that depends on the suspension can call it without coordinating.
 */
export function installForgeRateLimitWatch(): void {
  if (installed) return;
  installed = true;
  onForgeFailure((failure: ForgeFailure) => {
    if (failure.concept === 'rate-limit') return; // never suspend on the probe itself
    if (!isRateLimitError(failure.message)) return;
    noteRateLimited(null);
  });
}
