import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { BuilderCard } from '../src/components/BuilderCard.js';
import type { OverviewBuilder } from '../src/lib/api.js';

afterEach(() => {
  cleanup();
});

function makeBuilder(overrides: Partial<OverviewBuilder> = {}): OverviewBuilder {
  return {
    id: '0823',
    issueId: '823',
    issueTitle: 'Multi-architect coordination',
    phase: 'implement',
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
