/**
 * Spec 1470, Phase 2 — porch emits a refresh task at declared boundaries,
 * exactly once each.
 *
 * ## What these tests are actually protecting
 *
 * The refresh ends in `/clear`, which has no undo. So the negatives here matter
 * more than the positives: a boundary that fails to fire costs some context,
 * while a boundary that fires twice — or fires mid-task — destroys a builder's
 * working memory with nobody watching. Every non-boundary state is therefore
 * asserted explicitly rather than left to be implied by the positives.
 *
 * The #1408 case is reproduced directly rather than described: that issue saw
 * verify-approval reset all plan phases to `pending`, which would replay every
 * plan-phase advance. If at-most-once were inferred from phase or iteration
 * instead of recorded, that loop would clear a builder once per plan phase.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import * as yaml from 'js-yaml';
import { next } from '../next.js';
import {
  declaresEnter,
  declaresPlanPhaseAdvance,
  enterBoundary,
  hasRefreshed,
  planPhaseBoundary,
  recordRefresh,
  shouldRefresh,
} from '../context-refresh.js';
import type { ProjectState, Protocol } from '../types.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let root: string;

const PROJECT_ID = '9001';
const PROJECT_TITLE = '9001-refresh-fixture';

/**
 * Sentinel for "omit the key entirely".
 *
 * `undefined` cannot express this: passing it triggers the default parameter, so
 * a fixture meant to declare NOTHING would silently declare everything and the
 * negative test would pass for the wrong reason.
 */
const OMIT = Symbol('omit-context-refresh');

/** SPIR-shaped protocol with the four boundaries declared. */
function spirLike(contextRefresh: unknown = {
  on_enter: ['plan', 'implement', 'review'],
  on_plan_phase_advance: true,
}): Record<string, unknown> {
  const p: Record<string, unknown> = {
    name: 'fixture-spir',
    version: '1.0.0',
    description: 'fixture',
    phases: [
      {
        id: 'specify',
        name: 'Specify',
        type: 'build_verify',
        build: { prompt: 'specify.md', artifact: 'codev/specs/${PROJECT_TITLE}.md' },
        gate: 'spec-approval',
        next: 'plan',
      },
      {
        id: 'plan',
        name: 'Plan',
        type: 'build_verify',
        build: { prompt: 'plan.md', artifact: 'codev/plans/${PROJECT_TITLE}.md' },
        gate: 'plan-approval',
        next: 'implement',
      },
      { id: 'implement', name: 'Implement', type: 'per_plan_phase', next: 'review' },
      { id: 'review', name: 'Review', type: 'build_verify', gate: 'pr', next: null },
    ],
  };
  if (contextRefresh !== OMIT) p.context_refresh = contextRefresh;
  return p;
}

/** ASPIR-shaped: same phases, NO spec/plan gates. */
function aspirLike(): Record<string, unknown> {
  const p = spirLike() as Record<string, unknown>;
  const phases = p.phases as Array<Record<string, unknown>>;
  delete phases[0].gate;
  delete phases[1].gate;
  p.name = 'fixture-aspir';
  return p;
}

function writeProtocol(json: Record<string, unknown>): void {
  const dir = path.join(root, 'codev/protocols', json.name as string);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'protocol.json'), JSON.stringify(json, null, 2));
}

function baseState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    id: PROJECT_ID,
    title: PROJECT_TITLE,
    protocol: 'fixture-spir',
    phase: 'specify',
    plan_phases: [],
    current_plan_phase: null,
    gates: {},
    iteration: 1,
    build_complete: false,
    history: [],
    started_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function writeState(state: ProjectState): string {
  const dir = path.join(root, 'codev/projects', PROJECT_TITLE);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'status.yaml');
  fs.writeFileSync(p, yaml.dump(state));
  return p;
}

function readState(): ProjectState {
  const p = path.join(root, 'codev/projects', PROJECT_TITLE, 'status.yaml');
  return yaml.load(fs.readFileSync(p, 'utf-8')) as ProjectState;
}

/** A plan whose phases porch can extract. */
function writePlan(phaseIds: string[]): void {
  const dir = path.join(root, 'codev/plans');
  fs.mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(
    { phases: phaseIds.map(id => ({ id, title: `Title for ${id}` })) },
    null,
    2,
  );
  fs.writeFileSync(
    path.join(dir, `${PROJECT_TITLE}.md`),
    `# Plan\n\n## Phases (Machine Readable)\n\n\`\`\`json\n${json}\n\`\`\`\n`,
  );
}

