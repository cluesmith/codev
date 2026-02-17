/**
 * Tests for porch rollback command (GitHub Issue #401)
 *
 * Verifies that `porch rollback <id> <phase>` correctly rewinds project state
 * to an earlier phase, clears downstream gates, and resets build state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { rollback } from '../index.js';
import {
  writeState,
  readState,
  getStatusPath,
  PROJECTS_DIR,
} from '../state.js';
import type { ProjectState } from '../types.js';

// ============================================================================
// Test Fixtures
// ============================================================================

function createTestDir(): string {
  const dir = path.join(tmpdir(), `porch-rollback-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    id: '0042',
    title: 'test-feature',
    protocol: 'spir',
    phase: 'specify',
    plan_phases: [],
    current_plan_phase: null,
    gates: {
      'spec-approval': { status: 'pending' as const },
      'plan-approval': { status: 'pending' as const },
    },
    iteration: 1,
    build_complete: false,
    history: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const spirProtocol = {
  name: 'spir',
  version: '1.0.0',
  phases: [
    {
      id: 'specify',
      name: 'Specify',
      type: 'build_verify',
      build: { prompt: 'specify.md', artifact: 'codev/specs/${PROJECT_ID}-*.md' },
      verify: { type: 'spec', models: ['gemini', 'codex', 'claude'] },
      max_iterations: 1,
      gate: 'spec-approval',
    },
    {
      id: 'plan',
      name: 'Plan',
      type: 'build_verify',
      build: { prompt: 'plan.md', artifact: 'codev/plans/${PROJECT_ID}-*.md' },
      verify: { type: 'plan', models: ['gemini', 'codex', 'claude'] },
      max_iterations: 1,
      gate: 'plan-approval',
    },
    {
      id: 'implement',
      name: 'Implement',
      type: 'per_plan_phase',
      build: { prompt: 'implement.md' },
      verify: { type: 'impl', models: ['gemini', 'codex', 'claude'] },
      max_iterations: 1,
    },
    {
      id: 'review',
      name: 'Review',
      type: 'build_verify',
      build: { prompt: 'review.md', artifact: 'codev/reviews/${PROJECT_ID}-*.md' },
      verify: { type: 'pr', models: ['gemini', 'codex', 'claude'] },
      max_iterations: 1,
    },
  ],
};

// ============================================================================
// Tests
// ============================================================================

describe('porch rollback (bugfix #401)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
    setupProtocol(testDir, 'spir', spirProtocol);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('rolls back from plan to specify', async () => {
    const state = makeState({
      phase: 'plan',
      gates: {
        'spec-approval': { status: 'approved', approved_at: '2026-01-20T10:00:00Z' },
        'plan-approval': { status: 'pending' },
      },
    });
    const statusPath = getStatusPath(testDir, '0042', 'test-feature');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    writeState(statusPath, state);

    await rollback(testDir, '0042', 'specify');

    const updated = readState(statusPath);
    expect(updated.phase).toBe('specify');
  });

  it('clears gates at and after the target phase', async () => {
    const state = makeState({
      phase: 'implement',
      gates: {
        'spec-approval': { status: 'approved', approved_at: '2026-01-20T10:00:00Z' },
        'plan-approval': { status: 'approved', approved_at: '2026-01-20T11:00:00Z' },
      },
    });
    const statusPath = getStatusPath(testDir, '0042', 'test-feature');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    writeState(statusPath, state);

    await rollback(testDir, '0042', 'specify');

    const updated = readState(statusPath);
    expect(updated.gates['spec-approval'].status).toBe('pending');
    expect(updated.gates['spec-approval'].approved_at).toBeUndefined();
    expect(updated.gates['plan-approval'].status).toBe('pending');
    expect(updated.gates['plan-approval'].approved_at).toBeUndefined();
  });

  it('resets iteration, build_complete, and plan phases', async () => {
    const state = makeState({
      phase: 'implement',
      iteration: 3,
      build_complete: true,
      plan_phases: [
        { id: 'phase_1', title: 'Core types', status: 'complete' },
        { id: 'phase_2', title: 'State mgmt', status: 'in_progress' },
      ],
      current_plan_phase: 'phase_2',
      gates: {
        'spec-approval': { status: 'approved', approved_at: '2026-01-20T10:00:00Z' },
        'plan-approval': { status: 'approved', approved_at: '2026-01-20T11:00:00Z' },
      },
    });
    const statusPath = getStatusPath(testDir, '0042', 'test-feature');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    writeState(statusPath, state);

    await rollback(testDir, '0042', 'plan');

    const updated = readState(statusPath);
    expect(updated.phase).toBe('plan');
    expect(updated.iteration).toBe(1);
    expect(updated.build_complete).toBe(false);
    expect(updated.plan_phases).toEqual([]);
    expect(updated.current_plan_phase).toBeNull();
  });

  it('throws when target phase does not exist in protocol', async () => {
    const state = makeState({ phase: 'plan' });
    const statusPath = getStatusPath(testDir, '0042', 'test-feature');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    writeState(statusPath, state);

    await expect(rollback(testDir, '0042', 'nonexistent')).rejects.toThrow('Unknown phase');
  });

  it('throws when trying to rollback forward', async () => {
    const state = makeState({ phase: 'specify' });
    const statusPath = getStatusPath(testDir, '0042', 'test-feature');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    writeState(statusPath, state);

    await expect(rollback(testDir, '0042', 'plan')).rejects.toThrow('Cannot rollback forward');
  });

  it('throws when trying to rollback to current phase', async () => {
    const state = makeState({ phase: 'plan' });
    const statusPath = getStatusPath(testDir, '0042', 'test-feature');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    writeState(statusPath, state);

    await expect(rollback(testDir, '0042', 'plan')).rejects.toThrow('Cannot rollback forward');
  });

  it('throws for non-existent project', async () => {
    await expect(rollback(testDir, '9999', 'specify')).rejects.toThrow('not found');
  });

  it('preserves gates before the target phase', async () => {
    const state = makeState({
      phase: 'implement',
      gates: {
        'spec-approval': { status: 'approved', approved_at: '2026-01-20T10:00:00Z' },
        'plan-approval': { status: 'approved', approved_at: '2026-01-20T11:00:00Z' },
      },
    });
    const statusPath = getStatusPath(testDir, '0042', 'test-feature');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    writeState(statusPath, state);

    // Roll back to plan — spec-approval gate is on the specify phase which is BEFORE plan
    // But per the issue: "Clear any gate approvals that came after"
    // The spec-approval gate belongs to the specify phase (index 0)
    // Target is plan (index 1), so gates at index >= 1 should be cleared
    await rollback(testDir, '0042', 'plan');

    const updated = readState(statusPath);
    // spec-approval is on the specify phase (before plan) — should be preserved
    expect(updated.gates['spec-approval'].status).toBe('approved');
    // plan-approval is on the plan phase (at target) — should be cleared
    expect(updated.gates['plan-approval'].status).toBe('pending');
  });

  it('allows rollback from complete state', async () => {
    const state = makeState({
      phase: 'complete',
      gates: {
        'spec-approval': { status: 'approved', approved_at: '2026-01-20T10:00:00Z' },
        'plan-approval': { status: 'approved', approved_at: '2026-01-20T11:00:00Z' },
      },
    });
    const statusPath = getStatusPath(testDir, '0042', 'test-feature');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    writeState(statusPath, state);

    await rollback(testDir, '0042', 'plan');

    const updated = readState(statusPath);
    expect(updated.phase).toBe('plan');
    expect(updated.gates['plan-approval'].status).toBe('pending');
  });

  it('re-extracts plan phases when rolling back to a per_plan_phase phase', async () => {
    // Set up a plan file with phases
    const plansDir = path.join(testDir, 'codev', 'plans');
    fs.mkdirSync(plansDir, { recursive: true });
    const planContent = `# Plan

## Phases

\`\`\`json
{"phases": [
  {"id": "phase_1", "title": "Core types"},
  {"id": "phase_2", "title": "State management"},
  {"id": "phase_3", "title": "CLI wiring"}
]}
\`\`\`
`;
    fs.writeFileSync(path.join(plansDir, '0042-test-feature.md'), planContent);

    const state = makeState({
      phase: 'review',
      plan_phases: [
        { id: 'phase_1', title: 'Core types', status: 'complete' },
        { id: 'phase_2', title: 'State management', status: 'complete' },
        { id: 'phase_3', title: 'CLI wiring', status: 'complete' },
      ],
      current_plan_phase: null,
      gates: {
        'spec-approval': { status: 'approved', approved_at: '2026-01-20T10:00:00Z' },
        'plan-approval': { status: 'approved', approved_at: '2026-01-20T11:00:00Z' },
      },
    });
    const statusPath = getStatusPath(testDir, '0042', 'test-feature');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    writeState(statusPath, state);

    await rollback(testDir, '0042', 'implement');

    const updated = readState(statusPath);
    expect(updated.phase).toBe('implement');
    expect(updated.plan_phases).toHaveLength(3);
    expect(updated.plan_phases[0].id).toBe('phase_1');
    expect(updated.plan_phases[0].status).toBe('in_progress');
    expect(updated.plan_phases[1].status).toBe('pending');
    expect(updated.current_plan_phase).toBe('phase_1');
  });

  it('clears history on rollback', async () => {
    const state = makeState({
      phase: 'plan',
      history: [
        {
          iteration: 1,
          build_output: '/tmp/build.txt',
          reviews: [{ model: 'gemini', verdict: 'APPROVE' as const, file: '/tmp/review.txt' }],
        },
      ],
      gates: {
        'spec-approval': { status: 'approved', approved_at: '2026-01-20T10:00:00Z' },
        'plan-approval': { status: 'pending' },
      },
    });
    const statusPath = getStatusPath(testDir, '0042', 'test-feature');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    writeState(statusPath, state);

    await rollback(testDir, '0042', 'specify');

    const updated = readState(statusPath);
    expect(updated.history).toEqual([]);
  });
});
