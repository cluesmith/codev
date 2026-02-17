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
import { writeState, getProjectDir, getStatusPath } from '../state.js';
import type { ProjectState } from '../types.js';

// ============================================================================
// Test Fixtures
// ============================================================================

function createTestDir(): string {
  const dir = path.join(tmpdir(), `porch-done-verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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
  // Test 3: porch done sets build_complete before gate check
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
});
