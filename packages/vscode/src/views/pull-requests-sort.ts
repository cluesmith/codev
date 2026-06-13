import type { OverviewPR } from '@cluesmith/codev-types';

/**
 * Pure sort helpers for the Pull Requests view. Kept vscode-free (mirroring
 * `backlog-filter.ts`) so they're unit-testable under the node vitest harness
 * without an Electron host.
 */

/**
 * Bucket a PR for the reviewer-centric sort:
 *   0 — mine (I authored it; wins even if I'm also a requested reviewer)
 *   1 — review-requested (I'm a requested reviewer)
 *   2 — everything else
 *
 * `me` is the lowercased current-user login. When it's undefined (gh
 * unavailable / not authenticated) every PR falls into bucket 2, so the
 * partitioning collapses and the sort degenerates to createdAt-desc.
 */
function prBucket(pr: OverviewPR, me: string | undefined): number {
  if (!me) { return 2; }
  if (pr.author?.toLowerCase() === me) { return 0; }
  if (pr.reviewRequests.some(login => login.toLowerCase() === me)) { return 1; }
  return 2;
}

/**
 * Comparator for the PR sidebar: bucket ascending (mine → review-requested →
 * others), then createdAt descending within a bucket. ISO-8601 `createdAt`
 * strings sort chronologically under lexicographic compare, so no Date parsing
 * is needed.
 */
export function comparePendingPRs(a: OverviewPR, b: OverviewPR, me: string | undefined): number {
  const bucketDiff = prBucket(a, me) - prBucket(b, me);
  if (bucketDiff !== 0) { return bucketDiff; }
  return b.createdAt.localeCompare(a.createdAt);
}

/**
 * Return a new array of PRs sorted by {@link comparePendingPRs}. `me` is the
 * raw current-user login (or undefined); it's lowercased here so callers don't
 * have to.
 */
export function sortPendingPRs(prs: OverviewPR[], me: string | undefined): OverviewPR[] {
  const meLower = me?.toLowerCase();
  return [...prs].sort((a, b) => comparePendingPRs(a, b, meLower));
}
