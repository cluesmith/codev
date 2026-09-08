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
 * So: when a forge command reports a rate limit, suspend every refresh that
 * would go to **that same backend** until the limit resets. The state is keyed
 * by backend rather than by workspace — a GitHub rate limit is charged to the
 * account, so a second workspace hitting the same API would only dig deeper —
 * and by *backend* rather than by configured provider, because providers are
 * hybrid: a Linear workspace's PR concepts fall through to `gh` and spend
 * GitHub's budget. A limit on one forge never suspends another.
 *
 * The suspension is time-bounded, never permanent: it lifts at `resetAt`, and
 * the next successful command clears it outright.
 */

import {
  DEFAULT_PROVIDER,
  executeForgeCommand,
  onForgeFailure,
  type ForgeFailure,
} from './forge.js';

export { DEFAULT_PROVIDER };

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

/** Per-provider suspension state. */
interface ProviderState {
  suspendedUntilMs: number;
  /** When the current suspension began. Guards the success/probe races below. */
  suspendedSinceMs: number;
  consecutiveHits: number;
  /** `suspendedSinceMs` of the suspension the reset probe has already run for. */
  probedSuspensionMs: number;
}

/**
 * Suspension state **keyed by resolved backend**, not process-global.
 *
 * A rate limit is charged to one forge's account. Suspending every backend on
 * a GitHub limit would blank a GitLab or Gitea workspace's Work view for the
 * whole backoff window over an outage that has nothing to do with it.
 */
const providerStates = new Map<string, ProviderState>();

/**
 * Every function below takes the backend as a **required first argument**, with
 * no default. An earlier revision defaulted it and put it last, which let
 * `isForgeSuspended(now)` read a timestamp as a backend name and silently
 * answer about the wrong forge. Required-and-first makes that a type error.
 *
 * Keys are lowercased on the way in, so a config that spells its provider
 * `GitHub` cannot end up with state separate from one that spells it `github`.
 */

/** Normalize a backend key. Casing must never split one forge's state in two. */
function backendKey(backend: string): string {
  return backend.trim().toLowerCase();
}

function stateFor(backend: string): ProviderState {
  const key = backendKey(backend);
  let state = providerStates.get(key);
  if (!state) {
    state = { suspendedUntilMs: 0, suspendedSinceMs: 0, consecutiveHits: 0, probedSuspensionMs: -1 };
    providerStates.set(key, state);
  }
  return state;
}

/** Set while a reset probe is in flight, keyed by provider. */
const probing = new Set<string>();

export interface ForgeRateLimitState {
  /** True while this provider's forge-backed refreshes are suspended. */
  limited: boolean;
  /** ISO instant the suspension lifts, or null when not suspended. */
  resetAt: string | null;
}

/** Current suspension state for one provider. */
export function getForgeRateLimit(
  provider: string,
  now: number = Date.now(),
): ForgeRateLimitState {
  const { suspendedUntilMs } = stateFor(provider);
  if (suspendedUntilMs <= now) return { limited: false, resetAt: null };
  return { limited: true, resetAt: new Date(suspendedUntilMs).toISOString() };
}

/** True while this provider's forge-backed refreshes should not be attempted. */
export function isForgeSuspended(
  provider: string,
  now: number = Date.now(),
): boolean {
  return stateFor(provider).suspendedUntilMs > now;
}

/**
 * Record a rate-limit hit for `provider` and suspend it until `resetAtMs`.
 *
 * With no reset instant the suspension follows a doubling backoff
 * (60 s → 15 min), so a forge that is merely flaky recovers quickly while one
 * that is genuinely throttled is left alone.
 *
 * The backoff escalates **once per suspension window, not once per failed
 * command**. An overview refresh fires four forge commands in parallel and all
 * four fail together; counting each would jump straight from 60 s to 8 minutes
 * on the very first refresh.
 */
