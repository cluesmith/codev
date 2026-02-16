import type { OverviewBacklogItem } from '../lib/api.js';

interface BacklogListProps {
  items: OverviewBacklogItem[];
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

const PRIORITY_CLASS: Record<string, string> = {
  high: 'priority-dot--high',
  medium: 'priority-dot--med',
  low: 'priority-dot--low',
};

const TYPE_CLASS: Record<string, string> = {
  bug: 'type-tag--bug',
  project: 'type-tag--project',
};

export function BacklogList({ items }: BacklogListProps) {
  const visible = items.filter(i => !i.hasBuilder);

  if (visible.length === 0) {
    return <p className="work-empty">No open issues</p>;
  }

  return (
    <div className="backlog-rows">
      {visible.map(item => (
        <div key={item.number} className="backlog-row">
          <span className={`backlog-priority-dot ${PRIORITY_CLASS[item.priority] ?? 'priority-dot--low'}`} />
          <span className="backlog-row-number">#{item.number}</span>
          <span className={`backlog-type-tag ${TYPE_CLASS[item.type] ?? ''}`}>{item.type}</span>
          <span className="backlog-row-title">{item.title}</span>
          <span className="backlog-row-age">{timeAgo(item.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}
