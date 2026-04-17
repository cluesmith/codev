/**
 * Tests for porch done — verification enforcement
 *
 * Ensures `porch done` cannot bypass 3-way consultation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { done } from '../index.js';
import { writeState, getProjectDir, getStatusPath, readState } from '../state.js';
import type { ProjectState } from '../types.js';

// Mock loadConfig to return defaults, preventing workspace/global config from leaking in.
// Without this, loadConfig reads ~/.codev/config.json and framework cache, which can
// override consultation models (e.g., "parent") and break tests expecting 3-model defaults.
vi.mock('../../../lib/config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../lib/config.js')>();
  return {
    ...original,
    loadConfig: (_workspaceRoot: string) => ({
      porch: { consultation: { models: ['gemini', 'codex', 'claude'] } },
    }),
  };
});

// ============================================================================
// Test Fixtures
// ============================================================================

function createTestDir(): string {
  const dir = path.join(tmpdir(), `porch-done-verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function setupProtocol(testDir: string, protocolName: string, protocol: object): void {
  const protocolDir = path.join(testDir, 'codev', 'protocols', protocolName);
  fs.mkdirSync(protocolDir, { recursive: true });
  fs.writeFileSync(
    path.join(protocolDir, 'protocol.json'),
    JSON.stringify(protocol, null, 2)
  );
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
      'pr': { status: 'pending' as const },
    },
    iteration: 1,
    build_complete: false,
    history: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// Minimal SPIR protocol with build_verify phases
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
      next: 'verify',
    },
    {
      id: 'verify',
      name: 'Verify',
      type: 'once',
      gate: 'verify-approval',
      next: null,
    },
  ],
};

// ============================================================================
// Tests
// ============================================================================

describe('porch done — verification enforcement', () => {
  let testDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDir = createTestDir();
    setupProtocol(testDir, 'spir', spirProtocol);
    // Mock process.exit to throw instead of exiting
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // Test 1: porch done blocks when review files missing
  // --------------------------------------------------------------------------

  it('blocks when review files are missing (build_complete, gate approved)', async () => {
    const state = makeState({
      build_complete: true,
      gates: {
        'spec-approval': { status: 'approved', approved_at: new Date().toISOString() },
        'plan-approval': { status: 'pending' as const },
        'pr': { status: 'pending' as const },
      },
    });
    setupState(testDir, state);

    // No review files created — verification should block

    await expect(done(testDir, '0001')).rejects.toThrow('process.exit(1)');

    // Should have printed VERIFICATION REQUIRED
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('VERIFICATION REQUIRED');
    expect(output).toContain('gemini');
    expect(output).toContain('codex');
    expect(output).toContain('claude');
  });

  // --------------------------------------------------------------------------
  // Test 2: porch done advances when review files present
  // --------------------------------------------------------------------------

  it('advances when all review files are present (build_complete, gate approved)', async () => {
    const state = makeState({
      build_complete: true,
      gates: {
        'spec-approval': { status: 'approved', approved_at: new Date().toISOString() },
        'plan-approval': { status: 'pending' as const },
        'pr': { status: 'pending' as const },
      },
    });
    setupState(testDir, state);

    // Create review files for all 3 models
    const projectDir = getProjectDir(testDir, '0001', 'test-feature');
    fs.mkdirSync(projectDir, { recursive: true });
    for (const model of ['gemini', 'codex', 'claude']) {
      fs.writeFileSync(
        path.join(projectDir, `0001-specify-iter1-${model}.txt`),
        `Review content\n\n---\nVERDICT: APPROVE\n---`
      );
    }

    // Should NOT throw — verification passes, gate approved, advances to plan
    await done(testDir, '0001');

    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('ADVANCING TO: plan');
  });

  // --------------------------------------------------------------------------
  // Test 3: porch done skips checks when gate was recently approved (#432)
  // --------------------------------------------------------------------------

  it('skips checks when gate was approved within 60 seconds', async () => {
    // Protocol with checks AND a gate on the same phase
    const protocolWithChecks = {
      name: 'test-checks',
      version: '1.0.0',
      phases: [
        {
          id: 'investigate',
          name: 'Investigate',
          checks: {
            build: { command: 'echo build-ok' },
          },
          gate: 'pr',
          next: null,
        },
      ],
    };
    setupProtocol(testDir, 'test-checks', protocolWithChecks);

    const state = makeState({
      protocol: 'test-checks',
      phase: 'investigate',
      gates: {
        'pr': { status: 'approved', approved_at: new Date().toISOString() },
      },
    });
    setupState(testDir, state);

    await done(testDir, '0001');

    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    // Should skip checks, not run them
    expect(output).toContain('Checks skipped');
    expect(output).not.toContain('RUNNING CHECKS');
  });

  it('runs checks when gate was approved more than 60 seconds ago', async () => {
    const protocolWithChecks = {
      name: 'test-checks',
      version: '1.0.0',
      phases: [
        {
          id: 'investigate',
          name: 'Investigate',
          checks: {
            build: { command: 'echo build-ok' },
          },
          gate: 'pr',
          next: null,
        },
      ],
    };
    setupProtocol(testDir, 'test-checks', protocolWithChecks);

    // Approved 120 seconds ago — should NOT skip
    const oldApproval = new Date(Date.now() - 120_000).toISOString();
    const state = makeState({
      protocol: 'test-checks',
      phase: 'investigate',
      gates: {
        'pr': { status: 'approved', approved_at: oldApproval },
      },
    });
    setupState(testDir, state);

    await done(testDir, '0001');

    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    // Should run checks normally
    expect(output).toContain('RUNNING CHECKS');
    expect(output).not.toContain('Checks skipped');
  });

  it('runs checks when gate is not approved', async () => {
    const protocolWithChecks = {
      name: 'test-checks',
      version: '1.0.0',
      phases: [
        {
          id: 'investigate',
          name: 'Investigate',
          checks: {
            build: { command: 'echo build-ok' },
          },
          gate: 'pr',
          next: null,
        },
      ],
    };
    setupProtocol(testDir, 'test-checks', protocolWithChecks);

    const state = makeState({
      protocol: 'test-checks',
      phase: 'investigate',
      gates: {
        'pr': { status: 'pending' },
      },
    });
    setupState(testDir, state);

    await done(testDir, '0001');

    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    // Should run checks (gate not approved yet)
    expect(output).toContain('RUNNING CHECKS');
    expect(output).not.toContain('Checks skipped');
  });

  // --------------------------------------------------------------------------
  // Test 4: porch done sets build_complete before gate check
  // --------------------------------------------------------------------------

  it('sets build_complete before checking gate (gate pending, build_complete false)', async () => {
    const state = makeState({
      build_complete: false,
      gates: {
        'spec-approval': { status: 'pending' as const },
        'plan-approval': { status: 'pending' as const },
        'pr': { status: 'pending' as const },
      },
    });
    setupState(testDir, state);

    // No review files, gate is pending — but build_complete is false
    // Should set build_complete and return (not block at gate)
    await done(testDir, '0001');

    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('BUILD COMPLETE');
    expect(output).toContain('porch next');

    // Should NOT contain GATE REQUIRED (build_complete handled first)
    expect(output).not.toContain('GATE REQUIRED');
  });

  // ==========================================================================
  // PR Tracking (Spec 653 Phase 3)
  // ==========================================================================

  it('records PR in pr_history via --pr flag (record-only, no phase advancement)', async () => {
    const state = makeState({ phase: 'specify', build_complete: false });
    setupState(testDir, state);
    setupProtocol(testDir, 'spir', spirProtocol);

    await done(testDir, '0001', undefined, { pr: 42, branch: 'spir/653/specify' });

    const updated = readState(getStatusPath(testDir, '0001', 'test-feature'));
    expect(updated.pr_history).toBeDefined();
    expect(updated.pr_history!.length).toBe(1);
    expect(updated.pr_history![0].pr_number).toBe(42);
    expect(updated.pr_history![0].branch).toBe('spir/653/specify');
    expect(updated.pr_history![0].phase).toBe('specify');
    expect(updated.pr_history![0].created_at).toBeDefined();
    // Record-only: build_complete should NOT be changed
    expect(updated.build_complete).toBe(false);
  });

  it('marks PR as merged via --merged flag (record-only)', async () => {
    const state = makeState({
      phase: 'implement',
      pr_history: [{ phase: 'specify', pr_number: 42, branch: 'stage-1', created_at: '2026-01-01T00:00:00Z' }],
    });
    setupState(testDir, state);
    setupProtocol(testDir, 'spir', spirProtocol);

    await done(testDir, '0001', undefined, { merged: 42 });

    const updated = readState(getStatusPath(testDir, '0001', 'test-feature'));
    expect(updated.pr_history![0].merged).toBe(true);
    expect(updated.pr_history![0].merged_at).toBeDefined();
    // Record-only: phase should NOT change
    expect(updated.phase).toBe('implement');
  });

  it('throws when --pr is used without --branch', async () => {
    const state = makeState();
    setupState(testDir, state);
    setupProtocol(testDir, 'spir', spirProtocol);

    await expect(done(testDir, '0001', undefined, { pr: 42 })).rejects.toThrow('--pr requires --branch');
  });

  it('throws when --merged targets nonexistent PR', async () => {
    const state = makeState({ pr_history: [] });
    setupState(testDir, state);
    setupProtocol(testDir, 'spir', spirProtocol);

    await expect(done(testDir, '0001', undefined, { merged: 99 })).rejects.toThrow('PR #99 not found');
  });

  // ==========================================================================
  // Verify Phase (Spec 653 Phase 4)
  // ==========================================================================

  it('porch done in verify phase auto-requests verify-approval gate', async () => {
    const state = makeState({
      phase: 'verify',
      build_complete: false,
      gates: {
        'spec-approval': { status: 'approved' as const },
        'plan-approval': { status: 'approved' as const },
        'pr': { status: 'approved' as const },
      },
    });
    setupState(testDir, state);

    await done(testDir, '0001');

    const updated = readState(getStatusPath(testDir, '0001', 'test-feature'));
    // Gate should be auto-requested
    expect(updated.gates['verify-approval']).toBeDefined();
    expect(updated.gates['verify-approval'].status).toBe('pending');
    expect(updated.gates['verify-approval'].requested_at).toBeDefined();
  });

  it('readState migrates phase complete to verified (backward compat)', () => {
    const state = makeState({ phase: 'complete' as string });
    const statusPath = getStatusPath(testDir, '0001', 'test-feature');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    writeState(statusPath, state);

    const loaded = readState(statusPath);
    expect(loaded.phase).toBe('verified');
  });
});
