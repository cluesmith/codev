import type { Builder } from '../lib/api.js';

interface BuilderCardProps {
  builder: Builder;
}

const statusColors: Record<string, string> = {
  spawning: '#22c55e',
  implementing: '#f97316',
  blocked: '#ef4444',
  'pr-ready': '#eab308',
  complete: '#22c55e',
};

export function BuilderCard({ builder }: BuilderCardProps) {
  const color = statusColors[builder.status] ?? '#6b7280';

  return (
    <div className="builder-card">
      <div className="builder-header">
        <span
          className="status-dot"
          style={{ backgroundColor: color }}
          aria-label={`Status: ${builder.status}`}
        />
        <span className="builder-name">{builder.name || builder.id}</span>
      </div>
      <div className="builder-meta">
        <span className="builder-status">{builder.status}</span>
        {builder.phase && <span className="builder-phase">{builder.phase}</span>}
      </div>
    </div>
  );
}
