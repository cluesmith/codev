/**
 * Tests for porch protocol loader
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadProtocol,
  findProtocolFile,
  validateProtocol,
  getPhase,
  getNextPhase,
  isTerminalPhase,
  getPhasedPhases,
} from '../protocol-loader.js';

describe('protocol-loader', () => {
  const testDir = path.join(tmpdir(), `porch-protocol-test-${Date.now()}`);
  const protocolsDir = path.join(testDir, 'codev-skeleton', 'protocols');

  beforeEach(() => {
    fs.mkdirSync(protocolsDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  const sampleProtocol = {
    name: 'test-protocol',
    version: '1.0.0',
    description: 'A test protocol',
    phases: [
      {
        id: 'start',
        name: 'Start',
        type: 'once',
        steps: ['step1', 'step2'],
        transition: { on_complete: 'middle' },
      },
      {
        id: 'middle',
        name: 'Middle',
        type: 'per_plan_phase',
        steps: ['implement', 'test'],
        checks: {
          build: { command: 'npm run build', on_fail: 'retry' },
        },
        transition: { on_complete: 'end' },
      },
      {
        id: 'end',
        name: 'End',
        type: 'once',
        gate: { name: 'final-approval', next: null },
      },
    ],
  };

  describe('findProtocolFile', () => {
    it('should find protocol file in codev-skeleton', () => {
      const protocolDir = path.join(protocolsDir, 'test-protocol');
      fs.mkdirSync(protocolDir, { recursive: true });
      fs.writeFileSync(path.join(protocolDir, 'protocol.json'), JSON.stringify(sampleProtocol));

      const result = findProtocolFile(testDir, 'test-protocol');
      expect(result).not.toBeNull();
      expect(result).toContain('test-protocol/protocol.json');
    });

    it('should return null for non-existent protocol', () => {
      const result = findProtocolFile(testDir, 'nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('loadProtocol', () => {
    it('should load and convert protocol from JSON', () => {
      const protocolDir = path.join(protocolsDir, 'test-protocol');
      fs.mkdirSync(protocolDir, { recursive: true });
      fs.writeFileSync(path.join(protocolDir, 'protocol.json'), JSON.stringify(sampleProtocol));

      const protocol = loadProtocol(testDir, 'test-protocol');

      expect(protocol).not.toBeNull();
      expect(protocol!.name).toBe('test-protocol');
      expect(protocol!.version).toBe('1.0.0');
      expect(protocol!.phases).toHaveLength(3);
    });

    it('should set correct initial state', () => {
      const protocolDir = path.join(protocolsDir, 'test-protocol');
      fs.mkdirSync(protocolDir, { recursive: true });
      fs.writeFileSync(path.join(protocolDir, 'protocol.json'), JSON.stringify(sampleProtocol));

      const protocol = loadProtocol(testDir, 'test-protocol');
      // Initial state should be first phase:first substate
      expect(protocol!.initial).toBe('start:step1');
    });

    it('should convert phase types correctly', () => {
      const protocolDir = path.join(protocolsDir, 'test-protocol');
      fs.mkdirSync(protocolDir, { recursive: true });
      fs.writeFileSync(path.join(protocolDir, 'protocol.json'), JSON.stringify(sampleProtocol));

      const protocol = loadProtocol(testDir, 'test-protocol');
      const startPhase = protocol!.phases.find(p => p.id === 'start');
      const middlePhase = protocol!.phases.find(p => p.id === 'middle');

      expect(startPhase!.phased).toBe(false);
      expect(middlePhase!.phased).toBe(true);
    });

    it('should mark terminal phase correctly', () => {
      const protocolDir = path.join(protocolsDir, 'test-protocol');
      fs.mkdirSync(protocolDir, { recursive: true });
      fs.writeFileSync(path.join(protocolDir, 'protocol.json'), JSON.stringify(sampleProtocol));

      const protocol = loadProtocol(testDir, 'test-protocol');
      const endPhase = protocol!.phases.find(p => p.id === 'end');

      expect(endPhase!.terminal).toBe(true);
    });

    it('should return null for invalid JSON', () => {
      const protocolDir = path.join(protocolsDir, 'broken');
      fs.mkdirSync(protocolDir, { recursive: true });
      fs.writeFileSync(path.join(protocolDir, 'protocol.json'), 'not valid json');

      const protocol = loadProtocol(testDir, 'broken');
      expect(protocol).toBeNull();
    });
  });

  describe('validateProtocol', () => {
    it('should validate correct protocol', () => {
      const protocolDir = path.join(protocolsDir, 'test-protocol');
      fs.mkdirSync(protocolDir, { recursive: true });
      fs.writeFileSync(path.join(protocolDir, 'protocol.json'), JSON.stringify(sampleProtocol));

      const protocol = loadProtocol(testDir, 'test-protocol')!;
      const result = validateProtocol(protocol);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should detect missing name', () => {
      const protocol = { phases: [], initial: 'start', name: '', version: '1.0.0', description: '' };
      const result = validateProtocol(protocol);
      expect(result.valid).toBe(false);
    });

    it('should detect empty phases', () => {
      const protocol = { name: 'test', phases: [], initial: 'start', version: '1.0.0', description: '' };
      const result = validateProtocol(protocol);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('at least one phase'))).toBe(true);
    });
  });

  describe('getPhase', () => {
    it('should get phase by ID', () => {
      const protocolDir = path.join(protocolsDir, 'test-protocol');
      fs.mkdirSync(protocolDir, { recursive: true });
      fs.writeFileSync(path.join(protocolDir, 'protocol.json'), JSON.stringify(sampleProtocol));

      const protocol = loadProtocol(testDir, 'test-protocol')!;
      const phase = getPhase(protocol, 'middle');

      expect(phase).not.toBeNull();
      expect(phase!.id).toBe('middle');
      expect(phase!.name).toBe('Middle');
    });

    it('should return null for unknown phase', () => {
      const protocolDir = path.join(protocolsDir, 'test-protocol');
      fs.mkdirSync(protocolDir, { recursive: true });
      fs.writeFileSync(path.join(protocolDir, 'protocol.json'), JSON.stringify(sampleProtocol));

      const protocol = loadProtocol(testDir, 'test-protocol')!;
      const phase = getPhase(protocol, 'nonexistent');

      expect(phase).toBeNull();
    });
  });

  describe('getNextPhase', () => {
    it('should get next phase in sequence', () => {
      const protocolDir = path.join(protocolsDir, 'test-protocol');
      fs.mkdirSync(protocolDir, { recursive: true });
      fs.writeFileSync(path.join(protocolDir, 'protocol.json'), JSON.stringify(sampleProtocol));

      const protocol = loadProtocol(testDir, 'test-protocol')!;
      const next = getNextPhase(protocol, 'start');

      expect(next).not.toBeNull();
      expect(next!.id).toBe('middle');
    });

    it('should return null for last phase', () => {
      const protocolDir = path.join(protocolsDir, 'test-protocol');
      fs.mkdirSync(protocolDir, { recursive: true });
      fs.writeFileSync(path.join(protocolDir, 'protocol.json'), JSON.stringify(sampleProtocol));

      const protocol = loadProtocol(testDir, 'test-protocol')!;
      const next = getNextPhase(protocol, 'end');

      expect(next).toBeNull();
    });
  });

  describe('isTerminalPhase', () => {
    it('should identify terminal phase', () => {
      const protocolDir = path.join(protocolsDir, 'test-protocol');
      fs.mkdirSync(protocolDir, { recursive: true });
      fs.writeFileSync(path.join(protocolDir, 'protocol.json'), JSON.stringify(sampleProtocol));

      const protocol = loadProtocol(testDir, 'test-protocol')!;

      expect(isTerminalPhase(protocol, 'end')).toBe(true);
      expect(isTerminalPhase(protocol, 'start')).toBe(false);
    });
  });

  describe('getPhasedPhases', () => {
    it('should get only phased phases', () => {
      const protocolDir = path.join(protocolsDir, 'test-protocol');
      fs.mkdirSync(protocolDir, { recursive: true });
      fs.writeFileSync(path.join(protocolDir, 'protocol.json'), JSON.stringify(sampleProtocol));

      const protocol = loadProtocol(testDir, 'test-protocol')!;
      const phased = getPhasedPhases(protocol);

      expect(phased).toHaveLength(1);
      expect(phased[0].id).toBe('middle');
    });
  });

  describe('gate trigger logic', () => {
    it('should set gate.after from requires array (last item)', () => {
      const protocolWithRequires = {
        name: 'gate-test',
        version: '1.0.0',
        description: 'Test gate triggers',
        phases: [
          {
            id: 'specify',
            name: 'Specify',
            type: 'once',
            steps: ['draft', 'consult', 'revise', 'spec_final'],
            gate: {
              name: 'spec-approval',
              requires: ['spec_final', 'consultation_done'],
              next: 'plan',
            },
          },
          {
            id: 'plan',
            name: 'Plan',
            type: 'once',
            steps: ['draft'],
          },
        ],
      };

      const protocolDir = path.join(protocolsDir, 'gate-test');
      fs.mkdirSync(protocolDir, { recursive: true });
      fs.writeFileSync(path.join(protocolDir, 'protocol.json'), JSON.stringify(protocolWithRequires));

      const protocol = loadProtocol(testDir, 'gate-test')!;
      const specifyPhase = protocol.phases.find(p => p.id === 'specify');

      // Gate should trigger after last item in requires: 'consultation_done'
      expect(specifyPhase!.gate).toBeDefined();
      expect(specifyPhase!.gate!.after).toBe('consultation_done');
    });

    it('should set gate.after from last step when no requires array', () => {
      const protocolWithoutRequires = {
        name: 'gate-test-2',
        version: '1.0.0',
        description: 'Test gate triggers without requires',
        phases: [
          {
            id: 'review',
            name: 'Review',
            type: 'once',
            steps: ['draft', 'consult', 'final'],
            gate: {
              name: 'review-approval',
              next: null,
            },
          },
        ],
      };

      const protocolDir = path.join(protocolsDir, 'gate-test-2');
      fs.mkdirSync(protocolDir, { recursive: true });
      fs.writeFileSync(path.join(protocolDir, 'protocol.json'), JSON.stringify(protocolWithoutRequires));

      const protocol = loadProtocol(testDir, 'gate-test-2')!;
      const reviewPhase = protocol.phases.find(p => p.id === 'review');

      // Gate should trigger after last step: 'final'
      expect(reviewPhase!.gate).toBeDefined();
      expect(reviewPhase!.gate!.after).toBe('final');
    });

    it('should fallback to gate name when no steps or requires', () => {
      const protocolMinimal = {
        name: 'gate-test-3',
        version: '1.0.0',
        description: 'Minimal gate test',
        phases: [
          {
            id: 'end',
            name: 'End',
            type: 'once',
            gate: {
              name: 'final-gate',
              next: null,
            },
          },
        ],
      };

      const protocolDir = path.join(protocolsDir, 'gate-test-3');
      fs.mkdirSync(protocolDir, { recursive: true });
      fs.writeFileSync(path.join(protocolDir, 'protocol.json'), JSON.stringify(protocolMinimal));

      const protocol = loadProtocol(testDir, 'gate-test-3')!;
      const endPhase = protocol.phases.find(p => p.id === 'end');

      // Gate should fallback to gate name: 'final-gate'
      expect(endPhase!.gate).toBeDefined();
      expect(endPhase!.gate!.after).toBe('final-gate');
    });
  });
});
