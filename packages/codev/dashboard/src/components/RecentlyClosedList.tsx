import type { OverviewRecentlyClosed } from '../lib/api.js';
import { createFileTab } from '../lib/api.js';

interface RecentlyClosedListProps {
  items: OverviewRecentlyClosed[];
  onRefresh?: () => void;
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

export function RecentlyClosedList({ items, onRefresh }: RecentlyClosedListProps) {
  if (items.length === 0) return null;

  return (
    <div className="recently-closed-rows">
      {items.map(item => {
        const hasArtifacts = item.prUrl || item.specPath || item.planPath || item.reviewPath;
        return (
          <div key={item.number} className="recently-closed-row">
            <a className="recently-closed-row-main" href={item.url} target="_blank" rel="noopener noreferrer">
              <span className="recently-closed-check">&#10003;</span>
              <span className="backlog-row-number">#{item.number}</span>
              <span className={`backlog-type-tag ${TYPE_CLASS[item.type] ?? ''}`}>{item.type}</span>
              <span className="backlog-row-title">{item.title}</span>
              <span className="backlog-row-age">{timeAgo(item.closedAt)}</span>
            </a>
            {hasArtifacts && (
              <span className="backlog-artifacts">
                {item.specPath && <ArtifactLink label="spec" filePath={item.specPath} onRefresh={onRefresh} />}
                {item.planPath && <ArtifactLink label="plan" filePath={item.planPath} onRefresh={onRefresh} />}
                {item.reviewPath && <ArtifactLink label="review" filePath={item.reviewPath} onRefresh={onRefresh} />}
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
