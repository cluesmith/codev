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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

// Mock loadConfig, following the convention in next.test.ts.
//
// `resolveConsultationModels` does NOT read the phase's `verify.models` — it
// reads workspace/global config, which in a temp root falls back to the
// three-model default. So porch sat waiting for a `gemini` review that the
// fixture never writes, and every transition-site test returned "Run remaining
// consultations" instead of transitioning. Pinning the models here makes the
// fixture's two review files sufficient.
vi.mock('../../../lib/config.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../../lib/config.js')>();
  return {
    ...original,
    loadConfig: (_workspaceRoot: string) => ({
      porch: { consultation: { models: ['codex', 'claude'] } },
    }),
  };
});

// Mock fetchIssue so buildPhasePrompt does not shell out to `gh issue view`
// once per test (the flake fixed in #894).
vi.mock('../../../lib/github.js', () => ({
  fetchIssue: vi.fn().mockResolvedValue(null),
}));

/**
 * Count `writeStateAndCommit` calls.
 *
 * Inspecting only the FINAL state cannot distinguish one atomic write from a
 * transition write followed by a separate boundary write — and that distinction
 * is the entire at-most-once mechanism. If the record could land in a second
 * write, a crash between the two would leave a project transitioned but not
 * marked, and the next `porch next` would clear the builder again.
 */
const { writeCounter } = vi.hoisted(() => ({ writeCounter: { count: 0 } }));

vi.mock('../state.js', async importOriginal => {
  const original = await importOriginal<typeof import('../state.js')>();
  return {
    ...original,
    writeStateAndCommit: async (...args: Parameters<typeof original.writeStateAndCommit>) => {
      writeCounter.count += 1;
      return original.writeStateAndCommit(...args);
    },
  };
});

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
        verify: { type: 'spec', models: ['codex', 'claude'], parallel: true },
        gate: 'spec-approval',
        next: 'plan',
      },
      {
        id: 'plan',
        name: 'Plan',
        type: 'build_verify',
        build: { prompt: 'plan.md', artifact: 'codev/plans/${PROJECT_TITLE}.md' },
        verify: { type: 'plan', models: ['codex', 'claude'], parallel: true },
        gate: 'plan-approval',
        next: 'implement',
      },
      {
        id: 'implement',
        name: 'Implement',
        type: 'per_plan_phase',
        // BOTH build and verify are required: `isBuildVerify` is
        // `!!(phase.build && phase.verify)`, so a phase missing either one
        // falls through to `handleOncePhase` and the transition sites under
        // test are never reached at all.
        build: { prompt: 'implement.md', artifact: 'src/**/*.ts' },
        verify: { type: 'impl', models: ['codex', 'claude'], parallel: true },
        next: 'review',
      },
      {
        id: 'review',
        name: 'Review',
        type: 'build_verify',
        build: { prompt: 'review.md', artifact: 'codev/reviews/${PROJECT_TITLE}.md' },
        verify: { type: 'pr', models: ['codex', 'claude'], parallel: true },
        gate: 'pr',
        next: null,
      },
    ],
    // Without a verify config the fixture never reaches handleVerifyApproved,
    // so every transition-site test would silently assert on a build task.
    defaults: { verify: { models: ['codex', 'claude'], parallel: true } },
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

/**
 * A plan whose phases porch can extract.
 *
 * `approved` prepends the frontmatter IN THE SAME FILE rather than writing it
 * separately: the plan artifact and the pre-approval marker are one file, and
 * writing them in two calls silently clobbered the phases JSON — which made
 * `extractPlanPhases` fall back to inventing a `phase_1`.
 */
function writePlan(phaseIds: string[], approved = false): void {
  const dir = path.join(root, 'codev/plans');
  fs.mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(
    { phases: phaseIds.map(id => ({ id, title: `Title for ${id}` })) },
    null,
    2,
  );
  const frontmatter = approved
    ? '---\napproved: 2026-01-01\nvalidated: [codex, claude]\n---\n\n'
    : '';
  fs.writeFileSync(
    path.join(dir, `${PROJECT_TITLE}.md`),
    `${frontmatter}# Plan\n\n## Phases (Machine Readable)\n\n\`\`\`json\n${json}\n\`\`\`\n`,
  );
}