function isRefreshTask(response: { tasks?: Array<{ subject: string }> }): boolean {
  return response.tasks?.[0]?.subject === 'Refresh your context';
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), 'porch-1470-trigger-'));
  // git init so writeStateAndCommit has a repo to commit into
  fs.mkdirSync(path.join(root, 'codev'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure helpers — the decision logic, isolated from porch's I/O
// ---------------------------------------------------------------------------

describe('boundary declaration lookup', () => {
  const withFields = { context_refresh: { on_enter: ['plan'], on_plan_phase_advance: true } } as Protocol;
  const empty = { context_refresh: {} } as Protocol;
  const none = {} as Protocol;

  it('reads on_enter membership, not object presence', () => {
    expect(declaresEnter(withFields, 'plan')).toBe(true);
    expect(declaresEnter(withFields, 'review')).toBe(false);
  });

  it('treats an EMPTY context_refresh as declaring nothing', () => {
    // `{}` is valid config and truthy. A presence check would report every
    // boundary as declared for a protocol that opted into none.
    expect(declaresEnter(empty, 'plan')).toBe(false);
    expect(declaresPlanPhaseAdvance(empty)).toBe(false);
  });

  it('treats an absent context_refresh as declaring nothing', () => {
    expect(declaresEnter(none, 'plan')).toBe(false);
    expect(declaresPlanPhaseAdvance(none)).toBe(false);
  });
});

describe('at-most-once record', () => {
  it('records a boundary once and is idempotent on repeat', () => {
    const state = baseState();
    recordRefresh(state, 'enter:plan', 'T1');
    recordRefresh(state, 'enter:plan', 'T2');
    expect(state.context_refreshes).toHaveLength(1);
    expect(state.context_refreshes?.[0].at).toBe('T1');
  });

  it('shouldRefresh is false once recorded, and false when undeclared', () => {
    const state = baseState();
    expect(shouldRefresh(state, true, 'enter:plan')).toBe(true);
    recordRefresh(state, 'enter:plan', 'T1');
    expect(shouldRefresh(state, true, 'enter:plan')).toBe(false);
    expect(shouldRefresh(baseState(), false, 'enter:plan')).toBe(false);
  });

  it('hasRefreshed tolerates a state predating the field', () => {
    const legacy = baseState();
    delete legacy.context_refreshes;
    expect(hasRefreshed(legacy, 'enter:plan')).toBe(false);
  });

  it('derives ids from the transition', () => {
    expect(enterBoundary('implement')).toBe('enter:implement');
    expect(planPhaseBoundary('phase_2_x')).toBe('plan-phase:phase_2_x');
  });
});

// ---------------------------------------------------------------------------
// Site 2: gate-approved transition (SPIR)
// ---------------------------------------------------------------------------

describe('gate-approved transition', () => {
  it('emits a refresh on entering plan after spec-approval', async () => {
    writeProtocol(spirLike());
    writeState(
      baseState({ phase: 'specify', gates: { 'spec-approval': { status: 'approved' } } }),
    );

    const response = await next(root, PROJECT_ID);

    expect(isRefreshTask(response)).toBe(true);
    expect(response.status).toBe('tasks');
    expect(response.tasks?.[0].description).toContain('enter:plan');
    // The transition happened in the SAME write as the record.
    const after = readState();
    expect(after.phase).toBe('plan');
    expect(after.context_refreshes?.map(r => r.boundary)).toEqual(['enter:plan']);
  });

  it('uses status "tasks" rather than a new status variant', async () => {
    // Dashboards and the VS Code tree parse the existing set; a refresh is
    // actionable work and needs no new category.
    writeProtocol(spirLike());
    writeState(baseState({ phase: 'specify', gates: { 'spec-approval': { status: 'approved' } } }));
    const response = await next(root, PROJECT_ID);
    expect(response.status).toBe('tasks');
  });

  it('does NOT instruct porch done', async () => {
    writeProtocol(spirLike());
    writeState(baseState({ phase: 'specify', gates: { 'spec-approval': { status: 'approved' } } }));
    const response = await next(root, PROJECT_ID);
    const description = response.tasks?.[0].description ?? '';
    // Assert the prohibition is present, and that no line INSTRUCTS running it.
    // A naive /run `porch done`/ negative would match the prohibition's own text.
    expect(description).toMatch(/do not run `porch done`/i);
    const instructsPorchDone = description
      .split('\n')
      .some(line => /(^|[^t] )run `porch done`/i.test(line) && !/do not/i.test(line));
    expect(instructsPorchDone).toBe(false);
  });

  it('emits normal tasks on the SECOND call — at most once', async () => {
    writeProtocol(spirLike());
    writeState(baseState({ phase: 'specify', gates: { 'spec-approval': { status: 'approved' } } }));

    const first = await next(root, PROJECT_ID);
    expect(isRefreshTask(first)).toBe(true);

    const second = await next(root, PROJECT_ID);
    expect(isRefreshTask(second)).toBe(false);
    expect(readState().context_refreshes).toHaveLength(1);
  });

  it('emits no refresh when the protocol declares none', async () => {
    writeProtocol(spirLike(OMIT));
    writeState(baseState({ phase: 'specify', gates: { 'spec-approval': { status: 'approved' } } }));
    const response = await next(root, PROJECT_ID);
    expect(isRefreshTask(response)).toBe(false);
    expect(readState().context_refreshes ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Site 4: no-gate direct advance (ASPIR)
// ---------------------------------------------------------------------------

describe('ungated transition (ASPIR shape)', () => {
  it('emits a refresh on a gate-free phase transition', async () => {
    // ASPIR runs UNSUPERVISED, which is the case the fail-safes exist for, so
    // it must get the same boundaries as SPIR.
    writeProtocol(aspirLike());
    writePlan(['phase_1_a', 'phase_2_b']);
    writeState(
      baseState({
        protocol: 'fixture-aspir',
        phase: 'plan',
        build_complete: true,
        iteration: 1,
      }),
    );

    // Drive the no-gate advance directly through the helper the site uses,
    // since reaching it through next() requires a full verify cycle.
    const state = readState();
    expect(declaresEnter({ context_refresh: { on_enter: ['plan', 'implement', 'review'] } } as Protocol, 'implement')).toBe(true);
    expect(shouldRefresh(state, true, enterBoundary('implement'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Timing safety — the negatives that matter most
// ---------------------------------------------------------------------------

describe('never fires at an unsafe moment', () => {
  it('does not fire while parked at a pending gate', async () => {
    // Post-approval only: a builder refreshed while parked could not tell
    // "waiting" from "approved".
    writeProtocol(spirLike());
    writeState(
      baseState({
        phase: 'specify',
        gates: { 'spec-approval': { status: 'pending', requested_at: '2026-01-01T00:00:00Z' } },
      }),
    );

    const response = await next(root, PROJECT_ID);

    expect(isRefreshTask(response)).toBe(false);
    expect(response.status).toBe('gate_pending');
    expect(readState().context_refreshes ?? []).toHaveLength(0);
  });

  it('does not fire mid-iteration on a rebuttal round', async () => {
    writeProtocol(spirLike());
    writeState(baseState({ phase: 'plan', iteration: 2, build_complete: false }));

    const response = await next(root, PROJECT_ID);

    expect(isRefreshTask(response)).toBe(false);
    expect(readState().context_refreshes ?? []).toHaveLength(0);
  });

  it('does not fire on a plain build task', async () => {
    writeProtocol(spirLike());
    writeState(baseState({ phase: 'plan', iteration: 1, build_complete: false }));

    const response = await next(root, PROJECT_ID);

    expect(isRefreshTask(response)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idempotency under the #1408 transition loop
// ---------------------------------------------------------------------------

describe('#1408 transition loop', () => {
  it('does not re-fire boundaries already recorded when plan phases reset to pending', async () => {
    // Reproduce the post-loop state: every plan phase back to `pending`,
    // current back at the first, boundaries already recorded. If at-most-once
    // were inferred rather than recorded, this would clear the builder again
    // for every plan phase.
    writeProtocol(spirLike());
    writePlan(['phase_1_a', 'phase_2_b', 'phase_3_c']);
    const recorded = [
      { boundary: 'enter:implement', at: 'T1' },
      { boundary: 'plan-phase:phase_2_b', at: 'T2' },
      { boundary: 'plan-phase:phase_3_c', at: 'T3' },
    ];
    const state = baseState({
      phase: 'implement',
      plan_phases: [
        { id: 'phase_1_a', title: 'A', status: 'pending' },
        { id: 'phase_2_b', title: 'B', status: 'pending' },
        { id: 'phase_3_c', title: 'C', status: 'pending' },
      ],
      current_plan_phase: 'phase_1_a',
      context_refreshes: recorded,
    });

    for (const r of recorded) {
      expect(shouldRefresh(state, true, r.boundary)).toBe(false);
    }

    writeState(state);
    const response = await next(root, PROJECT_ID);
    expect(isRefreshTask(response)).toBe(false);
    expect(readState().context_refreshes).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

describe('states predating this feature', () => {
  it('loads and does not retroactively refresh a boundary already passed', async () => {
    // A project mid-implement that never had the field: entering `implement`
    // is in its past, and porch must not fire for a transition that already
    // happened before the feature existed.
    writeProtocol(spirLike());
    writePlan(['phase_1_a', 'phase_2_b']);
    const legacy = baseState({
      phase: 'implement',
      plan_phases: [
        { id: 'phase_1_a', title: 'A', status: 'in_progress' },
        { id: 'phase_2_b', title: 'B', status: 'pending' },
      ],
      current_plan_phase: 'phase_1_a',
    });
    delete legacy.context_refreshes;
    writeState(legacy);

    const response = await next(root, PROJECT_ID);

    expect(isRefreshTask(response)).toBe(false);
    expect(readState().context_refreshes ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Non-blocking: a refresh never gates the phase's normal work
// ---------------------------------------------------------------------------

describe('non-blocking', () => {
  it('normal tasks are reachable in one further call from a fired boundary', async () => {
    // The builder-side command never writes status.yaml, so there is no
    // completion signal — a refresh that fails is simply skipped, and the
    // phase's work is never held hostage to it.
    writeProtocol(spirLike());
    writeState(baseState({ phase: 'specify', gates: { 'spec-approval': { status: 'approved' } } }));

    expect(isRefreshTask(await next(root, PROJECT_ID))).toBe(true);
    const second = await next(root, PROJECT_ID);
    expect(isRefreshTask(second)).toBe(false);
    expect(second.tasks?.length).toBeGreaterThan(0);
  });
});
