import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { BuilderCard } from '../src/components/BuilderCard.js';
import type { OverviewBuilder } from '../src/lib/api.js';
import type { ServedAgentState } from '@cluesmith/codev-types';

afterEach(() => {
  cleanup();
});

function makeBuilder(overrides: Partial<OverviewBuilder> = {}): OverviewBuilder {
  return {
    id: '0823',
    issueId: '823',
    issueTitle: 'Multi-architect coordination',
    phase: 'implement',
    protocolPhase: 'implement',
    mode: 'strict',
    gates: {},
    worktreePath: '/tmp/.builders/spir-823',
    roleId: 'builder-spir-823',
    protocol: 'spir',
    planPhases: [],
    progress: 50,
    blocked: null,
    blockedGate: null,
    blockedSince: null,
    startedAt: '2026-05-22T12:00:00Z',
    idleMs: 0,
    lastDataAt: null,
    spawnedByArchitect: null,
    prReady: false,
    ...overrides,
  };
}

function renderBuilder(props: Parameters<typeof BuilderCard>[0]) {
  // BuilderCard renders a <tr>, so wrap it in a <table><tbody> for valid DOM.
  return render(
    <table>
      <tbody>
        <BuilderCard {...props} />
      </tbody>
    </table>,
  );
}

describe('BuilderCard — Spec 823 attribution rendering', () => {
  it('does NOT render attribution span when architectCount === 1 (N=1 baseline)', () => {
    renderBuilder({
      builder: makeBuilder({ spawnedByArchitect: 'main' }),
      architectCount: 1,
    });
    // Even with a non-null spawnedByArchitect, N=1 must render no attribution
    // span — the dashboard with one architect looks identical to pre-823.
    expect(document.querySelector('.builder-attribution')).toBeNull();
    expect(screen.getByText('#823')).toBeInTheDocument();

    // Strong N=1 baseline: the ID cell's text content is exactly '#823' — no
    // extra whitespace, no separator, no trailing architect-name (per iter-1
    // Codex finding: the absence-of-attribution check alone is weaker than the
    // baseline parity the plan calls for).
    const idCell = document.querySelector('.builder-col-id');
    expect(idCell).not.toBeNull();
    expect(idCell!.textContent).toBe('#823');
    // ID cell has no child element beyond the text — no <span> introduced.
    expect(idCell!.children.length).toBe(0);
  });

  it('does NOT render attribution span when architectCount is omitted (default 0)', () => {
    renderBuilder({
      builder: makeBuilder({ spawnedByArchitect: 'main' }),
      // architectCount intentionally omitted — default `0` is the loading-state
      // safety net per WorkView's null-safe `state.architects?.length ?? 0`.
    });
    expect(document.querySelector('.builder-attribution')).toBeNull();
  });

  it('renders attribution span at architectCount === 2 with spawnedByArchitect populated', () => {
    renderBuilder({
      builder: makeBuilder({ spawnedByArchitect: 'ob-refine' }),
      architectCount: 2,
    });
    const span = document.querySelector('.builder-attribution');
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe(' · ob-refine');
    // Hover-tooltip (COULD criterion lifted into MUST since the `title`
    // attribute is free at this point).
    expect(span!.getAttribute('title')).toBe('spawned by ob-refine');
  });

  it('does NOT render attribution span at architectCount === 2 when spawnedByArchitect is null', () => {
    // Legacy builders (pre-#755) carry `spawned_by_architect = null` in the
    // DB. They render no attribution even when other builders in the same
    // workspace do.
    renderBuilder({
      builder: makeBuilder({ spawnedByArchitect: null }),
      architectCount: 2,
    });
    expect(document.querySelector('.builder-attribution')).toBeNull();
  });

  it('renders attribution for soft-mode builder when spawnedByArchitect is populated', () => {
    // Per iter-1 Gemini's SQL `WHERE` finding: soft-mode builders (issue_number
    // = null) must still enrich and render their attribution. This test asserts
    // the BuilderCard side; the SQL side is covered by overview.test.ts.
    renderBuilder({
      builder: makeBuilder({
        id: 'task-foo',
        issueId: null,
        issueTitle: null,
        mode: 'soft',
        spawnedByArchitect: 'ob-refine',
      }),
      architectCount: 2,
    });
    const span = document.querySelector('.builder-attribution');
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe(' · ob-refine');
  });

  it('renders attribution at architectCount === 3 (multi-sibling)', () => {
    renderBuilder({
      builder: makeBuilder({ spawnedByArchitect: 'team-a' }),
      architectCount: 3,
    });
    expect(document.querySelector('.builder-attribution')!.textContent).toBe(' · team-a');
  });
});

