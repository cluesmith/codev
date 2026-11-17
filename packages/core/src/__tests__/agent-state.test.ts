import { describe, it, expect } from 'vitest';
import type { AgentActivity } from '@cluesmith/codev-types';
import { projectAgentState, type AgentStateFacts, type ReportedActivityFact } from '../agent-state.js';

const NOW = '2026-10-21T06:00:00.000Z';
const LIVENESS_SINCE = '2026-10-21T05:59:50.000Z';
const BLOCKED_SINCE = '2026-10-21T05:00:00.000Z';
const REPORT_SINCE = '2026-10-21T05:58:00.000Z';
const REPORT_AT = '2026-10-21T05:59:00.000Z';

function reported(activity: AgentActivity, extra: Partial<ReportedActivityFact> = {}): ReportedActivityFact {
  return { activity, since: REPORT_SINCE, at: REPORT_AT, backgroundWork: false, ...extra };
}

function facts(overrides: Partial<AgentStateFacts>): AgentStateFacts {
  return {
    blocked: false,
    blockedSince: BLOCKED_SINCE,
    phase: 'implement',
    liveness: null,
    reported: null,
    now: NOW,
    ...overrides,
  };
}

function livenessFor(alive: boolean | null | undefined): AgentStateFacts['liveness'] {
  if (alive === undefined) return null;
  return { alive, since: LIVENESS_SINCE };
}

function reportedFor(activity: AgentActivity | null): ReportedActivityFact | null {
  if (!activity) return null;
  return reported(activity);
}

const ALIVE_VALUES: Array<boolean | null | undefined> = [true, false, null, undefined];
const ACTIVITIES: Array<AgentActivity | null> = ['working', 'needs-input', 'idle', null];
const PHASES = ['implement', 'review', 'complete', 'verified', ''];

/** The documented precedence, restated independently of the implementation. */
function expectedState(blocked: boolean, alive: boolean | null | undefined, activity: AgentActivity | null, phase: string): string | null {
  if (blocked) return 'blocked';
  if (alive === false && phase !== 'complete' && phase !== 'verified') return 'dead';
  if (activity) return activity;
  return null;
}

describe('projectAgentState', () => {
  describe('precedence table (every combination)', () => {
    for (const blocked of [false, true]) {
      for (const alive of ALIVE_VALUES) {
        for (const activity of ACTIVITIES) {
          for (const phase of PHASES) {
            const label = `blocked=${blocked} alive=${String(alive)} activity=${String(activity)} phase=${phase || '(architect)'}`;
            it(label, () => {
              const result = projectAgentState(facts({
                blocked,
                phase,
                liveness: livenessFor(alive),
                reported: reportedFor(activity),
              }));
              expect(result?.state ?? null).toBe(expectedState(blocked, alive, activity, phase));
            });
          }
        }
      }
    }
  });

  it('never projects dead for a complete or verified builder', () => {
    for (const phase of ['complete', 'verified']) {
      const result = projectAgentState(facts({ phase, liveness: { alive: false, since: LIVENESS_SINCE } }));
      expect(result).toBeNull();
    }
  });

  it('blocked is served from tower with the gate time, falling back to now', () => {
    expect(projectAgentState(facts({ blocked: true }))).toMatchObject({ state: 'blocked', source: 'tower', since: BLOCKED_SINCE });
    expect(projectAgentState(facts({ blocked: true, blockedSince: null }))?.since).toBe(NOW);
  });

  it('dead is served from tower with the liveness time and outranks a stale report', () => {
    const result = projectAgentState(facts({
      liveness: { alive: false, since: LIVENESS_SINCE },
      reported: reported('working'),
    }));
    expect(result).toMatchObject({ state: 'dead', source: 'tower', since: LIVENESS_SINCE, alive: false, activity: 'working' });
  });

  it('reported activity is served from the harness with its own since', () => {
    expect(projectAgentState(facts({ reported: reported('idle') }))).toMatchObject({
      state: 'idle',
      source: 'harness',
      since: REPORT_SINCE,
      activityAt: REPORT_AT,
    });
  });

  it('carries the raw inputs on every served row', () => {
    const result = projectAgentState(facts({
      blocked: true,
      liveness: { alive: true, since: LIVENESS_SINCE },
      reported: reported('working', { backgroundWork: true }),
    }));
    expect(result).toEqual({
      state: 'blocked',
      since: BLOCKED_SINCE,
      source: 'tower',
      alive: true,
      activity: 'working',
      activityAt: REPORT_AT,
      backgroundWork: true,
    });
  });

  it('defaults raw inputs when nothing was reported', () => {
    expect(projectAgentState(facts({ liveness: { alive: false, since: LIVENESS_SINCE } }))).toEqual({
      state: 'dead',
      since: LIVENESS_SINCE,
      source: 'tower',
      alive: false,
      activity: null,
      activityAt: null,
      backgroundWork: false,
    });
  });

  it('carries needs-input detail with the raw activity, whatever state wins', () => {
    const detail = { kind: 'permission' as const, tool: 'Bash', summary: 'pnpm test' };
    const needsInput = reported('needs-input', { needsInput: detail });
    expect(projectAgentState(facts({ reported: needsInput }))?.needsInput).toEqual(detail);
    const blocked = projectAgentState(facts({ blocked: true, reported: needsInput }));
    expect(blocked).toMatchObject({ state: 'blocked', activity: 'needs-input', needsInput: detail });
    const dead = projectAgentState(facts({ liveness: { alive: false, since: LIVENESS_SINCE }, reported: needsInput }));
    expect(dead).toMatchObject({ state: 'dead', activity: 'needs-input', needsInput: detail });
  });

  it('never carries needs-input detail for another activity', () => {
    const stray = reported('working', { needsInput: { kind: 'other' } });
    expect(projectAgentState(facts({ reported: stray }))?.needsInput).toBeUndefined();
  });

  it('unknown liveness never yields dead', () => {
    expect(projectAgentState(facts({ liveness: { alive: null, since: LIVENESS_SINCE } }))).toBeNull();
  });
});
