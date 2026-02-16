import type { OverviewPR } from '../lib/api.js';

interface PRListProps {
  prs: OverviewPR[];
}

function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

const STATUS_MAP: Record<string, { label: string; className: string }> = {
  APPROVED: { label: 'approved', className: 'pr-status--approved' },
  CHANGES_REQUESTED: { label: 'changes', className: 'pr-status--changes' },
  REVIEW_REQUIRED: { label: 'reviewing', className: 'pr-status--reviewing' },
};

export function PRList({ prs }: PRListProps) {
  if (prs.length === 0) {
    return <p className="work-empty">No open pull requests</p>;
  }

  return (
    <div className="pr-rows">
      {prs.map(pr => {
        const status = STATUS_MAP[pr.reviewStatus] ?? STATUS_MAP.REVIEW_REQUIRED;
        return (
          <div key={pr.number} className="pr-row">
            <span className="pr-row-number">#{pr.number}</span>
            <span className="pr-row-title">{pr.title}</span>
            <span className={`pr-row-status ${status.className}`}>{status.label}</span>
            <span className="pr-row-age">{timeAgo(pr.createdAt)}</span>
          </div>
        );
      })}
    </div>
  );
}
