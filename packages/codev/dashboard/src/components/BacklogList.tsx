import type { OverviewBacklogItem } from '../lib/api.js';

interface BacklogListProps {
  items: OverviewBacklogItem[];
}

function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1 month ago' : `${months} months ago`;
}

export function BacklogList({ items }: BacklogListProps) {
  if (items.length === 0) {
    return <p className="work-empty">No open issues</p>;
  }

  // Group: "Ready to start" (has spec, no builder) above "Backlog" (no spec)
  // Active builders are shown in the Builders section, not here
  const nonBuilding = items.filter(i => !i.hasBuilder);
  const ready = nonBuilding.filter(i => i.hasSpec);
  const backlog = nonBuilding.filter(i => !i.hasSpec);

  return (
    <div className="backlog-list">
      {ready.length > 0 && (
        <div className="backlog-group">
          <h4 className="backlog-group-title">Ready to Start ({ready.length})</h4>
          {ready.map(item => <BacklogItem key={item.number} item={item} />)}
        </div>
      )}
      {backlog.length > 0 && (
        <div className="backlog-group">
          <h4 className="backlog-group-title">Backlog ({backlog.length})</h4>
          {backlog.map(item => <BacklogItem key={item.number} item={item} />)}
        </div>
      )}
    </div>
  );
}

function BacklogItem({ item }: { item: OverviewBacklogItem }) {
  return (
    <div className="backlog-item">
      <div className="backlog-item-header">
        <span className="backlog-number">#{item.number}</span>
        <span className={`type-badge type-${item.type}`}>{item.type}</span>
        <span className={`priority-badge priority-${item.priority}`}>{item.priority}</span>
      </div>
      <div className="backlog-item-title">{item.title}</div>
      <div className="backlog-item-meta">{timeAgo(item.createdAt)}</div>
    </div>
  );
}
