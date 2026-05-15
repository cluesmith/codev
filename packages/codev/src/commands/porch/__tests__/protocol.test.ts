/**
 * Tests for porch protocol loading
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

describe('porch protocol loading', () => {
  const testDir = path.join(tmpdir(), `porch-protocol-test-${Date.now()}`);
  const protocolsDir = path.join(testDir, 'codev/protocols/spir');

  // Create test protocol JSON
  const spiderProtocol = {
    name: 'spir',
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
    fs.mkdirSync(protocolsDir, { recursive: true });
    fs.writeFileSync(
      path.join(protocolsDir, 'protocol.json'),
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
      const protocol = loadProtocol(testDir, 'spir');

      expect(protocol.name).toBe('spir');
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
        path.join(protocolsDir, 'protocol.json'),
        '{ invalid json }'
      );

      expect(() => {
        loadProtocol(testDir, 'spir');
      }).toThrow('JSON parse error');
    });

    it('should throw error for missing name field', () => {
      fs.writeFileSync(
        path.join(protocolsDir, 'protocol.json'),
        JSON.stringify({ phases: [] })
      );

      expect(() => {
        loadProtocol(testDir, 'spir');
      }).toThrow('missing "name" field');
    });

    it('should collect checks from defaults and phases', () => {
      const protocol = loadProtocol(testDir, 'spir');

      expect(protocol.checks).toBeDefined();
      expect(protocol.checks?.build).toEqual({ command: 'npm run build' });
      expect(protocol.checks?.test).toEqual({ command: 'npm test' });
      expect(protocol.checks?.lint).toEqual({ command: 'npm run lint' });
    });

    it('should normalize phases correctly', () => {
      const protocol = loadProtocol(testDir, 'spir');
      const specifyPhase = protocol.phases.find(p => p.id === 'specify');

      expect(specifyPhase).toBeDefined();
      expect(specifyPhase?.name).toBe('Specification');
      expect(specifyPhase?.gate).toBe('spec_approval');
      expect(specifyPhase?.next).toBe('plan');
    });
  });

  describe('getPhaseConfig', () => {
    it('should return phase by id', () => {
      const protocol = loadProtocol(testDir, 'spir');
      const phase = getPhaseConfig(protocol, 'implement');

      expect(phase).not.toBeNull();
      expect(phase?.name).toBe('Implementation');
    });

    it('should return null for non-existent phase', () => {
      const protocol = loadProtocol(testDir, 'spir');
      const phase = getPhaseConfig(protocol, 'nonexistent');

      expect(phase).toBeNull();
    });
  });

  describe('getNextPhase', () => {
    it('should return next phase', () => {
      const protocol = loadProtocol(testDir, 'spir');
      const next = getNextPhase(protocol, 'specify');

      expect(next).not.toBeNull();
      expect(next?.id).toBe('plan');
    });

    it('should return null for terminal phase', () => {
      const protocol = loadProtocol(testDir, 'spir');
      const next = getNextPhase(protocol, 'review');

      expect(next).toBeNull();
    });

    it('should return null for non-existent phase', () => {
      const protocol = loadProtocol(testDir, 'spir');
      const next = getNextPhase(protocol, 'nonexistent');

      expect(next).toBeNull();
    });
  });

  describe('getPhaseChecks', () => {
    it('should return checks for phase', () => {
      const protocol = loadProtocol(testDir, 'spir');
      const checks = getPhaseChecks(protocol, 'implement');

      expect(checks.build).toEqual({ command: 'npm run build' });
      expect(checks.test).toEqual({ command: 'npm test' });
    });

    it('should return empty object for phase without checks', () => {
      const protocol = loadProtocol(testDir, 'spir');
      const checks = getPhaseChecks(protocol, 'plan');

      expect(checks).toEqual({});
    });
  });

  describe('getPhaseGate', () => {
    it('should return gate name for gated phase', () => {
      const protocol = loadProtocol(testDir, 'spir');
      const gate = getPhaseGate(protocol, 'specify');

      expect(gate).toBe('spec_approval');
    });

    it('should return null for phase without gate', () => {
      const protocol = loadProtocol(testDir, 'spir');
      const gate = getPhaseGate(protocol, 'implement');

      expect(gate).toBeNull();
    });
  });

  describe('isPhased', () => {
    it('should return true for per_plan_phase', () => {
      const protocol = loadProtocol(testDir, 'spir');
      expect(isPhased(protocol, 'implement')).toBe(true);
    });

    it('should return false for once phase', () => {
      const protocol = loadProtocol(testDir, 'spir');
      expect(isPhased(protocol, 'specify')).toBe(false);
    });
  });

  describe('.codev/ override fallback', () => {
    it('should load from .codev/ if not in codev/', () => {
      // Remove from codev/protocols/spir
      fs.rmSync(path.join(protocolsDir, 'protocol.json'));

      // Create in .codev/protocols/spir (user customization tier)
      const overrideDir = path.join(testDir, '.codev/protocols/spir');
      fs.mkdirSync(overrideDir, { recursive: true });
      fs.writeFileSync(
        path.join(overrideDir, 'protocol.json'),
        JSON.stringify({ ...spiderProtocol, description: 'From .codev override' })
      );

      const protocol = loadProtocol(testDir, 'spir');
      expect(protocol.name).toBe('spir');
      expect(protocol.description).toBe('From .codev override');
    });
  });

  describe('alias resolution', () => {
    it('should resolve "spider" alias to spir protocol', () => {
      // Add alias field to the protocol
      const protocolWithAlias = { ...spiderProtocol, alias: 'spider' };
      fs.writeFileSync(
        path.join(protocolsDir, 'protocol.json'),
        JSON.stringify(protocolWithAlias, null, 2)
      );

      const protocol = loadProtocol(testDir, 'spider');
      expect(protocol.name).toBe('spir');
    });
  });
});

/**
 * PIR-specific protocol shape tests (Issue 691).
 *
 * PIR's contract is meaningful enough that we lock it in here:
 *   plan      → gated by 'plan-approval' → next 'implement'
 *   implement → gated by 'dev-approval'   → next 'review'
 *   review    → no gate, terminal (next: null)
 *
 * The PIR protocol.json itself lives at codev/protocols/pir/ in the repo;
 * to keep these tests independent of working-tree state, we synthesize a
 * minimal PIR-shaped protocol and verify loadProtocol parses it correctly.
 */
