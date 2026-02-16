import type { OverviewBuilder } from '../lib/api.js';

interface BuilderCardProps {
  builder: OverviewBuilder;
  onOpen?: (builder: OverviewBuilder) => void;
}

function GateBadge({ name, status }: { name: string; status: string }) {
  const label = name.replace(/-/g, ' ');
  return (
    <span className={`gate-badge gate-${status}`}>
      {label}: {status}
    </span>
  );
}

export function BuilderCard({ builder, onOpen }: BuilderCardProps) {
  const gateEntries = Object.entries(builder.gates).filter(([, s]) => s === 'pending' || s === 'approved');
  const displayId = builder.issueNumber ? `#${builder.issueNumber}` : builder.id;
  const displayTitle = builder.issueTitle || builder.id;

  return (
    <div className="builder-card">
      <div className="builder-card-header">
        <div className="builder-card-id">{displayId}</div>
        <span className={`builder-mode-badge mode-${builder.mode}`}>{builder.mode}</span>
        {onOpen && (
          <button className="builder-open-btn" onClick={() => onOpen(builder)}>
            Open
          </button>
        )}
      </div>
      <div className="builder-card-title">{displayTitle}</div>
      {builder.mode === 'strict' && builder.phase && (
        <div className="builder-card-phase">Phase: {builder.phase}</div>
      )}
      {builder.mode === 'soft' && (
        <div className="builder-card-phase soft">running</div>
      )}
      {gateEntries.length > 0 && (
        <div className="builder-card-gates">
          {gateEntries.map(([name, status]) => (
            <GateBadge key={name} name={name} status={status} />
          ))}
        </div>
      )}
    </div>
  );
}
