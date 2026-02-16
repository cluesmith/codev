import type { OverviewPR } from '../lib/api.js';

interface PRListProps {
  prs: OverviewPR[];
}

const REVIEW_BADGES: Record<string, { label: string; className: string }> = {
  APPROVED: { label: 'Approved', className: 'review-approved' },
  CHANGES_REQUESTED: { label: 'Changes', className: 'review-changes' },
  REVIEW_REQUIRED: { label: 'Review needed', className: 'review-pending' },
};

export function PRList({ prs }: PRListProps) {
  if (prs.length === 0) {
    return <p className="work-empty">No open pull requests</p>;
  }

  return (
    <div className="pr-list">
      {prs.map(pr => {
        const badge = REVIEW_BADGES[pr.reviewStatus] ?? REVIEW_BADGES.REVIEW_REQUIRED;
        return (
          <div key={pr.number} className="pr-item">
            <div className="pr-item-header">
              <span className="pr-number">#{pr.number}</span>
              <span className={`review-badge ${badge.className}`}>{badge.label}</span>
            </div>
            <div className="pr-item-title">{pr.title}</div>
            {pr.linkedIssue && (
              <div className="pr-linked-issue">
                Linked: Issue #{pr.linkedIssue}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
