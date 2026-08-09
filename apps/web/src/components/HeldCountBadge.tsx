/**
 * Spec 1313 Phase 8: compact held-mail count indicator for the dashboard header.
 *
 * Read-only and count-only. It renders the number of currently-*held* (undelivered)
 * mailbox rows in the workspace, fed by `OverviewData.heldCount` (which the overview
 * refetches live on the `overview-changed` broadcast). When at least one held row has
 * crossed the escalation age (`OverviewData.mailboxEscalated`) the badge enters an
 * attention state — a pulsing amber dot — and clears back to normal when the row
 * resolves. Dismissal stays CLI-only (`afx inbox`); this surface never mutates state
 * (spec Decision 8). Renders nothing when the count is zero, so it stays out of the
 * way until there is held mail.
 *
 * Presentational only (takes its data as props) so it unit-tests in isolation, mirroring
 * `CloudStatus`.
 */
export interface HeldCountBadgeProps {
  /** Count of currently-held rows across the workspace (`OverviewData.heldCount`). */
  count: number;
  /** True when at least one held row has crossed the escalation age. */
  escalated: boolean;
}

export function HeldCountBadge({ count, escalated }: HeldCountBadgeProps) {
  if (count <= 0) {
    return null;
  }
  const label = `${count} held`;
  const title = escalated
    ? `${count} held message${count === 1 ? '' : 's'} — at least one past the escalation age. Review with: afx inbox`
    : `${count} held message${count === 1 ? '' : 's'} awaiting a clear prompt. Review with: afx inbox`;
  return (
    <span
      className={`held-badge${escalated ? ' held-badge--attention' : ''}`}
      data-testid="held-badge"
      title={title}
    >
      <span className={`held-dot${escalated ? ' held-dot--attention' : ''}`} />
      {label}
    </span>
  );
}
