/**
 * Tests for porch next command
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { next } from '../next.js';
import { writeState, getProjectDir, getStatusPath, PROJECTS_DIR } from '../state.js';
import type { ProjectState, Protocol, PorchNextResponse } from '../types.js';

// ============================================================================
// Test Fixtures
// ============================================================================

function createTestDir(): string {
  const dir = path.join(tmpdir(), `porch-next-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function setupProtocol(testDir: string, protocolName: string, protocol: object): void {
  const protocolDir = path.join(testDir, 'codev-skeleton', 'protocols', protocolName);
  fs.mkdirSync(protocolDir, { recursive: true });
  fs.writeFileSync(
    path.join(protocolDir, 'protocol.json'),
    JSON.stringify(protocol, null, 2)
  );
}

function setupPrompts(testDir: string, protocolName: string, prompts: Record<string, string>): void {
  const promptsDir = path.join(testDir, 'codev-skeleton', 'protocols', protocolName, 'prompts');
  fs.mkdirSync(promptsDir, { recursive: true });
  for (const [name, content] of Object.entries(prompts)) {
    fs.writeFileSync(path.join(promptsDir, name), content);
  }
}

function setupState(testDir: string, state: ProjectState): void {
  const statusPath = getStatusPath(testDir, state.id, state.title);
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  writeState(statusPath, state);
}

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    id: '0001',
    title: 'test-feature',
    protocol: 'spir',
    phase: 'specify',
    plan_phases: [],
    current_plan_phase: null,
    gates: {
      'spec-approval': { status: 'pending' as const },
      'plan-approval': { status: 'pending' as const },
      'pr-ready': { status: 'pending' as const },
    },
    iteration: 1,
    build_complete: false,
    history: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// Minimal SPIR protocol for testing
const spirProtocol = {
  name: 'spir',
  version: '1.0.0',
  phases: [
    {
      id: 'specify',
      name: 'Specify',
      type: 'build_verify',
      build: { prompt: 'specify.md', artifact: 'codev/specs/${PROJECT_ID}-*.md' },
      verify: { type: 'spec-review', models: ['gemini', 'codex', 'claude'] },
      max_iterations: 1,
      on_complete: { commit: true, push: true },
      gate: 'spec-approval',
    },
    {
      id: 'plan',
      name: 'Plan',
      type: 'build_verify',
      build: { prompt: 'plan.md', artifact: 'codev/plans/${PROJECT_ID}-*.md' },
      verify: { type: 'plan-review', models: ['gemini', 'codex', 'claude'] },
      max_iterations: 1,
      on_complete: { commit: true, push: true },
      gate: 'plan-approval',
    },
    {
      id: 'implement',
      name: 'Implement',
      type: 'per_plan_phase',
      build: { prompt: 'implement.md', artifact: 'src/**/*.ts' },
      verify: { type: 'impl-review', models: ['gemini', 'codex', 'claude'] },
      max_iterations: 1,
      on_complete: { commit: true, push: true },
      checks: {
        build: { command: 'npm run build' },
        tests: { command: 'npm test' },
      },
    },
    {
      id: 'review',
      name: 'Review',
      type: 'build_verify',
      build: { prompt: 'review.md', artifact: 'codev/reviews/${PROJECT_ID}-*.md' },
      verify: { type: 'pr-ready', models: ['gemini', 'codex', 'claude'] },
      max_iterations: 1,
      on_complete: { commit: true, push: true },
      gate: 'pr-ready',
    },
  ],
};

// ============================================================================
// Tests
// ============================================================================

