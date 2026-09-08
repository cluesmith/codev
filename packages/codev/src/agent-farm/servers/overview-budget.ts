/**
 * Cache windows for the overview's forge-backed fetches, and the API spend they
 * imply (Issue #1645).
 *
 * A standalone, dependency-free module so `codev doctor` can report the same
 * numbers `OverviewCache` actually spends without importing the whole Tower
 * graph behind `overview.ts`.
 */

/**
 * Positive TTL for the two per-request forge lists (open PRs, open issues).
 * Raised from 30 s (#1645): the dashboard polls `/api/overview` every 2.5 s
 * (`apps/web/src/hooks/useOverview.ts`), so the TTL — not the poll — is what
 * sets the API spend. Explicit user actions bypass it via
 * `POST /api/overview/refresh`, which invalidates the whole cache.
 */
export const POSITIVE_TTL_MS = 120_000;

/**
 * Positive TTL for the two `--search`-backed 24 h windows (recently closed
 * issues, recently merged PRs). Far longer than POSITIVE_TTL_MS because a 24 h
 * window barely moves minute to minute, and these are the most expensive
 * queries of the four (`--limit 1000`, multi-page).
 */
export const SEARCH_TTL_MS = 600_000;

/** First negative-cache window after a failure. Doubles per consecutive failure. */
export const NEGATIVE_TTL_BASE_MS = 60_000;

/** Ceiling for the negative-cache backoff. */
export const NEGATIVE_TTL_MAX_MS = 900_000;

/** How long a failed fetch is remembered before it is retried. */
export function negativeTtlMs(failures: number): number {
  const exponent = Math.max(0, failures - 1);
  return Math.min(NEGATIVE_TTL_BASE_MS * 2 ** exponent, NEGATIVE_TTL_MAX_MS);
}

/**
 * Worst-case forge commands per hour for `workspaceCount` workspaces, each with
 * a client polling `/api/overview` continuously (#1645).
 *
 * Two calls (`pr-list`, `issue-list`) per POSITIVE_TTL_MS window plus two
 * (`recently-closed`, `recently-merged`) per SEARCH_TTL_MS window. The
 * once-an-hour `user-identity` call is REST and charged to a different budget,
 * so it is left out.
 */
export function projectHourlyForgeCalls(workspaceCount: number): number {
  const perWorkspace = 2 * (3_600_000 / POSITIVE_TTL_MS) + 2 * (3_600_000 / SEARCH_TTL_MS);
  return Math.round(workspaceCount * perWorkspace);
}
