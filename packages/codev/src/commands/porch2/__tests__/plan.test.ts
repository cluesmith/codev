/**
 * Tests for porch2 plan parsing
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
  advancePlanPhase,
  getPhaseContent,
} from '../plan.js';

describe('porch2 plan parsing', () => {
  const testDir = path.join(tmpdir(), `porch2-plan-test-${Date.now()}`);
  const plansDir = path.join(testDir, 'codev/plans');

  // Sample plan content
  const samplePlan = `# Plan 0074: Test Feature

## Overview

This is a test plan.

## Implementation Phases

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
- done command

## Dependencies

- Node.js 18+
- js-yaml
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
    it('should extract phases from standard format', () => {
      const phases = extractPlanPhases(samplePlan);

      expect(phases).toHaveLength(3);
      expect(phases[0].id).toBe('phase_1');
      expect(phases[0].title).toBe('Core Types');
      expect(phases[0].status).toBe('pending');
      expect(phases[1].id).toBe('phase_2');
      expect(phases[2].id).toBe('phase_3');
    });

    it('should return default phase if no phases section', () => {
      const content = '# Simple Plan\n\nJust some text.';
      const phases = extractPlanPhases(content);

      expect(phases).toHaveLength(1);
      expect(phases[0].id).toBe('phase_1');
      expect(phases[0].title).toBe('Implementation');
    });

    it('should return default phase if no phase headers found', () => {
      const content = `# Plan

## Implementation Phases

Just some text without phase headers.
`;
      const phases = extractPlanPhases(content);

      expect(phases).toHaveLength(1);
      expect(phases[0].title).toBe('Implementation');
    });

    it('should handle alternative "Phases" header', () => {
      const content = `# Plan

## Phases

### Phase 1: Setup

Do setup.

### Phase 2: Build

Build it.
`;
      const phases = extractPlanPhases(content);

      expect(phases).toHaveLength(2);
      expect(phases[0].title).toBe('Setup');
      expect(phases[1].title).toBe('Build');
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

  describe('getCurrentPlanPhase', () => {
    it('should return first non-complete phase', () => {
      const phases = [
        { id: 'phase_1', title: 'One', status: 'complete' as const },
        { id: 'phase_2', title: 'Two', status: 'in_progress' as const },
        { id: 'phase_3', title: 'Three', status: 'pending' as const },
      ];

      const current = getCurrentPlanPhase(phases);

      expect(current?.id).toBe('phase_2');
    });

    it('should return null if all complete', () => {
      const phases = [
        { id: 'phase_1', title: 'One', status: 'complete' as const },
        { id: 'phase_2', title: 'Two', status: 'complete' as const },
      ];

      const current = getCurrentPlanPhase(phases);

      expect(current).toBeNull();
    });
  });

  describe('getNextPlanPhase', () => {
    const phases = [
      { id: 'phase_1', title: 'One', status: 'complete' as const },
      { id: 'phase_2', title: 'Two', status: 'in_progress' as const },
      { id: 'phase_3', title: 'Three', status: 'pending' as const },
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
        { id: 'phase_1', title: 'One', status: 'complete' as const },
        { id: 'phase_2', title: 'Two', status: 'complete' as const },
      ];

      expect(allPlanPhasesComplete(phases)).toBe(true);
    });

    it('should return false when some pending', () => {
      const phases = [
        { id: 'phase_1', title: 'One', status: 'complete' as const },
        { id: 'phase_2', title: 'Two', status: 'pending' as const },
      ];

      expect(allPlanPhasesComplete(phases)).toBe(false);
    });
  });

  describe('advancePlanPhase', () => {
    it('should mark current as complete and next as in_progress', () => {
      const phases = [
        { id: 'phase_1', title: 'One', status: 'in_progress' as const },
        { id: 'phase_2', title: 'Two', status: 'pending' as const },
        { id: 'phase_3', title: 'Three', status: 'pending' as const },
      ];

      const updated = advancePlanPhase(phases, 'phase_1');

      expect(updated[0].status).toBe('complete');
      expect(updated[1].status).toBe('in_progress');
      expect(updated[2].status).toBe('pending');
    });

    it('should handle advancing last phase', () => {
      const phases = [
        { id: 'phase_1', title: 'One', status: 'complete' as const },
        { id: 'phase_2', title: 'Two', status: 'in_progress' as const },
      ];

      const updated = advancePlanPhase(phases, 'phase_2');

      expect(updated[0].status).toBe('complete');
      expect(updated[1].status).toBe('complete');
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
