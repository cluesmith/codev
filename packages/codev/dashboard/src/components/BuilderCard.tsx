import type { OverviewBuilder } from '../lib/api.js';

interface BuilderCardProps {
  builder: OverviewBuilder;
  onOpen?: (builder: OverviewBuilder) => void;
}

function stateLabel(builder: OverviewBuilder): string {
  if (builder.blocked) return `Blocked: ${builder.blocked}`;
  if (builder.mode === 'soft') return 'running';
  if (!builder.phase) return 'starting';
  const phases = builder.planPhases;
  if (phases.length === 0) return builder.phase;
  const idx = phases.findIndex(p => p.id === builder.phase);
  if (idx === -1) return builder.phase;
  return `${builder.phase} (${idx + 1}/${phases.length})`;
}

function formatMs(ms: number): string {
  if (ms < 0) return '-';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return `${hours}h ${rem}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function elapsed(startedAt: string | null, idleMs: number): string {
  if (!startedAt) return '-';
  const wallMs = Date.now() - new Date(startedAt).getTime();
  if (wallMs < 0) return '-';
  const agentMs = Math.max(0, wallMs - idleMs);
  if (idleMs === 0) return formatMs(wallMs);
  return `${formatMs(wallMs)} wc / ${formatMs(agentMs)} ag`;
}

export function BuilderCard({ builder, onOpen }: BuilderCardProps) {
  const displayId = builder.issueNumber ? `#${builder.issueNumber}` : builder.id;
  const displayTitle = builder.issueTitle || builder.id;
  const isBlocked = builder.blocked !== null && builder.blocked !== '';
  const pct = Math.min(100, Math.max(0, Math.round(builder.progress ?? 0)));

  return (
    <tr className={`builder-row${isBlocked ? ' builder-row--blocked' : ''}`}>
      <td className="builder-col-id">{displayId}</td>
      <td className="builder-col-title">{displayTitle}</td>
      <td className="builder-col-state">
        <span className={isBlocked ? 'builder-state-blocked' : 'builder-state-active'}>
          {stateLabel(builder)}
        </span>
      </td>
      <td className="builder-col-progress">
        <div className="progress-bar">
          <div
            className={`progress-fill${isBlocked ? ' progress-fill--blocked' : ''}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="progress-pct">{pct}%</span>
      </td>
      <td className="builder-col-elapsed">{elapsed(builder.startedAt, builder.idleMs ?? 0)}</td>
      <td className="builder-col-actions">
        {onOpen && (
          <button className="builder-row-open" onClick={() => onOpen(builder)}>
            Open
          </button>
        )}
      </td>
    </tr>
  );
}
