import type { OverviewRecentlyClosed } from '../lib/api.js';

interface RecentlyClosedListProps {
  items: OverviewRecentlyClosed[];
}

function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const TYPE_CLASS: Record<string, string> = {
  bug: 'type-tag--bug',
  project: 'type-tag--project',
};

export function RecentlyClosedList({ items }: RecentlyClosedListProps) {
  if (items.length === 0) return null;

  return (
    <div className="recently-closed-rows">
      {items.map(item => (
        <a key={item.number} className="recently-closed-row" href={item.url} target="_blank" rel="noopener noreferrer">
          <span className="recently-closed-check">&#10003;</span>
          <span className="backlog-row-number">#{item.number}</span>
          <span className={`backlog-type-tag ${TYPE_CLASS[item.type] ?? ''}`}>{item.type}</span>
          <span className="backlog-row-title">{item.title}</span>
          <span className="backlog-row-age">{timeAgo(item.closedAt)}</span>
        </a>
      ))}
    </div>
  );
}
