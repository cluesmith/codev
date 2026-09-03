/**
 * Shared fixture for the Spec 1470 porch tests.
 *
 * Extracted at Phase 8 rather than copied. The Phase 2 trigger tests and the
 * Phase 8 full-protocol simulation need the same SPIR-shaped protocol, and this
 * project has spent several rounds on the cost of near-duplicate definitions
 * drifting apart — a fixture that says `on_enter: ['plan', 'implement', 'review']`
 * in one file and something subtly different in another would let a simulation
 * "cover all four boundaries" while testing a protocol nobody ships.
 *
 * Mocks are deliberately NOT here: `vi.mock` is file-scoped, so each test file
 * declares its own. Only the data lives here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type { ProjectState } from '../../types.js';

export const PROJECT_ID = '9001';
export const PROJECT_TITLE = '9001-refresh-fixture';

/**
 * Sentinel for "omit the key entirely".
 *
 * `undefined` cannot express this: passing it triggers the default parameter, so
 * a fixture meant to declare NOTHING would silently declare everything and the
 * negative test would pass for the wrong reason.
 */
export const OMIT = Symbol('omit-context-refresh');

/** The boundaries a SPIR-shaped protocol declares — the shipped set. */
export const SPIR_ON_ENTER = ['plan', 'implement', 'review'] as const;

/** SPIR-shaped protocol with the four boundaries declared. */
export function spirLike(
  contextRefresh: unknown = {
    on_enter: [...SPIR_ON_ENTER],
    on_plan_phase_advance: true,
  },
): Record<string, unknown> {
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
export function aspirLike(): Record<string, unknown> {
  const p = spirLike() as Record<string, unknown>;
  const phases = p.phases as Array<Record<string, unknown>>;
  delete phases[0].gate;
  delete phases[1].gate;
  p.name = 'fixture-aspir';
  return p;
}

export function writeProtocol(root: string, json: Record<string, unknown>): void {
  const dir = path.join(root, 'codev/protocols', json.name as string);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'protocol.json'), JSON.stringify(json, null, 2));
}

export function baseState(overrides: Partial<ProjectState> = {}): ProjectState {
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

export function stateDir(root: string): string {
  return path.join(root, 'codev/projects', PROJECT_TITLE);
}

export function writeState(root: string, state: ProjectState): string {
  const dir = stateDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'status.yaml');
  fs.writeFileSync(p, yaml.dump(state));
  return p;
}

export function readState(root: string): ProjectState {
  return yaml.load(fs.readFileSync(path.join(stateDir(root), 'status.yaml'), 'utf-8')) as ProjectState;
}

/**
 * A plan whose phases porch can extract.
 *
 * `approved` prepends the frontmatter IN THE SAME FILE rather than writing it
 * separately: the plan artifact and the pre-approval marker are one file, and
 * writing them in two calls silently clobbered the phases JSON — which made
 * `extractPlanPhases` fall back to inventing a `phase_1`.
 */
export function writePlan(root: string, phaseIds: string[], approved = false): void {
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

/** Write a spec carrying `approved:` frontmatter. */
export function writeApprovedSpec(root: string): void {
  const dir = path.join(root, 'codev/specs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${PROJECT_TITLE}.md`),
    '---\napproved: 2026-01-01\nvalidated: [codex, claude]\n---\n\n# Spec\n',
  );
}

/**
 * Write APPROVE verdicts for the models the mocked config resolves to.
 *
 * Reaching any transition site requires a completed verify round — without
 * these, `next()` returns "Run remaining consultations" and every
 * transition-site assertion becomes vacuous.
 */
export function writeApprovingReviews(root: string, phase: string, iteration: number): void {
  const dir = stateDir(root);
  fs.mkdirSync(dir, { recursive: true });
  for (const model of ['codex', 'claude']) {
    fs.writeFileSync(
      path.join(dir, `${PROJECT_ID}-${phase}-iter${iteration}-${model}.txt`),
      '---\nVERDICT: APPROVE\nSUMMARY: ok\nCONFIDENCE: HIGH\n---\nKEY_ISSUES:\n- None\n',
    );
  }
}

export function isRefreshTask(response: { tasks?: Array<{ subject: string }> }): boolean {
  return response.tasks?.[0]?.subject === 'Refresh your context';
}
