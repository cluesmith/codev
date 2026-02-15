/**
 * Regression test for GitHub Issue #217:
 * af spawn --resume resets porch state to phase: specify
 *
 * Tests that `porch init` is idempotent: when status.yaml already exists
 * (e.g., from a previous builder session), calling init again preserves
 * the existing state rather than throwing or overwriting.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { init } from '../index.js';
import {
  writeState,
  readState,
  getStatusPath,
  findStatusPath,
  PROJECTS_DIR,
} from '../state.js';
import type { ProjectState } from '../types.js';

// ============================================================================
// Test Fixtures
// ============================================================================

function createTestDir(): string {
  const dir = path.join(tmpdir(), `porch-init-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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
    id: '0001',
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
      verify: { type: 'spec-review', models: ['gemini', 'codex', 'claude'] },
      max_iterations: 3,
      gate: 'spec-approval',
    },
    {
      id: 'plan',
      name: 'Plan',
      type: 'build_verify',
      build: { prompt: 'plan.md', artifact: 'codev/plans/${PROJECT_ID}-*.md' },
      verify: { type: 'plan-review', models: ['gemini', 'codex', 'claude'] },
      max_iterations: 3,
      gate: 'plan-approval',
    },
    {
      id: 'implement',
      name: 'Implement',
      type: 'per_plan_phase',
      build: { prompt: 'implement.md' },
      verify: { type: 'impl-review', models: ['gemini', 'codex', 'claude'] },
      max_iterations: 3,
    },
  ],
};

// ============================================================================
// Tests
// ============================================================================

describe('porch init idempotency (bugfix #217)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
    setupProtocol(testDir, 'spir', spirProtocol);
    // Suppress console output during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('creates fresh state when no status.yaml exists', async () => {
    await init(testDir, 'spir', '0001', 'test-feature');

    const statusPath = getStatusPath(testDir, '0001', 'test-feature');
    expect(fs.existsSync(statusPath)).toBe(true);

    const state = readState(statusPath);
    expect(state.id).toBe('0001');
    expect(state.phase).toBe('specify');
    expect(state.protocol).toBe('spir');
  });

  it('preserves existing state when status.yaml already exists (same name)', async () => {
    // Simulate a builder that reached the implement phase
    const existingState = makeState({
      phase: 'implement',
      gates: {
        'spec-approval': { status: 'approved', approved_at: '2026-01-20T10:00:00Z' },
        'plan-approval': { status: 'approved', approved_at: '2026-01-20T11:00:00Z' },
      },
      plan_phases: [
        { id: 'phase_1', title: 'Core types', status: 'complete' },
        { id: 'phase_2', title: 'State management', status: 'in_progress' },
      ],
      current_plan_phase: 'phase_2',
      iteration: 3,
    });
    const statusPath = getStatusPath(testDir, '0001', 'test-feature');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    writeState(statusPath, existingState);

    // Call init again — this should NOT throw or overwrite
    await init(testDir, 'spir', '0001', 'test-feature');

    // State should be preserved, not reset to specify
    const state = readState(statusPath);
    expect(state.phase).toBe('implement');
    expect(state.current_plan_phase).toBe('phase_2');
    expect(state.iteration).toBe(3);
    expect(state.gates['spec-approval'].status).toBe('approved');
    expect(state.gates['plan-approval'].status).toBe('approved');
  });

  it('preserves existing state when project ID exists under different name', async () => {
    // Simulate project created with one name
    const existingState = makeState({
      id: '0001',
      title: 'original-name',
      phase: 'plan',
      gates: {
        'spec-approval': { status: 'approved', approved_at: '2026-01-20T10:00:00Z' },
        'plan-approval': { status: 'pending' },
      },
    });
    const statusPath = getStatusPath(testDir, '0001', 'original-name');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    writeState(statusPath, existingState);

    // Call init with same ID but different name — should detect and preserve
    await init(testDir, 'spir', '0001', 'different-name');

    // Original state should still be there, untouched
    const originalState = readState(statusPath);
    expect(originalState.phase).toBe('plan');
    expect(originalState.title).toBe('original-name');
    expect(originalState.gates['spec-approval'].status).toBe('approved');

    // No new status.yaml should have been created
    const newPath = getStatusPath(testDir, '0001', 'different-name');
    expect(fs.existsSync(newPath)).toBe(false);
  });

  it('does not modify existing state timestamps on idempotent init', async () => {
    const existingState = makeState({
      phase: 'implement',
      started_at: '2026-01-15T10:00:00Z',
    });
    const statusPath = getStatusPath(testDir, '0001', 'test-feature');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    writeState(statusPath, existingState);

    // Record the updated_at after initial write
    const stateBeforeInit = readState(statusPath);
    const updatedBefore = stateBeforeInit.updated_at;

    // Call init again
    await init(testDir, 'spir', '0001', 'test-feature');

    // State should not have been rewritten (same updated_at)
    const stateAfterInit = readState(statusPath);
    expect(stateAfterInit.updated_at).toBe(updatedBefore);
    expect(stateAfterInit.started_at).toBe('2026-01-15T10:00:00Z');
  });
});
