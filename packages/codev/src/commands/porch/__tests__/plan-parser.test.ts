/**
 * Tests for porch plan parser
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractPhasesFromPlan,
  getCurrentPhase,
  getNextPhase,
  allPhasesComplete,
} from '../plan-parser.js';

describe('plan-parser', () => {
  describe('extractPhasesFromPlan', () => {
    it('should extract all phases from plan with Phases section', () => {
      const planContent = `# Implementation Plan

## Overview
This is the plan overview.

## Phases

### Phase 1: Project Setup
- Set up the initial project structure
- Configure dependencies

### Phase 2: Core Logic
- Implement the core business logic
- Add validation

### Phase 3: Testing
- Add unit tests
- Add integration tests
`;

      const result = extractPhasesFromPlan(planContent);
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('phase_1');
      expect(result[0].title).toBe('Project Setup');
      expect(result[1].id).toBe('phase_2');
      expect(result[1].title).toBe('Core Logic');
      expect(result[2].id).toBe('phase_3');
      expect(result[2].title).toBe('Testing');
    });

    it('should return default phase for plan without Phases section', () => {
      const planContent = `# Implementation Plan

This is a simple plan without a phases section.

Some more content here.
`;
      const result = extractPhasesFromPlan(planContent);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('phase_1');
      expect(result[0].title).toBe('Implementation');
    });

    it('should handle plan with Implementation Phases section', () => {
      const planContent = `# Plan

## Implementation Phases

### Phase 1: Setup
- Initialize project

### Phase 2: Build
- Build features
`;
      const result = extractPhasesFromPlan(planContent);
      expect(result).toHaveLength(2);
      expect(result[0].title).toBe('Setup');
      expect(result[1].title).toBe('Build');
    });

    it('should extract descriptions from bullet points', () => {
      const planContent = `# Plan

## Phases

### Phase 1: Setup
- Create directories
- Initialize config
- Install dependencies
`;
      const result = extractPhasesFromPlan(planContent);
      expect(result).toHaveLength(1);
      expect(result[0].description).toContain('Create directories');
    });
  });

  describe('getCurrentPhase', () => {
    const phases = [
      { id: 'phase_1', title: 'Setup' },
      { id: 'phase_2', title: 'Build' },
      { id: 'phase_3', title: 'Test' },
    ];

    it('should return first incomplete phase', () => {
      const completed = new Set(['phase_1']);
      const current = getCurrentPhase(phases, completed);
      expect(current?.id).toBe('phase_2');
    });

    it('should return first phase when none completed', () => {
      const completed = new Set<string>();
      const current = getCurrentPhase(phases, completed);
      expect(current?.id).toBe('phase_1');
    });

    it('should return null when all complete', () => {
      const completed = new Set(['phase_1', 'phase_2', 'phase_3']);
      const current = getCurrentPhase(phases, completed);
      expect(current).toBeNull();
    });
  });

  describe('getNextPhase', () => {
    const phases = [
      { id: 'phase_1', title: 'Setup' },
      { id: 'phase_2', title: 'Build' },
      { id: 'phase_3', title: 'Test' },
    ];

    it('should return next phase in sequence', () => {
      const next = getNextPhase(phases, 'phase_1');
      expect(next?.id).toBe('phase_2');
    });

    it('should return null for last phase', () => {
      const next = getNextPhase(phases, 'phase_3');
      expect(next).toBeNull();
    });

    it('should return null for unknown phase', () => {
      const next = getNextPhase(phases, 'nonexistent');
      expect(next).toBeNull();
    });
  });

  describe('allPhasesComplete', () => {
    const phases = [
      { id: 'phase_1', title: 'Setup' },
      { id: 'phase_2', title: 'Build' },
    ];

    it('should return true when all complete', () => {
      const completed = new Set(['phase_1', 'phase_2']);
      expect(allPhasesComplete(phases, completed)).toBe(true);
    });

    it('should return false when some incomplete', () => {
      const completed = new Set(['phase_1']);
      expect(allPhasesComplete(phases, completed)).toBe(false);
    });

    it('should return false when none complete', () => {
      const completed = new Set<string>();
      expect(allPhasesComplete(phases, completed)).toBe(false);
    });
  });
});