export function noteRateLimited(
  provider: string,
  resetAtMs: number | null,
  now: number = Date.now(),
): void {
  const state = stateFor(provider);
  const alreadySuspended = state.suspendedUntilMs > now;
  if (!alreadySuspended) {
    state.consecutiveHits++;
    state.suspendedSinceMs = now;
  }
  const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (state.consecutiveHits - 1), BACKOFF_MAX_MS);
  const until = resetAtMs !== null && resetAtMs > now
    ? Math.min(resetAtMs, now + SUSPEND_CAP_MS)
    : now + backoff;
  // Never shorten a suspension already in force.
  state.suspendedUntilMs = Math.max(state.suspendedUntilMs, until);
}

/**
 * Clear `provider`'s suspension after one of its commands succeeded.
 *
 * `startedAt` is when that command was dispatched, and it matters: an overview
 * refresh dispatches its forge commands in parallel, and one of them
 * (`user-identity`) is a REST call charged to a *different* budget. Without
 * this guard that REST success would wipe the suspension its GraphQL siblings
 * had just set — the very first failing refresh would un-suspend itself and
 * the hammering would continue. Only a command dispatched *after* the current
 * suspension began is evidence that the forge has actually recovered.
 */
export function noteForgeSuccess(
  provider: string,
  startedAt: number = Date.now(),
): void {
  const state = stateFor(provider);
  if (state.suspendedUntilMs > 0 && startedAt < state.suspendedSinceMs) return;
  clearForgeSuspension(provider);
}

/**
 * Drop a suspension outright. For an explicit human action — a dashboard
 * Refresh — which should not have to wait out a backoff window after the forge
 * has recovered. Omit `provider` to clear every provider.
 */
export function clearForgeSuspension(backend?: string): void {
  if (backend === undefined) {
    providerStates.clear();
    return;
  }
  providerStates.delete(backendKey(backend));
}

/** Reset all state. Tests only. */
export function resetForgeRateLimit(): void {
  providerStates.clear();
  probing.clear();
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
export async function maybeProbeReset(
  provider: string,
  cwd?: string,
): Promise<void> {
  // `gh` only: the `rate-limit` concept has no script outside the github
  // preset, so for any other backend it would fall through to the github
  // default and shell out to `gh` for a forge that does not use it.
  if (backendKey(provider) !== 'gh' && backendKey(provider) !== DEFAULT_PROVIDER) return;
  if (!probeEnabled || probing.has(provider) || !isForgeSuspended(provider)) return;
  const state = stateFor(provider);
  if (state.probedSuspensionMs === state.suspendedSinceMs) return; // already probed this window
  state.probedSuspensionMs = state.suspendedSinceMs;
  probing.add(provider);
  try {
    const budget = await fetchForgeBudget(cwd);
    if (budget && budget.remaining === 0 && budget.reset > 0) {
      noteRateLimited(provider, budget.reset * 1000);
    }
  } catch {
    // Probe failures are non-events — the backoff already covers us.
  } finally {
    probing.delete(provider);
  }
}

// =============================================================================
// Wiring
// =============================================================================

let installed = false;

/**
 * Subscribe to forge failures and suspend on a rate limit. Idempotent, so any
 * module that depends on the suspension can call it without coordinating.
 *
 * Note what "suspend" does and does not mean: this module only *records* the
 * suspension. Honouring it is up to each caller, and today the only caller that
 * does is `OverviewCache.fetchCached` — the one on a 2.5 s timer, and so the
 * one that turns a transient limit into a permanent one. A one-off command
 * (`afx spawn` fetching an issue) still runs and still fails fast, which is
 * what a human at a prompt wants.
 */
export function installForgeRateLimitWatch(): void {
  if (installed) return;
  installed = true;
  onForgeFailure((failure: ForgeFailure) => {
    if (failure.concept === 'rate-limit') return; // never suspend on the probe itself
    if (!isRateLimitError(failure.message)) return;
    // Suspend only the backend that was refused. A `gh` limit says nothing
    // about a workspace whose concepts run `glab`.
    noteRateLimited(failure.backend, null);
  });
}
