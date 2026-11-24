import type { OverviewRecentlyClosed } from '@cluesmith/codev-types';
import { issueRef } from '../lib/issueIds.js';
import { ArtifactLink } from './ArtifactLink.js';

interface RecentlyClosedListProps {
  items: OverviewRecentlyClosed[];
  /** Open a spec / plan / review file. Without it, the item's artifact links are not shown. */
  onOpenArtifact?: (path: string) => void;
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
  spike: 'type-tag--spike',
};

export function RecentlyClosedList({ items, onOpenArtifact }: RecentlyClosedListProps) {
  if (items.length === 0) return null;

  return (
    <div className="recently-closed-rows">
      {items.map(item => {
        const hasFiles = !!onOpenArtifact && !!(item.specPath || item.planPath || item.reviewPath);
        const hasArtifacts = item.prUrl || hasFiles;
        return (
          <div key={item.id} className="recently-closed-row">
            <a className="recently-closed-row-main" href={item.url} target="_blank" rel="noopener noreferrer">
              <span className="recently-closed-check">&#10003;</span>
              <span className="backlog-row-number">{issueRef(item.id)}</span>
              <span className={`backlog-type-tag ${TYPE_CLASS[item.type] ?? ''}`}>{item.type}</span>
              <span className="backlog-row-title">{item.title}</span>
              <span className="backlog-row-age">{timeAgo(item.closedAt)}</span>
            </a>
            {hasArtifacts && (
              <span className="backlog-artifacts">
                {onOpenArtifact && item.specPath && <ArtifactLink label="spec" filePath={item.specPath} onOpen={onOpenArtifact} />}
                {onOpenArtifact && item.planPath && <ArtifactLink label="plan" filePath={item.planPath} onOpen={onOpenArtifact} />}
                {onOpenArtifact && item.reviewPath && <ArtifactLink label="review" filePath={item.reviewPath} onOpen={onOpenArtifact} />}
                {item.prUrl && (
                  <a
                    className="backlog-artifact-link"
                    href={item.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    PR
                  </a>
                )}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
