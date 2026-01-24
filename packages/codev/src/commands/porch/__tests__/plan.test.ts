/**
 * Tests for porch plan parsing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  findPlanFile,
  extractPlanPhases,
  extractPhasesFromFile,
  getCurrentPlanPhase,
  getNextPlanPhase,
  allPlanPhasesComplete,
  advanceStage,
  getPhaseContent,
  isPlanPhaseComplete,
  getCurrentStage,
} from '../plan.js';
import type { PlanPhase } from '../types.js';

// Helper to create a plan phase with all stages pending
const pendingPhase = (id: string, title: string): PlanPhase => ({
  id,
  title,
  stages: { implement: 'pending', defend: 'pending', evaluate: 'pending' },
});

// Helper to create a fully complete plan phase
const completePhase = (id: string, title: string): PlanPhase => ({
  id,
  title,
  stages: { implement: 'complete', defend: 'complete', evaluate: 'complete' },
});

describe('porch plan parsing', () => {
  const testDir = path.join(tmpdir(), `porch-plan-test-${Date.now()}`);
  const plansDir = path.join(testDir, 'codev/plans');

  // Sample plan content with JSON phases block
  const samplePlan = `# Plan 0074: Test Feature

## Overview

This is a test plan.

## Phases (Machine Readable)

\`\`\`json
{
  "phases": [
    {"id": "phase_1", "title": "Core Types"},
    {"id": "phase_2", "title": "State Management"},
    {"id": "phase_3", "title": "Commands"}
  ]
}
\`\`\`

## Phase Breakdown

### Phase 1: Core Types

Create the basic type definitions.

- Define interfaces
- Add type exports

### Phase 2: State Management

Implement state persistence.

- Read/write YAML
- Atomic writes

### Phase 3: Commands

Implement CLI commands.

- status command
- check command
`;

  beforeEach(() => {
    fs.mkdirSync(plansDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('findPlanFile', () => {
    it('should find plan in legacy location', () => {
      const planPath = path.join(plansDir, '0074-test-feature.md');
      fs.writeFileSync(planPath, samplePlan);

      const result = findPlanFile(testDir, '0074');
      expect(result).toBe(planPath);
    });

    it('should find plan in new project location', () => {
      const projectDir = path.join(testDir, 'codev/projects/0074-test-feature');
      fs.mkdirSync(projectDir, { recursive: true });
      const planPath = path.join(projectDir, 'plan.md');
      fs.writeFileSync(planPath, samplePlan);

      const result = findPlanFile(testDir, '0074', 'test-feature');
      expect(result).toBe(planPath);
    });

    it('should return null if plan not found', () => {
      const result = findPlanFile(testDir, '9999');
      expect(result).toBeNull();
    });
  });

  describe('extractPlanPhases', () => {
    it('should extract phases from JSON block', () => {
      const phases = extractPlanPhases(samplePlan);

      expect(phases).toHaveLength(3);
      expect(phases[0].id).toBe('phase_1');
      expect(phases[0].title).toBe('Core Types');
      expect(phases[0].stages.implement).toBe('pending');
      expect(phases[0].stages.defend).toBe('pending');
      expect(phases[0].stages.evaluate).toBe('pending');
      expect(phases[1].id).toBe('phase_2');
      expect(phases[1].title).toBe('State Management');
      expect(phases[2].id).toBe('phase_3');
      expect(phases[2].title).toBe('Commands');
    });

    it('should return default phase if no JSON block', () => {
      const content = '# Simple Plan\n\nJust some text.';
      const phases = extractPlanPhases(content);

      expect(phases).toHaveLength(1);
      expect(phases[0].id).toBe('phase_1');
      expect(phases[0].title).toBe('Implementation');
    });

    it('should return default phase if JSON is invalid', () => {
      const content = `# Plan

\`\`\`json
{invalid json}
\`\`\`
`;
      const phases = extractPlanPhases(content);

      expect(phases).toHaveLength(1);
      expect(phases[0].title).toBe('Implementation');
    });

    it('should handle 6-phase plan', () => {
      const content = `# Plan

## Phases (Machine Readable)

\`\`\`json
{
  "phases": [
    {"id": "phase_1", "title": "Remove Frontend Files"},
    {"id": "phase_2", "title": "Remove HTML References"},
    {"id": "phase_3", "title": "Remove Utils Functions"},
    {"id": "phase_4", "title": "Remove Backend Code"},
    {"id": "phase_5", "title": "Update Documentation"},
    {"id": "phase_6", "title": "Final Verification"}
  ]
}
\`\`\`
`;
      const phases = extractPlanPhases(content);

      expect(phases).toHaveLength(6);
      expect(phases[0].title).toBe('Remove Frontend Files');
      expect(phases[5].title).toBe('Final Verification');
    });
  });

  describe('extractPhasesFromFile', () => {
    it('should extract phases from file', () => {
      const planPath = path.join(plansDir, '0074-test.md');
      fs.writeFileSync(planPath, samplePlan);

      const phases = extractPhasesFromFile(planPath);

      expect(phases).toHaveLength(3);
    });

    it('should throw error for missing file', () => {
      expect(() => {
        extractPhasesFromFile('/nonexistent/plan.md');
      }).toThrow('Plan file not found');
    });
  });

  describe('isPlanPhaseComplete', () => {
    it('should return true when all stages complete', () => {
      const phase = completePhase('phase_1', 'Test');
      expect(isPlanPhaseComplete(phase)).toBe(true);
    });

    it('should return false when any stage incomplete', () => {
      const phase: PlanPhase = {
        id: 'phase_1',
        title: 'Test',
        stages: { implement: 'complete', defend: 'complete', evaluate: 'pending' },
      };
      expect(isPlanPhaseComplete(phase)).toBe(false);
    });
  });

  describe('getCurrentStage', () => {
    it('should return first incomplete stage', () => {
      const phase: PlanPhase = {
        id: 'phase_1',
        title: 'Test',
        stages: { implement: 'complete', defend: 'in_progress', evaluate: 'pending' },
      };
      expect(getCurrentStage(phase)).toBe('defend');
    });

    it('should return null when all stages complete', () => {
      const phase = completePhase('phase_1', 'Test');
      expect(getCurrentStage(phase)).toBeNull();
    });
  });

  describe('getCurrentPlanPhase', () => {
    it('should return first non-complete phase', () => {
      const phases: PlanPhase[] = [
        completePhase('phase_1', 'One'),
        {
          id: 'phase_2',
          title: 'Two',
          stages: { implement: 'in_progress', defend: 'pending', evaluate: 'pending' },
        },
        pendingPhase('phase_3', 'Three'),
      ];

      const current = getCurrentPlanPhase(phases);

      expect(current?.id).toBe('phase_2');
    });

    it('should return null if all complete', () => {
      const phases = [
        completePhase('phase_1', 'One'),
        completePhase('phase_2', 'Two'),
      ];

      const current = getCurrentPlanPhase(phases);

      expect(current).toBeNull();
    });
  });

  describe('getNextPlanPhase', () => {
    const phases = [
      completePhase('phase_1', 'One'),
      pendingPhase('phase_2', 'Two'),
      pendingPhase('phase_3', 'Three'),
    ];

    it('should return next phase', () => {
      const next = getNextPlanPhase(phases, 'phase_1');
      expect(next?.id).toBe('phase_2');
    });

    it('should return null for last phase', () => {
      const next = getNextPlanPhase(phases, 'phase_3');
      expect(next).toBeNull();
    });

    it('should return null for non-existent phase', () => {
      const next = getNextPlanPhase(phases, 'phase_99');
      expect(next).toBeNull();
    });
  });

  describe('allPlanPhasesComplete', () => {
    it('should return true when all complete', () => {
      const phases = [
        completePhase('phase_1', 'One'),
        completePhase('phase_2', 'Two'),
      ];

      expect(allPlanPhasesComplete(phases)).toBe(true);
    });

    it('should return false when some pending', () => {
      const phases = [
        completePhase('phase_1', 'One'),
        pendingPhase('phase_2', 'Two'),
      ];

      expect(allPlanPhasesComplete(phases)).toBe(false);
    });
  });

  describe('advanceStage', () => {
    it('should advance from implement to defend', () => {
      const phases: PlanPhase[] = [
        {
          id: 'phase_1',
          title: 'One',
          stages: { implement: 'in_progress', defend: 'pending', evaluate: 'pending' },
        },
        pendingPhase('phase_2', 'Two'),
      ];

      const { phases: updated, nextProtocolPhase } = advanceStage(phases, 'phase_1', 'implement');

      expect(updated[0].stages.implement).toBe('complete');
      expect(updated[0].stages.defend).toBe('in_progress');
      expect(nextProtocolPhase).toBe('defend');
    });

    it('should advance from defend to evaluate', () => {
      const phases: PlanPhase[] = [
        {
          id: 'phase_1',
          title: 'One',
          stages: { implement: 'complete', defend: 'in_progress', evaluate: 'pending' },
        },
        pendingPhase('phase_2', 'Two'),
      ];

      const { phases: updated, nextProtocolPhase } = advanceStage(phases, 'phase_1', 'defend');

      expect(updated[0].stages.defend).toBe('complete');
      expect(updated[0].stages.evaluate).toBe('in_progress');
      expect(nextProtocolPhase).toBe('evaluate');
    });

    it('should advance from evaluate to next plan phase implement', () => {
      const phases: PlanPhase[] = [
        {
          id: 'phase_1',
          title: 'One',
          stages: { implement: 'complete', defend: 'complete', evaluate: 'in_progress' },
        },
        pendingPhase('phase_2', 'Two'),
      ];

      const { phases: updated, nextProtocolPhase } = advanceStage(phases, 'phase_1', 'evaluate');

      expect(updated[0].stages.evaluate).toBe('complete');
      expect(updated[1].stages.implement).toBe('in_progress');
      expect(nextProtocolPhase).toBe('implement');
    });

    it('should return review when last phase evaluate completes', () => {
      const phases: PlanPhase[] = [
        completePhase('phase_1', 'One'),
        {
          id: 'phase_2',
          title: 'Two',
          stages: { implement: 'complete', defend: 'complete', evaluate: 'in_progress' },
        },
      ];

      const { phases: updated, nextProtocolPhase } = advanceStage(phases, 'phase_2', 'evaluate');

      expect(updated[1].stages.evaluate).toBe('complete');
      expect(nextProtocolPhase).toBe('review');
    });
  });

  describe('getPhaseContent', () => {
    it('should extract content for a phase', () => {
      const content = getPhaseContent(samplePlan, 'phase_1');

      expect(content).toContain('Create the basic type definitions');
      expect(content).toContain('Define interfaces');
    });

    it('should return null for non-existent phase', () => {
      const content = getPhaseContent(samplePlan, 'phase_99');
      expect(content).toBeNull();
    });

    it('should return null for invalid phase id', () => {
      const content = getPhaseContent(samplePlan, 'invalid');
      expect(content).toBeNull();
    });
  });
});
