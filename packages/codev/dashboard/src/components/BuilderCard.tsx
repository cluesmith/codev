import type { OverviewBuilder } from '../lib/api.js';

interface BuilderCardProps {
  builder: OverviewBuilder;
  onOpen?: (builder: OverviewBuilder) => void;
}

function phaseLabel(builder: OverviewBuilder): string {
  if (builder.mode === 'soft') return 'running';
  if (!builder.phase) return '';
  const phases = builder.planPhases;
  if (phases.length === 0) return builder.phase;
  const idx = phases.findIndex(p => p.id === builder.phase);
  if (idx === -1) return builder.phase;
  return `${builder.phase} (${idx + 1}/${phases.length})`;
}

export function BuilderCard({ builder, onOpen }: BuilderCardProps) {
  const displayId = builder.issueNumber ? `#${builder.issueNumber}` : builder.id;
  const displayTitle = builder.issueTitle || builder.id;
  const isBlocked = builder.blocked !== null && builder.blocked !== '';
  const pct = Math.min(100, Math.max(0, Math.round((builder.progress ?? 0) * 100)));

  return (
    <div className={`builder-row${isBlocked ? ' builder-row--blocked' : ''}`}>
      <span className="builder-row-id">{displayId}</span>
      <span className="builder-row-title">{displayTitle}</span>
      <div className="builder-row-progress">
        <div className="progress-bar">
          <div
            className={`progress-fill${isBlocked ? ' progress-fill--blocked' : ''}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        {isBlocked ? (
          <span className="builder-row-blocked">Blocked: {builder.blocked}</span>
        ) : (
          <span className="builder-row-phase">{phaseLabel(builder)}</span>
        )}
      </div>
      {onOpen && (
        <button className="builder-row-open" onClick={() => onOpen(builder)}>
          Open
        </button>
      )}
    </div>
  );
}
