/**
 * The overview's forge spend, in one dependency-free place (Spec 1647).
 *
 * `OverviewCache` reads its refresh cadence from here, and `codev doctor`
 * projects the hourly cost from the same numbers, so the projection cannot
 * drift from what the cache actually does.
 */

/** Open lists: what porch/VS Code invalidation refreshes. */
export const LIST_TTL_MS = 180_000;
/** The two 24 h searches: invalidation never touches these. */
export const SEARCH_TTL_MS = 600_000;
/** GitHub identity is session-stable. */
export const USER_TTL_MS = 3_600_000;
/** A list refetches at most once per minute per workspace because of invalidation. */
export const INVALIDATE_DEBOUNCE_MS = 60_000;

/** The four concepts one `overview-bundle` call replaces. */
export const OVERVIEW_CONSTITUENTS = ['pr-list', 'issue-list', 'recently-closed', 'recently-merged'] as const;
export type OverviewConstituent = (typeof OVERVIEW_CONSTITUENTS)[number];

/** The constituents that are open lists; the other two are the 24 h searches. */
const OPEN_LISTS: ReadonlySet<OverviewConstituent> = new Set(['pr-list', 'issue-list']);

/** Why a workspace's overview makes the four per-section calls. */
export type FourCallCause =
  /** The project overrides or disables at least one constituent. */
  | { kind: 'constituents'; overridden: OverviewConstituent[]; disabled: OverviewConstituent[] }
  /** The project sets `overview-bundle` to null. */
  | { kind: 'bundle-disabled' }
  /** The provider's preset disables `overview-bundle`. */
  | { kind: 'preset-disabled'; provider: string };

/**
 * How a workspace's overview fetches, decided from configuration alone.
 *
 * `bypassed` is non-empty only when the project overrides `overview-bundle`
 * itself: it lists the constituent overrides and disables that the bundle then
 * hides. `runnable` lists the constituents that resolve to a command.
 */
export type OverviewPlan =
  | { mode: 'bundled'; bypassed: Array<{ concept: OverviewConstituent; how: 'overridden' | 'disabled' }> }
  | { mode: 'four-call'; cause: FourCallCause; runnable: OverviewConstituent[] };

export interface HourlyForgeCalls {
  /** Nothing invalidates the overview. */
  idle: number;
  /** Invalidation arrives constantly, so every list refetches once per debounce window. */
  churn: number;
}

const HOUR_MS = 3_600_000;

/**
 * Forge calls (concept invocations) per hour for one watched workspace.
 * `user-identity` is excluded: it is hourly and independent of the mode.
 */
export function projectHourlyForgeCalls(plan: OverviewPlan): HourlyForgeCalls {
  const list: HourlyForgeCalls = { idle: HOUR_MS / LIST_TTL_MS, churn: HOUR_MS / INVALIDATE_DEBOUNCE_MS };
  if (plan.mode === 'bundled') return list;
  const search = HOUR_MS / SEARCH_TTL_MS;
  return plan.runnable.reduce<HourlyForgeCalls>(
    (total, concept) => OPEN_LISTS.has(concept)
      ? { idle: total.idle + list.idle, churn: total.churn + list.churn }
      : { idle: total.idle + search, churn: total.churn + search },
    { idle: 0, churn: 0 },
  );
}
