/**
 * The overview refresh cadence and the forge-call spend it implies (Spec 1995).
 *
 * `OverviewCache` runs on these constants and `codev doctor` reports
 * `projectHourlyForgeCalls` from them, so the projection cannot drift from the
 * cache. Dependency-free on purpose: doctor imports it without pulling in Tower.
 */

/** Open lists: what porch/VS Code invalidation refreshes. */
export const LIST_TTL_MS = 180_000;
/** The two 24 h searches: invalidation never touches these. */
export const SEARCH_TTL_MS = 600_000;
/** GitHub identity is session-stable. */
export const USER_TTL_MS = 3_600_000;
/** A list refetches at most once per minute per workspace because of invalidation. */
export const INVALIDATE_DEBOUNCE_MS = 60_000;
/** Failure window: 60 s, doubling per window (not per failed command) to 15 min. */
export const FAILURE_WINDOW_MIN_MS = 60_000;
export const FAILURE_WINDOW_MAX_MS = 15 * 60_000;

/** The TTLs the projection depends on; the defaults are the ones the cache runs on. */
export interface OverviewListTtls {
  listTtlMs: number;
  searchTtlMs: number;
}

const HOUR_MS = 3_600_000;

/**
 * Forge calls per hour one watched workspace spends on its overview lists, in
 * the idle steady state. Invalidation can only add refreshes, so this is a floor.
 *
 * - `bundle`: one call per open-list refresh; the 24 h windows ride along.
 * - `four-call`: `pr-list` and `issue-list` per open-list refresh, plus
 *   `recently-closed` and `recently-merged` per search refresh.
 *
 * The identity call (`user-identity`, REST, hourly) is not counted.
 */
export function projectHourlyForgeCalls(
  path: 'bundle' | 'four-call',
  ttls: OverviewListTtls = { listTtlMs: LIST_TTL_MS, searchTtlMs: SEARCH_TTL_MS },
): number {
  const listRefreshes = HOUR_MS / ttls.listTtlMs;
  if (path === 'bundle') return listRefreshes;
  return 2 * listRefreshes + 2 * (HOUR_MS / ttls.searchTtlMs);
}