describe('PIR protocol shape', () => {
  const testDir = path.join(tmpdir(), `porch-pir-test-${Date.now()}`);
  const pirDir = path.join(testDir, 'codev/protocols/pir');

  const pirProtocol = {
    name: 'pir',
    alias: 'plan-implement-review',
    version: '1.0.0',
    description: 'PIR: Plan → Implement → Review for GitHub-issue-driven work with two human gates',
    input: { type: 'github-issue', required: true },
    phases: [
      {
        id: 'plan',
        name: 'Plan',
        type: 'build_verify',
        gate: 'plan-approval',
        next: 'implement',
      },
      {
        id: 'implement',
        name: 'Implement',
        type: 'build_verify',
        gate: 'dev-approval',
        next: 'review',
      },
      {
        id: 'review',
        name: 'Review',
        type: 'build_verify',
        next: null,
      },
    ],
  };

  beforeEach(() => {
    fs.mkdirSync(pirDir, { recursive: true });
    fs.writeFileSync(
      path.join(pirDir, 'protocol.json'),
      JSON.stringify(pirProtocol, null, 2),
    );
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it('loads and normalizes the three PIR phases', () => {
    const protocol = loadProtocol(testDir, 'pir');

    expect(protocol.name).toBe('pir');
    expect(protocol.phases).toHaveLength(3);
    expect(protocol.phases.map(p => p.id)).toEqual(['plan', 'implement', 'review']);
  });

  it('gates the plan phase on plan-approval and transitions to implement', () => {
    const protocol = loadProtocol(testDir, 'pir');
    expect(getPhaseGate(protocol, 'plan')).toBe('plan-approval');
    expect(getNextPhase(protocol, 'plan')?.id).toBe('implement');
  });

  it('gates the implement phase on dev-approval and transitions to review', () => {
    const protocol = loadProtocol(testDir, 'pir');
    expect(getPhaseGate(protocol, 'implement')).toBe('dev-approval');
    expect(getNextPhase(protocol, 'implement')?.id).toBe('review');
  });

  it('leaves the review phase ungated and terminal', () => {
    const protocol = loadProtocol(testDir, 'pir');
    expect(getPhaseGate(protocol, 'review')).toBeNull();
    expect(getNextPhase(protocol, 'review')).toBeNull();
  });

  it('resolves the plan-implement-review alias', () => {
    const protocol = loadProtocol(testDir, 'plan-implement-review');
    expect(protocol.name).toBe('pir');
  });

  it('treats dev-approval as a valid gate name (no whitelist)', () => {
    // Sanity check: porch must accept new gate names purely from data. If a
    // whitelist were ever added, this test would break before PIR ships.
    const protocol = loadProtocol(testDir, 'pir');
    const gate = getPhaseGate(protocol, 'implement');
    expect(gate).toBe('dev-approval');
  });
});