/** Spec 1595: a served state begun two minutes ago, with fresh output (not a stale `working`). */
function served(state: ServedAgentState['state'], extra: Partial<ServedAgentState> = {}): Partial<OverviewBuilder> {
  const since = new Date(Date.now() - 2 * 60_000).toISOString();
  return {
    lastDataAt: new Date().toISOString(),
    agentState: { state, since, source: 'harness', alive: state !== 'dead', activity: null, activityAt: since, backgroundWork: false, ...extra },
  };
}

function stateCell(): HTMLElement {
  return document.querySelector('.builder-col-state span') as HTMLElement;
}

describe('BuilderCard — Spec 1595 agent state', () => {
  it('shows a permission prompt as "Needs input: …"', () => {
    renderBuilder({ builder: makeBuilder(served('needs-input', { needsInput: { kind: 'permission', tool: 'Bash', summary: 'git push' } })) });
    expect(stateCell().textContent).toBe('Needs input: at a permission prompt: Bash git push');
    expect(document.querySelector('.builder-row--waiting')).not.toBeNull();
  });

  it('shows a question, and a needs-input without detail', () => {
    renderBuilder({ builder: makeBuilder(served('needs-input', { needsInput: { kind: 'question' } })) });
    expect(stateCell().textContent).toBe('Needs input: asking a question');
    cleanup();
    renderBuilder({ builder: makeBuilder(served('needs-input')) });
    expect(stateCell().textContent).toBe('Needs input');
  });

  it('shows Idle for a turn end and the phase for a working agent', () => {
    renderBuilder({ builder: makeBuilder(served('idle')) });
    expect(stateCell().textContent).toBe('Idle');
    cleanup();
    renderBuilder({ builder: makeBuilder(served('working')) });
    expect(stateCell().textContent).toBe('implement');
  });

  it('renders a dead agent distinctly from idle and needs-input (SC7)', () => {
    renderBuilder({ builder: makeBuilder(served('dead')) });
    expect(stateCell().textContent).toBe('Agent exited');
    expect(stateCell().className).toBe('builder-state-dead');
    expect(document.querySelector('.builder-row--dead')).not.toBeNull();
    expect(document.querySelector('.builder-row--waiting')).toBeNull();
  });

  it('keeps the PTY-silence wording when Tower serves no state', () => {
    renderBuilder({ builder: makeBuilder({ lastDataAt: new Date(Date.now() - 10 * 60_000).toISOString() }) });
    expect(stateCell().textContent).toBe('Waiting on input');
  });

  it('renders a Markdown and HTML summary literally, as a text node (SC19)', () => {
    const summary = '<img src=x onerror=alert(1)> [run](command:x) **b**';
    renderBuilder({ builder: makeBuilder(served('needs-input', { needsInput: { kind: 'permission', tool: 'Bash', summary } })) });
    expect(stateCell().textContent).toBe(`Needs input: at a permission prompt: Bash ${summary}`);
    expect(stateCell().children.length).toBe(0);
    expect(document.querySelector('.builder-col-state img')).toBeNull();
    expect(document.querySelector('.builder-col-state a')).toBeNull();
  });
});
