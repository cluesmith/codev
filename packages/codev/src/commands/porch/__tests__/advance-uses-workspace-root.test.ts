/**
 * Regression test for bugfix #336: Builder worktree changes leak into main worktree
 *
 * The `advanceProtocolPhase` function was using `process.cwd()` instead of the
 * explicit `workspaceRoot` parameter when calling `findPlanFile`. In builder
 * worktrees, `process.cwd()` is the worktree root, but `workspaceRoot` is the
 * parameter that should be used consistently. This test ensures `done()` uses
 * the provided `workspaceRoot` — not `process.cwd()` — when extracting plan
 * phases during phase advancement.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { done } from '../index.js';
import { writeState, getStatusPath } from '../state.js';
import { readState } from '../state.js';
import type { ProjectState } from '../types.js';

// ============================================================================
// Helpers
// ============================================================================

function createTestDir(suffix: string): string {
  const dir = path.join(tmpdir(), `porch-advance-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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
    id: '0042',
    title: 'test-feature',
    protocol: 'test-proto',
    phase: 'prepare',
    plan_phases: [],
    current_plan_phase: null,
    gates: {},
    iteration: 1,
    build_complete: false,
    history: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Protocol with two phases:
 * - "prepare" (type: once) — no checks, no gate, no build/verify
 * - "implement" (type: per_plan_phase) — phased, uses plan files
 *
 * When `done()` is called for "prepare", it advances to "implement"
 * and calls `findPlanFile(workspaceRoot, ...)` to extract plan phases.
 */
const testProtocol = {
  name: 'test-proto',
  version: '1.0.0',
  phases: [
    { id: 'prepare', name: 'Prepare', type: 'once' },
    { id: 'implement', name: 'Implement', type: 'per_plan_phase' },
  ],
};

const PLAN_CONTENT = `# Plan

## Phases

### Phase 1: Setup database

Create the schema and migrations.

### Phase 2: Add API endpoints

Implement the REST endpoints.
`;

// ============================================================================
// Tests
// ============================================================================

describe('advanceProtocolPhase uses workspaceRoot (bugfix #336)', () => {
  let testDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDir = createTestDir('workspace');
    setupProtocol(testDir, 'test-proto', testProtocol);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    logSpy.mockRestore();
  });

  it('finds plan file using workspaceRoot, not process.cwd()', async () => {
    // Set up state at "prepare" phase
    setupState(testDir, makeState());

    // Create a plan file in the test workspace (NOT in process.cwd())
    const plansDir = path.join(testDir, 'codev', 'plans');
    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(path.join(plansDir, '0042-test-feature.md'), PLAN_CONTENT);

    // Verify process.cwd() is different from testDir
    // (the test runner runs from the repo root, not the temp dir)
    expect(process.cwd()).not.toBe(testDir);

    // Call done() with explicit workspaceRoot
    // Before the fix, advanceProtocolPhase used process.cwd() to find plans
    // which would fail since the plan is in testDir, not process.cwd()
    await done(testDir, '0042');

    // Read the updated state
    const statusPath = getStatusPath(testDir, '0042', 'test-feature');
    const updatedState = readState(statusPath);

    // Should have advanced to "implement" and extracted plan phases
    expect(updatedState.phase).toBe('implement');
    expect(updatedState.plan_phases.length).toBeGreaterThan(0);
    expect(updatedState.plan_phases[0].title).toBe('Setup database');
    expect(updatedState.current_plan_phase).toBe('phase_1');
  });

  it('extracts all plan phases when advancing to phased phase', async () => {
    setupState(testDir, makeState());

    const plansDir = path.join(testDir, 'codev', 'plans');
    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(path.join(plansDir, '0042-test-feature.md'), PLAN_CONTENT);

    await done(testDir, '0042');

    const statusPath = getStatusPath(testDir, '0042', 'test-feature');
    const updatedState = readState(statusPath);

    expect(updatedState.plan_phases).toHaveLength(2);
    expect(updatedState.plan_phases[0].id).toBe('phase_1');
    expect(updatedState.plan_phases[0].title).toBe('Setup database');
    expect(updatedState.plan_phases[1].id).toBe('phase_2');
    expect(updatedState.plan_phases[1].title).toBe('Add API endpoints');
  });
});
