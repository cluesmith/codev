/**
 * Tests for porch2 protocol loading
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadProtocol,
  getPhaseConfig,
  getNextPhase,
  getPhaseChecks,
  getPhaseGate,
  isPhased,
} from '../protocol.js';

describe('porch2 protocol loading', () => {
  const testDir = path.join(tmpdir(), `porch2-protocol-test-${Date.now()}`);
  const protocolsDir = path.join(testDir, 'codev/protocols');

  // Create test protocol JSON
  const spiderProtocol = {
    name: 'spider',
    version: '1.0.0',
    description: 'Test protocol',
    phases: [
      {
        id: 'specify',
        name: 'Specification',
        type: 'once',
        gate: { name: 'spec_approval', next: 'plan' },
        checks: {
          build: { command: 'npm run build' },
        },
      },
      {
        id: 'plan',
        name: 'Planning',
        type: 'once',
        gate: { name: 'plan_approval', next: 'implement' },
      },
      {
        id: 'implement',
        name: 'Implementation',
        type: 'per_plan_phase',
        checks: {
          build: { command: 'npm run build' },
          test: { command: 'npm test' },
        },
        transition: { on_complete: 'review' },
      },
      {
        id: 'review',
        name: 'Review',
        type: 'once',
        gate: { name: 'review_approval', next: null },
      },
    ],
    defaults: {
      checks: {
        lint: 'npm run lint',
      },
    },
  };

  beforeEach(() => {
    fs.mkdirSync(path.join(protocolsDir, 'spider'), { recursive: true });
    fs.writeFileSync(
      path.join(protocolsDir, 'spider', 'protocol.json'),
      JSON.stringify(spiderProtocol, null, 2)
    );
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('loadProtocol', () => {
    it('should load protocol from codev/protocols', () => {
      const protocol = loadProtocol(testDir, 'spider');

      expect(protocol.name).toBe('spider');
      expect(protocol.version).toBe('1.0.0');
      expect(protocol.phases).toHaveLength(4);
    });

    it('should throw error for non-existent protocol', () => {
      expect(() => {
        loadProtocol(testDir, 'nonexistent');
      }).toThrow("Protocol 'nonexistent' not found");
    });

    it('should throw error for invalid JSON', () => {
      fs.writeFileSync(
        path.join(protocolsDir, 'spider', 'protocol.json'),
        '{ invalid json }'
      );

      expect(() => {
        loadProtocol(testDir, 'spider');
      }).toThrow('JSON parse error');
    });

    it('should throw error for missing name field', () => {
      fs.writeFileSync(
        path.join(protocolsDir, 'spider', 'protocol.json'),
        JSON.stringify({ phases: [] })
      );

      expect(() => {
        loadProtocol(testDir, 'spider');
      }).toThrow('missing "name" field');
    });

    it('should collect checks from defaults and phases', () => {
      const protocol = loadProtocol(testDir, 'spider');

      expect(protocol.checks).toBeDefined();
      expect(protocol.checks?.build).toBe('npm run build');
      expect(protocol.checks?.test).toBe('npm test');
      expect(protocol.checks?.lint).toBe('npm run lint');
    });

    it('should normalize phases correctly', () => {
      const protocol = loadProtocol(testDir, 'spider');
      const specifyPhase = protocol.phases.find(p => p.id === 'specify');

      expect(specifyPhase).toBeDefined();
      expect(specifyPhase?.name).toBe('Specification');
      expect(specifyPhase?.gate).toBe('spec_approval');
      expect(specifyPhase?.next).toBe('plan');
    });
  });

  describe('getPhaseConfig', () => {
    it('should return phase by id', () => {
      const protocol = loadProtocol(testDir, 'spider');
      const phase = getPhaseConfig(protocol, 'implement');

      expect(phase).not.toBeNull();
      expect(phase?.name).toBe('Implementation');
    });

    it('should return null for non-existent phase', () => {
      const protocol = loadProtocol(testDir, 'spider');
      const phase = getPhaseConfig(protocol, 'nonexistent');

      expect(phase).toBeNull();
    });
  });

  describe('getNextPhase', () => {
    it('should return next phase', () => {
      const protocol = loadProtocol(testDir, 'spider');
      const next = getNextPhase(protocol, 'specify');

      expect(next).not.toBeNull();
      expect(next?.id).toBe('plan');
    });

    it('should return null for terminal phase', () => {
      const protocol = loadProtocol(testDir, 'spider');
      const next = getNextPhase(protocol, 'review');

      expect(next).toBeNull();
    });

    it('should return null for non-existent phase', () => {
      const protocol = loadProtocol(testDir, 'spider');
      const next = getNextPhase(protocol, 'nonexistent');

      expect(next).toBeNull();
    });
  });

  describe('getPhaseChecks', () => {
    it('should return checks for phase', () => {
      const protocol = loadProtocol(testDir, 'spider');
      const checks = getPhaseChecks(protocol, 'implement');

      expect(checks.build).toBe('npm run build');
      expect(checks.test).toBe('npm test');
    });

    it('should return empty object for phase without checks', () => {
      const protocol = loadProtocol(testDir, 'spider');
      const checks = getPhaseChecks(protocol, 'plan');

      expect(checks).toEqual({});
    });
  });

  describe('getPhaseGate', () => {
    it('should return gate name for gated phase', () => {
      const protocol = loadProtocol(testDir, 'spider');
      const gate = getPhaseGate(protocol, 'specify');

      expect(gate).toBe('spec_approval');
    });

    it('should return null for phase without gate', () => {
      const protocol = loadProtocol(testDir, 'spider');
      const gate = getPhaseGate(protocol, 'implement');

      expect(gate).toBeNull();
    });
  });

  describe('isPhased', () => {
    it('should return true for per_plan_phase', () => {
      const protocol = loadProtocol(testDir, 'spider');
      expect(isPhased(protocol, 'implement')).toBe(true);
    });

    it('should return false for once phase', () => {
      const protocol = loadProtocol(testDir, 'spider');
      expect(isPhased(protocol, 'specify')).toBe(false);
    });
  });

  describe('codev-skeleton fallback', () => {
    it('should load from codev-skeleton if not in codev', () => {
      // Remove from codev/protocols
      fs.rmSync(path.join(protocolsDir, 'spider'), { recursive: true });

      // Create in codev-skeleton/protocols
      const skeletonDir = path.join(testDir, 'codev-skeleton/protocols/spider');
      fs.mkdirSync(skeletonDir, { recursive: true });
      fs.writeFileSync(
        path.join(skeletonDir, 'protocol.json'),
        JSON.stringify({ ...spiderProtocol, description: 'From skeleton' })
      );

      const protocol = loadProtocol(testDir, 'spider');
      expect(protocol.name).toBe('spider');
      expect(protocol.description).toBe('From skeleton');
    });
  });
});