function isRefreshTask(response: { tasks?: Array<{ subject: string }> }): boolean {
  return response.tasks?.[0]?.subject === 'Refresh your context';
}

/**
 * Write APPROVE verdicts for the models the mocked config resolves to.
 *
 * Reaching any transition site requires a completed verify round — without
 * these, `next()` returns "Run remaining consultations" and every
 * transition-site assertion becomes vacuous.
 */
function writeApprovingReviews(phase: string, iteration: number): void {
  const dir = path.join(root, 'codev/projects', PROJECT_TITLE);
  fs.mkdirSync(dir, { recursive: true });
  for (const model of ['codex', 'claude']) {
    fs.writeFileSync(
      path.join(dir, `${PROJECT_ID}-${phase}-iter${iteration}-${model}.txt`),
      '---\nVERDICT: APPROVE\nSUMMARY: ok\nCONFIDENCE: HIGH\n---\nKEY_ISSUES:\n- None\n',
    );
  }
}

/** Write a spec carrying `approved:` frontmatter. (Plans: use writePlan(ids, true).) */
function writeApprovedSpec(): void {
  const dir = path.join(root, 'codev/specs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${PROJECT_TITLE}.md`),
    '---\napproved: 2026-01-01\nvalidated: [codex, claude]\n---\n\n# Spec\n',
  );
}

beforeEach(() => {
  writeCounter.count = 0;
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
  /**
   * Drive the no-gate advance through `next()` for real.
   *
   * Reaching it requires a completed verify round, so the fixture writes review
   * files whose verdicts porch parses. An earlier version of this test only
   * called the pure helpers — which is why it missed the plan_phases defect
   * below entirely. Testing the decision without the wiring proves nothing
   * about whether the wiring runs.
   */
  it('emits a refresh entering implement, and extracts plan phases there', async () => {
    // ASPIR runs UNSUPERVISED — the case the fail-safes exist for — so it must
    // get the same boundaries as SPIR.
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
    writeApprovingReviews('plan', 1);

    const response = await next(root, PROJECT_ID);

    expect(isRefreshTask(response)).toBe(true);
    expect(response.tasks?.[0].description).toContain('enter:implement');

    const after = readState();
    expect(after.phase).toBe('implement');
    // REGRESSION GUARD (pre-existing bug, fixed in this phase): the ungated
    // path did not extract plan_phases, unlike the gated and pre-approved
    // paths. ASPIR always reaches implement through here, so it entered with an
    // empty plan_phases and never reached the per-plan-phase advance branch —
    // silently costing ASPIR its per-phase iteration, and making its declared
    // plan-phase:* boundaries unreachable.
    expect(after.plan_phases.map(p => p.id)).toEqual(['phase_1_a', 'phase_2_b']);
    expect(after.current_plan_phase).toBe('phase_1_a');
  });
});

// ---------------------------------------------------------------------------
// Site 1: pre-approval skip — the path CLAUDE.md documents as normal
// ---------------------------------------------------------------------------

