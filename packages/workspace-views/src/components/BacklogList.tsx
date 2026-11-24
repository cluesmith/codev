import type { OverviewBacklogItem } from '@cluesmith/codev-types';
import { issueRef } from '../lib/issueIds.js';
import { ArtifactLink } from './ArtifactLink.js';

interface BacklogListProps {
  items: OverviewBacklogItem[];
  /** Open a spec / plan / review file. Without it, the item's artifact links are not shown. */
  onOpenArtifact?: (path: string) => void;
}

/** Compact age, or '' when the forge supplied no (or an unparseable) date (#1740). */
export function timeAgo(dateStr: string | undefined): string {
  if (!dateStr) return '';
  const then = new Date(dateStr).getTime();
  if (Number.isNaN(then)) return '';
  const ms = Date.now() - then;
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
  spike: 'type-tag--spike',
};

export function BacklogList({ items, onOpenArtifact }: BacklogListProps) {
  const visible = items.filter(i => !i.hasBuilder);

  if (visible.length === 0) {
    return <p className="work-empty">No open issues</p>;
  }

  return (
    <div className="backlog-rows">
      {visible.map(item => (
        <div key={item.id} className="backlog-row">
          <a className="backlog-row-main" href={item.url} target="_blank" rel="noopener noreferrer">
            <span className={`backlog-priority-dot ${PRIORITY_CLASS[item.priority] ?? 'priority-dot--low'}`} />
            <span className="backlog-row-number">{issueRef(item.id)}</span>
            <span className={`backlog-type-tag ${TYPE_CLASS[item.type] ?? ''}`}>{item.type}</span>
            <span className="backlog-row-title">{item.title}</span>
            {item.author && (
              <span className="backlog-row-author">r: @{item.author}</span>
            )}
            <span className="backlog-row-assignees">
              a: {item.assignees && item.assignees.length > 0
                ? item.assignees.map(a => `@${a}`).join(', ')
                : 'none'}
            </span>
            <span className="backlog-row-age">{timeAgo(item.createdAt)}</span>
          </a>
          {onOpenArtifact && (item.specPath || item.planPath || item.reviewPath) && (
            <span className="backlog-artifacts">
              {item.specPath && <ArtifactLink label="spec" filePath={item.specPath} onOpen={onOpenArtifact} />}
              {item.planPath && <ArtifactLink label="plan" filePath={item.planPath} onOpen={onOpenArtifact} />}
              {item.reviewPath && <ArtifactLink label="review" filePath={item.reviewPath} onOpen={onOpenArtifact} />}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