describe('porch next', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
    setupProtocol(testDir, 'spir', spirProtocol);
    setupPrompts(testDir, 'spir', {
      'specify.md': '# Specify\nWrite a spec for project {{project_id}}.',
      'plan.md': '# Plan\nWrite a plan for project {{project_id}}.',
      'implement.md': '# Implement\nImplement phase {{plan_phase_id}} for project {{project_id}}.',
      'review.md': '# Review\nWrite a review for project {{project_id}}.',
    });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // Error cases
  // --------------------------------------------------------------------------

  it('returns error for non-existent project', async () => {
    const result = await next(testDir, '9999');
    expect(result.status).toBe('error');
    expect(result.error).toContain('9999');
  });

  // --------------------------------------------------------------------------
  // Fresh project — specify BUILD tasks
  // --------------------------------------------------------------------------

  it('emits BUILD tasks for fresh specify phase', async () => {
    setupState(testDir, makeState());

    const result = await next(testDir, '0001');

    expect(result.status).toBe('tasks');
    expect(result.phase).toBe('specify');
    expect(result.iteration).toBe(1);
    expect(result.tasks).toBeDefined();
    expect(result.tasks!.length).toBeGreaterThanOrEqual(2);
    // First task is the build task with prompt
    expect(result.tasks![0].subject).toContain('Build artifact');
    expect(result.tasks![0].description).toContain('Specify');
    // Last task signals completion
    expect(result.tasks![result.tasks!.length - 1].subject).toContain('Signal build complete');
    expect(result.tasks![result.tasks!.length - 1].description).toContain('porch done');
  });

  // --------------------------------------------------------------------------
  // Build complete — VERIFY tasks
  // --------------------------------------------------------------------------

  it('emits VERIFY tasks when build_complete is true and no reviews exist', async () => {
    setupState(testDir, makeState({ build_complete: true }));

    const result = await next(testDir, '0001');

    expect(result.status).toBe('tasks');
    expect(result.phase).toBe('specify');
    expect(result.tasks).toBeDefined();
    expect(result.tasks!.length).toBe(1);
    expect(result.tasks![0].subject).toContain('consultation');
    expect(result.tasks![0].description).toContain('consult');
    expect(result.tasks![0].description).toContain('gemini');
    expect(result.tasks![0].description).toContain('codex');
    expect(result.tasks![0].description).toContain('claude');
  });

  // --------------------------------------------------------------------------
  // Build complete + all approve → gate pending
  // --------------------------------------------------------------------------

  it('requests gate when all reviewers approve', async () => {
    const state = makeState({ build_complete: true });
    setupState(testDir, state);

    // Create review files with APPROVE verdicts
    const projectDir = getProjectDir(testDir, '0001', 'test-feature');
    fs.mkdirSync(projectDir, { recursive: true });
    for (const model of ['gemini', 'codex', 'claude']) {
      const reviewContent = `Review text that is long enough to pass the minimum length threshold for parsing.\n\n---\nVERDICT: APPROVE\nSUMMARY: Looks good\nCONFIDENCE: HIGH\n---`;
      fs.writeFileSync(
        path.join(projectDir, `0001-specify-iter1-${model}.txt`),
        reviewContent
      );
    }

    const result = await next(testDir, '0001');

    expect(result.status).toBe('gate_pending');
    expect(result.gate).toBe('spec-approval');
    expect(result.tasks).toBeDefined();
    expect(result.tasks![0].description).toContain('porch gate');
  });

  // --------------------------------------------------------------------------
  // Build complete + request changes → write rebuttal task
  // --------------------------------------------------------------------------

  it('emits write rebuttal task when reviewers request changes', async () => {
    const state = makeState({ build_complete: true });
    setupState(testDir, state);

    // Create review files — one requests changes
    const projectDir = getProjectDir(testDir, '0001', 'test-feature');
    fs.mkdirSync(projectDir, { recursive: true });

    const approveContent = `Review text that is long enough to pass the minimum length threshold for parsing.\n\n---\nVERDICT: APPROVE\nSUMMARY: Looks good\nCONFIDENCE: HIGH\n---`;
    const requestChangesContent = `Review text that is long enough to pass the minimum length threshold for parsing.\n\n---\nVERDICT: REQUEST_CHANGES\nSUMMARY: Missing tests\nCONFIDENCE: HIGH\n---`;

    fs.writeFileSync(path.join(projectDir, '0001-specify-iter1-gemini.txt'), approveContent);
    fs.writeFileSync(path.join(projectDir, '0001-specify-iter1-codex.txt'), requestChangesContent);
    fs.writeFileSync(path.join(projectDir, '0001-specify-iter1-claude.txt'), approveContent);

    const result = await next(testDir, '0001');

    expect(result.status).toBe('tasks');
    expect(result.iteration).toBe(1); // iteration NOT incremented
    expect(result.tasks).toBeDefined();
    expect(result.tasks![0].subject).toContain('Write rebuttal');
    expect(result.tasks![0].description).toContain('rebuttals.md');
    expect(result.tasks![0].description).toContain('REQUEST_CHANGES');
  });

  // --------------------------------------------------------------------------
  // Gate pending — returns gate_pending status
  // --------------------------------------------------------------------------

  it('returns gate_pending when gate is pending and requested', async () => {
    const state = makeState({
      gates: {
        'spec-approval': { status: 'pending', requested_at: new Date().toISOString() },
        'plan-approval': { status: 'pending' },
        'pr-ready': { status: 'pending' },
      },
    });
    setupState(testDir, state);

    const result = await next(testDir, '0001');

    expect(result.status).toBe('gate_pending');
    expect(result.gate).toBe('spec-approval');
    expect(result.tasks).toBeDefined();
    expect(result.tasks![0].description).toContain('porch gate');
  });

  // --------------------------------------------------------------------------
  // Gate approved — advances to next phase
  // --------------------------------------------------------------------------

  it('advances phase when gate is approved', async () => {
    const state = makeState({
      gates: {
        'spec-approval': { status: 'approved', approved_at: new Date().toISOString() },
        'plan-approval': { status: 'pending' },
        'pr-ready': { status: 'pending' },
      },
    });
    setupState(testDir, state);

    const result = await next(testDir, '0001');

    // Should advance to plan phase and emit BUILD tasks
    expect(result.status).toBe('tasks');
    expect(result.phase).toBe('plan');
    expect(result.iteration).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Pre-approved artifact — skips phase
  // --------------------------------------------------------------------------

  it('skips phase when artifact has approved frontmatter', async () => {
    setupState(testDir, makeState());

    // Create spec with approved frontmatter
    const specsDir = path.join(testDir, 'codev', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(
      path.join(specsDir, '0001-test-feature.md'),
      '---\napproved: 2026-01-29\nvalidated: [gemini, codex, claude]\n---\n\n# Test Spec'
    );

    const result = await next(testDir, '0001');

    // Should skip specify and go to plan
    expect(result.phase).toBe('plan');
    expect(result.status).toBe('tasks');
  });

  // --------------------------------------------------------------------------
  // Per-plan-phase — emits tasks for current plan phase
  // --------------------------------------------------------------------------

  it('emits tasks for current plan phase in implement', async () => {
    const state = makeState({
      phase: 'implement',
      gates: {
        'spec-approval': { status: 'approved', approved_at: new Date().toISOString() },
        'plan-approval': { status: 'approved', approved_at: new Date().toISOString() },
        'pr-ready': { status: 'pending' },
      },
      plan_phases: [
        { id: 'phase_1', title: 'Core types', status: 'in_progress' },
        { id: 'phase_2', title: 'State management', status: 'pending' },
      ],
      current_plan_phase: 'phase_1',
    });
    setupState(testDir, state);

    const result = await next(testDir, '0001');

    expect(result.status).toBe('tasks');
    expect(result.phase).toBe('implement');
    expect(result.plan_phase).toBe('phase_1');
    // Should include check tasks for implement phase
    const subjects = result.tasks!.map(t => t.subject);
    expect(subjects.some(s => s.includes('Build artifact'))).toBe(true);
    expect(subjects.some(s => s.includes('Signal build complete'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Plan phase advance — moves to next plan phase after approval
  // --------------------------------------------------------------------------

  it('advances plan phase after all reviewers approve', async () => {
    const state = makeState({
      phase: 'implement',
      build_complete: true,
      gates: {
        'spec-approval': { status: 'approved', approved_at: new Date().toISOString() },
        'plan-approval': { status: 'approved', approved_at: new Date().toISOString() },
        'pr-ready': { status: 'pending' },
      },
      plan_phases: [
        { id: 'phase_1', title: 'Core types', status: 'in_progress' },
        { id: 'phase_2', title: 'State management', status: 'pending' },
      ],
      current_plan_phase: 'phase_1',
    });
    setupState(testDir, state);

    // Create review files with APPROVE
    const projectDir = getProjectDir(testDir, '0001', 'test-feature');
    fs.mkdirSync(projectDir, { recursive: true });
    for (const model of ['gemini', 'codex', 'claude']) {
      const content = `Review text that is long enough to pass the minimum length threshold for parsing.\n\n---\nVERDICT: APPROVE\nSUMMARY: Good\n---`;
      fs.writeFileSync(path.join(projectDir, `0001-phase_1-iter1-${model}.txt`), content);
    }

    const result = await next(testDir, '0001');

    // Should advance to phase_2
    expect(result.phase).toBe('implement');
    expect(result.plan_phase).toBe('phase_2');
    expect(result.iteration).toBe(1);
    expect(result.status).toBe('tasks');
  });

  // --------------------------------------------------------------------------
  // All plan phases complete — moves to review
  // --------------------------------------------------------------------------

  it('moves to review when all plan phases complete', async () => {
    const state = makeState({
      phase: 'implement',
      build_complete: true,
      gates: {
        'spec-approval': { status: 'approved', approved_at: new Date().toISOString() },
        'plan-approval': { status: 'approved', approved_at: new Date().toISOString() },
        'pr-ready': { status: 'pending' },
      },
      plan_phases: [
        { id: 'phase_1', title: 'Core types', status: 'complete' },
        { id: 'phase_2', title: 'State management', status: 'in_progress' },
      ],
      current_plan_phase: 'phase_2',
    });
    setupState(testDir, state);

    // Create review files for phase_2 with APPROVE
    const projectDir = getProjectDir(testDir, '0001', 'test-feature');
    fs.mkdirSync(projectDir, { recursive: true });
    for (const model of ['gemini', 'codex', 'claude']) {
      const content = `Review text that is long enough to pass the minimum length threshold for parsing.\n\n---\nVERDICT: APPROVE\nSUMMARY: Good\n---`;
      fs.writeFileSync(path.join(projectDir, `0001-phase_2-iter1-${model}.txt`), content);
    }

    const result = await next(testDir, '0001');

    // Should move to review phase
    expect(result.phase).toBe('review');
    expect(result.status).toBe('tasks');
  });

  // --------------------------------------------------------------------------
  // Protocol complete
  // --------------------------------------------------------------------------

  it('returns complete when protocol is finished', async () => {
    const state = makeState({ phase: 'complete' });
    setupState(testDir, state);

    const result = await next(testDir, '0001');

    expect(result.status).toBe('complete');
    expect(result.summary).toContain('completed');
  });

  // --------------------------------------------------------------------------
  // Idempotency — same output when called twice without changes
  // --------------------------------------------------------------------------

  it('is idempotent when called twice without filesystem changes', async () => {
    setupState(testDir, makeState());

    const result1 = await next(testDir, '0001');
    const result2 = await next(testDir, '0001');

    expect(result1.status).toBe(result2.status);
    expect(result1.phase).toBe(result2.phase);
    expect(result1.iteration).toBe(result2.iteration);
    expect(result1.tasks!.length).toBe(result2.tasks!.length);
    expect(result1.tasks![0].subject).toBe(result2.tasks![0].subject);
  });

  // --------------------------------------------------------------------------
  // Rebuttal advancement — advances when rebuttal file exists
  // --------------------------------------------------------------------------

  it('advances when rebuttal file exists after REQUEST_CHANGES', async () => {
    const state = makeState({ build_complete: true });
    setupState(testDir, state);

    const projectDir = getProjectDir(testDir, '0001', 'test-feature');
    fs.mkdirSync(projectDir, { recursive: true });

    // Create review files — one requests changes
    const approveContent = `Review text that is long enough to pass the minimum length threshold for parsing.\n\n---\nVERDICT: APPROVE\n---`;
    const rcContent = `Review text that is long enough to pass the minimum length threshold for parsing.\n\n---\nVERDICT: REQUEST_CHANGES\n---`;
    fs.writeFileSync(path.join(projectDir, '0001-specify-iter1-gemini.txt'), approveContent);
    fs.writeFileSync(path.join(projectDir, '0001-specify-iter1-codex.txt'), rcContent);
    fs.writeFileSync(path.join(projectDir, '0001-specify-iter1-claude.txt'), approveContent);

    // Create rebuttal file
    fs.writeFileSync(
      path.join(projectDir, '0001-specify-iter1-rebuttals.md'),
      '## Rebuttal\n\nThe requested changes are not applicable because...'
    );

    const result = await next(testDir, '0001');

    // Rebuttal exists — should advance to gate (via handleVerifyApproved)
    expect(result.status).toBe('gate_pending');
    expect(result.gate).toBe('spec-approval');
  });

  // --------------------------------------------------------------------------
  // Rebuttal for per_plan_phase advances to next plan phase
  // --------------------------------------------------------------------------

  it('advances plan phase via rebuttal in implement phase', async () => {
    const state = makeState({
      phase: 'implement',
      build_complete: true,
      gates: {
        'spec-approval': { status: 'approved', approved_at: new Date().toISOString() },
        'plan-approval': { status: 'approved', approved_at: new Date().toISOString() },
        'pr-ready': { status: 'pending' },
      },
      plan_phases: [
        { id: 'phase_1', title: 'Core types', status: 'in_progress' },
        { id: 'phase_2', title: 'State management', status: 'pending' },
      ],
      current_plan_phase: 'phase_1',
    });
    setupState(testDir, state);

    const projectDir = getProjectDir(testDir, '0001', 'test-feature');
    fs.mkdirSync(projectDir, { recursive: true });

    // Reviews with REQUEST_CHANGES for phase_1
    const approveContent = `Review text that is long enough to pass the minimum length threshold for parsing.\n\n---\nVERDICT: APPROVE\n---`;
    const rcContent = `Review text that is long enough to pass the minimum length threshold for parsing.\n\n---\nVERDICT: REQUEST_CHANGES\n---`;
    fs.writeFileSync(path.join(projectDir, '0001-phase_1-iter1-gemini.txt'), approveContent);
    fs.writeFileSync(path.join(projectDir, '0001-phase_1-iter1-codex.txt'), rcContent);
    fs.writeFileSync(path.join(projectDir, '0001-phase_1-iter1-claude.txt'), approveContent);

    // Create rebuttal file for phase_1
    fs.writeFileSync(
      path.join(projectDir, '0001-phase_1-iter1-rebuttals.md'),
      '## Rebuttal\n\nCodex concerns are false positives.'
    );

    const result = await next(testDir, '0001');

    // Should advance to phase_2 (via handleVerifyApproved)
    expect(result.phase).toBe('implement');
    expect(result.plan_phase).toBe('phase_2');
    expect(result.iteration).toBe(1);
    expect(result.status).toBe('tasks');
  });

  // --------------------------------------------------------------------------
  // Write rebuttal task includes correct review verdicts
  // --------------------------------------------------------------------------

  it('write rebuttal task lists all review verdicts', async () => {
    const state = makeState({ build_complete: true });
    setupState(testDir, state);

    const projectDir = getProjectDir(testDir, '0001', 'test-feature');
    fs.mkdirSync(projectDir, { recursive: true });

    // All three request changes
    const rcContent = `Review text that is long enough to pass the minimum length threshold for parsing.\n\n---\nVERDICT: REQUEST_CHANGES\n---`;
    fs.writeFileSync(path.join(projectDir, '0001-specify-iter1-gemini.txt'), rcContent);
    fs.writeFileSync(path.join(projectDir, '0001-specify-iter1-codex.txt'), rcContent);
    fs.writeFileSync(path.join(projectDir, '0001-specify-iter1-claude.txt'), rcContent);

    const result = await next(testDir, '0001');

    expect(result.status).toBe('tasks');
    expect(result.tasks![0].description).toContain('0001-specify-iter1-gemini.txt');
    expect(result.tasks![0].description).toContain('0001-specify-iter1-codex.txt');
    expect(result.tasks![0].description).toContain('0001-specify-iter1-claude.txt');
  });

  // --------------------------------------------------------------------------
  // Write rebuttal is idempotent
  // --------------------------------------------------------------------------

  it('emits same write rebuttal task on repeated calls', async () => {
    const state = makeState({ build_complete: true });
    setupState(testDir, state);

    const projectDir = getProjectDir(testDir, '0001', 'test-feature');
    fs.mkdirSync(projectDir, { recursive: true });

    const approveContent = `Review text that is long enough to pass the minimum length threshold for parsing.\n\n---\nVERDICT: APPROVE\n---`;
    const rcContent = `Review text that is long enough to pass the minimum length threshold for parsing.\n\n---\nVERDICT: REQUEST_CHANGES\n---`;
    fs.writeFileSync(path.join(projectDir, '0001-specify-iter1-gemini.txt'), approveContent);
    fs.writeFileSync(path.join(projectDir, '0001-specify-iter1-codex.txt'), rcContent);
    fs.writeFileSync(path.join(projectDir, '0001-specify-iter1-claude.txt'), approveContent);

    const result1 = await next(testDir, '0001');
    const result2 = await next(testDir, '0001');

    expect(result1.status).toBe('tasks');
    expect(result2.status).toBe('tasks');
    expect(result1.tasks![0].subject).toBe(result2.tasks![0].subject);
    expect(result1.iteration).toBe(result2.iteration);
  });

  // --------------------------------------------------------------------------
  // Stateful reviews — generates context file for iteration > 1
  // --------------------------------------------------------------------------

  it('generates context file for consult commands on iteration > 1', async () => {
    const state = makeState({
      build_complete: true,
      iteration: 2,
      history: [{
        iteration: 1,
        build_output: '',
        reviews: [
          { model: 'gemini', verdict: 'REQUEST_CHANGES', file: '/tmp/fake-review-gemini.txt' },
          { model: 'codex', verdict: 'REQUEST_CHANGES', file: '/tmp/fake-review-codex.txt' },
          { model: 'claude', verdict: 'APPROVE', file: '/tmp/fake-review-claude.txt' },
        ],
      }],
    });
    setupState(testDir, state);

    const result = await next(testDir, '0001');

    expect(result.status).toBe('tasks');
    expect(result.tasks).toBeDefined();
    expect(result.tasks![0].description).toContain('--context');

    // Verify context file was created
    const projectDir = getProjectDir(testDir, '0001', 'test-feature');
    const contextPath = path.join(projectDir, '0001-specify-iter2-context.md');
    expect(fs.existsSync(contextPath)).toBe(true);

    const contextContent = fs.readFileSync(contextPath, 'utf-8');
    expect(contextContent).toContain('Iteration 1 Reviews');
    expect(contextContent).toContain('gemini: REQUEST_CHANGES');
    expect(contextContent).toContain('Stateful Review Context');
  });

  it('includes rebuttals in context file when rebuttal file exists', async () => {
    const state = makeState({
      build_complete: true,
      iteration: 2,
      history: [{
        iteration: 1,
        build_output: '',
        reviews: [
          { model: 'gemini', verdict: 'REQUEST_CHANGES', file: '/tmp/fake-review.txt' },
          { model: 'codex', verdict: 'APPROVE', file: '/tmp/fake-review2.txt' },
          { model: 'claude', verdict: 'APPROVE', file: '/tmp/fake-review3.txt' },
        ],
      }],
    });
    setupState(testDir, state);

    // Create a rebuttal file for iteration 1
    const projectDir = getProjectDir(testDir, '0001', 'test-feature');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '0001-specify-iter1-rebuttals.md'),
      '## Disputed: Missing tailwind.config.ts\n\nTailwind v4 uses CSS-first configuration.'
    );

    const result = await next(testDir, '0001');

    // Verify context file includes rebuttals
    const contextPath = path.join(projectDir, '0001-specify-iter2-context.md');
    expect(fs.existsSync(contextPath)).toBe(true);

    const contextContent = fs.readFileSync(contextPath, 'utf-8');
    expect(contextContent).toContain('Builder Response to Iteration 1');
    expect(contextContent).toContain('Tailwind v4 uses CSS-first configuration');
  });

  // --------------------------------------------------------------------------
  // Partial reviews — asks for remaining
  // --------------------------------------------------------------------------

  it('asks for remaining consultations when partial reviews exist', async () => {
    const state = makeState({ build_complete: true });
    setupState(testDir, state);

    // Only create one review file (out of 3 expected)
    const projectDir = getProjectDir(testDir, '0001', 'test-feature');
    fs.mkdirSync(projectDir, { recursive: true });
    const content = `Review text that is long enough to pass the minimum length threshold for parsing.\n\n---\nVERDICT: APPROVE\n---`;
    fs.writeFileSync(path.join(projectDir, '0001-specify-iter1-gemini.txt'), content);

    const result = await next(testDir, '0001');

    expect(result.status).toBe('tasks');
    expect(result.tasks![0].description).toContain('codex');
    expect(result.tasks![0].description).toContain('claude');
    // Should not mention gemini (already done)
    expect(result.tasks![0].subject).toContain('remaining');
  });

  // --------------------------------------------------------------------------
  // Once phase (TICK/BUGFIX) — emits single task
  // --------------------------------------------------------------------------

  it('emits single task for once-type phase', async () => {
    // Set up a simple protocol with a 'once' phase
    const onceProtocol = {
      name: 'tick',
      version: '1.0.0',
      phases: [
        {
          id: 'identify',
          name: 'Identify Target',
          type: 'once',
          transition: { on_complete: 'amend_spec' },
        },
        {
          id: 'amend_spec',
          name: 'Amend Specification',
          type: 'once',
          transition: { on_complete: null },
        },
      ],
    };
    setupProtocol(testDir, 'tick', onceProtocol);

    const state: ProjectState = {
      id: '0002',
      title: 'tick-test',
      protocol: 'tick',
      phase: 'identify',
      plan_phases: [],
      current_plan_phase: null,
      gates: {},
      iteration: 1,
      build_complete: false,
      history: [],
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    setupState(testDir, state);

    const result = await next(testDir, '0002');

    expect(result.status).toBe('tasks');
    expect(result.phase).toBe('identify');
    expect(result.tasks!.length).toBe(1);
    expect(result.tasks![0].subject).toContain('Identify Target');
    expect(result.tasks![0].description).toContain('porch done');
  });

  // --------------------------------------------------------------------------
  // Bugfix complete — no merge task, no second notification (#319)
  // --------------------------------------------------------------------------

  it('returns empty tasks for completed bugfix protocol (no merge instruction)', async () => {
    const bugfixProtocol = {
      name: 'bugfix',
      version: '1.1.0',
      phases: [
        {
          id: 'investigate',
          name: 'Investigate',
          type: 'once',
          transition: { on_complete: 'fix' },
        },
        {
          id: 'fix',
          name: 'Fix',
          type: 'once',
          transition: { on_complete: 'pr' },
        },
        {
          id: 'pr',
          name: 'Create PR',
          type: 'once',
          transition: { on_complete: null },
        },
      ],
    };
    setupProtocol(testDir, 'bugfix', bugfixProtocol);

    const state: ProjectState = {
      id: 'builder-bugfix-42',
      title: 'login-spaces',
      protocol: 'bugfix',
      phase: 'complete',
      plan_phases: [],
      current_plan_phase: null,
      gates: {},
      iteration: 1,
      build_complete: false,
      history: [],
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    setupState(testDir, state);

    const result = await next(testDir, 'builder-bugfix-42');

    expect(result.status).toBe('complete');
    expect(result.tasks).toEqual([]);
    // Must NOT contain merge instructions or af send — builder is done
    expect(result.summary).not.toContain('Merge');
    expect(result.summary).toContain('architect');
  });

  it('returns merge task for completed non-bugfix protocol', async () => {
    const state = makeState({ phase: 'complete' });
    setupState(testDir, state);

    const result = await next(testDir, '0001');

    expect(result.status).toBe('complete');
    expect(result.tasks!.length).toBe(1);
    expect(result.tasks![0].subject).toContain('Merge');
    expect(result.tasks![0].description).toContain('gh pr merge');
  });
});
