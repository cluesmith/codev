/**
 * E2E tests for SPIDER protocol flow
 *
 * These tests verify the state machine transitions through the full protocol
 * without invoking real Claude or consult processes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  createInitialState,
  updateState,
  approveGate,
  requestGateApproval,
  updatePhaseStatus,
  setPlanPhases,
  writeState,
  readState,
  getProjectDir,
} from '../../state.js';
import { loadProtocol } from '../../protocol-loader.js';
import type { ProjectState, Protocol } from '../../types.js';

describe('SPIDER E2E Flow', () => {
  const testDir = path.join(tmpdir(), `porch-e2e-test-${Date.now()}`);
  const protocolsDir = path.join(testDir, 'codev-skeleton', 'protocols', 'spider');
  const projectsDir = path.join(testDir, 'codev', 'projects');

  // Sample SPIDER protocol for testing
  const sampleSpiderProtocol = {
    name: 'spider',
    version: '1.0.0',
    description: 'Test SPIDER protocol',
    phases: [
      {
        id: 'specify',
        name: 'Specify',
        type: 'once',
        steps: ['draft', 'consult', 'revise'],
        gate: { name: 'spec_approval', next: 'plan' },
        transition: { on_complete: 'plan' },
      },
      {
        id: 'plan',
        name: 'Plan',
        type: 'once',
        steps: ['draft', 'consult', 'revise'],
        gate: { name: 'plan_approval', next: 'implement' },
        transition: { on_complete: 'implement' },
      },
      {
        id: 'implement',
        name: 'Implement',
        type: 'per_plan_phase',
        steps: ['code', 'check'],
        checks: { build: { command: 'echo "build"', on_fail: 'retry' } },
        transition: { on_complete: 'defend' },
      },
      {
        id: 'defend',
        name: 'Defend',
        type: 'per_plan_phase',
        steps: ['tests', 'verify'],
        checks: { tests: { command: 'echo "test"', on_fail: 'implement' } },
        transition: { on_complete: 'evaluate' },
      },
      {
        id: 'evaluate',
        name: 'Evaluate',
        type: 'per_plan_phase',
        steps: ['assess'],
        transition: { on_complete: 'review' },
      },
      {
        id: 'review',
        name: 'Review',
        type: 'once',
        steps: ['document'],
        gate: { name: null, next: null },
      },
    ],
  };

  beforeEach(() => {
    // Create test directories
    fs.mkdirSync(protocolsDir, { recursive: true });
    fs.mkdirSync(projectsDir, { recursive: true });

    // Write sample protocol
    fs.writeFileSync(
      path.join(protocolsDir, 'protocol.json'),
      JSON.stringify(sampleSpiderProtocol)
    );
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it('should follow full SPIDER flow with manual state transitions', async () => {
    // Load protocol
    const protocol = loadProtocol(testDir, 'spider');
    expect(protocol).not.toBeNull();
    expect(protocol!.name).toBe('spider');

    // Initialize project state
    const projectDir = path.join(projectsDir, '9999-test-feature');
    fs.mkdirSync(projectDir, { recursive: true });

    let state = createInitialState(protocol!, '9999', 'test-feature');
    expect(state.current_state).toBe('specify:draft');

    // Simulate SPECIFY phase
    // 1. Draft complete -> move to consult
    state = updateState(state, 'specify:consult', { signal: 'SPEC_DRAFTED' });
    expect(state.current_state).toBe('specify:consult');

    // 2. Consultation complete -> move to revise
    state = updateState(state, 'specify:revise');
    expect(state.current_state).toBe('specify:revise');

    // 3. Request gate approval
    state = requestGateApproval(state, 'spec_approval');
    expect(state.gates['spec_approval'].status).toBe('pending');
    expect(state.gates['spec_approval'].requested_at).toBeDefined();

    // 4. Human approves gate
    state = approveGate(state, 'spec_approval');
    expect(state.gates['spec_approval'].status).toBe('passed');
    expect(state.gates['spec_approval'].approved_at).toBeDefined();

    // Move to PLAN phase
    state = updateState(state, 'plan:draft');
    expect(state.current_state).toBe('plan:draft');

    // Simulate PLAN phase
    state = updateState(state, 'plan:consult', { signal: 'PLAN_DRAFTED' });
    state = updateState(state, 'plan:revise');
    state = requestGateApproval(state, 'plan_approval');
    state = approveGate(state, 'plan_approval');
    expect(state.gates['plan_approval'].status).toBe('passed');

    // Set up plan phases (extracted from plan document)
    const planPhases = [
      { id: 'phase_1', title: 'Setup' },
      { id: 'phase_2', title: 'Core Logic' },
    ];
    state = setPlanPhases(state, planPhases);
    expect(state.plan_phases).toHaveLength(2);
    expect(state.phases['phase_1'].status).toBe('pending');
    expect(state.phases['phase_2'].status).toBe('pending');

    // Move to IMPLEMENT phase (IDE loop starts)
    state = updateState(state, 'implement:phase_1');
    state = updatePhaseStatus(state, 'phase_1', 'in_progress');
    expect(state.current_state).toBe('implement:phase_1');

    // IDE Loop for phase_1: Implement -> Defend -> Evaluate
    state = updateState(state, 'defend:phase_1', { signal: 'PHASE_IMPLEMENTED' });
    expect(state.current_state).toBe('defend:phase_1');

    state = updateState(state, 'evaluate:phase_1', { signal: 'TESTS_WRITTEN' });
    expect(state.current_state).toBe('evaluate:phase_1');

    // Phase 1 complete, move to phase 2
    state = updatePhaseStatus(state, 'phase_1', 'complete');
    state = updateState(state, 'implement:phase_2', { signal: 'EVALUATION_COMPLETE' });
    state = updatePhaseStatus(state, 'phase_2', 'in_progress');
    expect(state.phases['phase_1'].status).toBe('complete');
    expect(state.current_state).toBe('implement:phase_2');

    // IDE Loop for phase_2
    state = updateState(state, 'defend:phase_2', { signal: 'PHASE_IMPLEMENTED' });
    state = updateState(state, 'evaluate:phase_2', { signal: 'TESTS_WRITTEN' });
    state = updatePhaseStatus(state, 'phase_2', 'complete');

    // All phases complete, move to REVIEW
    state = updateState(state, 'review:document', { signal: 'EVALUATION_COMPLETE' });
    expect(state.current_state).toBe('review:document');
    expect(state.phases['phase_2'].status).toBe('complete');

    // Review complete
    state = updateState(state, 'complete', { signal: 'REVIEW_COMPLETE' });
    expect(state.current_state).toBe('complete');

    // Verify final state
    expect(state.iteration).toBeGreaterThan(0);
    expect(state.gates['spec_approval'].status).toBe('passed');
    expect(state.gates['plan_approval'].status).toBe('passed');
    expect(state.phases['phase_1'].status).toBe('complete');
    expect(state.phases['phase_2'].status).toBe('complete');
  });

  it('should handle gate rejection and re-approval', async () => {
    const protocol = loadProtocol(testDir, 'spider')!;
    let state = createInitialState(protocol, '9998', 'test-rejection');

    // Move to gate
    state = updateState(state, 'specify:revise');
    state = requestGateApproval(state, 'spec_approval');
    expect(state.gates['spec_approval'].status).toBe('pending');

    // Simulate rejection by staying in current state
    // (In real flow, architect would reject and Claude would revise)

    // Re-request approval after revision
    state = requestGateApproval(state, 'spec_approval');
    expect(state.gates['spec_approval'].status).toBe('pending');

    // Final approval
    state = approveGate(state, 'spec_approval');
    expect(state.gates['spec_approval'].status).toBe('passed');
  });

  it('should persist state to file and reload', async () => {
    const protocol = loadProtocol(testDir, 'spider')!;
    const projectDir = path.join(projectsDir, '9997-persistence-test');
    fs.mkdirSync(projectDir, { recursive: true });
    const statusFile = path.join(projectDir, 'status.yaml');

    // Create and save state
    let state = createInitialState(protocol, '9997', 'persistence-test');
    state = updateState(state, 'specify:consult');
    state = requestGateApproval(state, 'spec_approval');
    await writeState(statusFile, state);

    // Reload state
    const reloaded = readState(statusFile);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.id).toBe('9997');
    expect(reloaded!.current_state).toBe('specify:consult');
    expect(reloaded!.gates['spec_approval'].status).toBe('pending');
  });

  it('should track log entries through transitions', async () => {
    const protocol = loadProtocol(testDir, 'spider')!;
    let state = createInitialState(protocol, '9996', 'log-test');

    // Make several transitions
    state = updateState(state, 'specify:consult', { signal: 'SPEC_DRAFTED' });
    state = updateState(state, 'specify:revise');
    state = updateState(state, 'plan:draft');

    // Verify log (initial state + 3 transitions = 4 entries)
    expect(state.log.length).toBeGreaterThanOrEqual(3);
    // Find the transition log entries (skip any initialization entries)
    const transitions = state.log.filter(entry => entry.from !== null || entry.signal);
    expect(transitions.length).toBeGreaterThanOrEqual(3);

    // Check that we have the expected transitions
    const toStates = state.log.map(entry => entry.to);
    expect(toStates).toContain('specify:consult');
    expect(toStates).toContain('specify:revise');
    expect(toStates).toContain('plan:draft');
  });
});