describe('pre-approval transition', () => {
  it('transitions and extracts plan phases, but does NOT refresh', async () => {
    // A skip is not work. The branch runs at iteration 1 with build_complete
    // false — before the builder has done anything in the skipped phase — so
    // there is no context to refresh. The transition itself must still be
    // complete, including plan-phase extraction.
    writeProtocol(spirLike());
    writePlan(['phase_1_a', 'phase_2_b'], true);
    writeState(baseState({ phase: 'plan', iteration: 1, build_complete: false }));

    const response = await next(root, PROJECT_ID);

    expect(isRefreshTask(response)).toBe(false);
    const after = readState();
    expect(after.phase).toBe('implement');
    expect(after.gates['plan-approval'].status).toBe('approved');
    expect(after.plan_phases.map(p => p.id)).toEqual(['phase_1_a', 'phase_2_b']);
    expect(after.current_plan_phase).toBe('phase_1_a');
    expect(after.context_refreshes ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Site 3: plan-phase advance, and entering review
// ---------------------------------------------------------------------------

describe('plan-phase advance and review entry', () => {
  it('emits a refresh advancing from plan phase 1 to 2', async () => {
    writeProtocol(spirLike());
    writePlan(['phase_1_a', 'phase_2_b']);
    writeState(
      baseState({
        phase: 'implement',
        plan_phases: [
          { id: 'phase_1_a', title: 'A', status: 'in_progress' },
          { id: 'phase_2_b', title: 'B', status: 'pending' },
        ],
        current_plan_phase: 'phase_1_a',
        build_complete: true,
        iteration: 1,
      }),
    );
    writeApprovingReviews('phase_1_a', 1);

    const response = await next(root, PROJECT_ID);

    expect(isRefreshTask(response)).toBe(true);
    expect(response.tasks?.[0].description).toContain('plan-phase:phase_2_b');
    const after = readState();
    expect(after.current_plan_phase).toBe('phase_2_b');
    // NOT plan-phase:phase_1_a — the first plan phase coincides with entering
    // `implement`, and this boundary fires only on advance BETWEEN phases.
    expect(after.context_refreshes?.map(r => r.boundary)).toEqual(['plan-phase:phase_2_b']);
  });

  it('emits a refresh entering review when the last plan phase completes', async () => {
    // The quality boundary: a builder entering review in a fresh context reads
    // its own diff cold.
    writeProtocol(spirLike());
    writePlan(['phase_1_a']);
    writeState(
      baseState({
        phase: 'implement',
        plan_phases: [{ id: 'phase_1_a', title: 'A', status: 'in_progress' }],
        current_plan_phase: 'phase_1_a',
        build_complete: true,
        iteration: 1,
      }),
    );
    writeApprovingReviews('phase_1_a', 1);

    const response = await next(root, PROJECT_ID);

    expect(isRefreshTask(response)).toBe(true);
    expect(response.tasks?.[0].description).toContain('enter:review');
    const after = readState();
    expect(after.phase).toBe('review');
    expect(after.context_refreshes?.map(r => r.boundary)).toEqual(['enter:review']);
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
  it('advances into an already-recorded plan-phase boundary WITHOUT re-firing', async () => {
    // The real shape of #1408: verify-approval reset every plan phase to
    // `pending`, so the project re-walks advances it already made. An earlier
    // version of this test left `build_complete: false`, so porch returned a
    // build task and never re-entered a transition at all — it asserted "no
    // refresh" about a call that could not have produced one.
    //
    // This drives a genuine approving verify round that ADVANCES into a
    // boundary already present in context_refreshes, which is the only way to
    // prove the record (not the control flow) is what suppresses the second
    // refresh.
    writeProtocol(spirLike());
    writePlan(['phase_1_a', 'phase_2_b']);
    writeState(
      baseState({
        phase: 'implement',
        plan_phases: [
          { id: 'phase_1_a', title: 'A', status: 'in_progress' },
          { id: 'phase_2_b', title: 'B', status: 'pending' },
        ],
        current_plan_phase: 'phase_1_a',
        build_complete: true,
        iteration: 1,
        // The boundary we are about to advance into is ALREADY recorded.
        context_refreshes: [{ boundary: 'plan-phase:phase_2_b', at: 'T-earlier' }],
      }),
    );
    writeApprovingReviews('phase_1_a', 1);

    const response = await next(root, PROJECT_ID);

    // The transition MUST still happen — suppressing the refresh must not
    // suppress protocol progress.
    const after = readState();
    expect(after.current_plan_phase).toBe('phase_2_b');
    expect(isRefreshTask(response)).toBe(false);
    // Still exactly one record, with its ORIGINAL timestamp: not re-appended,
    // not overwritten.
    expect(after.context_refreshes).toHaveLength(1);
    expect(after.context_refreshes?.[0].at).toBe('T-earlier');
  });

  it('does not re-fire an entry boundary re-entered after a reset', async () => {
    writeProtocol(spirLike());
    writePlan(['phase_1_a']);
    writeState(
      baseState({
        phase: 'specify',
        gates: { 'spec-approval': { status: 'approved' } },
        context_refreshes: [{ boundary: 'enter:plan', at: 'T-earlier' }],
      }),
    );

    const response = await next(root, PROJECT_ID);

    expect(readState().phase).toBe('plan');
    expect(isRefreshTask(response)).toBe(false);
    expect(readState().context_refreshes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// One write per boundary transition
// ---------------------------------------------------------------------------

describe('atomicity', () => {
  it('records the boundary and the transition in ONE state write', async () => {
    // Final-state inspection cannot tell one atomic write from two sequential
    // ones. If the record landed in a second write, a crash between them would
    // leave a project transitioned but unmarked — and the next porch next would
    // clear the builder a second time.
    writeProtocol(spirLike());
    writeState(baseState({ phase: 'specify', gates: { 'spec-approval': { status: 'approved' } } }));

    const response = await next(root, PROJECT_ID);

    expect(isRefreshTask(response)).toBe(true);
    expect(writeCounter.count).toBe(1);
    const after = readState();
    expect(after.phase).toBe('plan');
    expect(after.context_refreshes).toHaveLength(1);
  });

  it('writes once for a plan-phase advance too', async () => {
    writeProtocol(spirLike());
    writePlan(['phase_1_a', 'phase_2_b']);
    writeState(
      baseState({
        phase: 'implement',
        plan_phases: [
          { id: 'phase_1_a', title: 'A', status: 'in_progress' },
          { id: 'phase_2_b', title: 'B', status: 'pending' },
        ],
        current_plan_phase: 'phase_1_a',
        build_complete: true,
        iteration: 1,
      }),
    );
    writeApprovingReviews('phase_1_a', 1);

    await next(root, PROJECT_ID);

    expect(writeCounter.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Transition matrix — every declared boundary reached by every route
// ---------------------------------------------------------------------------

describe('transition matrix', () => {
  /**
   * Each case names the ROUTE as well as the boundary, because the same
   * boundary reached by a different route is a different code path — and the
   * first plan draft shipped three of the four routes precisely because the
   * boundary list looked complete.
   */
  interface MatrixCase {
    name: string;
    setUp: () => void;
    expectBoundary: string;
    expectPhase?: string;
    expectPlanPhase?: string | null;
  }

  const cases: MatrixCase[] = [
    {
      name: 'gated: specify → plan',
      setUp: () => {
        writeProtocol(spirLike());
        writeState(
          baseState({ phase: 'specify', gates: { 'spec-approval': { status: 'approved' } } }),
        );
      },
      expectBoundary: 'enter:plan',
      expectPhase: 'plan',
    },
    {
      name: 'gated: plan → implement (extracts plan phases, no first-phase refresh)',
      setUp: () => {
        writeProtocol(spirLike());
        writePlan(['phase_1_a', 'phase_2_b']);
        writeState(
          baseState({ phase: 'plan', gates: { 'plan-approval': { status: 'approved' } } }),
        );
      },
      expectBoundary: 'enter:implement',
      expectPhase: 'implement',
      expectPlanPhase: 'phase_1_a',
    },
    {
      name: 'ungated (ASPIR): specify → plan',
      setUp: () => {
        writeProtocol(aspirLike());
        writeState(
          baseState({
            protocol: 'fixture-aspir',
            phase: 'specify',
            build_complete: true,
            iteration: 1,
          }),
        );
        writeApprovingReviews('specify', 1);
      },
      expectBoundary: 'enter:plan',
      expectPhase: 'plan',
    },
    {
      name: 'ungated (ASPIR): plan → implement (extracts plan phases)',
      setUp: () => {
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
        writeApprovingReviews('plan', 1);
      },
      expectBoundary: 'enter:implement',
      expectPhase: 'implement',
      expectPlanPhase: 'phase_1_a',
    },
    {
      name: 'ungated (ASPIR): plan-phase advance',
      setUp: () => {
        writeProtocol(aspirLike());
        writePlan(['phase_1_a', 'phase_2_b']);
        writeState(
          baseState({
            protocol: 'fixture-aspir',
            phase: 'implement',
            plan_phases: [
              { id: 'phase_1_a', title: 'A', status: 'in_progress' },
              { id: 'phase_2_b', title: 'B', status: 'pending' },
            ],
            current_plan_phase: 'phase_1_a',
            build_complete: true,
            iteration: 1,
          }),
        );
        writeApprovingReviews('phase_1_a', 1);
      },
      expectBoundary: 'plan-phase:phase_2_b',
      expectPhase: 'implement',
      expectPlanPhase: 'phase_2_b',
    },
    {
      name: 'ungated (ASPIR): last plan phase → review',
      setUp: () => {
        writeProtocol(aspirLike());
        writePlan(['phase_1_a']);
        writeState(
          baseState({
            protocol: 'fixture-aspir',
            phase: 'implement',
            plan_phases: [{ id: 'phase_1_a', title: 'A', status: 'in_progress' }],
            current_plan_phase: 'phase_1_a',
            build_complete: true,
            iteration: 1,
          }),
        );
        writeApprovingReviews('phase_1_a', 1);
      },
      expectBoundary: 'enter:review',
      expectPhase: 'review',
      expectPlanPhase: null,
    },
  ];

  for (const c of cases) {
    it(`fires ${c.expectBoundary} via ${c.name}`, async () => {
      c.setUp();

      const response = await next(root, PROJECT_ID);

      expect(isRefreshTask(response), `${c.name} did not emit a refresh`).toBe(true);
      expect(response.tasks?.[0].description).toContain(c.expectBoundary);

      const after = readState();
      expect(after.context_refreshes?.map(r => r.boundary)).toEqual([c.expectBoundary]);
      if (c.expectPhase) expect(after.phase).toBe(c.expectPhase);
      if (c.expectPlanPhase !== undefined) {
        expect(after.current_plan_phase).toBe(c.expectPlanPhase);
      }
      // Never two boundaries at one moment: entering `implement` IS entering
      // plan phase 1, and only the entry boundary may be recorded there.
      expect(after.context_refreshes).toHaveLength(1);
      // And one write for the whole thing.
      expect(writeCounter.count).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// A skip is not work
// ---------------------------------------------------------------------------

describe('pre-approval chains', () => {
  it('emits NO refresh when both spec and plan are pre-approved', async () => {
    // This repo's documented default shape: "Approved specs and plans need
    // frontmatter and must be committed to main before spawning."
    //
    // Such a project skips specify AND plan on consecutive `porch next` calls,
    // with no builder work in between. Firing at both would clear a builder
    // twice back to back — violating the spec's "never emitted twice in a row"
    // — and at both moments the context is near-empty, so the >=1000-byte save
    // gate would be padded or would abort.
    //
    // The rule: a pre-approval SKIP means the builder did no work in that phase
    // (the branch only runs at iteration 1 with build_complete false), so there
    // is nothing to refresh. The valuable enter:implement boundary still fires
    // from the gate-approved site whenever the builder actually wrote the plan.
    writeProtocol(spirLike());
    writeApprovedSpec();
    writePlan(['phase_1_a', 'phase_2_b'], true);
    writeState(baseState({ phase: 'specify' }));

    const first = await next(root, PROJECT_ID);
    expect(isRefreshTask(first)).toBe(false);

    const second = await next(root, PROJECT_ID);
    expect(isRefreshTask(second)).toBe(false);

    const after = readState();
    expect(after.phase).toBe('implement');
    expect(after.current_plan_phase).toBe('phase_1_a');
    expect(after.context_refreshes ?? []).toHaveLength(0);
  });

  it('still refreshes entering implement when the builder actually wrote the plan', async () => {
    // Spec pre-approved (no refresh — the builder had done nothing yet), plan
    // written by the builder, so the gate-approved transition into implement
    // DOES refresh. Suppressing the skip must not cost the boundary that matters.
    writeProtocol(spirLike());
    writeApprovedSpec();
    writePlan(['phase_1_a', 'phase_2_b']);
    writeState(baseState({ phase: 'specify' }));

    expect(isRefreshTask(await next(root, PROJECT_ID))).toBe(false);
    expect(readState().phase).toBe('plan');
    expect(readState().context_refreshes ?? []).toHaveLength(0);

    // Builder finishes the plan; the human approves the gate.
    const state = readState();
    state.gates['plan-approval'] = { status: 'approved' };
    writeState(state);

    const response = await next(root, PROJECT_ID);
    expect(isRefreshTask(response)).toBe(true);
    expect(response.tasks?.[0].description).toContain('enter:implement');
    expect(readState().context_refreshes?.map(r => r.boundary)).toEqual(['enter:implement']);
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
