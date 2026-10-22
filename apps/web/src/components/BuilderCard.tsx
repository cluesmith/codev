import { agentAttentionState, describeNeedsInput, isIdleWaiting } from '@cluesmith/codev-sdk/builder-helpers';
import type { OverviewBuilder } from '../lib/api.js';
import { issueRef } from '../lib/issueIds.js';

interface BuilderCardProps {
  builder: OverviewBuilder;
  onOpen?: (builder: OverviewBuilder) => void;
  /**
   * Number of architects in the workspace. Used to gate the inline attribution
   * tag — rendered only when `architectCount > 1` per Spec 823 (baked decision
   * 2b: separator + name, no "spawned by" prefix label). N=1 renders identical
   * to pre-823 DOM.
   */
  architectCount?: number;
}

/**
 * The card's attention state, through the shared sdk classifier (Spec 1595): a porch gate first,
 * then the served agent state (a stale `working` reads as idle), then, when Tower serves no state,
 * the PTY-silence predicate (`waiting`).
 */
type CardState = 'blocked' | 'needs-input' | 'idle' | 'dead' | 'waiting' | 'active';

function cardState(builder: OverviewBuilder): CardState {
  if (builder.blocked) return 'blocked';
  const served = agentAttentionState(builder);
  if (served === 'needs-input' || served === 'idle' || served === 'dead' || served === 'blocked') return served;
  if (served === null && isIdleWaiting(builder)) return 'waiting';
  return 'active';
}

/** "Needs input: <what>", or bare "Needs input" when the reporter sent no detail. */
function needsInputLabel(builder: OverviewBuilder): string {
  const detail = builder.agentState?.needsInput;
  if (!detail || detail.kind === 'other') return 'Needs input';
  return `Needs input: ${describeNeedsInput(detail)}`;
}

function stateLabel(builder: OverviewBuilder, state: CardState): string {
  if (state === 'blocked') return `Blocked: ${builder.blocked ?? 'gate'}`;
  if (state === 'needs-input') return needsInputLabel(builder);
  if (state === 'idle') return 'Idle';
  if (state === 'dead') return 'Agent exited';
  if (state === 'waiting') return 'Waiting on input';
  if (builder.mode === 'soft') return 'running';
  if (!builder.phase) return 'starting';
  const phases = builder.planPhases;
  if (phases.length === 0) return builder.phase;
  const idx = phases.findIndex(p => p.id === builder.phase);
  if (idx === -1) return builder.phase;
  return `${builder.phase} (${idx + 1}/${phases.length})`;
}

/** The state text's class: a distinct one for a dead agent, the shared "needs me" one for the waits. */
function stateClass(state: CardState): string {
  if (state === 'dead') return 'builder-state-dead';
  if (state === 'needs-input') return 'builder-state-blocked builder-state-needs-input';
  if (state === 'active') return 'builder-state-active';
  return 'builder-state-blocked';
}

/** The row modifier: blocked and dead have their own; every other wait shares `--waiting`. */
function rowModifier(state: CardState): string {
  if (state === 'blocked') return ' builder-row--blocked';
  if (state === 'dead') return ' builder-row--dead';
  if (state === 'active') return '';
  return ' builder-row--waiting';
}

function fillModifier(state: CardState): string {
  if (state === 'blocked') return ' progress-fill--blocked';
  if (state === 'active') return '';
  return ' progress-fill--waiting';
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

export function BuilderCard({ builder, onOpen, architectCount = 0 }: BuilderCardProps) {
  const displayId = builder.issueId ? issueRef(builder.issueId) : builder.id;
  const displayTitle = builder.issueTitle || builder.id;
  const state = cardState(builder);
  const label = stateLabel(builder, state);
  const pct = Math.min(100, Math.max(0, Math.round(builder.progress ?? 0)));
  // Spec 823: render attribution only when the workspace has >1 architect AND
  // the builder carries a spawning-architect name. N=1 renders identically to
  // pre-823 (no extra DOM, per baked decision 2b).
  const showAttribution = architectCount > 1 && !!builder.spawnedByArchitect;

  // The waits reuse the blocked text color (all are "needs me" states); a dead
  // agent has its own row and text treatment (SC7).
  const rowMod = rowModifier(state);
  const fillMod = fillModifier(state);

  return (
    <tr className={`builder-row${rowMod}`}>
      <td className="builder-col-id">
        {displayId}
        {showAttribution && (
          <span className="builder-attribution" title={`spawned by ${builder.spawnedByArchitect}`}>
            {' · '}{builder.spawnedByArchitect}
          </span>
        )}
      </td>
      <td className="builder-col-title">{displayTitle}</td>
      <td className="builder-col-state">
        {/* A text node and a plain `title`: a needs-input summary renders literally (SC19). */}
        <span className={stateClass(state)} title={label}>
          {label}
        </span>
      </td>
      <td className="builder-col-progress">
        <div className="progress-bar">
          <div
            className={`progress-fill${fillMod}`}
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
