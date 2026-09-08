/**
 * Per-backend rate-limit suspension for forge fetches (#1645).
 *
 * When a backend (`gh`, `glab`, …) reports that its budget is exhausted, every
 * fetch that would spend the same budget is suspended until the reset instant.
 * Importing this module never shells out: the optional reset probe is injected
 * by the caller that wants it (Tower's overview cache).
 */

/** GitHub's GraphQL and REST primary-limit messages, and gh's error type. */
const RATE_LIMIT_PATTERN = /rate limit (?:already )?exceeded|RATE_LIMITED|graphql_rate_limit|secondary rate limit/i;

export function isRateLimitError(text: string): boolean {
  return RATE_LIMIT_PATTERN.test(text);
}

/**
 * Concepts that spend a budget other than the one the backend's list concepts
 * spend. This is a fact about the backend: on `gh`, `user-identity` is a REST
 * call outside the GraphQL bucket; on Linear every concept is GraphQL on
 * Linear's own budget, so nothing is split out there.
 */
const OFF_BUDGET_CONCEPTS: Record<string, ReadonlySet<string>> = {
  gh: new Set(['user-identity', 'auth-status']),
};

/** The budget a concept spends on its backend, e.g. `gh` or `gh:rest`. */
export function budgetKeyFor(backend: string, concept: string): string {
  const key = backend.toLowerCase();
  return OFF_BUDGET_CONCEPTS[key]?.has(concept) ? `${key}:rest` : key;
}

/** Result of a reset probe. `remaining === 0` makes the reported reset credible. */
export interface RateLimitProbeResult {
  remaining: number;
  /** Reset instant, epoch milliseconds. */
  resetAt: number;
}

export type RateLimitProbe = (backend: string, cwd: string) => Promise<RateLimitProbeResult | null>;

interface Suspension {
  startedAt: number;
  until: number;
}

export const SUSPENSION_FALLBACK_MS = 15 * 60_000;

export class ForgeRateLimiter {
  private readonly suspensions = new Map<string, Suspension>();

  constructor(private readonly probe?: RateLimitProbe) {}

  /** Read-only: never allocates, so polling it every 2.5 s costs nothing. */
  isSuspended(budget: string, now: number): boolean {
    const s = this.suspensions.get(budget);
    return s !== undefined && now < s.until;
  }

  /** Reset instant (epoch ms) of an active suspension, else null. */
  resetAt(budget: string, now: number): number | null {
    const s = this.suspensions.get(budget);
    return s !== undefined && now < s.until ? s.until : null;
  }

  /**
   * Record a failure. Only a rate-limit error suspends, and only the failing
   * budget: a REST failure never suspends the GraphQL bucket. A fresh
   * suspension runs the reset probe at most once; a credible probe result
   * (budget confirmed gone) sets the true reset instant, even if that is
   * earlier than the fallback window.
   */
  noteFailure(budget: string, backend: string, cwd: string, errorText: string, now: number): boolean {
    if (!isRateLimitError(errorText)) return false;
    const existing = this.suspensions.get(budget);
    if (existing && now < existing.until) return true;
    const suspension: Suspension = { startedAt: now, until: now + SUSPENSION_FALLBACK_MS };
    this.suspensions.set(budget, suspension);
    const probe = this.probe;
    if (probe && backend === 'gh') {
      Promise.resolve()
        .then(() => probe(backend, cwd))
        .then(result => this.applyProbe(budget, suspension, result))
        .catch(() => { /* probe is advisory; keep the fallback window */ });
    }
    return true;
  }

  /**
   * A success clears a suspension only if it was dispatched strictly after the
   * suspension began: a batch dispatched in one tick shares a millisecond with
   * the failure that suspended it, and its successes are not evidence of recovery.
   */
  noteSuccess(budget: string, dispatchedAt: number): void {
    const s = this.suspensions.get(budget);
    if (s && dispatchedAt > s.startedAt) this.suspensions.delete(budget);
  }

  /** Honour a credible probe: the true reset instant wins over the fallback in both directions. */
  private applyProbe(budget: string, suspension: Suspension, result: RateLimitProbeResult | null): void {
    if (!result || result.remaining > 0) return;
    if (this.suspensions.get(budget) !== suspension) return;
    if (result.resetAt > suspension.startedAt) suspension.until = result.resetAt;
  }
}
