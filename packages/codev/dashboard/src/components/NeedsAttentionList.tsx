import type { OverviewPR, OverviewBuilder } from '../lib/api.js';

interface NeedsAttentionListProps {
  prs: OverviewPR[];
  builders: OverviewBuilder[];
}

interface AttentionItem {
  key: string;
  issueOrPR: string;
  title: string;
  kind: string;
  kindClass: string;
  waitingSince: string;
  url?: string;
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

function buildItems(prs: OverviewPR[], builders: OverviewBuilder[]): AttentionItem[] {
  const items: AttentionItem[] = [];

  // PRs needing review
  for (const pr of prs) {
    items.push({
      key: `pr-${pr.number}`,
      issueOrPR: `#${pr.number}`,
      title: pr.title,
      kind: 'PR review',
      kindClass: 'attention-kind--pr',
      waitingSince: pr.createdAt,
      url: pr.url,
    });
  }

  // Builders blocked on gate approvals
  for (const b of builders) {
    if (!b.blocked || !b.blockedSince) continue;
    // Skip "PR review" — those are already covered by the PRs list
    if (b.blocked === 'PR review') continue;
    const label = b.issueNumber ? `#${b.issueNumber}` : b.id;
    items.push({
      key: `gate-${b.id}`,
      issueOrPR: label,
      title: b.issueTitle || b.id,
      kind: b.blocked,
      kindClass: b.blocked === 'spec review'
        ? 'attention-kind--spec'
        : 'attention-kind--plan',
      waitingSince: b.blockedSince,
    });
  }

  // Sort by waiting time (oldest first)
  items.sort((a, b) =>
    new Date(a.waitingSince).getTime() - new Date(b.waitingSince).getTime()
  );

  return items;
}

export function NeedsAttentionList({ prs, builders }: NeedsAttentionListProps) {
  const items = buildItems(prs, builders);

  if (items.length === 0) {
    return <p className="work-empty">Nothing needs attention</p>;
  }

  return (
    <div className="attention-rows">
      {items.map(item => {
        const inner = (
          <>
            <span className="attention-row-id">{item.issueOrPR}</span>
            <span className="attention-row-title">{item.title}</span>
            <span className={`attention-row-kind ${item.kindClass}`}>{item.kind}</span>
            <span className="attention-row-age">{timeAgo(item.waitingSince)}</span>
          </>
        );

        if (item.url) {
          return (
            <a key={item.key} className="attention-row" href={item.url} target="_blank" rel="noopener noreferrer">
              {inner}
            </a>
          );
        }

        return (
          <div key={item.key} className="attention-row">
            {inner}
          </div>
        );
      })}
    </div>
  );
}
