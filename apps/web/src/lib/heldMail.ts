/**
 * Issue 1450: age/countdown formatting for the dashboard's held-mail popover.
 *
 * Ported — deliberately, not imported — from the `afx inbox` CLI renderer
 * (`packages/codev/src/agent-farm/commands/inbox.ts:77-90`). The web app must not import
 * from `@cluesmith/codev-core` (server/client isolation, #1189), and `@cluesmith/codev-types`
 * is a types-only devDependency, the wrong home for a runtime helper. Ten lines duplicated
 * beats a boundary violation; keeping the output identical to the CLI's is what lets a
 * reviewer check the popover against `afx inbox` row for row.
 *
 * Named `formatHeldAge` rather than `formatDuration` because
 * `apps/web/src/lib/open-files-shells-utils.ts` already exports a `formatDuration` with
 * DIFFERENT semantics (minute granularity, `<1m` floor) and existing callers. Two
 * same-named formatters with different output in one `lib/` is a trap.
 */

/**
 * Compact human duration ("5s", "3m", "2h", "1d") from a millisecond delta.
 * Second-granularity, matching the CLI — held mail is often seconds old, and "<1m"
 * would erase the distinction between "just held" and "held for most of a minute".
 * Negative deltas clamp to `0s`.
 */
export function formatHeldDuration(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Compact human age ("5s", "3m", "2h", "1d") from an epoch-ms timestamp. */
export function formatHeldAge(createdAt: number, now: number): string {
  return formatHeldDuration(now - createdAt);
}

/**
 * Is this row a pre-due `--delay` send — scheduled rather than stuck?
 *
 * The single predicate that splits the popover's two groups, and the same test the CLI
 * applies (`inbox.ts:135`). A scheduled row is excluded from `OverviewData.heldCount` by
 * `heldSummaryForWorkspace`, so grouping on exactly this predicate is what makes the
 * "Held" group's length equal the badge count.
 */
export function isScheduled(notBefore: number | null, now: number): boolean {
  return notBefore != null && notBefore > now;
}

/**
 * The hold verdict as one cell: `reason:detail` when the render gate recorded a detail, else
 * the bare reason (Issue #1482).
 *
 * `busy:user-text` means a human is at that composer and the hold clears by itself;
 * `busy:no-region-end` / `busy:no-composer-marker` mean the classifier could not verify the
 * composer at all, and that hold does NOT clear on its own. A popover showing only `busy`
 * cannot tell an operator which of those they are looking at.
 *
 * Ported, not imported, for the same reason as the formatters above — `formatVerdict` lives in
 * `packages/codev/src/agent-farm/utils/hold-verdict.ts`, which is server-side and off-limits to
 * the web app (#1189). Keep the two in step: the popover and `afx inbox` must render the same
 * row identically.
 */
export function formatHoldVerdict(
  reason: string | null | undefined,
  detail: string | null | undefined,
  fallback = 'held',
): string {
  const base = reason ?? fallback;
  return detail ? `${base}:${detail}` : base;
}
