import type { OverviewBacklogItem } from '../lib/api.js';
import { createFileTab } from '../lib/api.js';

interface BacklogListProps {
  items: OverviewBacklogItem[];
  onRefresh?: () => void;
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

function ArtifactLink({ label, filePath, onRefresh }: { label: string; filePath: string; onRefresh?: () => void }) {
  return (
    <button
      className="backlog-artifact-link"
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await createFileTab(filePath);
        onRefresh?.();
      }}
    >
      {label}
    </button>
  );
}

export function BacklogList({ items, onRefresh }: BacklogListProps) {
  const visible = items.filter(i => !i.hasBuilder);

  if (visible.length === 0) {
    return <p className="work-empty">No open issues</p>;
  }

  return (
    <div className="backlog-rows">
      {visible.map(item => (
        <div key={item.number} className="backlog-row">
          <a className="backlog-row-main" href={item.url} target="_blank" rel="noopener noreferrer">
            <span className={`backlog-priority-dot ${PRIORITY_CLASS[item.priority] ?? 'priority-dot--low'}`} />
            <span className="backlog-row-number">#{item.number}</span>
            <span className={`backlog-type-tag ${TYPE_CLASS[item.type] ?? ''}`}>{item.type}</span>
            <span className="backlog-row-title">{item.title}</span>
            <span className="backlog-row-age">{timeAgo(item.createdAt)}</span>
          </a>
          {(item.specPath || item.planPath || item.reviewPath) && (
            <span className="backlog-artifacts">
              {item.specPath && <ArtifactLink label="spec" filePath={item.specPath} onRefresh={onRefresh} />}
              {item.planPath && <ArtifactLink label="plan" filePath={item.planPath} onRefresh={onRefresh} />}
              {item.reviewPath && <ArtifactLink label="review" filePath={item.reviewPath} onRefresh={onRefresh} />}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
